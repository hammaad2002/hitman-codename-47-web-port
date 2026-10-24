/**
 * PE32 image model: sections mapped at their virtual addresses, imports with IAT slot
 * addresses, and typed reads by virtual address.
 */

export interface Section {
  name: string;
  va: number;
  vsize: number;
  rawOffset: number;
  rawSize: number;
  characteristics: number;
  /** Owning module file name (set by PeSet). */
  module?: string;
  executable: boolean;
  writable: boolean;
}

export interface Import {
  dll: string; // lower-case, e.g. "kernel32.dll"
  name: string; // function name, or "#<ordinal>"
  ordinal: number | null;
  /** Virtual address of the IAT slot the loader fills with the function's address. */
  iatSlot: number;
}

/** What the discovery, lifting and emitting code needs from a PE image (a single module or a PeSet). */
export interface PeLike {
  readonly entry: number;
  readonly sections: Section[];
  readonly imports: Import[];
  readonly importBySlot: Map<number, Import>;
  section(va: number): Section | undefined;
  isCode(va: number): boolean;
  contains(va: number): boolean;
  u8(va: number): number;
  u16(va: number): number;
  u32(va: number): number;
  cstr(va: number): string;
  view(va: number, length: number): Uint8Array;
}

export interface PeOptions {
  /** Map the image here instead of its preferred base, applying its base relocations. */
  rebaseTo?: number;
  /** Module file name, e.g. "Globals.dll" (used by PeSet to tell intra-set imports from HLE imports). */
  name?: string;
}

export class PeImage implements PeLike {
  readonly name: string;
  /** Exported names and ordinals -> virtual address (forwarders are skipped). */
  readonly exports = new Map<string, number>();
  readonly exportsByOrdinal = new Map<number, number>();
  readonly bytes: Uint8Array;
  readonly imageBase: number;
  readonly imageSize: number;
  readonly entry: number;
  readonly sections: Section[] = [];
  readonly imports: Import[] = [];
  readonly importBySlot = new Map<number, Import>();
  readonly stackReserve: number;
  readonly stackCommit: number;
  /** The whole image mapped at its virtual layout (index = va - imageBase). */
  readonly mapped: Uint8Array;

  constructor(bytes: Uint8Array, opts: PeOptions = {}) {
    this.bytes = bytes;
    this.name = opts.name ?? "";
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint16(0, true) !== 0x5a4d) throw new Error("not an MZ executable");
    const pe = dv.getUint32(0x3c, true);
    if (dv.getUint32(pe, true) !== 0x4550) throw new Error("not a PE executable");
    if (dv.getUint16(pe + 4, true) !== 0x14c) throw new Error("not an i386 PE");
    const nsec = dv.getUint16(pe + 6, true);
    const optSize = dv.getUint16(pe + 20, true);
    const opt = pe + 24;
    if (dv.getUint16(opt, true) !== 0x10b) throw new Error("not a PE32 optional header");
    const entryRva = dv.getUint32(opt + 16, true);
    const preferredBase = dv.getUint32(opt + 28, true);
    this.imageBase = opts.rebaseTo ?? preferredBase;
    this.imageSize = dv.getUint32(opt + 56, true);
    this.stackReserve = dv.getUint32(opt + 72, true);
    this.stackCommit = dv.getUint32(opt + 76, true);
    this.entry = this.imageBase + entryRva;
    const numDirs = dv.getUint32(opt + 92, true);
    const dir = (i: number) => (i < numDirs ? { rva: dv.getUint32(opt + 96 + i * 8, true), size: dv.getUint32(opt + 100 + i * 8, true) } : { rva: 0, size: 0 });

    let so = opt + optSize;
    for (let i = 0; i < nsec; i++, so += 40) {
      let name = "";
      for (let k = 0; k < 8 && bytes[so + k]; k++) name += String.fromCharCode(bytes[so + k]);
      const ch = dv.getUint32(so + 36, true);
      this.sections.push({
        name,
        vsize: dv.getUint32(so + 8, true),
        va: this.imageBase + dv.getUint32(so + 12, true),
        rawSize: dv.getUint32(so + 16, true),
        rawOffset: dv.getUint32(so + 20, true),
        characteristics: ch,
        executable: (ch & 0x20000000) !== 0 || (ch & 0x20) !== 0,
        writable: (ch & 0x80000000) !== 0,
      });
    }

