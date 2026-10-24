/**
 * x86-32 -> IR lifter for one discovered function.
 *
 * Conventions:
 *  - Guest GPRs are locals (`eax`..`edi`), loaded from the Cpu struct at entry and after every
 *    call, stored back before calls, returns and tail calls ("syncout"/"syncin").
 *  - The guest stack and return addresses live in guest memory exactly as on real hardware.
 *  - The x87 register file stays in the Cpu struct (`fpr[8]`), indexed by the `ftop` local.
 *  - Arithmetic flags follow the static plan from flags.ts.
 */
import type { Block, Func, Program } from "./cfg.ts";
import { gprIndex } from "./cfg.ts";
import {
  ALL_FLAGS, AF, CF, OF, PF, SF, ZF, FLAG_NAMES, analyzeFlags, defKind, fromIced, operandBits, regBits,
  type DefKind, type FlagPlan,
} from "./flags.ts";
import {
  add, and, bin, c32, c64, call, cf64, cpu, eq, eqz, load, loc, ne, or, sel, shl, shrs, shru, sub, un, xor,
  type CpuField, type Expr, type IrBlock, type IrFunc, type Stmt, type Term, type Ty,
} from "./ir.ts";
import { ConditionCode, MemorySize, Mnemonic, Register, type Insn, type MemOperand, type Operand } from "./x86.ts";

export const GPR_NAMES = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"] as const;

const hex = (n: number) => n.toString(16).padStart(8, "0");
export const funcName = (va: number) => `f_${hex(va)}`;
const label = (va: number) => `b_${hex(va)}`;

const MASK = (bits: number) => (bits === 32 ? -1 : (1 << bits) - 1);
const SIGN = (bits: number) => (bits === 32 ? 0x80000000 | 0 : 1 << (bits - 1));

export class LiftError extends Error {}

export function liftFunction(prog: Program, f: Func, importIndex: (slot: number) => number): IrFunc {
  return new FnLifter(prog, f, importIndex).lift();
}

class FnLifter {
  private readonly prog: Program;
  private readonly f: Func;
  private readonly plan: FlagPlan;
  private readonly importIndex: (slot: number) => number;
  private readonly ir: IrFunc;
  private cur!: IrBlock;
  private tmpN = 0;
  private synthN = 0;
  /** Flags read by the instruction currently being lifted (only these may be evaluated). */
  private insn!: Insn;

  constructor(prog: Program, f: Func, importIndex: (slot: number) => number) {
    this.prog = prog;
    this.f = f;
    this.importIndex = importIndex;
    this.plan = analyzeFlags(f);
    this.ir = { entry: f.entry, name: funcName(f.entry), locals: new Map(), order: [], blocks: new Map() };
     for (const g of GPR_NAMES) this.ir.locals.set(g, "i32");
     for (const [, n] of FLAG_NAMES) this.ir.locals.set(n, "i32");
     for (const n of ["df", "sa", "sb", "sr", "ftop", "pc24"]) this.ir.locals.set(n, "i32");
     // Segment registers (selector values, zero-extended to 32 bits)
     for (const n of ["es", "cs", "ss", "ds", "fs", "gs"]) this.ir.locals.set(n, "i32");
  }

  lift(): IrFunc {
    const entry = this.newBlock("entry");
    this.cur = entry;
    this.emit({ k: "syncin" });
     for (const [, n] of FLAG_NAMES) this.set(n, c32(0));
     for (const n of ["df", "sa", "sb", "sr"]) this.set(n, c32(0));
     // Initialize segment registers to 0
     for (const n of ["es", "cs", "ss", "ds", "fs", "gs"]) this.set(n, c32(0));
    entry.term = { k: "br", to: label(this.f.entry) };

    const blocks = [...this.f.blocks.values()].sort((a, b) => a.start - b.start);
    for (const b of blocks) {
      this.cur = this.newBlock(label(b.start));
      for (let k = 0; k < b.insns.length; k++) {
        const i = b.insns[k];
        const last = k === b.insns.length - 1;
        this.insn = i;
        if (last && this.isTerminatorInsn(b, i)) break;
        this.emit({ k: "comment", text: `${hex(i.ip)}: ${i.text}` });
        try {
          this.lower(i);
        } catch (e) {
          if (e instanceof LiftError) this.emit({ k: "trap", msg: `unsupported ${i.text} at 0x${hex(i.ip)}: ${e.message}` });
          else throw e;
        }
      }
      this.terminate(b);
    }
    return this.ir;
  }

  // ------------------------------------------------------------------------------------------
  // IR plumbing

  private newBlock(id: string): IrBlock {
    if (this.ir.blocks.has(id)) throw new Error(`duplicate block ${id}`);
    const b: IrBlock = { id, stmts: [], term: { k: "trap", msg: "unterminated block" } };
    this.ir.blocks.set(id, b);
    this.ir.order.push(id);
    return b;
  }

  private synthBlock(): IrBlock {
    return this.newBlock(`${this.cur.id}_${++this.synthN}`);
  }

  private emit(s: Stmt): void {
    this.cur.stmts.push(s);
  }

  private set(name: string, v: Expr, ty: Ty = v.ty): void {
    if (!this.ir.locals.has(name)) this.ir.locals.set(name, ty);
    this.emit({ k: "set", name, ty, v });
  }

  /** Evaluate `v` once into a fresh temporary (registers are copied: they may be overwritten). */
  private tmp(v: Expr): Expr {
    if (v.k === "const") return v;
    const name = `t${++this.tmpN}`;
    this.set(name, v);
    return loc(name, v.ty);
  }

  private trapHere(msg: string): never {
    throw new LiftError(msg);
  }

  // ------------------------------------------------------------------------------------------
  // Registers, memory and operands

  private gpr(r: Register): { name: string; part: "d" | "w" | "l" | "h" } {
    const idx = gprIndex(r);
    if (idx < 0) this.trapHere(`register ${Register[r]}`);
    const name = GPR_NAMES[idx];
    const bits = regBits(r);
    if (bits === 32) return { name, part: "d" };
    if (bits === 16) return { name, part: "w" };
    const isHigh = r === Register.AH || r === Register.CH || r === Register.DH || r === Register.BH;
    return { name, part: isHigh ? "h" : "l" };
  }

  private getReg(r: Register): Expr {
    const { name, part } = this.gpr(r);
    const v = loc(name);
    if (part === "d") return v;
    if (part === "w") return and(v, c32(0xffff));
    if (part === "l") return and(v, c32(0xff));
    return and(shru(v, c32(8)), c32(0xff));
  }

  private isSegmentReg(r: Register): boolean {
    return r === Register.ES || r === Register.CS || r === Register.SS || r === Register.DS || r === Register.FS || r === Register.GS;
  }

  private segLocal(r: Register): string {
    switch (r) {
      case Register.ES: return "es";
      case Register.CS: return "cs";
      case Register.SS: return "ss";
      case Register.DS: return "ds";
      case Register.FS: return "fs";
      case Register.GS: return "gs";
      default: this.trapHere("expected a segment register");
    }
  }

  private setReg(r: Register, value: Expr): void {
    const { name, part } = this.gpr(r);
    const v = loc(name);
    if (part === "d") this.set(name, value);
    else if (part === "w") this.set(name, or(and(v, c32(0xffff0000)), and(value, c32(0xffff))));
    else if (part === "l") this.set(name, or(and(v, c32(0xffffff00)), and(value, c32(0xff))));
    else this.set(name, or(and(v, c32(0xffff00ff)), shl(and(value, c32(0xff)), c32(8))));
  }

  private ea(m: MemOperand): Expr {
    let a: Expr | null = null;
    if (m.base !== Register.None) a = this.getReg(m.base);
    if (m.index !== Register.None) {
      const idx = this.getReg(m.index);
      const scaled = m.scale === 1 ? idx : shl(idx, c32(Math.log2(m.scale)));
      a = a ? add(a, scaled) : scaled;
    }
    if (m.disp !== 0 || !a) a = a ? add(a, c32(m.disp)) : c32(m.disp);
    if (m.seg === Register.FS) a = add(a, cpu("fs_base"));
    else if (m.seg === Register.GS) this.trapHere("GS segment");
    return a;
  }

  private loadMem(m: MemOperand, bytes: 1 | 2 | 4 | 8, addr?: Expr): Expr {
    return load(bytes, addr ?? this.ea(m));
  }

  private store(bytes: 1 | 2 | 4 | 8, addr: Expr, v: Expr): void {
    this.emit({ k: "store", bytes, addr, v });
  }

  private opBits(o: Operand): number {
    if (o.kind === "reg") return regBits(o.reg);
    if (o.kind === "mem") return o.mem.size * 8;
    return 32;
  }

  /** Read an integer operand, zero-extended to i32. */
  private read(o: Operand, addr?: Expr): Expr {
    switch (o.kind) {
      case "reg":
        if (this.isSegmentReg(o.reg)) return loc(this.segLocal(o.reg));
        return this.getReg(o.reg);
      case "imm":
        return c32(o.value);
      case "mem": {
        const bytes = o.mem.size as 1 | 2 | 4;
        if (bytes !== 1 && bytes !== 2 && bytes !== 4) this.trapHere(`integer memory operand of ${o.mem.size} bytes`);
        return this.loadMem(o.mem, bytes, addr);
      }
      default:
        return this.trapHere(`operand kind ${o.kind}`);
    }
  }

  private write(o: Operand, v: Expr, addr?: Expr): void {
    if (o.kind === "reg") {
      if (this.isSegmentReg(o.reg)) this.set(this.segLocal(o.reg), and(v, c32(0xffff)));
      else this.setReg(o.reg, v);
      return;
    }
    else if (o.kind === "mem") this.store(o.mem.size as 1 | 2 | 4, addr ?? this.ea(o.mem), v);
    else this.trapHere(`write to ${o.kind}`);
  }

  private push(v: Expr): void {
    const val = this.tmp(v);
    this.set("esp", sub(loc("esp"), c32(4)));
    this.store(4, loc("esp"), val);
  }

  private pop(): Expr {
    const v = this.tmp(load(4, loc("esp")));
    this.set("esp", add(loc("esp"), c32(4)));
    return v;
  }

  // ------------------------------------------------------------------------------------------
  // Flags

  private flagExpr(kind: DefKind, bits: number, flag: number, a: Expr, b: Expr, r: Expr): Expr {
    const M = c32(MASK(bits));
    const S = c32(SIGN(bits));
    switch (flag) {
      case ZF:
        return eq(and(r, M), c32(0));
      case SF:
        return ne(and(r, S), c32(0));
      case PF:
        return call("parity8", "i32", r);
    }
    switch (kind) {
      case "add":
        if (flag === CF) return bin("ltu", and(r, M), and(a, M));
        if (flag === OF) return ne(and(and(xor(a, r), xor(b, r)), S), c32(0));
        return ne(and(xor(xor(a, b), r), c32(0x10)), c32(0));
      case "sub":
        if (flag === CF) return bin("ltu", and(a, M), and(b, M));
        if (flag === OF) return ne(and(and(xor(a, b), xor(a, r)), S), c32(0));
        return ne(and(xor(xor(a, b), r), c32(0x10)), c32(0));
      case "logic":
        return c32(0);
      case "inc":
        if (flag === OF) return eq(and(r, M), S);
        if (flag === AF) return eq(and(r, c32(0xf)), c32(0));
        break;
      case "dec":
        if (flag === OF) return eq(and(r, M), c32(SIGN(bits) - 1));
        if (flag === AF) return eq(and(r, c32(0xf)), c32(0xf));
        break;
      case "neg":
        if (flag === CF) return ne(and(a, M), c32(0));
        if (flag === OF) return eq(and(a, M), S);
        return ne(and(a, c32(0xf)), c32(0));
    }
    throw new Error(`no ${kind} formula for flag ${flag}`);
  }

  /**
   * Record flag definitions for the current instruction. `custom(flag)` supplies formulas for
   * instructions outside the snapshot kinds (or overrides, e.g. CF for adc/sbb).
   */
  private defFlags(a: Expr, b: Expr, r: Expr, custom?: (flag: number) => Expr | null): void {
    const i = this.insn;
    const { kind, size } = defKind(i);
    if (this.plan.snapshot.has(i.ip)) {
      if (kind === "other") throw new Error(`snapshot requested for non-snapshot def at ${hex(i.ip)}`);
      this.set("sa", a);
      this.set("sb", b);
      this.set("sr", r);
    }
    const want = this.plan.materialize.get(i.ip) ?? 0;
    if (!want) return;
    const vals: [string, Expr][] = [];
    for (const [fl, name] of FLAG_NAMES) {
      if (!(want & fl)) continue;
      let v = custom?.(fl) ?? (kind === "other" ? null : this.flagExpr(kind, size, fl, a, b, r));
      // Architecturally undefined flags (e.g. SF/ZF after imul) may hold any value.
      if (v === null && fromIced(i.rflagsUndefined) & fl) v = c32(0);
      if (v === null) throw new Error(`no flag formula for ${name} at ${hex(i.ip)}: ${i.text}`);
      vals.push([name, v]);
    }
    // Evaluate all flag values before assigning any (custom formulas may read old flags).
    const tmps = vals.map(([n, v]) => [n, this.tmp(v)] as const);
    for (const [n, v] of tmps) this.set(n, v);
  }

  /** Value (0/1) of one flag as read by the current instruction. */
  private getFlag(flag: number): Expr {
    const mode = this.plan.useMode.get(this.insn.ip);
    if (mode && mode.mode === "snapshot") return this.flagExpr(mode.kind, mode.size, flag, loc("sa"), loc("sb"), loc("sr"));
    const name = FLAG_NAMES.find(([f]) => f === flag)![1];
    return loc(name);
  }

  private cond(cc: ConditionCode): Expr {
    const mode = this.plan.useMode.get(this.insn.ip);
    if (mode && mode.mode === "snapshot" && (mode.kind === "sub" || mode.kind === "logic")) {
      const fast = this.fastCond(cc, mode.kind, mode.size);
      if (fast) return fast;
    }
    const F = (f: number) => this.getFlag(f);
    const lt = () => xor(F(SF), F(OF));
    switch (cc) {
      case ConditionCode.o: return F(OF);
      case ConditionCode.no: return eqz(F(OF));
      case ConditionCode.b: return F(CF);
      case ConditionCode.ae: return eqz(F(CF));
      case ConditionCode.e: return F(ZF);
      case ConditionCode.ne: return eqz(F(ZF));
      case ConditionCode.be: return or(F(CF), F(ZF));
      case ConditionCode.a: return eqz(or(F(CF), F(ZF)));
      case ConditionCode.s: return F(SF);
      case ConditionCode.ns: return eqz(F(SF));
      case ConditionCode.p: return F(PF);
      case ConditionCode.np: return eqz(F(PF));
      case ConditionCode.l: return lt();
      case ConditionCode.ge: return eqz(lt());
      case ConditionCode.le: return or(F(ZF), lt());
      case ConditionCode.g: return eqz(or(F(ZF), lt()));
      default: return this.trapHere(`condition ${cc}`);
    }
  }

