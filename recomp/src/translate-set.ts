/**
 * Translates the player's own Hitman modules (hitman.exe and its DLLs, see docs/ARCH.md) into one
 * WebAssembly module. Like translate.ts it runs in the browser and in Node and never ships code.
 */
import { Program } from "./cfg.ts";
import { WasmModuleWriter } from "./emit-wasm.ts";
import { liftFunction } from "./lift.ts";
import { PeImage } from "./pe.ts";
import { PeSet } from "./peset.ts";
import type { Progress, TranslateResult } from "./translate.ts";

/** Load order and addresses; xmlparse is rebased because its preferred base collides with the heap. */
export const MODULE_TABLE: { name: string; base?: number }[] = [
  { name: "hitman.exe" },
  { name: "Globals.dll" },
  { name: "system.dll" },
  { name: "EngineData.dll" },
  { name: "gsc.dll" },
  { name: "Sound.dll" },
  { name: "Locale.dll" },
  { name: "RenderOpenGL.dll" },
  { name: "xmlparse.dll", base: 0x0fb50000 },
  // The game's own logic DLL (renamed .dlc); its preferred base overlaps Sound.dll, so it is rebased too.
  { name: "HitmanDlc.dlc", base: 0x0f800000 },
];

export interface SetMetadata {
  format: 2;
  modules: { name: string; sha256: string; size: number; base: number }[];
  entries: number[];
  noreturn: number[];
  jumpTargets: [number, number[]][];
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function loadSet(files: Map<string, Uint8Array>): PeSet {
  return new PeSet(
    MODULE_TABLE.map(({ name, base }) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error(`missing module ${name}`);
      return new PeImage(bytes, { name, rebaseTo: base });
    }),
  );
}

/** Every module entry point (DllMain) and exported function is a discovery root. */
export function rootEntries(set: PeSet): number[] {
  const roots = new Set<number>();
  for (const m of set.modules) {
    roots.add(m.entry);
    for (const va of m.exports.values()) roots.add(va);
    for (const va of m.exportsByOrdinal.values()) roots.add(va);
  }
  return [...roots].filter((va) => set.isCode(va));
}

export function translateSet(files: Map<string, Uint8Array>, meta: SetMetadata, progress?: Progress): TranslateResult {
  const t0 = now();
  progress?.("discover", 0, 1);
  const set = loadSet(files);
  const prog = new Program(set, { entries: meta.entries, noreturn: meta.noreturn, jumpTargets: new Map(meta.jumpTargets) });
  prog.discover({ speculate: false });
  const t1 = now();
  const importIndex = new Map(set.imports.map((im, i) => [im.iatSlot, i]));
  const entries = [...prog.funcs.keys()].sort((a, b) => a - b);
  const writer = new WasmModuleWriter(entries, { ranges: set.execRanges() });
  for (let i = 0; i < entries.length; i++) {
    writer.add(liftFunction(prog, prog.funcs.get(entries[i])!, (slot) => importIndex.get(slot)!));
    if (i % 250 === 0) progress?.("translate", i, entries.length);
  }
  progress?.("encode", 0, 1);
  const out = writer.finish();
  return { wasm: out.bytes, functions: entries.length, irreducible: out.irreducible, ms: { discover: t1 - t0, translate: now() - t1 } };
}

/** Offline: record the discovery result (addresses only). */
export function buildSetMetadata(prog: Program, modules: SetMetadata["modules"]): SetMetadata {
  const jumpTargets: [number, number[]][] = [];
  for (const f of prog.funcs.values())
    for (const b of f.blocks.values()) if (b.term.kind === "switch") jumpTargets.push([b.term.table.at, b.term.table.targets.filter((t) => t >= 0)]);
  jumpTargets.sort((a, b) => a[0] - b[0]);
  return { format: 2, modules, entries: [...prog.funcs.keys()].sort((a, b) => a - b), noreturn: [...prog.noreturn].sort((a, b) => a - b), jumpTargets };
}
