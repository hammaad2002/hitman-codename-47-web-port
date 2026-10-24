/**
 * Builds a synthetic PE containing one tiny test function per distinct instruction form used by
 * the game, plus a JSON manifest, for differential testing (Unicorn vs. recompiled code).
 *
 *   node tests/conformance/snippets.ts <game.exe> <ghidra-hints.json> <outdir>
 *
 * Integer snippet:   push [IN_FLAGS]; popfd; <insn>; pushfd; pop [OUT_FLAGS]; ret
 * x87 snippet:       fninit; fldcw [IN_FCW]; fld qword [IN_F2]; fld [IN_F1]; fld [IN_F0]; <insn>;
 *                    fnstsw [OUT_SW]; fstp qword [OUT_F0..]; ...; ret
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Program } from "../../recomp/src/cfg.ts";
import { loadGhidraHints } from "../../recomp/src/hints.ts";
import { PeImage } from "../../recomp/src/pe.ts";
import { Code, FlowControl, Mnemonic, Register, type Insn } from "../../recomp/src/x86.ts";

export const SNIPPET_BASE = 0x10000000;
export const IO = 0x2ff00000;
export const IO_IN_FLAGS = IO + 0x00;
export const IO_OUT_FLAGS = IO + 0x04;
export const IO_IN_FCW = IO + 0x08;
export const IO_OUT_SW = IO + 0x0c;
export const IO_IN_F = IO + 0x10; // 5 x f64 (ends at 0x38)
export const IO_OUT_F = IO + 0x40; // up to 7 x f64
export const IO_IN_XMM = IO + 0x100; // 8 x 16 bytes, seeded into xmm0-7
export const IO_IN_MM = IO + 0x180; // 8 x 8 bytes, seeded into mm0-7
export const IO_OUT_XMM = IO + 0x200; // 8 x 16 bytes, xmm0-7 after the instruction
export const IO_OUT_MM = IO + 0x280; // 8 x 8 bytes, mm0-7 after the instruction

const [exePath, hintsPath, outDir] = process.argv.slice(2);
const pe = new PeImage(new Uint8Array(readFileSync(exePath)));
const hints = hintsPath && hintsPath !== "-" ? await loadGhidraHints(hintsPath) : {};
const prog = new Program(pe, hints);
prog.discover({ speculate: true });

const X87_PREFIX = 0xd8; // escape opcodes d8..df
function isX87(i: Insn): boolean {
  const b = pe.u8(i.ip);
  return (b >= 0xd8 && b <= 0xdf) || (b === 0x9b && pe.u8(i.ip + 1) >= 0xd8);
}
function isSimd(i: Insn): boolean {
  return i.ops.some((o) => o.kind === "reg" && ((o.reg >= Register.MM0 && o.reg <= Register.MM7) || (o.reg >= Register.XMM0 && o.reg <= Register.XMM31)));
}
// SIMD forms the lifter implements; remaining 3DNow! (Pf*/P*) forms still trap.
const SIMD_SUPPORTED = new Set<Mnemonic>([
  Mnemonic.Movss, Mnemonic.Addss, Mnemonic.Subss, Mnemonic.Mulss, Mnemonic.Divss, Mnemonic.Minss,
  Mnemonic.Maxss, Mnemonic.Sqrtss, Mnemonic.Rcpss, Mnemonic.Rsqrtss, Mnemonic.Comiss, Mnemonic.Ucomiss,
  Mnemonic.Cmpss, Mnemonic.Cmpsd, Mnemonic.Comisd, Mnemonic.Ucomisd,
  Mnemonic.Cvtsi2ss, Mnemonic.Cvttss2si, Mnemonic.Cvtss2si, Mnemonic.Cvtss2sd, Mnemonic.Cvtsd2ss,
  Mnemonic.Cvtsi2sd, Mnemonic.Cvtsd2si, Mnemonic.Cvttsd2si, Mnemonic.Cvtdq2pd, Mnemonic.Cvtdq2ps,
  Mnemonic.Cvtps2dq, Mnemonic.Cvttps2dq, Mnemonic.Cvtpd2dq, Mnemonic.Cvttpd2dq,
  Mnemonic.Cvtps2pi, Mnemonic.Cvttps2pi, Mnemonic.Cvtpi2ps,
  Mnemonic.Movaps, Mnemonic.Movups, Mnemonic.Movapd, Mnemonic.Movupd,
  Mnemonic.Movhlps, Mnemonic.Movlhps, Mnemonic.Movhps, Mnemonic.Movlps, Mnemonic.Movlpd, Mnemonic.Movhpd,
  Mnemonic.Movsd, Mnemonic.Movd, Mnemonic.Movq,
  Mnemonic.Shufps, Mnemonic.Shufpd, Mnemonic.Unpcklps, Mnemonic.Unpckhps, Mnemonic.Unpcklpd, Mnemonic.Unpckhpd,
  Mnemonic.Xorps, Mnemonic.Andps, Mnemonic.Andnps, Mnemonic.Orps,
  Mnemonic.Xorpd, Mnemonic.Andpd, Mnemonic.Andnpd, Mnemonic.Orpd,
  Mnemonic.Addps, Mnemonic.Subps, Mnemonic.Mulps, Mnemonic.Divps, Mnemonic.Minps, Mnemonic.Maxps,
  Mnemonic.Sqrtps, Mnemonic.Rcpps, Mnemonic.Rsqrtps, Mnemonic.Cmpps, Mnemonic.Cmppd,
  Mnemonic.Addpd, Mnemonic.Subpd, Mnemonic.Mulpd, Mnemonic.Divpd, Mnemonic.Minpd, Mnemonic.Maxpd,
  Mnemonic.Sqrtpd, Mnemonic.Addsd, Mnemonic.Subsd, Mnemonic.Mulsd, Mnemonic.Divsd, Mnemonic.Minsd,
  Mnemonic.Maxsd, Mnemonic.Sqrtsd,
  Mnemonic.Pand, Mnemonic.Pandn, Mnemonic.Por, Mnemonic.Pxor,
  Mnemonic.Paddb, Mnemonic.Paddw, Mnemonic.Paddd, Mnemonic.Paddq,
  Mnemonic.Paddusb, Mnemonic.Paddusw, Mnemonic.Psubb, Mnemonic.Psubw, Mnemonic.Psubd, Mnemonic.Psubq,
  Mnemonic.Psubusb, Mnemonic.Psubusw, Mnemonic.Pmulhw, Mnemonic.Pmullw, Mnemonic.Pmaddwd,
  Mnemonic.Pcmpeqb, Mnemonic.Pcmpeqw, Mnemonic.Pcmpeqd,
  Mnemonic.Pcmpgtb, Mnemonic.Pcmpgtw, Mnemonic.Pcmpgtd,
  Mnemonic.Pmaxsw, Mnemonic.Pminsw, Mnemonic.Pmaxub, Mnemonic.Pminub,
  Mnemonic.Packsswb, Mnemonic.Packssdw, Mnemonic.Packuswb,
  Mnemonic.Punpcklbw, Mnemonic.Punpckhbw, Mnemonic.Punpcklwd, Mnemonic.Punpckhwd,
  Mnemonic.Punpckldq, Mnemonic.Punpckhdq,
  Mnemonic.Psllw, Mnemonic.Pslld, Mnemonic.Psllq, Mnemonic.Psrlw, Mnemonic.Psrld, Mnemonic.Psrlq,
  Mnemonic.Psraw, Mnemonic.Psrad,
  Mnemonic.Pshufd, Mnemonic.Pextrw, Mnemonic.Pinsrw, Mnemonic.Pmovmskb,
]);
const EXCLUDE = new Set<Mnemonic>([Mnemonic.Cpuid, Mnemonic.Int3, Mnemonic.Hlt, Mnemonic.Rdtsc, Mnemonic.Wait, Mnemonic.Nop,
  Mnemonic.Stmxcsr, Mnemonic.Ldmxcsr, Mnemonic.Emms, Mnemonic.Femms, Mnemonic.Fnsave, Mnemonic.Frstor, Mnemonic.Fnstenv, Mnemonic.Fldenv,
  Mnemonic.Enter, Mnemonic.Leave, Mnemonic.Pushad, Mnemonic.Popad]);