  /** Direct comparisons for cmp/sub and test/and/or/xor snapshots. */
  private fastCond(cc: ConditionCode, kind: DefKind, bits: number): Expr | null {
    const sx = (e: Expr) => (bits === 32 ? e : bits === 16 ? un("ext16s", e, "i32") : un("ext8s", e, "i32"));
    const a = loc("sa");
    const b = loc("sb");
    const r = loc("sr");
    if (kind === "sub") {
      switch (cc) {
        case ConditionCode.e: return eq(r, c32(0));
        case ConditionCode.ne: return ne(r, c32(0));
        case ConditionCode.b: return bin("ltu", a, b);
        case ConditionCode.ae: return bin("geu", a, b);
        case ConditionCode.be: return bin("leu", a, b);
        case ConditionCode.a: return bin("gtu", a, b);
        case ConditionCode.l: return bin("lts", sx(a), sx(b));
        case ConditionCode.ge: return bin("ges", sx(a), sx(b));
        case ConditionCode.le: return bin("les", sx(a), sx(b));
        case ConditionCode.g: return bin("gts", sx(a), sx(b));
        case ConditionCode.s: return bin("lts", sx(r), c32(0));
        case ConditionCode.ns: return bin("ges", sx(r), c32(0));
        default: return null;
      }
    }
    switch (cc) {
      case ConditionCode.e:
      case ConditionCode.be: return eq(r, c32(0));
      case ConditionCode.ne:
      case ConditionCode.a: return ne(r, c32(0));
      case ConditionCode.s:
      case ConditionCode.l: return bin("lts", sx(r), c32(0));
      case ConditionCode.ns:
      case ConditionCode.ge: return bin("ges", sx(r), c32(0));
      case ConditionCode.le: return bin("les", sx(r), c32(0));
      case ConditionCode.g: return bin("gts", sx(r), c32(0));
      case ConditionCode.b:
      case ConditionCode.o: return c32(0);
      case ConditionCode.ae:
      case ConditionCode.no: return c32(1);
      default: return null;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Instruction lowering

  private isTerminatorInsn(b: Block, i: Insn): boolean {
    switch (b.term.kind) {
      case "jmp": case "jcc": case "switch": case "switch-addr": case "ret": case "tail-import": case "tail-indirect":
        return true;
      case "tail":
        return i.mnemonic === Mnemonic.Jmp;
      default:
        return false;
    }
  }

  private lower(i: Insn): void {
    const o = i.ops;
    switch (i.mnemonic) {
      case Mnemonic.Nop: case Mnemonic.Wait: case Mnemonic.Ffree: case Mnemonic.Fnclex: case Mnemonic.Emms: case Mnemonic.Femms:
        if (i.mnemonic === Mnemonic.Fnclex) this.emit({ k: "cpuset", field: "fsw", ty: "i32", v: and(cpu("fsw"), c32(0x7f00)) });
        return;
       case Mnemonic.Mov: {
         if (o[0].kind === "reg" && this.isSegmentReg(o[0].reg)) {
           const dstName = this.segLocal(o[0].reg);
           if (o[1].kind === "reg") {
             const srcExpr = this.isSegmentReg(o[1].reg)
               ? loc(this.segLocal(o[1].reg))
               : and(this.getReg(o[1].reg), c32(0xffff));
             this.set(dstName, srcExpr);
           } else if (o[1].kind === "mem") {
             const addr = this.ea(o[1].mem);
             this.set(dstName, load(2, addr));
           } else {
             this.trapHere("mov to segment register with unsupported source");
           }
           return;
         }
         if (o[1].kind === "reg" && this.isSegmentReg(o[1].reg)) {
           this.write(o[0], loc(this.segLocal(o[1].reg)));
           return;
         }
         this.write(o[0], this.read(o[1]));
         return;
       }
      case Mnemonic.Movzx:
        this.write(o[0], this.read(o[1]));
        return;
      case Mnemonic.Movsx: {
        const bits = this.opBits(o[1]);
        const v = this.read(o[1]);
        this.write(o[0], bits === 8 ? un("ext8s", v, "i32") : un("ext16s", v, "i32"));
        return;
      }
      case Mnemonic.Lea: {
        if (o[1].kind !== "mem") this.trapHere("lea without memory");
        this.write(o[0], this.ea(o[1].mem));
        return;
      }
      case Mnemonic.Xchg: {
        const addr = o[0].kind === "mem" ? this.tmp(this.ea(o[0].mem)) : o[1].kind === "mem" ? this.tmp(this.ea(o[1].mem)) : undefined;
        const a = this.tmp(this.read(o[0], addr));
        const b = this.tmp(this.read(o[1], addr));
        this.write(o[0], b, addr);
        this.write(o[1], a, addr);
        return;
      }
      case Mnemonic.Push: {
        if (this.opBits(o[0]) === 16 && o[0].kind !== "imm") this.trapHere("16-bit push");
        if (o[0].kind === "imm" && i.stackIncrement === -2) this.trapHere("16-bit push");
        this.push(this.read(o[0]));
        return;
      }
      case Mnemonic.Pop: {
        const v = this.pop();
        this.write(o[0], v); // effective address uses the incremented ESP, as on hardware
        return;
      }
      case Mnemonic.Pushad: {
        const t = this.tmp(loc("esp"));
        for (const r of ["eax", "ecx", "edx", "ebx"]) this.push(loc(r));
        this.push(t);
        for (const r of ["ebp", "esi", "edi"]) this.push(loc(r));
        return;
      }
      case Mnemonic.Popad: {
        for (const r of ["edi", "esi", "ebp"]) this.set(r, this.pop());
        this.set("esp", add(loc("esp"), c32(4)));
        for (const r of ["ebx", "edx", "ecx", "eax"]) this.set(r, this.pop());
        return;
      }
      case Mnemonic.Pushfd:
      case Mnemonic.Pushf:
        this.push(this.composeEflags());
        return;
      case Mnemonic.Popfd:
      case Mnemonic.Popf: {
        const v = this.pop();
        this.emit({ k: "cpuset", field: "eflags", ty: "i32", v: and(v, c32(~0x8d5)) });
        this.set("df", and(shru(v, c32(10)), c32(1)));
        const bit = (n: number) => and(shru(v, c32(n)), c32(1));
        this.defFlags(c32(0), c32(0), c32(0), (fl) => (fl === CF ? bit(0) : fl === PF ? bit(2) : fl === AF ? bit(4) : fl === ZF ? bit(6) : fl === SF ? bit(7) : bit(11)));
        return;
      }
      case Mnemonic.Lahf: {
        const F = (f: number) => this.getFlag(f);
        this.setReg(Register.AH, or(or(or(shl(F(SF), c32(7)), shl(F(ZF), c32(6))), or(shl(F(AF), c32(4)), shl(F(PF), c32(2)))), or(F(CF), c32(2))));
        return;
      }
      case Mnemonic.Sahf: {
        const ah = this.tmp(this.getReg(Register.AH));
        const bit = (n: number) => and(shru(ah, c32(n)), c32(1));
        this.defFlags(c32(0), c32(0), c32(0), (fl) => (fl === CF ? bit(0) : fl === PF ? bit(2) : fl === AF ? bit(4) : fl === ZF ? bit(6) : fl === SF ? bit(7) : null));
        return;
      }
      case Mnemonic.Cld: this.set("df", c32(0)); return;
      case Mnemonic.Std: this.set("df", c32(1)); return;
      case Mnemonic.Clc: this.defFlags(c32(0), c32(0), c32(0), () => c32(0)); return;
      case Mnemonic.Stc: this.defFlags(c32(0), c32(0), c32(0), () => c32(1)); return;
      case Mnemonic.Cmc: {
        const cf = this.tmp(this.getFlag(CF));
        this.defFlags(c32(0), c32(0), c32(0), () => eqz(cf));
        return;
      }
      case Mnemonic.Cdq:
        this.set("edx", shrs(loc("eax"), c32(31)));
        return;
      case Mnemonic.Cwde:
        this.set("eax", un("ext16s", loc("eax"), "i32"));
        return;
      case Mnemonic.Cbw:
        this.setReg(Register.AX, un("ext8s", loc("eax"), "i32"));
        return;
      case Mnemonic.Cwd:
        this.setReg(Register.DX, shrs(un("ext16s", loc("eax"), "i32"), c32(31)));
        return;
      case Mnemonic.Bswap:
        this.write(o[0], un("bswap", this.read(o[0]), "i32"));
        return;
      case Mnemonic.Leave:
        this.set("esp", loc("ebp"));
        this.set("ebp", this.pop());
        return;
      case Mnemonic.Enter: {
        const level = o[1]?.kind === "imm" ? o[1].value : 0;
        if (level !== 0) this.trapHere("enter with nesting level");
        this.push(loc("ebp"));
        this.set("ebp", loc("esp"));
        this.set("esp", sub(loc("esp"), c32(o[0].kind === "imm" ? o[0].value : 0)));
        return;
      }
      case Mnemonic.Xlatb:
        this.setReg(Register.AL, load(1, add(loc("ebx"), and(loc("eax"), c32(0xff)))));
        return;

      case Mnemonic.Add: case Mnemonic.Sub: case Mnemonic.And: case Mnemonic.Or: case Mnemonic.Xor:
      case Mnemonic.Cmp: case Mnemonic.Test: case Mnemonic.Adc: case Mnemonic.Sbb:
        return this.arith(i);
      case Mnemonic.Inc: case Mnemonic.Dec: case Mnemonic.Neg: case Mnemonic.Not:
        return this.unary(i);
      case Mnemonic.Imul: case Mnemonic.Mul:
        return this.mul(i);
      case Mnemonic.Div: case Mnemonic.Idiv:
        return this.div(i);
      case Mnemonic.Shl: case Mnemonic.Sal: case Mnemonic.Shr: case Mnemonic.Sar:
      case Mnemonic.Rol: case Mnemonic.Ror: case Mnemonic.Rcl: case Mnemonic.Rcr:
        return this.shift(i);
      case Mnemonic.Shld: case Mnemonic.Shrd:
        return this.shiftDouble(i);
      case Mnemonic.Bt: case Mnemonic.Bts: case Mnemonic.Btr: case Mnemonic.Btc:
        return this.bitTest(i);
      case Mnemonic.Bsf: case Mnemonic.Bsr: {
        const src = this.tmp(this.read(o[1]));
        const isZero = this.tmp(eqz(src));
        const v = i.mnemonic === Mnemonic.Bsf ? un("ctz", src, "i32") : sub(c32(31), un("clz", src, "i32"));
        this.write(o[0], sel(isZero, this.read(o[0]), v));
        this.defFlags(src, c32(0), c32(0), (fl) => (fl === ZF ? isZero : c32(0)));
        return;
      }
      case Mnemonic.Xadd: {
        const addr = o[0].kind === "mem" ? this.tmp(this.ea(o[0].mem)) : undefined;
        const bits = this.opBits(o[0]);
        const a = this.tmp(this.read(o[0], addr));
        const b = this.tmp(this.read(o[1]));
        const r = this.tmp(and(add(a, b), c32(MASK(bits))));
        this.write(o[1], a);
        this.write(o[0], r, addr);
        this.defFlags(a, b, r);
        return;
      }
      case Mnemonic.Cmpxchg: {
        const addr = o[0].kind === "mem" ? this.tmp(this.ea(o[0].mem)) : undefined;
        const bits = this.opBits(o[0]);
        const acc = bits === 32 ? Register.EAX : bits === 16 ? Register.AX : Register.AL;
        const a = this.tmp(this.getReg(acc));
        const d = this.tmp(this.read(o[0], addr));
        const s = this.tmp(this.read(o[1]));
        const equal = this.tmp(eq(a, d));
        this.write(o[0], sel(equal, s, d), addr);
        this.setReg(acc, sel(equal, a, d));
        this.defFlags(a, d, this.tmp(and(sub(a, d), c32(MASK(bits)))));
        return;
      }
      case Mnemonic.Sete: case Mnemonic.Setne: case Mnemonic.Setl: case Mnemonic.Setle: case Mnemonic.Setg: case Mnemonic.Setge:
      case Mnemonic.Setb: case Mnemonic.Setbe: case Mnemonic.Seta: case Mnemonic.Setae: case Mnemonic.Sets: case Mnemonic.Setns:
      case Mnemonic.Seto: case Mnemonic.Setno: case Mnemonic.Setp: case Mnemonic.Setnp:
        this.write(o[0], this.cond(i.cc));
        return;
      case Mnemonic.Cmove: case Mnemonic.Cmovne: case Mnemonic.Cmovl: case Mnemonic.Cmovle: case Mnemonic.Cmovg: case Mnemonic.Cmovge:
      case Mnemonic.Cmovb: case Mnemonic.Cmovbe: case Mnemonic.Cmova: case Mnemonic.Cmovae: case Mnemonic.Cmovs: case Mnemonic.Cmovns:
      case Mnemonic.Cmovo: case Mnemonic.Cmovno: case Mnemonic.Cmovp: case Mnemonic.Cmovnp: {
        const src = this.tmp(this.read(o[1]));
        this.write(o[0], sel(this.cond(i.cc), src, this.read(o[0])));
        return;
      }

      case Mnemonic.Movsb: case Mnemonic.Movsw: case Mnemonic.Stosb: case Mnemonic.Stosw: case Mnemonic.Stosd:
      case Mnemonic.Lodsb: case Mnemonic.Lodsw: case Mnemonic.Lodsd: case Mnemonic.Cmpsb: case Mnemonic.Cmpsw:
      case Mnemonic.Scasb: case Mnemonic.Scasw: case Mnemonic.Scasd:
        return this.stringOp(i);
      case Mnemonic.Movsd:
        if (o[0]?.kind === "string") return this.stringOp(i);
        return this.simdMove(i);
      case Mnemonic.Cmpsd:
        if (o[0]?.kind === "string") return this.stringOp(i);
        return this.simdScalarCompare(i);

      case Mnemonic.Ud2:
        this.emit({ k: "trap", msg: `ud2 at 0x${hex(i.ip)}` });
        return;
      case Mnemonic.Emms:
        // EMMS: empty the MMX state (x87 tag word); our MMX registers are plain 64-bit locals,
        // so there is nothing to tear down.
        return;
      case Mnemonic.Femms:
        return;
      case Mnemonic.Les: case Mnemonic.Lds: case Mnemonic.Lfs: case Mnemonic.Lgs: case Mnemonic.Lss: {
        if (o[0].kind !== "reg" || o[1].kind !== "mem") this.trapHere("load far pointer form");
        const seg =
          i.mnemonic === Mnemonic.Les ? "es"
          : i.mnemonic === Mnemonic.Lds ? "ds"
          : i.mnemonic === Mnemonic.Lfs ? "fs"
          : i.mnemonic === Mnemonic.Lgs ? "gs"
          : "ss";
        const addr = this.ea(o[1].mem);
        this.write(o[0], load(4, addr));
        this.set(seg, load(2, add(addr, c32(4))));
        return;
      }
      case Mnemonic.Stmxcsr: {
        if (o[0].kind !== "mem") this.trapHere("stmxcsr form");
        this.store(4, this.ea(o[0].mem), cpu("mxcsr"));
        return;
      }
      case Mnemonic.Ldmxcsr: {
        if (o[0].kind !== "mem") this.trapHere("ldmxcsr form");
        this.emit({ k: "cpuset", field: "mxcsr", ty: "i32", v: load(4, this.ea(o[0].mem)) });
        return;
      }

      case Mnemonic.Movss: case Mnemonic.Addss: case Mnemonic.Subss: case Mnemonic.Mulss:
      case Mnemonic.Divss: case Mnemonic.Minss: case Mnemonic.Maxss: case Mnemonic.Sqrtss:
      case Mnemonic.Rcpss: case Mnemonic.Rsqrtss:
        return this.simdScalar(i);
      case Mnemonic.Addsd: case Mnemonic.Subsd: case Mnemonic.Mulsd: case Mnemonic.Divsd:
      case Mnemonic.Minsd: case Mnemonic.Maxsd: case Mnemonic.Sqrtsd:
        return this.simdScalarD(i);
      case Mnemonic.Comiss: case Mnemonic.Ucomiss:
        return this.simdCompare(i);
      case Mnemonic.Comisd: case Mnemonic.Ucomisd:
        return this.simdCompareD(i);
      case Mnemonic.Cmpss:
        return this.simdScalarCompare(i);
      case Mnemonic.Cmpps: case Mnemonic.Cmppd:
        return this.simdPackedCompare(i);
      case Mnemonic.Cvtsi2ss: case Mnemonic.Cvttss2si: case Mnemonic.Cvtss2si: case Mnemonic.Cvtss2sd: case Mnemonic.Cvtsd2ss:
      case Mnemonic.Cvtsd2si: case Mnemonic.Cvttsd2si: case Mnemonic.Cvtsi2sd:
      case Mnemonic.Cvtdq2pd: case Mnemonic.Cvtdq2ps: case Mnemonic.Cvtps2dq: case Mnemonic.Cvttps2dq:
      case Mnemonic.Cvtpd2dq: case Mnemonic.Cvttpd2dq:
      case Mnemonic.Cvtps2pi: case Mnemonic.Cvttps2pi: case Mnemonic.Cvtpi2ps:
        return this.simdConvert(i);
      case Mnemonic.Movaps: case Mnemonic.Movups: case Mnemonic.Movapd: case Mnemonic.Movupd:
      case Mnemonic.Movhlps: case Mnemonic.Movlhps: case Mnemonic.Movhps: case Mnemonic.Movlps: case Mnemonic.Shufps:
      case Mnemonic.Xorps: case Mnemonic.Andps: case Mnemonic.Andnps: case Mnemonic.Orps:
      case Mnemonic.Xorpd: case Mnemonic.Andpd: case Mnemonic.Andnpd: case Mnemonic.Orpd:
        return this.simdPacked(i);
      case Mnemonic.Movq: case Mnemonic.Movd: case Mnemonic.Movlpd: case Mnemonic.Movhpd:
        return this.simdMove(i);
      case Mnemonic.Addps: case Mnemonic.Subps: case Mnemonic.Mulps: case Mnemonic.Divps:
      case Mnemonic.Minps: case Mnemonic.Maxps: case Mnemonic.Sqrtps: case Mnemonic.Rcpps: case Mnemonic.Rsqrtps:
      case Mnemonic.Addpd: case Mnemonic.Subpd: case Mnemonic.Mulpd: case Mnemonic.Divpd:
      case Mnemonic.Minpd: case Mnemonic.Maxpd: case Mnemonic.Sqrtpd:
        return this.simdPackedFloat(i);
      case Mnemonic.Unpcklps: case Mnemonic.Unpckhps: case Mnemonic.Unpcklpd: case Mnemonic.Unpckhpd:
        return this.simdUnpck(i);
      case Mnemonic.Shufpd:
        return this.simdShufpd(i);
      case Mnemonic.Pand: case Mnemonic.Pandn: case Mnemonic.Por: case Mnemonic.Pxor:
      case Mnemonic.Paddb: case Mnemonic.Paddw: case Mnemonic.Paddd: case Mnemonic.Paddq:
      case Mnemonic.Paddusb: case Mnemonic.Paddusw: case Mnemonic.Psubb: case Mnemonic.Psubw:
      case Mnemonic.Psubd: case Mnemonic.Psubq: case Mnemonic.Psubusb: case Mnemonic.Psubusw:
      case Mnemonic.Pmulhw: case Mnemonic.Pmullw: case Mnemonic.Pmaddwd:
      case Mnemonic.Pcmpeqb: case Mnemonic.Pcmpeqw: case Mnemonic.Pcmpeqd:
      case Mnemonic.Pcmpgtb: case Mnemonic.Pcmpgtw: case Mnemonic.Pcmpgtd:
      case Mnemonic.Pmaxsw: case Mnemonic.Pminsw: case Mnemonic.Pmaxub: case Mnemonic.Pminub:
      case Mnemonic.Packsswb: case Mnemonic.Packssdw: case Mnemonic.Packuswb:
      case Mnemonic.Punpcklbw: case Mnemonic.Punpckhbw: case Mnemonic.Punpcklwd: case Mnemonic.Punpckhwd:
      case Mnemonic.Punpckldq: case Mnemonic.Punpckhdq:
      case Mnemonic.Psllw: case Mnemonic.Pslld: case Mnemonic.Psllq:
      case Mnemonic.Psrlw: case Mnemonic.Psrld: case Mnemonic.Psrlq:
      case Mnemonic.Psraw: case Mnemonic.Psrad:
      case Mnemonic.Pshufd: case Mnemonic.Pextrw: case Mnemonic.Pinsrw: case Mnemonic.Pmovmskb:
        return this.packedInt(i);

      case Mnemonic.Call:
        return this.lowerCall(i);
      case Mnemonic.Loop: case Mnemonic.Loope: case Mnemonic.Loopne:
        this.set("ecx", sub(loc("ecx"), c32(1)));
        return;
      case Mnemonic.Jecxz:
        return;
      case Mnemonic.Cpuid:
        this.emit({ k: "syncout" });
        this.emit({ k: "helper", fn: "rt_cpuid", args: [] });
        this.emit({ k: "syncin" });
        return;
      case Mnemonic.Rdtsc:
        this.emit({ k: "syncout" });
        this.emit({ k: "helper", fn: "rt_rdtsc", args: [] });
        this.emit({ k: "syncin" });
        return;
      case Mnemonic.Int3:
        this.emit({ k: "trap", msg: `int3 at 0x${hex(i.ip)}` });
        return;
    }
    if (hasSimdReg(i)) return this.simd(i);
    if (isX87(i.mnemonic)) return this.x87(i);
    this.trapHere(`no semantics for ${Mnemonic[i.mnemonic]}`);
  }

  private composeEflags(): Expr {
    const F = (f: number) => this.getFlag(f);
    let v: Expr = or(and(cpu("eflags"), c32(~0x8d5)), c32(2));
    v = or(v, F(CF));
    v = or(v, shl(F(PF), c32(2)));
    v = or(v, shl(F(AF), c32(4)));
    v = or(v, shl(F(ZF), c32(6)));
    v = or(v, shl(F(SF), c32(7)));
    v = or(v, shl(loc("df"), c32(10)));
    v = or(v, shl(F(OF), c32(11)));
    return v;
  }

  private arith(i: Insn): void {
    const o = i.ops;
    const bits = this.opBits(o[0]);
    const M = c32(MASK(bits));
    const addr = o[0].kind === "mem" ? this.tmp(this.ea(o[0].mem)) : undefined;
    const a = this.tmp(this.read(o[0], addr));
    const b = this.tmp(and(this.read(o[1]), M));
    let r: Expr;
    let custom: ((f: number) => Expr | null) | undefined;
    switch (i.mnemonic) {
      case Mnemonic.Add:
        r = this.tmp(and(add(a, b), M));
        break;
      case Mnemonic.Sub:
      case Mnemonic.Cmp:
        r = this.tmp(and(sub(a, b), M));
        break;
      case Mnemonic.And:
      case Mnemonic.Test:
        r = this.tmp(and(a, b));
        break;
      case Mnemonic.Or:
        r = this.tmp(or(a, b));
        break;
      case Mnemonic.Xor:
        r = this.tmp(xor(a, b));
        break;
      case Mnemonic.Adc: {
        const cin = this.tmp(this.getFlag(CF));
        r = this.tmp(and(add(add(a, b), cin), M));
        const rr = r;
        custom = (fl) => {
          if (fl === CF) return sel(cin, bin("leu", rr, a), bin("ltu", rr, a));
          if (fl === OF) return ne(and(and(xor(a, rr), xor(b, rr)), c32(SIGN(bits))), c32(0));
          if (fl === AF) return ne(and(xor(xor(a, b), rr), c32(0x10)), c32(0));
          return null;
        };
        break;
      }
      case Mnemonic.Sbb: {
        const cin = this.tmp(this.getFlag(CF));
        r = this.tmp(and(sub(sub(a, b), cin), M));
        const rr = r;
        custom = (fl) => {
          if (fl === CF) return sel(cin, bin("leu", a, b), bin("ltu", a, b));
          if (fl === OF) return ne(and(and(xor(a, b), xor(a, rr)), c32(SIGN(bits))), c32(0));
          if (fl === AF) return ne(and(xor(xor(a, b), rr), c32(0x10)), c32(0));
          return null;
        };
        break;
      }
      default:
        throw new Error("unreachable");
    }
    if (i.mnemonic !== Mnemonic.Cmp && i.mnemonic !== Mnemonic.Test) this.write(o[0], r, addr);
    if (custom) {
      const c = custom;
      const generic = (fl: number) => c(fl) ?? (fl === ZF ? eq(r, c32(0)) : fl === SF ? ne(and(r, c32(SIGN(bits))), c32(0)) : call("parity8", "i32", r));
      this.defFlags(a, b, r, generic);
    } else this.defFlags(a, b, r);
  }

  private unary(i: Insn): void {
    const o = i.ops[0];
    const bits = this.opBits(o);
    const M = c32(MASK(bits));
    const addr = o.kind === "mem" ? this.tmp(this.ea(o.mem)) : undefined;
    const a = this.tmp(this.read(o, addr));
    switch (i.mnemonic) {
      case Mnemonic.Not:
        this.write(o, and(xor(a, c32(-1)), M), addr);
        return;
      case Mnemonic.Inc: {
        const r = this.tmp(and(add(a, c32(1)), M));
        this.write(o, r, addr);
        this.defFlags(a, c32(1), r);
        return;
      }
      case Mnemonic.Dec: {
        const r = this.tmp(and(sub(a, c32(1)), M));
        this.write(o, r, addr);
        this.defFlags(a, c32(1), r);
        return;
      }
      case Mnemonic.Neg: {
        const r = this.tmp(and(sub(c32(0), a), M));
        this.write(o, r, addr);
        this.defFlags(a, c32(0), r);
        return;
      }
    }
  }

  private mul(i: Insn): void {
    const o = i.ops;
    if (o.length === 1) {
      const bits = this.opBits(o[0]);
      const signed = i.mnemonic === Mnemonic.Imul;
      const src = this.tmp(this.read(o[0]));
      if (bits === 32) {
        const ext = (e: Expr) => un(signed ? "exts" : "extu", e, "i64");
        const t = this.tmp(bin("mul", ext(loc("eax")), ext(src)));
        const lo = this.tmp(un("wrap", t, "i32"));
        const hi = this.tmp(un("wrap", bin("shru", t, c64(32n)), "i32"));
        this.set("eax", lo);
        this.set("edx", hi);
        const ovf = this.tmp(signed ? ne(hi, shrs(lo, c32(31))) : ne(hi, c32(0)));
        this.defFlags(lo, c32(0), lo, (fl) => (fl === CF || fl === OF ? ovf : null));
      } else if (bits === 16) {
        const sx = (e: Expr) => (signed ? un("ext16s", e, "i32") : and(e, c32(0xffff)));
        const t = this.tmp(bin("mul", sx(loc("eax")), sx(src)));
        this.setReg(Register.AX, t);
        this.setReg(Register.DX, shru(t, c32(16)));
        const ovf = this.tmp(signed ? ne(t, un("ext16s", t, "i32")) : ne(shru(t, c32(16)), c32(0)));
        this.defFlags(t, c32(0), t, (fl) => (fl === CF || fl === OF ? ovf : null));
      } else {
        const sx = (e: Expr) => (signed ? un("ext8s", e, "i32") : and(e, c32(0xff)));
        const t = this.tmp(bin("mul", sx(loc("eax")), sx(src)));
        this.setReg(Register.AX, t);
        const ovf = this.tmp(signed ? ne(t, un("ext8s", t, "i32")) : ne(shru(t, c32(8)), c32(0)));
        this.defFlags(t, c32(0), t, (fl) => (fl === CF || fl === OF ? ovf : null));
      }
      return;
    }
    // Two- and three-operand imul: dst = a * b (truncated); CF = OF = signed overflow.
    const bits = this.opBits(o[0]);
    const a = this.tmp(this.read(o.length === 3 ? o[1] : o[0]));
    const b = this.tmp(this.read(o.length === 3 ? o[2] : o[1]));
    if (bits === 32) {
      const r = this.tmp(bin("mul", a, b));
      this.write(o[0], r);
      const want = this.plan.materialize.get(i.ip) ?? 0;
      if (want & (CF | OF)) {
        const wide = this.tmp(bin("mul", un("exts", a, "i64"), un("exts", b, "i64")));
        const ovf = this.tmp(bin("ne", wide, un("exts", r, "i64")));
        this.defFlags(r, c32(0), r, (fl) => (fl === CF || fl === OF ? ovf : null));
      } else this.defFlags(r, c32(0), r, () => c32(0));
    } else {
      const t = this.tmp(bin("mul", un("ext16s", a, "i32"), un("ext16s", b, "i32")));
      this.write(o[0], t);
      const ovf = this.tmp(ne(t, un("ext16s", t, "i32")));
      this.defFlags(t, c32(0), t, (fl) => (fl === CF || fl === OF ? ovf : null));
    }
  }

  private div(i: Insn): void {
    const bits = this.opBits(i.ops[0]);
    const signed = i.mnemonic === Mnemonic.Idiv;
    const d = this.tmp(this.read(i.ops[0]));
    this.emit({ k: "check", c: ne(d, c32(0)), msg: `divide by zero at 0x${hex(i.ip)}` });
    if (bits === 32) {
      const dividend = this.tmp(bin("or", bin("shl", un("extu", loc("edx"), "i64"), c64(32n)), un("extu", loc("eax"), "i64")));
      const div64 = signed ? un("exts", d, "i64") : un("extu", d, "i64");
      const q = this.tmp(bin(signed ? "divs" : "divu", dividend, div64));
      const r = this.tmp(bin(signed ? "rems" : "remu", dividend, div64));
      const fits = signed ? bin("eq", q, un("exts", un("wrap", q, "i32"), "i64")) : bin("eq", bin("shru", q, c64(32n)), c64(0n));
      this.emit({ k: "check", c: fits, msg: `divide overflow at 0x${hex(i.ip)}` });
      this.set("eax", un("wrap", q, "i32"));
      this.set("edx", un("wrap", r, "i32"));
    } else if (bits === 16) {
      const dividend = this.tmp(or(shl(and(loc("edx"), c32(0xffff)), c32(16)), and(loc("eax"), c32(0xffff))));
      const q = this.tmp(bin(signed ? "divs" : "divu", dividend, signed ? un("ext16s", d, "i32") : d));
      const r = this.tmp(bin(signed ? "rems" : "remu", dividend, signed ? un("ext16s", d, "i32") : d));
      this.setReg(Register.AX, q);
      this.setReg(Register.DX, r);
    } else {
      const dividend = this.tmp(and(loc("eax"), c32(0xffff)));
      const sdiv = signed ? un("ext16s", dividend, "i32") : dividend;
      const q = this.tmp(bin(signed ? "divs" : "divu", sdiv, signed ? un("ext8s", d, "i32") : d));
      const r = this.tmp(bin(signed ? "rems" : "remu", sdiv, signed ? un("ext8s", d, "i32") : d));
      this.setReg(Register.AL, q);
      this.setReg(Register.AH, r);
    }
    this.defFlags(c32(0), c32(0), c32(0), () => c32(0));
  }

  private shift(i: Insn): void {
    const o = i.ops;
    const bits = this.opBits(o[0]);
    const M = c32(MASK(bits));
    const addr = o[0].kind === "mem" ? this.tmp(this.ea(o[0].mem)) : undefined;
    const a = this.tmp(this.read(o[0], addr));
    const dynamic = o[1].kind === "reg";
    const count = this.tmp(and(o[1].kind === "imm" ? c32(o[1].value) : this.read(o[1]), c32(0x1f)));
    if (!dynamic && (o[1].kind === "imm" ? o[1].value & 0x1f : 0) === 0) return; // no-op, flags untouched
    const m = i.mnemonic;
    let r: Expr;
    let cfx: Expr;
    let ofx: Expr;
    const msb = (e: Expr) => and(shru(e, c32(bits - 1)), c32(1));
    if (m === Mnemonic.Shl || m === Mnemonic.Sal) {
      r = this.tmp(and(shl(a, count), M));
      cfx = bits === 32 ? and(shru(a, sub(c32(32), count)), c32(1)) : and(shru(shl(a, count), c32(bits)), c32(1));
      ofx = xor(msb(r), bits === 32 ? and(shru(a, sub(c32(32), count)), c32(1)) : and(shru(shl(a, count), c32(bits)), c32(1)));
    } else if (m === Mnemonic.Shr) {
      r = this.tmp(shru(a, count));
      cfx = and(shru(a, sub(count, c32(1))), c32(1));
      ofx = msb(a);
    } else if (m === Mnemonic.Sar) {
      const sa = bits === 32 ? a : bits === 16 ? un("ext16s", a, "i32") : un("ext8s", a, "i32");
      r = this.tmp(and(shrs(sa, count), M));
      cfx = and(shrs(sa, sub(count, c32(1))), c32(1));
      ofx = c32(0);
    } else if (m === Mnemonic.Rol || m === Mnemonic.Ror) {
      const left = m === Mnemonic.Rol;
      if (bits === 32) r = this.tmp(bin(left ? "rotl" : "rotr", a, count));
      else {
        const c = this.tmp(bin("remu", count, c32(bits)));
        const rotated = left ? or(shl(a, c), shru(a, sub(c32(bits), c))) : or(shru(a, c), shl(a, sub(c32(bits), c)));
        r = this.tmp(and(rotated, M));
      }
      cfx = left ? and(r, c32(1)) : msb(r);
      ofx = left ? xor(msb(r), and(r, c32(1))) : xor(msb(r), and(shru(r, c32(bits - 2)), c32(1)));
    } else {
      // rcl / rcr through the carry flag: runtime helper returns (result | cf << 32).
      const cin = this.tmp(this.getFlag(CF));
      const t = this.tmp(call(m === Mnemonic.Rcl ? "rt_rcl" : "rt_rcr", "i64", a, count, cin, c32(bits)));
      r = this.tmp(un("wrap", t, "i32"));
      cfx = un("wrap", bin("shru", t, c64(32n)), "i32");
      ofx = m === Mnemonic.Rcl ? xor(msb(r), cfx) : xor(msb(r), and(shru(r, c32(bits - 2)), c32(1)));
    }
    this.write(o[0], dynamic ? sel(eqz(count), a, r) : r, addr);
    const isRotate = m === Mnemonic.Rol || m === Mnemonic.Ror || m === Mnemonic.Rcl || m === Mnemonic.Rcr;
    const keep = (fl: number, v: Expr) => (dynamic ? sel(eqz(count), this.getFlag(fl), v) : v);
    this.defFlags(a, count, r, (fl) => {
      if (fl === CF) return keep(CF, cfx);
      if (fl === OF) return keep(OF, ofx);
      if (isRotate) return null;
      if (fl === ZF) return keep(ZF, eq(r, c32(0)));
      if (fl === SF) return keep(SF, msb(r));
      if (fl === PF) return keep(PF, call("parity8", "i32", r));
      return keep(AF, c32(0));
    });
  }

  private shiftDouble(i: Insn): void {
    const o = i.ops;
    if (this.opBits(o[0]) !== 32) this.trapHere("16-bit shld/shrd");
    const addr = o[0].kind === "mem" ? this.tmp(this.ea(o[0].mem)) : undefined;
    const a = this.tmp(this.read(o[0], addr));
    const b = this.tmp(this.read(o[1]));
    const count = this.tmp(and(o[2].kind === "imm" ? c32(o[2].value) : this.read(o[2]), c32(0x1f)));
    const left = i.mnemonic === Mnemonic.Shld;
    const r = this.tmp(
      sel(eqz(count), a, left ? or(shl(a, count), shru(b, sub(c32(32), count))) : or(shru(a, count), shl(b, sub(c32(32), count)))),
    );
    this.write(o[0], r, addr);
    const cfx = left ? and(shru(a, sub(c32(32), count)), c32(1)) : and(shru(a, sub(count, c32(1))), c32(1));
    const keep = (fl: number, v: Expr) => sel(eqz(count), this.getFlag(fl), v);
    this.defFlags(a, b, r, (fl) =>
      fl === CF ? keep(CF, cfx) : fl === ZF ? keep(ZF, eqz(r)) : fl === SF ? keep(SF, shru(r, c32(31))) : fl === PF ? keep(PF, call("parity8", "i32", r)) : fl === OF ? keep(OF, xor(shru(r, c32(31)), shru(a, c32(31)))) : keep(AF, c32(0)),
    );
  }

  private bitTest(i: Insn): void {
    const o = i.ops;
    let addr: Expr | undefined;
    let bit: Expr;
    let width = 32;
    if (o[0].kind === "mem" && o[1].kind === "reg") {
      // Register bit offsets address memory relative to the operand (signed, unbounded).
      const off = this.tmp(this.read(o[1]));
      addr = this.tmp(add(this.ea(o[0].mem), shrs(off, c32(3))));
      bit = this.tmp(and(off, c32(7)));
      width = 8;
    } else {
      if (o[0].kind === "mem") addr = this.tmp(this.ea(o[0].mem));
      width = this.opBits(o[0]);
      bit = this.tmp(and(this.read(o[1]), c32(width - 1)));
    }
    const dst: Operand = width === 8 && o[0].kind === "mem" ? { kind: "mem", mem: { ...o[0].mem, size: 1 } } : o[0];
    const v = this.tmp(this.read(dst, addr));
    const cf = this.tmp(and(shru(v, bit), c32(1)));
    const mask = shl(c32(1), bit);
    if (i.mnemonic === Mnemonic.Bts) this.write(dst, or(v, mask), addr);
    else if (i.mnemonic === Mnemonic.Btr) this.write(dst, and(v, xor(mask, c32(-1))), addr);
    else if (i.mnemonic === Mnemonic.Btc) this.write(dst, xor(v, mask), addr);
    this.defFlags(v, bit, cf, (fl) => (fl === CF ? cf : c32(0)));
  }

  private stringOp(i: Insn): void {
    const m = i.mnemonic;
    const size =
      m === Mnemonic.Movsb || m === Mnemonic.Stosb || m === Mnemonic.Lodsb || m === Mnemonic.Cmpsb || m === Mnemonic.Scasb ? 1
      : m === Mnemonic.Movsw || m === Mnemonic.Stosw || m === Mnemonic.Lodsw || m === Mnemonic.Cmpsw || m === Mnemonic.Scasw ? 2 : 4;
    const step = this.tmp(sel(loc("df"), c32(-size), c32(size)));
    const isMovs = m === Mnemonic.Movsb || m === Mnemonic.Movsw || m === Mnemonic.Movsd;
    const isStos = m === Mnemonic.Stosb || m === Mnemonic.Stosw || m === Mnemonic.Stosd;
    const isLods = m === Mnemonic.Lodsb || m === Mnemonic.Lodsw || m === Mnemonic.Lodsd;
    const acc = size === 4 ? Register.EAX : size === 2 ? Register.AX : Register.AL;
    const repeated = i.rep || i.repne;
    if (repeated && (isMovs || isStos)) {
      // Bulk copy/fill in the runtime (byte-exact x86 semantics, including overlap).
      this.emit({ k: "syncout" });
      this.emit({ k: "helper", fn: isMovs ? "rt_rep_movs" : "rt_rep_stos", args: [c32(size), loc("df")] });
      this.emit({ k: "syncin" });
      return;
    }
    const once = () => {
      if (isMovs) {
        this.store(size as 1 | 2 | 4, loc("edi"), load(size as 1 | 2 | 4, loc("esi")));
        this.set("esi", add(loc("esi"), step));
        this.set("edi", add(loc("edi"), step));
      } else if (isStos) {
        this.store(size as 1 | 2 | 4, loc("edi"), this.getReg(acc));
        this.set("edi", add(loc("edi"), step));
      } else if (isLods) {
        this.setReg(acc, load(size as 1 | 2 | 4, loc("esi")));
        this.set("esi", add(loc("esi"), step));
      } else {
        // cmps: [esi] - [edi]; scas: acc - [edi]
        const isCmps = m === Mnemonic.Cmpsb || m === Mnemonic.Cmpsw || m === Mnemonic.Cmpsd;
        const a = this.tmp(isCmps ? load(size as 1 | 2 | 4, loc("esi")) : this.getReg(acc));
        const b = this.tmp(load(size as 1 | 2 | 4, loc("edi")));
        if (isCmps) this.set("esi", add(loc("esi"), step));
        this.set("edi", add(loc("edi"), step));
        const r = this.tmp(and(sub(a, b), c32(MASK(size * 8))));
        if (repeated) this.defFlags(a, b, r, (fl) => this.flagExpr("sub", size * 8, fl, a, b, r));
        else this.defFlags(a, b, r);
        return eq(a, b);
      }
      return null;
    };
    if (!repeated) {
      once();
      return;
    }
    if (isLods) this.trapHere("rep lods");
    // repe/repne cmps/scas: loop in IR.
    const head = this.synthBlock();
    const body = this.synthBlock();
    const exit = this.synthBlock();
    this.cur.term = { k: "br", to: head.id };
    this.cur = head;
    head.term = { k: "cbr", c: eqz(loc("ecx")), t: exit.id, f: body.id };
    this.cur = body;
    const equal = once()!;
    this.set("ecx", sub(loc("ecx"), c32(1)));
    const again = i.repne ? eqz(equal) : equal;
    body.term = { k: "cbr", c: and(again, ne(loc("ecx"), c32(0))), t: head.id, f: exit.id };
    this.cur = exit;
  }

  private lowerCall(i: Insn): void {
    const o = i.ops[0];
    if (o.kind === "branch") {
      if (i.target === i.next) {
        this.push(c32(i.next)); // call $+5: get EIP
        return;
      }
      this.push(c32(i.next));
      this.emit({ k: "syncout" });
      if (this.prog.funcs.has(i.target)) this.emit({ k: "callguest", target: i.target });
      else this.emit({ k: "callind", target: c32(i.target) });
      this.emit({ k: "syncin" });
      return;
    }
    const slot = this.prog.iatSlotOf(i);
    if (slot !== null) {
      this.push(c32(i.next));
      this.emit({ k: "syncout" });
      const imp = this.prog.pe.importBySlot.get(slot)!;
      this.emit({ k: "callhle", slot: this.importIndex(slot), name: `${imp.dll}!${imp.name}` });
      this.emit({ k: "syncin" });
      return;
    }
    // Indirect: evaluate the target before pushing (call [esp+X] reads the pre-push ESP).
    const target = this.tmp(this.read(o));
    this.push(c32(i.next));
    this.emit({ k: "syncout" });
    this.emit({ k: "callind", target });
    this.emit({ k: "syncin" });
  }

  // ------------------------------------------------------------------------------------------
  // x87

  private st(n: number): Expr {
    return cpu("fpr", "f64", and(add(loc("ftop"), c32(n)), c32(7)));
  }

  private setSt(n: number, v: Expr): void {
    this.emit({ k: "cpuset", field: "fpr", index: and(add(loc("ftop"), c32(n)), c32(7)), ty: "f64", v });
  }

  private fpush(v: Expr): void {
    const t = this.tmp(v);
    this.set("ftop", and(sub(loc("ftop"), c32(1)), c32(7)));
    this.setSt(0, t);
  }

  private fpop(): void {
    this.set("ftop", and(add(loc("ftop"), c32(1)), c32(7)));
  }

  private stIndex(o: Operand): number {
    if (o.kind !== "reg" || o.reg < Register.ST0 || o.reg > Register.ST7) this.trapHere("expected st(i)");
    return o.reg - Register.ST0;
  }

  /**
   * Round the significand to 24 bits when the x87 precision control is single (as D3D9 sets it).
   * The exponent keeps its extended range, so this is not a float cast.
   */
  private prec(v: Expr): Expr {
    const t = this.tmp(v);
    return sel(loc("pc24"), call("rt_round24", "f64", t), t);
  }

  private fmem(m: MemOperand): Expr {
    switch (m.type) {
      case MemorySize.Float32: return un("f32to64", load(4, this.ea(m), false, "f32"), "f64");
      case MemorySize.Float64: return load(8, this.ea(m), false, "f64");
      case MemorySize.Float80: return call("rt_f80_load", "f64", this.ea(m));
      case MemorySize.Int16: return un("i32tof64s", load(2, this.ea(m), true), "f64");
      case MemorySize.Int32: return un("i32tof64s", load(4, this.ea(m)), "f64");
      case MemorySize.Int64: return un("i64tof64s", load(8, this.ea(m)), "f64");
      default: return this.trapHere(`x87 memory operand ${MemorySize[m.type]}`);
    }
  }

  private fstore(m: MemOperand, v: Expr): void {
    const addr = this.ea(m);
    switch (m.type) {
      case MemorySize.Float32: this.store(4, addr, un("f64to32", v, "f32")); return;
      case MemorySize.Float64: this.store(8, addr, v); return;
      case MemorySize.Float80: this.emit({ k: "helper", fn: "rt_f80_store", args: [addr, v] }); return;
      case MemorySize.Int16: this.store(2, addr, call("rt_fist16", "i32", v, cpu("fcw"))); return;
      case MemorySize.Int32: this.store(4, addr, call("rt_fist32", "i32", v, cpu("fcw"))); return;
      case MemorySize.Int64: this.store(8, addr, call("rt_fist64", "i64", v, cpu("fcw"))); return;
      default: this.trapHere(`x87 store ${MemorySize[m.type]}`);
    }
  }

  private setC2(v: Expr): void {
    this.emit({ k: "cpuset", field: "fsw", ty: "i32", v: or(and(cpu("fsw"), c32(~0x400)), shl(v, c32(10))) });
  }

  private fcompare(a: Expr, b: Expr): void {
    const x = this.tmp(a);
    const y = this.tmp(b);
    const unord = this.tmp(or(bin("fne", x, x), bin("fne", y, y)));
    const c0 = or(bin("flt", x, y), unord);
    const c3 = or(bin("feq", x, y), unord);
    const bits = or(or(shl(c0, c32(8)), shl(unord, c32(10))), shl(c3, c32(14)));
    this.emit({ k: "cpuset", field: "fsw", ty: "i32", v: or(and(cpu("fsw"), c32(~0x4700)), bits) });
  }

  private x87(i: Insn): void {
    const o = i.ops;
    const m = i.mnemonic;
    const arith = (op: "fadd" | "fsub" | "fmul" | "fdiv", reverse: boolean, pop: boolean) => {
      let dst = 0;
      let src: Expr;
      if (o.length === 1 && o[0].kind === "mem") src = this.fmem(o[0].mem);
      else if (o.length === 2) {
        dst = this.stIndex(o[0]);
        src = this.st(this.stIndex(o[1]));
      } else this.trapHere("x87 arithmetic form");
      const d = this.tmp(this.st(dst));
      const s = this.tmp(src!);
      this.setSt(dst, this.prec(reverse ? bin(op, s, d) : bin(op, d, s)));
      if (pop) this.fpop();
    };
    switch (m) {
      case Mnemonic.Fld:
        if (o[0].kind === "mem") this.fpush(this.fmem(o[0].mem));
        else this.fpush(this.st(this.stIndex(o[0])));
        return;
      case Mnemonic.Fild:
        if (o[0].kind !== "mem") this.trapHere("fild form");
        this.fpush(this.fmem(o[0].mem));
        return;
      case Mnemonic.Fst: case Mnemonic.Fstp: case Mnemonic.Fist: case Mnemonic.Fistp: {
        const v = this.tmp(this.st(0));
        if (o[0].kind === "mem") this.fstore(o[0].mem, v);
        else this.setSt(this.stIndex(o[0]), v);
        if (m === Mnemonic.Fstp || m === Mnemonic.Fistp) this.fpop();
        return;
      }
      case Mnemonic.Fadd: return arith("fadd", false, false);
      case Mnemonic.Faddp: return arith("fadd", false, true);
      case Mnemonic.Fmul: return arith("fmul", false, false);
      case Mnemonic.Fmulp: return arith("fmul", false, true);
      case Mnemonic.Fsub: return arith("fsub", false, false);
      case Mnemonic.Fsubp: return arith("fsub", false, true);
      case Mnemonic.Fsubr: return arith("fsub", true, false);
      case Mnemonic.Fsubrp: return arith("fsub", true, true);
      case Mnemonic.Fdiv: return arith("fdiv", false, false);
      case Mnemonic.Fdivp: return arith("fdiv", false, true);
      case Mnemonic.Fdivr: return arith("fdiv", true, false);
      case Mnemonic.Fdivrp: return arith("fdiv", true, true);
      case Mnemonic.Fiadd: case Mnemonic.Fisub: case Mnemonic.Fisubr: case Mnemonic.Fimul: case Mnemonic.Fidiv: case Mnemonic.Fidivr: {
        if (o[0].kind !== "mem") this.trapHere("fi* form");
        const s = this.tmp(this.fmem(o[0].mem));
        const d = this.tmp(this.st(0));
        const op = m === Mnemonic.Fiadd ? "fadd" : m === Mnemonic.Fisub || m === Mnemonic.Fisubr ? "fsub" : m === Mnemonic.Fimul ? "fmul" : "fdiv";
        const rev = m === Mnemonic.Fisubr || m === Mnemonic.Fidivr;
        this.setSt(0, this.prec(rev ? bin(op, s, d) : bin(op, d, s)));
        return;
      }
      case Mnemonic.Fcom: case Mnemonic.Fcomp: case Mnemonic.Fucom: case Mnemonic.Fucomp: case Mnemonic.Ficom: case Mnemonic.Ficomp: {
        const b = o.length === 0 ? this.st(1) : o[o.length - 1].kind === "mem" ? this.fmem((o[o.length - 1] as { kind: "mem"; mem: MemOperand }).mem) : this.st(this.stIndex(o[o.length - 1]));
        this.fcompare(this.st(0), b);
        if (m === Mnemonic.Fcomp || m === Mnemonic.Fucomp || m === Mnemonic.Ficomp) this.fpop();
        return;
      }
      // FCOMI/FUCOMI compare ST(0) with ST(i) and set ZF/PF/CF (not the x87 condition bits),
      // then the "p" forms pop the register stack.
      case Mnemonic.Fcomi: case Mnemonic.Fcomip:
      case Mnemonic.Fucomi: case Mnemonic.Fucomip: {
        const a = this.st(o.length >= 1 ? this.stIndex(o[0]) : 0);
        const b = this.st(o.length >= 2 ? this.stIndex(o[1]) : 1);
        this.setFloatFlags(a, b);
        if (m === Mnemonic.Fcomip || m === Mnemonic.Fucomip) this.fpop();
        return;
      }
      case Mnemonic.Fcompp: case Mnemonic.Fucompp:
        this.fcompare(this.st(0), this.st(1));
        this.fpop();
        this.fpop();
        return;
      // FCOMI/FUCOMI compare ST(0) with ST(i) and write the integer EFLAGS directly (no C bits):
      //   >  : ZF=PF=CF=0   <  : CF=1, ZF=PF=0   =  : ZF=1, PF=CF=0   unordered: ZF=PF=CF=1
      // OF, SF and AF are always cleared. Only the invalid-operation signalling differs between
      // the signalling FCOMI and quiet FUCOMI. Intel SDM Vol. 2A "FCOMI/FUCOMI".
      case Mnemonic.Fcomip:
      case Mnemonic.Fucomip: {
        const src = o.length === 2 ? this.stIndex(o[1]) : 1;
        const x = this.tmp(this.st(0));
        const y = this.tmp(this.st(src));
        const unord = this.tmp(or(bin("fne", x, x), bin("fne", y, y)));
        this.defFlags(x, y, c32(0), (fl) => {
          if (fl === ZF) return or(unord, bin("feq", x, y));
          if (fl === PF) return unord;
          if (fl === CF) return or(unord, bin("flt", x, y));
          return c32(0); // OF, SF and AF are cleared
        });
        this.fpop();
        return;
      }
      case Mnemonic.Ftst:
        this.fcompare(this.st(0), cf64(0));
        return;
      case Mnemonic.Fxam:
        this.emit({ k: "cpuset", field: "fsw", ty: "i32", v: or(and(cpu("fsw"), c32(~0x4700)), call("rt_fxam", "i32", this.st(0))) });
        return;
      case Mnemonic.Fnstsw: {
        const v = or(and(cpu("fsw"), c32(~0x3800)), shl(and(loc("ftop"), c32(7)), c32(11)));
        if (o[0].kind === "reg") this.setReg(o[0].reg, v);
        else if (o[0].kind === "mem") this.store(2, this.ea(o[0].mem), v);
        return;
      }
      case Mnemonic.Fnstcw:
        if (o[0].kind !== "mem") this.trapHere("fnstcw form");
        this.store(2, this.ea(o[0].mem), cpu("fcw"));
        return;
      case Mnemonic.Fldcw: {
        if (o[0].kind !== "mem") this.trapHere("fldcw form");
        const v = this.tmp(load(2, this.ea(o[0].mem)));
        this.emit({ k: "cpuset", field: "fcw", ty: "i32", v });
        this.set("pc24", eqz(and(v, c32(0x300))));
        return;
      }
      case Mnemonic.Fninit:
        this.emit({ k: "cpuset", field: "fcw", ty: "i32", v: c32(0x37f) });
        this.emit({ k: "cpuset", field: "fsw", ty: "i32", v: c32(0) });
        this.set("ftop", c32(0));
        this.set("pc24", c32(0));
        return;
      case Mnemonic.Fxch: {
        const k = o.length === 2 ? this.stIndex(o[1]) : 1;
        const a = this.tmp(this.st(0));
        const b = this.tmp(this.st(k));
        this.setSt(0, b);
        this.setSt(k, a);
        return;
      }
      case Mnemonic.Fchs: this.setSt(0, un("fneg", this.st(0), "f64")); return;
      case Mnemonic.Fabs: this.setSt(0, un("fabs", this.st(0), "f64")); return;
      case Mnemonic.Fsqrt: this.setSt(0, this.prec(un("fsqrt", this.st(0), "f64"))); return;
      case Mnemonic.Fldz: this.fpush(cf64(0)); return;
      case Mnemonic.Fld1: this.fpush(cf64(1)); return;
      case Mnemonic.Fldpi: this.fpush(cf64(Math.PI)); return;
      case Mnemonic.Fldl2e: this.fpush(cf64(Math.LOG2E)); return;
      case Mnemonic.Fldl2t: this.fpush(cf64(Math.log2(10))); return;
      case Mnemonic.Fldlg2: this.fpush(cf64(Math.LOG10E * Math.LN2)); return;
      case Mnemonic.Fldln2: this.fpush(cf64(Math.LN2)); return;
      // Trig operands with |x| >= 2^63 are left unchanged with C2 set and nothing pushed.
      case Mnemonic.Fsin:
      case Mnemonic.Fcos: {
        const x = this.tmp(this.st(0));
        const inRange = this.tmp(eqz(bin("fge", un("fabs", x, "f64"), cf64(2 ** 63))));
        this.setSt(0, call(m === Mnemonic.Fsin ? "rt_sin" : "rt_cos", "f64", x));
        this.setC2(eqz(inRange));
        return;
      }
      case Mnemonic.Fsincos: {
        // D9 FB (iced: Fsincos): Unicorn decrements TOP, writes cos to ST(0), sin to ST(1).
        const x = this.tmp(this.st(0));
        const inRange = this.tmp(eqz(bin("fge", un("fabs", x, "f64"), cf64(2 ** 63))));
        const sin = this.tmp(call("rt_sin", "f64", x));
        const cos = this.tmp(call("rt_cos", "f64", x));
        const top = this.tmp(sel(inRange, and(sub(loc("ftop"), c32(1)), c32(7)), loc("ftop")));
        const oldTop = this.tmp(cpu("fpr", "f64", top));
        this.emit({ k: "cpuset", field: "fpr", index: top, ty: "f64", v: sel(inRange, cos, oldTop) });
        this.set("ftop", top);
        this.setSt(1, sel(inRange, sin, this.st(1)));
        this.setC2(eqz(inRange));
        return;
      }
      case Mnemonic.Fptan: {
        const x = this.tmp(this.st(0));
        const inRange = this.tmp(eqz(bin("fge", un("fabs", x, "f64"), cf64(2 ** 63))));
        const oldST0 = this.tmp(this.st(0));
        const tan = this.tmp(call("rt_tan", "f64", x));
        this.setSt(0, sel(inRange, tan, oldST0));
        const top = this.tmp(sel(inRange, and(sub(loc("ftop"), c32(1)), c32(7)), loc("ftop")));
        const oldTop = this.tmp(cpu("fpr", "f64", top));
        this.emit({ k: "cpuset", field: "fpr", index: top, ty: "f64", v: sel(inRange, cf64(1), oldTop) });
        this.set("ftop", top);
        this.setC2(eqz(inRange));
        return;
      }
      case Mnemonic.Fpatan: {
        const y = this.tmp(this.st(1));
        const x = this.tmp(this.st(0));
        this.setSt(1, call("rt_atan2", "f64", y, x));
        this.fpop();
        return;
      }
      case Mnemonic.Fyl2x: {
        const y = this.tmp(this.st(1));
        const x = this.tmp(this.st(0));
        this.setSt(1, bin("fmul", y, call("rt_log2", "f64", x)));
        this.fpop();
        return;
      }
      case Mnemonic.F2xm1: this.setSt(0, call("rt_f2xm1", "f64", this.st(0))); return;
      case Mnemonic.Fscale: this.setSt(0, call("rt_fscale", "f64", this.st(0), this.st(1))); return;
      case Mnemonic.Frndint: this.setSt(0, call("rt_frndint", "f64", this.st(0), cpu("fcw"))); return;
      case Mnemonic.Fprem: case Mnemonic.Fprem1:
        this.emit({ k: "helper", fn: m === Mnemonic.Fprem ? "rt_fprem" : "rt_fprem1", args: [loc("ftop")] });
        return;
      case Mnemonic.Fincstp: this.fpop(); return;
      case Mnemonic.Fdecstp: this.set("ftop", and(sub(loc("ftop"), c32(1)), c32(7))); return;
      case Mnemonic.Fnsave: case Mnemonic.Fnstenv: case Mnemonic.Frstor: case Mnemonic.Fldenv: {
        if (o[0].kind !== "mem") this.trapHere("x87 env form");
        const fn = m === Mnemonic.Fnsave ? "rt_fnsave" : m === Mnemonic.Fnstenv ? "rt_fnstenv" : m === Mnemonic.Frstor ? "rt_frstor" : "rt_fldenv";
        this.emit({ k: "syncout" });
        this.emit({ k: "helper", fn, args: [this.ea(o[0].mem)] });
        this.emit({ k: "syncin" });
        return;
      }
    }
    this.trapHere(`no x87 semantics for ${Mnemonic[m]}`);
  }

  // ------------------------------------------------------------------------------------------
  // SSE1: scalar, move and logical semantics (XMM lanes stay i32, low lane first)
  //
  // Only the fault-free subset is modelled: MXCSR exception flags and alignment faults are not
  // tracked, RCPSS/RSQRTSS use exact 1/x and 1/sqrt(x) (hardware approximates within ~1 ulp),
  // and CVTSS2SI uses the default round-to-nearest-even MXCSR mode.

  private xmmIndex(o: Operand | Register): number {
    const r = typeof o === "number" ? o : o.kind === "reg" ? o.reg : Register.None;
    if (r < Register.XMM0 || r > Register.XMM31) this.trapHere("expected an XMM register");
    return r - Register.XMM0;
  }

  private xmmLane(reg: number, lane: number): Expr {
    return cpu("xmm", "i32", c32(4 * reg + lane));
  }

  private setXmmLane(reg: number, lane: number, v: Expr): void {
    this.emit({ k: "cpuset", field: "xmm", index: c32(4 * reg + lane), ty: "i32", v });
  }

  private isXmmReg(r: Register): boolean {
    return r >= Register.XMM0 && r <= Register.XMM31;
  }

  private isMmReg(r: Register): boolean {
    return r >= Register.MM0 && r <= Register.MM7;
  }

  private mmIndex(o: Operand | Register): number {
    const r = typeof o === "number" ? o : o.kind === "reg" ? o.reg : Register.None;
    if (!this.isMmReg(r)) this.trapHere("expected an MMX register");
    return r - Register.MM0;
  }

  private f32bits(v: Expr): Expr {
    return un("f32bits", v, "i32");
  }

  /** f32 value of an XMM low lane or a 4-byte memory operand. */
  private simdF32(o: Operand): Expr {
    if (o.kind === "reg") return un("bitsf32", this.xmmLane(this.xmmIndex(o), 0), "f32");
    if (o.kind === "mem" && o.mem.size === 4) return load(4, this.ea(o.mem), false, "f32");
    return this.trapHere(`expected an xmm or m32 operand, got ${o.kind}`);
  }

  /** f64 value of an XMM low pair or an 8-byte memory operand. */
  private simdF64(o: Operand): Expr {
    if (o.kind === "mem" && o.mem.size === 8) return load(8, this.ea(o.mem), false, "f64");
    if (o.kind === "reg") {
      const r = this.xmmIndex(o);
      const b = this.tmp(or(un("extu", this.xmmLane(r, 0), "i64"), bin("shl", un("extu", this.xmmLane(r, 1), "i64"), c64(32n))));
      return un("bitsf64", b, "f64");
    }
    return this.trapHere(`expected an xmm or m64 operand, got ${o.kind}`);
  }

  /** The four i32 lanes of a 128-bit register or memory source (low lane first). */
  private simdLanes(o: Operand): Expr[] {
    if (o.kind === "reg") {
      const r = this.xmmIndex(o);
      return [0, 1, 2, 3].map((l) => this.xmmLane(r, l));
    }
    if (o.kind === "mem" && o.mem.size === 16) {
      const a = this.tmp(this.ea(o.mem));
      return [0, 1, 2, 3].map((l) => load(4, add(a, c32(4 * l))));
    }
    return this.trapHere(`expected an xmm or m128 operand, got ${o.kind}`);
  }

  private writeLanes4(o: Operand, lanes: Expr[]): void {
    if (o.kind === "reg") {
      const r = this.xmmIndex(o);
      for (let l = 0; l < 4; l++) this.setXmmLane(r, l, lanes[l]);
      return;
    }
    if (o.kind === "mem" && o.mem.size === 16) {
      const a = this.ea(o.mem);
      for (let l = 0; l < 4; l++) this.store(4, add(a, c32(4 * l)), lanes[l]);
      return;
    }
    this.trapHere(`expected an xmm or m128 operand, got ${o.kind}`);
  }

  /** Low 8 bytes of a memory operand as two i32 lanes. */
  private memQword(o: Operand): [Expr, Expr] {
    if (o.kind !== "mem" || o.mem.size !== 8) this.trapHere("expected an m64 operand");
    const a = this.tmp(this.ea(o.mem));
    return [load(4, a), load(4, add(a, c32(4)))];
  }

  /** Store two i32 lanes into an 8-byte memory operand. */
  private storeQword(o: Operand, lo: Expr, hi: Expr): void {
    if (o.kind !== "mem" || o.mem.size !== 8) this.trapHere("expected an m64 operand");
    const a = this.ea(o.mem);
    this.store(4, a, lo);
    this.store(4, add(a, c32(4)), hi);
  }

  private setXmmF64(reg: number, v: Expr): void {
    const b = this.tmp(un("f64bits", v, "i64"));
    this.setXmmLane(reg, 0, un("wrap", b, "i32"));
    this.setXmmLane(reg, 1, un("wrap", bin("shru", b, c64(32n)), "i32"));
  }

  /** x86 CVT(T)SS2SI: truncate/round, with 0x80000000 for NaN and out-of-range results. */
  private cvtF32ToI32(x: Expr, round: boolean): Expr {
    const d = this.tmp(un("f32to64", x, "f64"));
    const v = round ? this.tmp(un("fnearest", d, "f64")) : d;
    const sat = un("f64toi32sat", v, "i32");
    const bad = or(bin("fne", d, d), bin("fge", d, cf64(2147483648)));
    return sel(bad, c32(0x80000000 | 0), sat);
  }

  private simdScalar(i: Insn): void {
    const o = i.ops;
    const m = i.mnemonic;
    if (m === Mnemonic.Movss) {
      if (o[0].kind === "reg") {
        const d = this.xmmIndex(o[0]);
        if (o[1].kind === "reg") {
          this.setXmmLane(d, 0, this.xmmLane(this.xmmIndex(o[1]), 0)); // upper lanes unchanged
        } else if (o[1].kind === "mem" && o[1].mem.size === 4) {
          this.setXmmLane(d, 0, load(4, this.ea(o[1].mem)));
          for (let l = 1; l < 4; l++) this.setXmmLane(d, l, c32(0)); // memory form clears bits 127:32
        } else this.trapHere("movss load form");
      } else if (o[0].kind === "mem" && o[0].mem.size === 4 && o[1].kind === "reg") {
        this.store(4, this.ea(o[0].mem), this.xmmLane(this.xmmIndex(o[1]), 0));
      } else this.trapHere("movss form");
      return;
    }
    const d = this.xmmIndex(o[0]);
    const a = un("bitsf32", this.xmmLane(d, 0), "f32");
    const b = this.simdF32(o[1]);
    let r: Expr;
    switch (m) {
      case Mnemonic.Addss: r = bin("fadd", a, b, "f32"); break;
      case Mnemonic.Subss: r = bin("fsub", a, b, "f32"); break;
      case Mnemonic.Mulss: r = bin("fmul", a, b, "f32"); break;
      case Mnemonic.Divss: r = bin("fdiv", a, b, "f32"); break;
      // x86 MINSS/MAXSS return the second (source) operand for NaN or equal inputs, including +/-0.
      case Mnemonic.Minss: r = sel(bin("flt", a, b), a, b); break;
      case Mnemonic.Maxss: r = sel(bin("fgt", a, b), a, b); break;
      case Mnemonic.Sqrtss: r = un("fsqrt", b, "f32"); break;
      case Mnemonic.Rcpss: r = un("f64to32", bin("fdiv", cf64(1), un("f32to64", b, "f64"), "f64"), "f32"); break;
      case Mnemonic.Rsqrtss: r = un("f64to32", bin("fdiv", cf64(1), un("fsqrt", un("f32to64", b, "f64"), "f64"), "f64"), "f32"); break;
      default: return this.trapHere(`no scalar semantics for ${Mnemonic[m]}`);
    }
    this.setXmmLane(d, 0, this.f32bits(r));
  }

  /**
   * EFLAGS for the floating-point compare-and-set-EFLAGS group (UCOMISS/COMISS, UCOMISD/COMISD,
   * FCOMI/FUCOMI): ZF=equal-or-unordered, PF=unordered, CF=less-or-unordered; OF/SF/AF cleared.
   * Intel SDM Vol. 2: COMISS/UCOMISS and FCOMI/FUCOMI "Operation" pseudocode.
   */
  private setFloatFlags(a: Expr, b: Expr): void {
    const x = this.tmp(a);
    const y = this.tmp(b);
    const unord = () => or(bin("fne", x, x), bin("fne", y, y));
    this.defFlags(x, y, c32(0), (fl) => {
      if (fl === ZF) return or(unord(), bin("feq", x, y));
      if (fl === PF) return unord();
      if (fl === CF) return or(unord(), bin("flt", x, y));
      return c32(0); // OF, SF and AF are cleared
    });
  }

  private simdCompare(i: Insn): void {
    this.setFloatFlags(this.simdF32(i.ops[0]), this.simdF32(i.ops[1]));
  }

  private simdConvert(i: Insn): void {
    const o = i.ops;
    switch (i.mnemonic) {
      case Mnemonic.Cvtsi2ss:
        this.setXmmLane(this.xmmIndex(o[0]), 0, this.f32bits(un("i32tof32s", this.read(o[1]), "f32")));
        return;
      case Mnemonic.Cvttss2si:
        this.write(o[0], this.cvtF32ToI32(this.simdF32(o[1]), false));
        return;
      case Mnemonic.Cvtss2si:
        this.write(o[0], this.cvtF32ToI32(this.simdF32(o[1]), true));
        return;
      case Mnemonic.Cvtss2sd:
        this.setXmmF64(this.xmmIndex(o[0]), un("f32to64", this.simdF32(o[1]), "f64"));
        return;
      case Mnemonic.Cvtsd2ss:
        this.setXmmLane(this.xmmIndex(o[0]), 0, this.f32bits(un("f64to32", this.simdF64(o[1]), "f32")));
        return;
      case Mnemonic.Cvtsi2sd:
        this.setXmmF64Lane(this.xmmIndex(o[0]), 0, un("i32tof64s", this.read(o[1]), "f64"));
        return;
      case Mnemonic.Cvtsd2si: // rounds per MXCSR; round-to-nearest is the seeded default
        this.write(o[0], this.cvtF64ToI32(this.simdF64(o[1]), true));
        return;
      case Mnemonic.Cvttsd2si:
        this.write(o[0], this.cvtF64ToI32(this.simdF64(o[1]), false));
        return;
      case Mnemonic.Cvtdq2pd: {
        const dw = this.readDwords(o[1], 2);
        this.setXmmF64Lane(this.xmmIndex(o[0]), 0, un("i32tof64s", dw[0], "f64"));
        this.setXmmF64Lane(this.xmmIndex(o[0]), 1, un("i32tof64s", dw[1], "f64"));
        return;
      }
      case Mnemonic.Cvtdq2ps: {
        const d = this.xmmIndex(o[0]);
        const dw = this.readDwords(o[1], 4);
        for (let l = 0; l < 4; l++) this.setXmmLane(d, l, this.f32bits(un("i32tof32s", dw[l], "f32")));
        return;
      }
      case Mnemonic.Cvtps2dq:
      case Mnemonic.Cvttps2dq: {
        const d = this.xmmIndex(o[0]);
        const round = i.mnemonic === Mnemonic.Cvtps2dq;
        const src = this.simdLanes(o[1]).map((e) => this.tmp(e));
        for (let l = 0; l < 4; l++) this.setXmmLane(d, l, this.cvtF32ToI32(un("bitsf32", src[l], "f32"), round));
        return;
      }
      case Mnemonic.Cvtpd2dq:
      case Mnemonic.Cvttpd2dq: {
        const d = this.xmmIndex(o[0]);
        const round = i.mnemonic === Mnemonic.Cvtpd2dq;
        this.setXmmLane(d, 0, this.cvtF64ToI32(this.f64LaneAt(o[1], 0), round));
        this.setXmmLane(d, 1, this.cvtF64ToI32(this.f64LaneAt(o[1], 1), round));
        this.setXmmLane(d, 2, c32(0));
        this.setXmmLane(d, 3, c32(0));
        return;
      }
      case Mnemonic.Cvtps2pi:
      case Mnemonic.Cvttps2pi: {
        const round = i.mnemonic === Mnemonic.Cvtps2pi;
        const dw = this.readDwords(o[1], 2);
        const r = dw.map((e) => this.cvtF32ToI32(un("bitsf32", e, "f32"), round));
        this.writeDwords(o[0], r);
        return;
      }
      case Mnemonic.Cvtpi2ps: {
        const d = this.xmmIndex(o[0]);
        const dw = this.readDwords(o[1], 2);
        this.setXmmLane(d, 0, this.f32bits(un("i32tof32s", dw[0], "f32")));
        this.setXmmLane(d, 1, this.f32bits(un("i32tof32s", dw[1], "f32")));
        return;
      }
      default:
        return this.trapHere(`no conversion semantics for ${Mnemonic[i.mnemonic]}`);
    }
  }

  private simdPacked(i: Insn): void {
    const o = i.ops;
    const m = i.mnemonic;
    switch (m) {
      case Mnemonic.Movaps:
      case Mnemonic.Movups:
      case Mnemonic.Movapd: // MOVAPD is a full 128-bit move; alignment faults are not modelled
      case Mnemonic.Movupd:
        this.writeLanes4(o[0], this.simdLanes(o[1]));
        return;
      case Mnemonic.Movhlps: {
        const d = this.xmmIndex(o[0]);
        const s = this.xmmIndex(o[1]);
        const lanes = [2, 3].map((l) => this.tmp(this.xmmLane(s, l)));
        this.setXmmLane(d, 0, lanes[0]);
        this.setXmmLane(d, 1, lanes[1]);
        return;
      }
      case Mnemonic.Movlhps: {
        const d = this.xmmIndex(o[0]);
        const s = this.xmmIndex(o[1]);
        const lanes = [0, 1].map((l) => this.tmp(this.xmmLane(s, l)));
        this.setXmmLane(d, 2, lanes[0]);
        this.setXmmLane(d, 3, lanes[1]);
        return;
      }
      case Mnemonic.Movhps:
        if (o[0].kind === "reg") this.writeHalf(this.xmmIndex(o[0]), 2, this.memQword(o[1]));
        else this.storeQword(o[0], this.xmmLane(this.xmmIndex(o[1]), 2), this.xmmLane(this.xmmIndex(o[1]), 3));
        return;
      case Mnemonic.Movlps:
        if (o[0].kind === "reg") this.writeHalf(this.xmmIndex(o[0]), 0, this.memQword(o[1]));
        else this.storeQword(o[0], this.xmmLane(this.xmmIndex(o[1]), 0), this.xmmLane(this.xmmIndex(o[1]), 1));
        return;
      case Mnemonic.Shufps: {
        const d = this.xmmIndex(o[0]);
        const imm = o[2].kind === "imm" ? o[2].value & 0xff : this.trapHere("shufps without imm8");
        const src = this.simdLanes(o[1]).map((e) => this.tmp(e));
        const dst = [0, 1, 2, 3].map((l) => this.tmp(this.xmmLane(d, l)));
        const pick = (k: number) => (k < 4 ? dst[k] : src[k - 4]);
        this.setXmmLane(d, 0, pick(imm & 3));
        this.setXmmLane(d, 1, pick((imm >> 2) & 3));
        this.setXmmLane(d, 2, pick(4 + ((imm >> 4) & 3)));
        this.setXmmLane(d, 3, pick(4 + ((imm >> 6) & 3)));
        return;
      }
      case Mnemonic.Xorps:
      case Mnemonic.Andps:
      case Mnemonic.Orps:
      case Mnemonic.Andnps:
      case Mnemonic.Xorpd:
      case Mnemonic.Andpd:
      case Mnemonic.Orpd:
      case Mnemonic.Andnpd:
        return this.packedBitwise(i);
      default:
        return this.trapHere(`no packed semantics for ${Mnemonic[m]}`);
    }
  }

  private writeHalf(reg: number, base: number, half: [Expr, Expr]): void {
    this.setXmmLane(reg, base, half[0]);
    this.setXmmLane(reg, base + 1, half[1]);
  }

  /** ANDPS/ANDNPS/ORPS/XORPS and their packed-double counterparts: bitwise on the four i32 lanes. */
  private packedBitwise(i: Insn): void {
    const o = i.ops;
    const m = i.mnemonic;
    const d = this.xmmIndex(o[0]);
    const src = this.simdLanes(o[1]).map((e) => this.tmp(e));
    const dst = [0, 1, 2, 3].map((l) => this.tmp(this.xmmLane(d, l)));
    const isAnd = m === Mnemonic.Andps || m === Mnemonic.Andpd;
    const isOr = m === Mnemonic.Orps || m === Mnemonic.Orpd;
    const isAndn = m === Mnemonic.Andnps || m === Mnemonic.Andnpd;
    for (let l = 0; l < 4; l++) {
      const v = isAnd ? and(dst[l], src[l]) : isOr ? or(dst[l], src[l]) : isAndn ? and(xor(dst[l], c32(-1)), src[l]) : xor(dst[l], src[l]);
      this.setXmmLane(d, l, v);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Packed integer vectors (MMX = 2 dwords in Cpu.mm, SSE2 = 4 dwords in Cpu.xmm).
  //
  // Integer SIMD ops are expressed element-wise: a register or memory operand is decoded into
  // 32-bit dword lanes (low first), split into elements of `elemBits`, transformed, and rebuilt.
  // MMX registers are 64-bit so `vecWidth` is 2; SSE2 registers are 128-bit so it is 4.

  private vecWidth(o: Operand): number {
    if (o.kind === "reg" && this.isMmReg(o.reg)) return 2;
    if (o.kind === "reg" && this.isXmmReg(o.reg)) return 4;
    return this.trapHere("expected a packed register destination");
  }

  private mmValue(o: Operand): Expr {
    if (o.kind === "reg" && this.isMmReg(o.reg)) return cpu("mm", "i64", c32(this.mmIndex(o)));
    if (o.kind === "mem" && o.mem.size === 8) return load(8, this.ea(o.mem));
    return this.trapHere("expected an MMX register or m64 operand");
  }

  /** `n` dword lanes (i32), low first, of a packed register or memory operand. */
  private readDwords(o: Operand, n: number): Expr[] {
    let out: Expr[];
    if (o.kind === "reg" && this.isMmReg(o.reg)) {
      const v = cpu("mm", "i64", c32(this.mmIndex(o)));
      out = [un("wrap", v, "i32"), un("wrap", bin("shru", v, c64(32n)), "i32")];
    } else if (o.kind === "reg" && this.isXmmReg(o.reg)) {
      const r = this.xmmIndex(o);
      out = [0, 1, 2, 3].map((l) => this.xmmLane(r, l));
    } else if (o.kind === "mem") {
      const a = this.tmp(this.ea(o.mem));
      out = Array.from({ length: n }, (_, i) => load(4, add(a, c32(4 * i))));
    } else return this.trapHere(`expected a packed operand, got ${o.kind}`);
    return out.slice(0, n).map((e) => this.tmp(e));
  }

  private writeDwords(o: Operand, lanes: Expr[]): void {
    if (o.kind === "reg" && this.isMmReg(o.reg)) {
      const v = or(un("extu", lanes[0], "i64"), bin("shl", un("extu", lanes[1] ?? c32(0), "i64"), c64(32n)));
      this.emit({ k: "cpuset", field: "mm", index: c32(this.mmIndex(o)), ty: "i64", v });
      return;
    }
    if (o.kind === "reg" && this.isXmmReg(o.reg)) {
      const r = this.xmmIndex(o);
      for (let l = 0; l < 4; l++) this.setXmmLane(r, l, lanes[l] ?? c32(0));
      return;
    }
    if (o.kind === "mem") {
      const a = this.ea(o.mem);
      for (let i = 0; i < lanes.length; i++) this.store(4, add(a, c32(4 * i)), lanes[i]);
      return;
    }
    this.trapHere("expected a packed destination");
  }

  /** Split dword lanes into `elemBits`-wide zero-extended elements (low element first). */
  private elems(lanes: Expr[], elemBits: number): Expr[] {
    const per = 32 / elemBits;
    const mask = c32((1 << elemBits) - 1);
    const out: Expr[] = [];
    for (const d of lanes)
      for (let k = 0; k < per; k++) {
        const v = k === 0 ? d : shru(d, c32(k * elemBits));
        out.push(elemBits === 32 ? v : and(v, mask));
      }
    return out;
  }

  /** Inverse of `elems`: pack `elemBits`-wide elements back into `nLanes` dword lanes. */
  private buildLanes(vals: Expr[], elemBits: number, nLanes: number): Expr[] {
    const per = 32 / elemBits;
    const mask = c32((1 << elemBits) - 1);
    const lanes: Expr[] = [];
    for (let d = 0; d < nLanes; d++) {
      let acc: Expr | null = null;
      for (let k = 0; k < per; k++) {
        let v = this.tmp(vals[d * per + k]);
        if (elemBits !== 32) v = and(v, mask);
        const part = k === 0 ? v : shl(v, c32(k * elemBits));
        acc = acc === null ? part : or(acc, part);
      }
      lanes.push(acc!);
    }
    return lanes;
  }

  /** Read `count` elements of `elemBits` bits from a register/memory operand. */
  private readElems(o: Operand, elemBits: number, count: number): Expr[] {
    if (elemBits === 64) this.trapHere("64-bit packed element read");
    if (o.kind === "reg") return this.readElemsFromReg(o, elemBits, count);
    if (o.kind !== "mem") return this.trapHere(`expected a packed operand, got ${o.kind}`);
    const a = this.tmp(this.ea(o.mem));
    const bytes = elemBits / 8;
    const out: Expr[] = [];
    for (let i = 0; i < count; i++) {
      const addr = add(a, c32(bytes * i));
      out.push(this.tmp(bytes === 1 ? load(1, addr) : bytes === 2 ? load(2, addr) : load(4, addr)));
    }
    return out;
  }

  private readElemsFromReg(o: Operand, elemBits: number, count: number): Expr[] {
    if (this.isMmReg((o as { kind: "reg"; reg: Register }).reg)) {
      return this.elems(this.readDwords(o, 2), elemBits).slice(0, count);
    }
    return this.elems(this.readDwords(o, 4), elemBits).slice(0, count);
  }

  private imm8(o: Operand | undefined): number {
    if (!o || o.kind !== "imm") return this.trapHere("expected an imm8 operand");
    return o.value & 0xff;
  }

  /** Element-wise binary integer op on a packed destination and source of equal shape. */
  private packedIntBinary(i: Insn, elemBits: number, fn: (a: Expr, b: Expr) => Expr): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const a = this.elems(this.readDwords(dst, nLanes), elemBits);
    const b = this.elems(this.readDwords(i.ops[1], nLanes), elemBits);
    const r = a.map((av, k) => this.tmp(fn(av, b[k])));
    this.writeDwords(dst, this.buildLanes(r, elemBits, nLanes));
  }

  private sxElem(v: Expr, elemBits: number): Expr {
    return elemBits === 32 ? v : elemBits === 16 ? un("ext16s", v, "i32") : un("ext8s", v, "i32");
  }

  /** PADDQ/PSUBQ: 64-bit lane add/sub (MMX has one 64-bit lane, SSE2 has two). */
  private packedQword(i: Insn, addOp: boolean): void {
    const dst = i.ops[0];
    const n = this.vecWidth(dst);
    const a = this.readDwords(dst, n);
    const b = this.readDwords(i.ops[1], n);
    const out: Expr[] = [];
    for (let q = 0; q < n / 2; q++) {
      const av = or(un("extu", a[2 * q], "i64"), bin("shl", un("extu", a[2 * q + 1], "i64"), c64(32n)));
      const bv = or(un("extu", b[2 * q], "i64"), bin("shl", un("extu", b[2 * q + 1], "i64"), c64(32n)));
      const r = this.tmp(bin(addOp ? "add" : "sub", av, bv));
      out.push(un("wrap", r, "i32"));
      out.push(un("wrap", bin("shru", r, c64(32n)), "i32"));
    }
    this.writeDwords(dst, out);
  }

  /** PADD/PADDUS/PSUB/PSUBUS/PMAX/PMIN/PACK-style helpers. */
  private packedInt(i: Insn): void {
    const m = i.mnemonic;
    const mask16 = c32(0xffff);
    const mask8 = c32(0xff);
    switch (m) {
      case Mnemonic.Pand: case Mnemonic.Por: case Mnemonic.Pxor: case Mnemonic.Pandn:
        return this.packedIntBinary(i, 32, (a, b) =>
          m === Mnemonic.Pand ? and(a, b) : m === Mnemonic.Por ? or(a, b) : m === Mnemonic.Pxor ? xor(a, b) : and(xor(a, c32(-1)), b),
        );
      case Mnemonic.Paddb: return this.packedIntBinary(i, 8, (a, b) => add(a, b));
      case Mnemonic.Paddw: return this.packedIntBinary(i, 16, (a, b) => add(a, b));
      case Mnemonic.Paddd: return this.packedIntBinary(i, 32, (a, b) => add(a, b));
      case Mnemonic.Paddq: return this.packedQword(i, true);
      case Mnemonic.Psubb: return this.packedIntBinary(i, 8, (a, b) => sub(a, b));
      case Mnemonic.Psubw: return this.packedIntBinary(i, 16, (a, b) => sub(a, b));
      case Mnemonic.Psubd: return this.packedIntBinary(i, 32, (a, b) => sub(a, b));
      case Mnemonic.Psubq: return this.packedQword(i, false);
      case Mnemonic.Psubq: return this.packedQword(i, false);
      // Unsigned saturating add: clamp the (widened) sum to the element maximum.
      case Mnemonic.Paddusb: return this.packedIntBinary(i, 8, (a, b) => sel(bin("gtu", add(a, b), mask8), mask8, add(a, b)));
      case Mnemonic.Paddusw: return this.packedIntBinary(i, 16, (a, b) => sel(bin("gtu", add(a, b), mask16), mask16, add(a, b)));
      // Unsigned saturating subtract: zero when the subtrahend is larger.
      case Mnemonic.Psubusb: return this.packedIntBinary(i, 8, (a, b) => sel(bin("ltu", a, b), c32(0), sub(a, b)));
      case Mnemonic.Psubusw: return this.packedIntBinary(i, 16, (a, b) => sel(bin("ltu", a, b), c32(0), sub(a, b)));
      case Mnemonic.Pcmpeqb: case Mnemonic.Pcmpeqw: case Mnemonic.Pcmpeqd: {
        const bits = m === Mnemonic.Pcmpeqb ? 8 : m === Mnemonic.Pcmpeqw ? 16 : 32;
        return this.packedIntBinary(i, bits, (a, b) => sel(eq(a, b), c32(-1), c32(0)));
      }
      case Mnemonic.Pcmpgtb: case Mnemonic.Pcmpgtw: case Mnemonic.Pcmpgtd: {
        const bits = m === Mnemonic.Pcmpgtb ? 8 : m === Mnemonic.Pcmpgtw ? 16 : 32;
        return this.packedIntBinary(i, bits, (a, b) => sel(bin("gts", this.sxElem(a, bits), this.sxElem(b, bits)), c32(-1), c32(0)));
      }
      case Mnemonic.Pmaxsw: return this.packedIntBinary(i, 16, (a, b) => sel(bin("gts", un("ext16s", a, "i32"), un("ext16s", b, "i32")), a, b));
      case Mnemonic.Pminsw: return this.packedIntBinary(i, 16, (a, b) => sel(bin("lts", un("ext16s", a, "i32"), un("ext16s", b, "i32")), a, b));
      case Mnemonic.Pmaxub: return this.packedIntBinary(i, 8, (a, b) => sel(bin("gtu", a, b), a, b));
      case Mnemonic.Pminub: return this.packedIntBinary(i, 8, (a, b) => sel(bin("ltu", a, b), a, b));
      case Mnemonic.Pmulhw: // signed high 16 bits of each 32-bit product
        return this.packedMul(i, 16, "hi");
      case Mnemonic.Pmullw: // low 16 bits of each signed product
        return this.packedMul(i, 16, "lo");
      case Mnemonic.Pmaddwd: return this.packedMaddwd(i);
      case Mnemonic.Packsswb: return this.packedPack(i, 16, true);
      case Mnemonic.Packssdw: return this.packedPack(i, 32, true);
      case Mnemonic.Packuswb: return this.packedPack(i, 16, false);
      case Mnemonic.Punpcklbw: return this.packedUnpack(i, 8, false);
      case Mnemonic.Punpckhbw: return this.packedUnpack(i, 8, true);
      case Mnemonic.Punpcklwd: return this.packedUnpack(i, 16, false);
      case Mnemonic.Punpckhwd: return this.packedUnpack(i, 16, true);
      case Mnemonic.Punpckldq: return this.packedUnpack(i, 32, false);
      case Mnemonic.Punpckhdq: return this.packedUnpack(i, 32, true);
      case Mnemonic.Psllw: return this.packedShift(i, 16, "left");
      case Mnemonic.Pslld: return this.packedShift(i, 32, "left");
      case Mnemonic.Psrlw: return this.packedShift(i, 16, "shru");
      case Mnemonic.Psrld: return this.packedShift(i, 32, "shru");
      case Mnemonic.Psraw: return this.packedShift(i, 16, "shrs");
      case Mnemonic.Psrad: return this.packedShift(i, 32, "shrs");
      case Mnemonic.Psllq: return this.packedShiftQ(i, true);
      case Mnemonic.Psrlq: return this.packedShiftQ(i, false);
      case Mnemonic.Pshufd: return this.packedShufd(i);
      case Mnemonic.Pextrw: return this.pextrw(i);
      case Mnemonic.Pinsrw: return this.pinsrw(i);
      case Mnemonic.Pmovmskb: return this.pmovmskb(i);
      default:
        return this.trapHere(`no packed integer semantics for ${Mnemonic[m]}`);
    }
  }

  /** PMULHW/PMULLW: 16-bit lane products kept high/low, 16-bit results. */
  private packedMul(i: Insn, bits: number, which: "hi" | "lo"): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const a = this.elems(this.readDwords(dst, nLanes), bits);
    const b = this.elems(this.readDwords(i.ops[1], nLanes), bits);
    const r = a.map((av, k) => {
      const p = this.tmp(bin("mul", un("ext16s", av, "i32"), un("ext16s", b[k], "i32")));
      return this.tmp(which === "hi" ? shru(p, c32(16)) : p);
    });
    this.writeDwords(dst, this.buildLanes(r, bits, nLanes));
  }

  /** PMADDWD: (a0*b0 + a1*b1) per pair of 16-bit lanes, kept as signed 32-bit results. */
  private packedMaddwd(i: Insn): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const a = this.elems(this.readDwords(dst, nLanes), 16).map((e) => un("ext16s", e, "i32"));
    const b = this.elems(this.readDwords(i.ops[1], nLanes), 16).map((e) => un("ext16s", e, "i32"));
    const r: Expr[] = [];
    for (let k = 0; k < a.length; k += 2)
      r.push(this.tmp(add(bin("mul", a[k], b[k]), bin("mul", a[k + 1], b[k + 1]))));
    this.writeDwords(dst, this.buildLanes(r, 32, nLanes));
  }

  /** PACKSSWB/PACKSSDW/PACKUSWB: saturate two source vectors into one narrower destination. */
  private packedPack(i: Insn, srcBits: number, signed: boolean): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const halfCount = (nLanes * 32) / srcBits;
    const d = this.readElems(dst, srcBits, halfCount);
    const s = this.readElems(i.ops[1], srcBits, halfCount);
    const outBits = srcBits / 2;
    const hi = signed ? (1 << (outBits - 1)) - 1 : (1 << outBits) - 1;
    const lo = signed ? -(1 << (outBits - 1)) : 0;
    const conv = (v: Expr) => {
      const sv = srcBits === 16 ? un("ext16s", v, "i32") : v;
      return sel(bin("lts", sv, c32(lo)), c32(lo), sel(bin("gts", sv, c32(hi)), c32(hi), sv));
    };
    this.writeDwords(dst, this.buildLanes([...d, ...s].map(conv), outBits, nLanes));
  }

