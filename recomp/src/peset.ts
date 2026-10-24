/**
 * A set of PE modules sharing one guest address space (hitman.exe plus its DLLs). Presents the
 * PeLike view the discovery/lifting code expects: address-based reads go to the owning module, and
 * only imports of DLLs outside the set are HLE imports. Imports of DLLs inside the set are filled
 * with real export addresses by the loader, so the lifter sees them as ordinary indirect calls.
 */
import { PeImage, type Import, type PeLike, type Section } from "./pe.ts";

export interface IntraImport {
  module: string;
  import: Import;
  /** Export address in the target module, or null when it is not exported. */
  target: number | null;
}

export class PeSet implements PeLike {
  readonly modules: PeImage[];
  readonly entry: number;
  readonly sections: Section[] = [];
  readonly imports: Import[] = [];
  readonly importBySlot = new Map<number, Import>();
  readonly intraImports: IntraImport[] = [];
  private last: PeImage;

  constructor(modules: PeImage[]) {
    this.modules = modules;
    this.last = modules[0];
    this.entry = modules[0].entry;
    const byName = new Map(modules.map((m) => [m.name.toLowerCase(), m]));
    const sorted = [...modules].sort((a, b) => a.imageBase - b.imageBase);
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i].imageBase < sorted[i - 1].imageBase + sorted[i - 1].imageSize) throw new Error(`modules overlap: ${sorted[i - 1].name} / ${sorted[i].name}`);
    for (const m of modules) {
      for (const s of m.sections) this.sections.push({ ...s, module: m.name });
      for (const im of m.imports) {
        const target = byName.get(im.dll);
        if (!target) {
          this.imports.push(im);
          this.importBySlot.set(im.iatSlot, im);
        } else {
          const va = im.ordinal !== null ? target.exportsByOrdinal.get(im.ordinal) : target.exports.get(im.name);
          this.intraImports.push({ module: m.name, import: im, target: va ?? null });
        }
      }
    }
  }

  moduleOf(va: number): PeImage | undefined {
    if (this.last.contains(va)) return this.last;
    for (const m of this.modules)
      if (m.contains(va)) return (this.last = m);
    return undefined;
  }

  /** One range per module covering its executable sections (for the emitter's dispatch index). */
  execRanges(): { lo: number; hi: number }[] {
    const out: { lo: number; hi: number }[] = [];
    for (const m of this.modules) {
      const ex = m.sections.filter((s) => s.executable);
      if (ex.length) out.push({ lo: Math.min(...ex.map((s) => s.va)), hi: Math.max(...ex.map((s) => s.va + Math.max(s.vsize, s.rawSize))) });
    }
    return out;
  }

  private at(va: number): PeImage {
    const m = this.moduleOf(va);
    if (!m) throw new Error(`address ${va.toString(16)} is outside every module`);
    return m;
  }

  section(va: number): Section | undefined {
    return this.moduleOf(va)?.section(va);
  }
  isCode(va: number): boolean {
    return this.moduleOf(va)?.isCode(va) ?? false;
  }
  contains(va: number): boolean {
    return this.moduleOf(va) !== undefined;
  }
  u8(va: number): number {
    return this.at(va).u8(va);
  }
  u16(va: number): number {
    return this.at(va).u16(va);
  }
  u32(va: number): number {
    return this.at(va).u32(va);
  }
  cstr(va: number): string {
    return this.at(va).cstr(va);
  }
  view(va: number, length: number): Uint8Array {
    const m = this.moduleOf(va);
    return m ? m.view(va, length) : new Uint8Array(0);
  }
}