const isXmm = (r: Register) => r >= Register.XMM0 && r <= Register.XMM31;
const isMm = (r: Register) => r >= Register.MM0 && r <= Register.MM7;

// Collect candidate instructions: up to 4 distinct encodings per iced Code.
const byCode = new Map<Code, Insn[]>();
for (const f of prog.funcs.values()) {
  if (f.speculative) continue;
  for (const b of f.blocks.values())
    for (const i of b.insns) {
      if (i.flow !== FlowControl.Next || i.invalid || EXCLUDE.has(i.mnemonic)) continue;
      if (isSimd(i) && (!SIMD_SUPPORTED.has(i.mnemonic) || i.ops.some((o) => o.kind === "reg" && isXmm(o.reg) && o.reg > Register.XMM7))) continue;
      if (i.stackIncrement !== 0) continue; // push/pop/leave would unbalance the snippet's ret
      if (i.mem && (i.mem.seg === Register.GS || i.mem.seg === Register.ES && i.ops.every((o) => o.kind !== "string"))) continue;
      if (i.ops.some((o) => o.kind === "reg" && (o.reg === Register.ESP || o.reg === Register.SP)) && i.mnemonic !== Mnemonic.Push) continue;
      const list = byCode.get(i.code) ?? [];
      if (list.length < 4 && !list.some((x) => x.text === i.text)) list.push(i);
      byCode.set(i.code, list);
    }
}