  /** PUNPCK{L,H}*: interleave the low or high halves of the destination and source elements. */
  private packedUnpack(i: Insn, elemBits: number, high: boolean): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const total = (nLanes * 32) / elemBits;
    const half = total / 2;
    const dAll = this.readElems(dst, elemBits, high ? total : half);
    const sAll = this.readElems(i.ops[1], elemBits, total);
    const d = high ? dAll.slice(half) : dAll;
    const s = high ? sAll.slice(half) : sAll;
    const out: Expr[] = [];
    for (let k = 0; k < half; k++) {
      out.push(this.tmp(d[k]));
      out.push(this.tmp(s[k]));
    }
    this.writeDwords(dst, this.buildLanes(out, elemBits, nLanes));
  }

  /** Packed shift count: immediate, MMX register, XMM register or memory, as a 64-bit value. */
  private packCount64(o: Operand | undefined): Expr {
    if (!o) return this.trapHere("missing packed shift count");
    if (o.kind === "imm") return c64(BigInt(o.value & 0xff));
    if (o.kind === "reg" && this.isMmReg(o.reg)) return cpu("mm", "i64", c32(this.mmIndex(o)));
    if (o.kind === "reg" && this.isXmmReg(o.reg)) {
      const r = this.xmmIndex(o);
      return or(un("extu", this.tmp(this.xmmLane(r, 0)), "i64"), bin("shl", un("extu", this.tmp(this.xmmLane(r, 1)), "i64"), c64(32n)));
    }
    if (o.kind === "mem") return load(8, this.ea(o.mem));
    return this.trapHere("packed shift count");
  }

  /** PSLL/PSRL/PSRA by a count of 0..255 (or a register/memory count). */
  private packedShift(i: Insn, elemBits: number, kind: "left" | "shru" | "shrs"): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const count = this.packCount64(i.ops[1]);
    const over = bin("geu", count, c64(BigInt(elemBits)));
    const cnt = un("wrap", count, "i32");
    const mask = c32((1 << elemBits) - 1);
    const vals = this.elems(this.readDwords(dst, nLanes), elemBits).map((v) => {
      let shifted: Expr;
      let fill: Expr = c32(0);
      if (kind === "left") shifted = shl(v, cnt);
      else if (kind === "shru") shifted = shru(v, cnt);
      else {
        shifted = shrs(this.sxElem(v, elemBits), cnt);
        fill = sel(bin("lts", this.sxElem(v, elemBits), c32(0)), mask, c32(0));
      }
      return this.tmp(sel(over, fill, shifted));
    });
    this.writeDwords(dst, this.buildLanes(vals, elemBits, nLanes));
  }

  /** PSLLQ/PSRLQ on 64-bit lanes (MMX sources are m64/mm; SSE2 sources m128/low 8 bytes). */
  private packedShiftQ(i: Insn, left: boolean): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const count = this.packCount64(i.ops[1]);
    const over = bin("geu", count, c64(64n));
    const cnt = un("wrap", count, "i32");
    const dwords = this.readDwords(dst, nLanes);
    const out: Expr[] = [];
    for (let q = 0; q < nLanes / 2; q++) {
      const v = or(un("extu", dwords[2 * q], "i64"), bin("shl", un("extu", dwords[2 * q + 1], "i64"), c64(32n)));
      const r = sel(over, c64(0n), left ? bin("shl", v, cnt) : bin("shru", v, cnt));
      out.push(this.tmp(un("wrap", r, "i32")));
      out.push(this.tmp(un("wrap", bin("shru", r, c64(32n)), "i32")));
    }
    this.writeDwords(dst, out);
  }

  /** PSHUFD: 4 dwords selected by the two-bit fields of imm8. */
  private packedShufd(i: Insn): void {
    const d = this.xmmIndex(i.ops[0]);
    const imm = this.imm8(i.ops[2]);
    const src = this.simdLanes(i.ops[1]).map((e) => this.tmp(e));
    for (let l = 0; l < 4; l++) this.setXmmLane(d, l, src[(imm >> (2 * l)) & 3]);
  }

  /** PEXTRW r32, mm/xmm, imm8: zero-extended selected word. */
  private pextrw(i: Insn): void {
    const src = i.ops[1];
    const idx = this.imm8(i.ops[2]);
    const word = this.readElems(src, 16, idx + 1)[idx];
    this.write(i.ops[0], and(word, c32(0xffff)));
  }

  /** PINSRW mm/xmm, r32/m16, imm8: insert into one word lane, leaving the rest unchanged. */
  private pinsrw(i: Insn): void {
    const dst = i.ops[0];
    const nLanes = this.vecWidth(dst);
    const idx = this.imm8(i.ops[2]);
    const w = and(this.read(i.ops[1]), c32(0xffff));
    const vals = this.elems(this.readDwords(dst, nLanes), 16);
    vals[idx] = w;
    this.writeDwords(dst, this.buildLanes(vals, 16, nLanes));
  }

  /** PMOVMSKB r32, mm/xmm: pack the sign bit of each byte into the low bits of a GPR. */
  private pmovmskb(i: Insn): void {
    const src = i.ops[1];
    const n = src.kind === "reg" && this.isMmReg(src.reg) ? 8 : 16;
    const bytes = this.readElems(src, 8, n);
    let acc: Expr = c32(0);
    for (let k = 0; k < n; k++) acc = or(acc, shl(and(shru(this.tmp(bytes[k]), c32(7)), c32(1)), c32(k)));
    this.write(i.ops[0], acc);
  }

  // ------------------------------------------------------------------------------------------
  // SSE1/SSE2 packed floating-point and data movement.

  /** f64 lane `l` (0/1) of an XMM register or an m128/m64 memory operand. */
  private f64LaneAt(o: Operand, l: number): Expr {
    if (o.kind === "reg" && this.isXmmReg(o.reg)) {
      const r = this.xmmIndex(o);
      const b = this.tmp(
        or(un("extu", this.tmp(this.xmmLane(r, 2 * l)), "i64"), bin("shl", un("extu", this.tmp(this.xmmLane(r, 2 * l + 1)), "i64"), c64(32n))),
      );
      return un("bitsf64", b, "f64");
    }
    if (o.kind === "mem" && o.mem.size === 16) return load(8, add(this.tmp(this.ea(o.mem)), c32(8 * l)), false, "f64");
    if (o.kind === "mem" && o.mem.size === 8) {
      if (l !== 0) this.trapHere("f64 lane 1 of m64");
      return load(8, this.ea(o.mem), false, "f64");
    }
    return this.trapHere(`expected an xmm or m128 operand, got ${o.kind}`);
  }

  /** Write one 64-bit lane of an XMM register from an i64 bit pattern. */
  private setXmmQword(reg: number, l: number, bits: Expr): void {
    const b = this.tmp(bits);
    this.setXmmLane(reg, 2 * l, un("wrap", b, "i32"));
    this.setXmmLane(reg, 2 * l + 1, un("wrap", bin("shru", b, c64(32n)), "i32"));
  }

  private setXmmF64Lane(reg: number, l: number, v: Expr): void {
    this.setXmmQword(reg, l, un("f64bits", v, "i64"));
  }

  /** ADDPS/SUBPS/MULPS/DIVPS/MINPS/MAXPS/SQRTPS/RCPPS and their packed-double counterparts. */
  private simdPackedFloat(i: Insn): void {
    const m = i.mnemonic;
    const d = this.xmmIndex(i.ops[0]);
    const src = i.ops[1];
    const single =
      m === Mnemonic.Addps || m === Mnemonic.Subps || m === Mnemonic.Mulps || m === Mnemonic.Divps ||
      m === Mnemonic.Minps || m === Mnemonic.Maxps || m === Mnemonic.Sqrtps || m === Mnemonic.Rcpps || m === Mnemonic.Rsqrtps;
    if (single) {
      const b = this.simdLanes(src).map((e) => this.tmp(e));
      for (let l = 0; l < 4; l++) {
        const a = un("bitsf32", this.xmmLane(d, l), "f32");
        const s = un("bitsf32", b[l], "f32");
        let r: Expr;
        switch (m) {
          case Mnemonic.Addps: r = bin("fadd", a, s, "f32"); break;
          case Mnemonic.Subps: r = bin("fsub", a, s, "f32"); break;
          case Mnemonic.Mulps: r = bin("fmul", a, s, "f32"); break;
          case Mnemonic.Divps: r = bin("fdiv", a, s, "f32"); break;
          case Mnemonic.Minps: r = sel(bin("flt", a, s), a, s); break;
          case Mnemonic.Maxps: r = sel(bin("fgt", a, s), a, s); break;
          case Mnemonic.Sqrtps: r = un("fsqrt", s, "f32"); break;
          // RCP(S)PS is an approximation on hardware; 1/x is exact and within the documented error.
          case Mnemonic.Rcpps: r = un("f64to32", bin("fdiv", cf64(1), un("f32to64", s, "f64"), "f64"), "f32"); break;
          case Mnemonic.Rsqrtps: r = un("f64to32", bin("fdiv", cf64(1), un("fsqrt", un("f32to64", s, "f64"), "f64"), "f64"), "f32"); break;
          default: return this.trapHere(`no packed-f32 semantics for ${Mnemonic[m]}`);
        }
        this.setXmmLane(d, l, this.f32bits(r));
      }
      return;
    }
    const b = [this.f64LaneAt(src, 0), this.f64LaneAt(src, 1)].map((e) => this.tmp(e));
    for (let l = 0; l < 2; l++) {
      const a = this.f64LaneAt(i.ops[0], l);
      const s = b[l];
      let r: Expr;
      switch (m) {
        case Mnemonic.Addpd: r = bin("fadd", a, s, "f64"); break;
        case Mnemonic.Subpd: r = bin("fsub", a, s, "f64"); break;
        case Mnemonic.Mulpd: r = bin("fmul", a, s, "f64"); break;
        case Mnemonic.Divpd: r = bin("fdiv", a, s, "f64"); break;
        case Mnemonic.Minpd: r = sel(bin("flt", a, s), a, s); break;
        case Mnemonic.Maxpd: r = sel(bin("fgt", a, s), a, s); break;
        case Mnemonic.Sqrtpd: r = un("fsqrt", s, "f64"); break;
        default: return this.trapHere(`no packed-f64 semantics for ${Mnemonic[m]}`);
      }
      this.setXmmF64Lane(d, l, r);
    }
  }

  /** UNPCK{L,H}PS and UNPCK{L,H}PD. */
  private simdUnpck(i: Insn): void {
    const m = i.mnemonic;
    const dst = i.ops[0];
    const d = this.xmmIndex(dst);
    const double = m === Mnemonic.Unpcklpd || m === Mnemonic.Unpckhpd;
    if (!double) {
      const high = m === Mnemonic.Unpckhps;
      const b = this.simdLanes(i.ops[1]).map((e) => this.tmp(e));
      const a = [0, 1, 2, 3].map((l) => this.tmp(this.xmmLane(d, l)));
      const base = high ? 2 : 0;
      this.setXmmLane(d, 0, a[base]);
      this.setXmmLane(d, 1, b[base]);
      this.setXmmLane(d, 2, a[base + 1]);
      this.setXmmLane(d, 3, b[base + 1]);
      return;
    }
    const high = m === Mnemonic.Unpckhpd;
    const b = [this.f64LaneAt(i.ops[1], 0), this.f64LaneAt(i.ops[1], 1)].map((e) => this.tmp(e));
    const a0 = this.f64LaneAt(dst, high ? 1 : 0);
    const b0 = b[high ? 1 : 0];
    this.setXmmF64Lane(d, 0, a0);
    this.setXmmF64Lane(d, 1, b0);
  }

  /** SHUFPD: imm bit 0 selects dst[0], bit 1 selects dst[1], each from {dst, src}. */
  private simdShufpd(i: Insn): void {
    const d = this.xmmIndex(i.ops[0]);
    const imm = this.imm8(i.ops[2]);
    const dst = [this.f64LaneAt(i.ops[0], 0), this.f64LaneAt(i.ops[0], 1)].map((e) => this.tmp(e));
    const src = [this.f64LaneAt(i.ops[1], 0), this.f64LaneAt(i.ops[1], 1)].map((e) => this.tmp(e));
    this.setXmmF64Lane(d, 0, (imm & 1) ? src[0] : dst[0]);
    this.setXmmF64Lane(d, 1, (imm & 2) ? src[1] : dst[1]);
  }

  private simdMove(i: Insn): void {
    const m = i.mnemonic;
    const dst = i.ops[0];
    const src = i.ops[1];
    if (m === Mnemonic.Movlpd || m === Mnemonic.Movhpd || m === Mnemonic.Movlps || m === Mnemonic.Movhps) {
      const high = m === Mnemonic.Movhpd || m === Mnemonic.Movhps;
      if (dst.kind === "reg" && this.isXmmReg(dst.reg)) {
        const d = this.xmmIndex(dst);
        if (src.kind !== "mem" || src.mem.size !== 8) this.trapHere(`${Mnemonic[m]} load form`);
        const q = this.memQword(src);
        if (high) this.writeHalf(d, 2, q);
        else this.writeHalf(d, 0, q);
      } else if (dst.kind === "mem" && src.kind === "reg" && this.isXmmReg(src.reg)) {
        const r = this.xmmIndex(src);
        this.storeQword(dst, this.xmmLane(r, high ? 2 : 0), this.xmmLane(r, high ? 3 : 1));
      } else this.trapHere(`${Mnemonic[m]} form`);
      return;
    }
    if (m === Mnemonic.Movq || m === Mnemonic.Movd) {
      const bits = m === Mnemonic.Movq ? 64 : 32;
      this.simdMoveToReg(dst, src, bits);
      return;
    }
    if (m === Mnemonic.Movsd) return this.simdMovsd(i);
    return this.trapHere(`no move semantics for ${Mnemonic[m]}`);
  }

  /** MOVD (32-bit) and MOVQ (64-bit) between GPRs/memory and MMX/XMM registers. */
  private simdMoveToReg(dst: Operand, src: Operand, bits: number): void {
    if (dst.kind === "reg" && this.isXmmReg(dst.reg)) {
      const d = this.xmmIndex(dst);
      if (src.kind === "reg" && this.isXmmReg(src.reg)) {
        const s = this.xmmIndex(src);
        const n = bits === 32 ? 1 : 2; // movq leaves bits 127:64 cleared, as does movd
        for (let l = 0; l < n; l++) this.setXmmLane(d, l, this.tmp(this.xmmLane(s, l)));
        for (let l = n; l < 4; l++) this.setXmmLane(d, l, c32(0));
        return;
      }
      if (bits === 32) {
        this.setXmmLane(d, 0, this.read(src));
        for (let l = 1; l < 4; l++) this.setXmmLane(d, l, c32(0));
      } else {
        const q = this.memQword(src);
        this.writeHalf(d, 0, q);
        for (let l = 2; l < 4; l++) this.setXmmLane(d, l, c32(0));
      }
      return;
    }
    if (dst.kind === "reg" && this.isMmReg(dst.reg)) {
      const d = this.mmIndex(dst);
      const v = bits === 32 ? un("extu", this.read(src), "i64") : this.mmValue(src);
      this.emit({ k: "cpuset", field: "mm", index: c32(d), ty: "i64", v });
      return;
    }
    // Store: destination is r/m32 or m64, source is an MMX or XMM register.
    if (src.kind === "reg" && this.isXmmReg(src.reg)) {
      const r = this.xmmIndex(src);
      if (bits === 32) this.write(dst, this.xmmLane(r, 0));
      else this.storeQword(dst, this.xmmLane(r, 0), this.xmmLane(r, 1));
      return;
    }
    if (src.kind === "reg" && this.isMmReg(src.reg)) {
      const v = cpu("mm", "i64", c32(this.mmIndex(src)));
      if (bits === 32) this.write(dst, un("wrap", v, "i32"));
      else {
        if (dst.kind !== "mem" || dst.mem.size !== 8) this.trapHere("movq store form");
        this.store(8, this.ea(dst.mem), v);
      }
      return;
    }
    this.trapHere("movd/movq source");
  }

  /** MOVSD xmm, xmm/m64 (merge low 64 bits) and MOVSD m64, xmm (store). */
  private simdMovsd(i: Insn): void {
    const dst = i.ops[0];
    const src = i.ops[1];
    if (dst.kind === "reg" && this.isXmmReg(dst.reg)) {
      const d = this.xmmIndex(dst);
      if (src.kind === "reg" && this.isXmmReg(src.reg)) {
        const r = this.xmmIndex(src);
        this.setXmmLane(d, 0, this.tmp(this.xmmLane(r, 0)));
        this.setXmmLane(d, 1, this.tmp(this.xmmLane(r, 1)));
      } else if (src.kind === "mem" && src.mem.size === 8) {
        const q = this.memQword(src);
        this.writeHalf(d, 0, q);
        this.setXmmLane(d, 2, c32(0)); // memory source clears bits 127:64
        this.setXmmLane(d, 3, c32(0));
      } else this.trapHere("movsd load form");
      return;
    }
    if (dst.kind === "mem" && dst.mem.size === 8 && src.kind === "reg" && this.isXmmReg(src.reg)) {
      const r = this.xmmIndex(src);
      this.storeQword(dst, this.xmmLane(r, 0), this.xmmLane(r, 1));
      return;
    }
    this.trapHere("movsd form");
  }

  /** COMISD/UCOMISD: compare the low f64 lanes and write EFLAGS like COMISS. */
  private simdCompareD(i: Insn): void {
    this.setFloatFlags(this.f64LaneAt(i.ops[0], 0), this.f64LaneAt(i.ops[1], 0));
  }

  /** ADDSD/SUBSD/MULSD/DIVSD/MINSD/MAXSD/SQRTSD: low f64 lane, upper 64 bits unchanged. */
  private simdScalarD(i: Insn): void {
    const o = i.ops;
    const m = i.mnemonic;
    const d = this.xmmIndex(o[0]);
    const a = this.f64LaneAt(o[0], 0);
    const b = this.simdF64(o[1]);
    let r: Expr;
    switch (m) {
      case Mnemonic.Addsd: r = bin("fadd", a, b, "f64"); break;
      case Mnemonic.Subsd: r = bin("fsub", a, b, "f64"); break;
      case Mnemonic.Mulsd: r = bin("fmul", a, b, "f64"); break;
      case Mnemonic.Divsd: r = bin("fdiv", a, b, "f64"); break;
      case Mnemonic.Minsd: r = sel(bin("flt", a, b), a, b); break;
      case Mnemonic.Maxsd: r = sel(bin("fgt", a, b), a, b); break;
      case Mnemonic.Sqrtsd: r = un("fsqrt", b, "f64"); break;
      default: return this.trapHere(`no scalar-double semantics for ${Mnemonic[m]}`);
    }
    this.setXmmF64Lane(d, 0, r);
  }

  /** CMPPS/CMPPD: per-lane masks from the imm8 predicate. */
  private simdPackedCompare(i: Insn): void {
    const m = i.mnemonic;
    const pred = this.imm8(i.ops[2]);
    const dst = i.ops[0];
    const d = this.xmmIndex(dst);
    const double = m === Mnemonic.Cmppd;
    const test = (a: Expr, b: Expr): Expr => {
      const unord = or(bin("fne", a, a), bin("fne", b, b));
      switch (pred & 7) {
        case 0: return bin("feq", a, b);
        case 1: return bin("flt", a, b);
        case 2: return bin("fle", a, b);
        case 3: return unord;
        case 4: return or(unord, bin("fne", a, b));
        case 5: return or(unord, eqz(bin("flt", a, b)));
        case 6: return or(unord, eqz(bin("fle", a, b)));
        default: return eqz(unord);
      }
    };
    if (!double) {
      const b = this.simdLanes(i.ops[1]).map((e) => this.tmp(e));
      for (let l = 0; l < 4; l++) {
        const a = un("bitsf32", this.xmmLane(d, l), "f32");
        this.setXmmLane(d, l, sel(test(a, un("bitsf32", b[l], "f32")), c32(-1), c32(0)));
      }
      return;
    }
    const b = [this.f64LaneAt(i.ops[1], 0), this.f64LaneAt(i.ops[1], 1)].map((e) => this.tmp(e));
    for (let l = 0; l < 2; l++) this.setXmmQword(d, l, sel(test(this.f64LaneAt(dst, l), b[l]), c64(-1n), c64(0n)));
  }

  /** CMPSS/CMPSD: predicate result in the low lane only, upper bits unchanged. */
  private simdScalarCompare(i: Insn): void {
    const pred = this.imm8(i.ops[2]);
    const d = this.xmmIndex(i.ops[0]);
    const single = i.mnemonic === Mnemonic.Cmpss;
    const a = single ? un("bitsf32", this.xmmLane(d, 0), "f32") : this.f64LaneAt(i.ops[0], 0);
    const b = single ? un("bitsf32", this.simdF32(i.ops[1]), "f32") : this.f64LaneAt(i.ops[1], 0);
    const unord = or(bin("fne", a, a), bin("fne", b, b));
    let t: Expr;
    switch (pred & 7) {
      case 0: t = bin("feq", a, b); break;
      case 1: t = bin("flt", a, b); break;
      case 2: t = bin("fle", a, b); break;
      case 3: t = unord; break;
      case 4: t = or(unord, bin("fne", a, b)); break;
      case 5: t = or(unord, eqz(bin("flt", a, b))); break;
      case 6: t = or(unord, eqz(bin("fle", a, b))); break;
      default: t = eqz(unord); break;
    }
    if (single) this.setXmmLane(d, 0, sel(t, c32(-1), c32(0)));
    else this.setXmmQword(d, 0, sel(t, c64(-1n), c64(0n)));
  }

  /** x86 CVTSD2SI/CVTTSD2SI: truncate/round, 0x80000000 for NaN or out-of-range. */
  private cvtF64ToI32(x: Expr, round: boolean): Expr {
    const v = round ? this.tmp(un("fnearest", x, "f64")) : x;
    const sat = un("f64toi32sat", v, "i32");
    const bad = or(bin("fne", x, x), bin("fge", x, cf64(2147483648)));
    return sel(bad, c32(0x80000000 | 0), sat);
  }

  /** Fallback for SIMD forms without semantics yet (packed *ps, SSE2, MMX, 3DNow!). */
  private simd(i: Insn): void {
    this.trapHere(`no semantics for ${Mnemonic[i.mnemonic]}`);
  }

  // ------------------------------------------------------------------------------------------
  // Terminators

  private terminate(b: Block): void {
    const t = b.term;
    const last = b.insns[b.insns.length - 1];
    if (last) this.insn = last;
    const done = (term: Term) => {
      this.cur.term = term;
    };
    switch (t.kind) {
      case "fall":
        return done({ k: "br", to: label(t.next) });
      case "jmp":
        if (last) this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        return done({ k: "br", to: label(t.target) });
      case "jcc": {
        this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        let c: Expr;
        if (last.mnemonic === Mnemonic.Jecxz) c = eqz(loc("ecx"));
        else if (last.mnemonic === Mnemonic.Loop) {
          this.set("ecx", sub(loc("ecx"), c32(1)));
          c = ne(loc("ecx"), c32(0));
        } else if (last.mnemonic === Mnemonic.Loope || last.mnemonic === Mnemonic.Loopne) {
          this.set("ecx", sub(loc("ecx"), c32(1)));
          const z = this.getFlag(ZF);
          c = and(ne(loc("ecx"), c32(0)), last.mnemonic === Mnemonic.Loope ? z : eqz(z));
        } else c = this.cond(last.cc);
        let target = label(t.target);
        if (!this.f.blocks.has(t.target)) {
          // Conditional tail call into another function.
          const cur = this.cur;
          const tb = this.synthBlock();
          this.cur = tb;
          this.emit({ k: "syncout" });
          tb.term = { k: "tail", target: t.target };
          this.cur = cur;
          target = tb.id;
        }
        return done({ k: "cbr", c, t: target, f: label(t.next) });
      }
      case "switch": {
        this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        const m = last.mem!;
        const idx = this.getReg(m.index);
        const cur = this.cur;
        const dflt = this.synthBlock();
        dflt.term = { k: "trap", msg: `switch index out of range at 0x${hex(last.ip)}` };
        this.cur = cur;
        return done({ k: "switch", idx, targets: t.table.targets.map((x) => (x < 0 ? dflt.id : label(x))), dflt: dflt.id });
      }
      case "ret": {
        this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        this.set("esp", add(loc("esp"), c32(4 + t.pop)));
        this.emit({ k: "syncout" });
        return done({ k: "ret" });
      }
      case "tail":
        if (last && last.mnemonic === Mnemonic.Jmp) this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        this.emit({ k: "syncout" });
        return done({ k: "tail", target: t.target });
      case "tail-import": {
        this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        const imp = this.prog.pe.importBySlot.get(t.slot)!;
        this.emit({ k: "syncout" });
        return done({ k: "tailhle", slot: this.importIndex(t.slot), name: `${imp.dll}!${imp.name}` });
      }
      case "switch-addr": {
        this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        const target = this.tmp(this.read(last.ops[0]));
        const cur = this.cur;
        const dflt = this.synthBlock();
        this.cur = dflt;
        this.emit({ k: "syncout" });
        dflt.term = { k: "tailind", target };
        this.cur = cur;
        return done({ k: "switchaddr", target, cases: t.targets.map((a) => [a, label(a)] as [number, string]), dflt: dflt.id });
      }
      case "tail-indirect": {
        this.emit({ k: "comment", text: `${hex(last.ip)}: ${last.text}` });
        const target = this.tmp(this.read(last.ops[0]));
        this.emit({ k: "syncout" });
        return done({ k: "tailind", target });
      }
      case "noreturn":
        return done({ k: "trap", msg: `no-return call returned at 0x${hex(last.ip)}` });
      case "trap":
        return done({ k: "trap", msg: t.reason });
    }
  }
}