    this.mapped = new Uint8Array(this.imageSize);
    const hdrSize = dv.getUint32(opt + 60, true);
    this.mapped.set(bytes.subarray(0, Math.min(hdrSize, bytes.length, this.imageSize)), 0);
    for (const s of this.sections) {
      const n = Math.min(s.rawSize, s.vsize || s.rawSize, bytes.length - s.rawOffset);
      if (n > 0) this.mapped.set(bytes.subarray(s.rawOffset, s.rawOffset + n), s.va - this.imageBase);
    }

    const rel = dir(5);
    const delta = (this.imageBase - preferredBase) >>> 0;
    if (delta && rel.rva) {
      const m = this.mapped;
      for (let b = rel.rva; b < rel.rva + rel.size; ) {
        const page = this.u32(this.imageBase + b);
        const size = this.u32(this.imageBase + b + 4);
        if (size < 8) break;
        for (let e = b + 8; e < b + size; e += 2) {
          const ent = this.u16(this.imageBase + e);
          if (ent >> 12 !== 3) continue; // IMAGE_REL_BASED_HIGHLOW; ABSOLUTE (0) is padding
          const o = page + (ent & 0xfff);
          const v = ((m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) + delta) >>> 0;
          m[o] = v; m[o + 1] = v >>> 8; m[o + 2] = v >>> 16; m[o + 3] = v >>> 24;
        }
        b += size;
      }
    }

    const exp = dir(0);
    if (exp.rva) {
      const e = this.imageBase + exp.rva;
      const ordBase = this.u32(e + 16), nFuncs = this.u32(e + 20), nNames = this.u32(e + 24);
      const funcs = this.imageBase + this.u32(e + 28), names = this.imageBase + this.u32(e + 32), ords = this.imageBase + this.u32(e + 36);
      for (let i = 0; i < nFuncs; i++) {
        const rva = this.u32(funcs + i * 4);
        if (rva && !(rva >= exp.rva && rva < exp.rva + exp.size)) this.exportsByOrdinal.set(ordBase + i, this.imageBase + rva);
      }
      for (let j = 0; j < nNames; j++) {
        const va = this.exportsByOrdinal.get(ordBase + this.u16(ords + j * 2));
        if (va !== undefined) this.exports.set(this.cstr(this.imageBase + this.u32(names + j * 4)), va);
      }
    }

    const imp = dir(1);
    if (imp.rva) {
      for (let d = imp.rva; ; d += 20) {
        const nameRva = this.u32(this.imageBase + d + 12);
        if (nameRva === 0) break;
        const lookupRva = this.u32(this.imageBase + d) || this.u32(this.imageBase + d + 16);
        const iatRva = this.u32(this.imageBase + d + 16);
        const dll = this.cstr(this.imageBase + nameRva).toLowerCase();
        for (let k = 0; ; k++) {
          const t = this.u32(this.imageBase + lookupRva + k * 4);
          if (t === 0) break;
          const ordinal = t & 0x80000000 ? t & 0xffff : null;
          const name = ordinal !== null ? `#${ordinal}` : this.cstr(this.imageBase + t + 2);
          const im: Import = { dll, name, ordinal, iatSlot: this.imageBase + iatRva + k * 4 };
          this.imports.push(im);
          this.importBySlot.set(im.iatSlot, im);
        }
      }
    }
  }

  section(va: number): Section | undefined {
    return this.sections.find((s) => va >= s.va && va < s.va + Math.max(s.vsize, s.rawSize));
  }

  isCode(va: number): boolean {
    const s = this.section(va);
    return s !== undefined && s.executable;
  }

  contains(va: number): boolean {
    return va >= this.imageBase && va < this.imageBase + this.imageSize;
  }

  u8(va: number): number {
    return this.mapped[va - this.imageBase];
  }

  u16(va: number): number {
    const o = va - this.imageBase;
    return this.mapped[o] | (this.mapped[o + 1] << 8);
  }

  u32(va: number): number {
    const o = va - this.imageBase;
    const m = this.mapped;
    return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0;
  }

  cstr(va: number): string {
    let s = "";
    for (let o = va - this.imageBase; o < this.mapped.length && this.mapped[o]; o++) s += String.fromCharCode(this.mapped[o]);
    return s;
  }

  /** Bytes of the image starting at `va` (mapped view, up to the end of the image). */
  view(va: number, length: number): Uint8Array {
    const o = va - this.imageBase;
    return this.mapped.subarray(o, Math.min(this.mapped.length, o + length));
  }
}