const code: number[] = [];
const manifest: unknown[] = [];
const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
for (const insns of byCode.values()) {
  for (const i of insns) {
    while (code.length % 16) code.push(0xcc);
    const addr = SNIPPET_BASE + 0x1000 + code.length;
    const bytes = Array.from(pe.view(i.ip, i.len));
    const x87 = isX87(i);
    const simd = isSimd(i);
    const mmUsed = i.ops.some((o) => o.kind === "reg" && isMm(o.reg));
    if (simd) {
      // Seed xmm0-7 (and mm0-7 for MMX forms) from IO, run the instruction, store them back; flags
      // via the stack as usual.
      code.push(0xff, 0x35, ...u32le(IO_IN_FLAGS), 0x9d); // push [IN_FLAGS]; popfd
      for (let r = 0; r < 8; r++) code.push(0x0f, 0x10, 0x05 | (r << 3), ...u32le(IO_IN_XMM + r * 16)); // movups xmm_r,[IO_IN_XMM+..]
      if (mmUsed) for (let r = 0; r < 8; r++) code.push(0x0f, 0x6f, 0x05 | (r << 3), ...u32le(IO_IN_MM + r * 8)); // movq mm_r,[IO_IN_MM+..]
      code.push(...bytes);
      for (let r = 0; r < 8; r++) code.push(0x0f, 0x11, 0x05 | (r << 3), ...u32le(IO_OUT_XMM + r * 16)); // movups [IO_OUT_XMM+..],xmm_r
      if (mmUsed) for (let r = 0; r < 8; r++) code.push(0x0f, 0x7f, 0x05 | (r << 3), ...u32le(IO_OUT_MM + r * 8)); // movq [IO_OUT_MM+..],mm_r
      code.push(0x9c, 0x8f, 0x05, ...u32le(IO_OUT_FLAGS)); // pushfd; pop [OUT_FLAGS]
    } else if (x87) {
      code.push(0xdb, 0xe3); // fninit
      code.push(0xd9, 0x2d, ...u32le(IO_IN_FCW)); // fldcw [IN_FCW]
      for (const k of [4, 3, 2, 1, 0]) code.push(0xdd, 0x05, ...u32le(IO_IN_F + k * 8)); // fld qword
      code.push(...bytes);
      code.push(0xdd, 0x3d, ...u32le(IO_OUT_SW)); // fnstsw [OUT_SW]
      const depth = 5 - i.fpuTopIncrement;
      for (let k = 0; k < depth; k++) code.push(0xdd, 0x1d, ...u32le(IO_OUT_F + k * 8)); // fstp qword
    } else {
      code.push(0xff, 0x35, ...u32le(IO_IN_FLAGS), 0x9d); // push [IN_FLAGS]; popfd
      code.push(...bytes);
      code.push(0x9c, 0x8f, 0x05, ...u32le(IO_OUT_FLAGS)); // pushfd; pop [OUT_FLAGS]
    }
    code.push(0xc3);
    const m = i.mem;
    const first = i.ops[0];
    const xmmWritten = simd && first?.kind === "reg" && isXmm(first.reg) ? [first.reg - Register.XMM0] : [];
    const xmmRead = i.ops
      .filter((op) => op.kind === "reg" && isXmm((op as { reg: Register }).reg))
      .map((op) => (op as { reg: Register }).reg - Register.XMM0)
      .filter((r) => !xmmWritten.includes(r) || i.mnemonic === Mnemonic.Shufps || i.mnemonic === Mnemonic.Movhlps || i.mnemonic === Mnemonic.Movlhps);
    const mmWritten = simd && first?.kind === "reg" && isMm(first.reg) ? [first.reg - Register.MM0] : [];
    const mmRead = i.ops
      .filter((op) => op.kind === "reg" && isMm((op as { reg: Register }).reg))
      .map((op) => (op as { reg: Register }).reg - Register.MM0)
      .filter((r) => !mmWritten.includes(r));
    manifest.push({
      addr,
      origIp: i.ip,
      text: i.text,
      mnemonic: Mnemonic[i.mnemonic],
      x87,
      simd,
      xmmWritten,
      xmmRead,
      mmWritten,
      mmRead,
      fpuInc: i.fpuTopIncrement,
      flagsModified: i.rflagsModified,
      flagsUndefined: i.rflagsUndefined,
      flagsRead: i.rflagsRead,
      mem: m ? { base: Register[m.base], index: Register[m.index], scale: m.scale, disp: m.disp, size: m.size, seg: Register[m.seg] } : null,
      string: i.ops.some((o) => o.kind === "string"),
      regs: i.ops.filter((o) => o.kind === "reg").map((o) => Register[(o as { reg: Register }).reg]),
    });
  }
}