const X87 = new Set<Mnemonic>([
  Mnemonic.Fld, Mnemonic.Fild, Mnemonic.Fst, Mnemonic.Fstp, Mnemonic.Fist, Mnemonic.Fistp, Mnemonic.Fadd, Mnemonic.Faddp,
  Mnemonic.Fmul, Mnemonic.Fmulp, Mnemonic.Fsub, Mnemonic.Fsubp, Mnemonic.Fsubr, Mnemonic.Fsubrp, Mnemonic.Fdiv, Mnemonic.Fdivp,
  Mnemonic.Fdivr, Mnemonic.Fdivrp, Mnemonic.Fiadd, Mnemonic.Fisub, Mnemonic.Fisubr, Mnemonic.Fimul, Mnemonic.Fidiv,
  Mnemonic.Fidivr, Mnemonic.Fcom, Mnemonic.Fcomp, Mnemonic.Fucom, Mnemonic.Fucomp, Mnemonic.Ficom, Mnemonic.Ficomp,
  Mnemonic.Fcomi, Mnemonic.Fcomip, Mnemonic.Fucomi, Mnemonic.Fucomip,
  Mnemonic.Fcompp, Mnemonic.Fucompp, Mnemonic.Ftst, Mnemonic.Fxam, Mnemonic.Fnstsw, Mnemonic.Fnstcw, Mnemonic.Fldcw,
  Mnemonic.Fninit, Mnemonic.Fxch, Mnemonic.Fchs, Mnemonic.Fabs, Mnemonic.Fsqrt, Mnemonic.Fldz, Mnemonic.Fld1, Mnemonic.Fldpi,
  Mnemonic.Fldl2e, Mnemonic.Fldl2t, Mnemonic.Fldlg2, Mnemonic.Fldln2, Mnemonic.Fsin, Mnemonic.Fcos, Mnemonic.Fsincos,
  Mnemonic.Fptan, Mnemonic.Fpatan, Mnemonic.Fyl2x, Mnemonic.F2xm1, Mnemonic.Fscale, Mnemonic.Frndint, Mnemonic.Fprem,
  Mnemonic.Fprem1, Mnemonic.Fincstp, Mnemonic.Fdecstp, Mnemonic.Fnsave, Mnemonic.Fnstenv, Mnemonic.Frstor, Mnemonic.Fldenv,
  Mnemonic.Fcomip, Mnemonic.Fucomip,
]);

function isX87(m: Mnemonic): boolean {
  return X87.has(m);
}

function hasSimdReg(i: Insn): boolean {
  return i.ops.some(
    (o) => o.kind === "reg" && ((o.reg >= Register.MM0 && o.reg <= Register.MM7) || (o.reg >= Register.XMM0 && o.reg <= Register.XMM31)),
  );
}

export { ALL_FLAGS, operandBits };
export type { CpuField };