// Minimal PE32: headers + one executable section.
const textSize = code.length;
const align = (v: number, a: number) => Math.ceil(v / a) * a;
const fileAlign = 0x200;
const sectAlign = 0x1000;
const hdr = new Uint8Array(0x400);
const dv = new DataView(hdr.buffer);
dv.setUint16(0, 0x5a4d, true);
dv.setUint32(0x3c, 0x80, true);
dv.setUint32(0x80, 0x4550, true);
dv.setUint16(0x84, 0x14c, true); // machine
dv.setUint16(0x86, 1, true); // sections
dv.setUint16(0x94, 0xe0, true); // optional header size
dv.setUint16(0x96, 0x10f, true);
const opt = 0x98;
dv.setUint16(opt, 0x10b, true);
dv.setUint32(opt + 16, 0x1000, true); // entry rva
dv.setUint32(opt + 28, SNIPPET_BASE, true);
dv.setUint32(opt + 32, sectAlign, true);
dv.setUint32(opt + 36, fileAlign, true);
dv.setUint32(opt + 56, 0x1000 + align(textSize, sectAlign), true); // size of image
dv.setUint32(opt + 60, 0x400, true); // size of headers
dv.setUint16(opt + 68, 2, true); // GUI subsystem
dv.setUint32(opt + 72, 0x100000, true);
dv.setUint32(opt + 76, 0x1000, true);
dv.setUint32(opt + 92, 16, true); // number of data directories
const sec = opt + 0xe0;
".text\0\0\0".split("").forEach((ch, k) => (hdr[sec + k] = ch.charCodeAt(0)));
dv.setUint32(sec + 8, textSize, true);
dv.setUint32(sec + 12, 0x1000, true);
dv.setUint32(sec + 16, align(textSize, fileAlign), true);
dv.setUint32(sec + 20, 0x400, true);
dv.setUint32(sec + 36, 0x60000020, true);
const file = new Uint8Array(0x400 + align(textSize, fileAlign));
file.set(hdr, 0);
file.set(code, 0x400);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "snippets.exe"), file);
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest));
writeFileSync(
  join(outDir, "hints.json"),
  JSON.stringify({ functions: manifest.map((m) => ({ entry: (m as { addr: number }).addr, name: "", thunk: false, noreturn: false, ranges: [] })), computedJumps: [] }),
);
console.log(`${manifest.length} snippets from ${byCode.size} instruction forms; ${textSize} bytes of code`);
void X87_PREFIX;
