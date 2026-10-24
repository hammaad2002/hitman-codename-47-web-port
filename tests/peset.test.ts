import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PeImage } from "../recomp/src/pe.ts";
import { PeSet } from "../recomp/src/peset.ts";

const dir = "work/game/app/";
const have = existsSync(dir + "hitman.exe");
const load = (name: string, rebaseTo?: number) => new PeImage(new Uint8Array(readFileSync(dir + name)), { name, rebaseTo });
const names = ["hitman.exe", "Globals.dll", "system.dll", "EngineData.dll", "gsc.dll", "Sound.dll", "Locale.dll", "RenderOpenGL.dll"];

describe.skipIf(!have)("PeSet", () => {
  const mods = [...names.map((n) => load(n)), load("xmlparse.dll", 0x0fb50000)];
  const set = new PeSet(mods);

  it("rebases xmlparse and rewrites relocation sites", () => {
    const pref = new PeImage(new Uint8Array(readFileSync(dir + "xmlparse.dll")), { name: "xmlparse.dll" });
    const re = mods[8];
    expect(re.imageBase).toBe(0x0fb50000);
    expect(pref.imageBase).toBe(0x20000000);
    // every exported function moves by the same delta
    for (const [n, va] of pref.exports) expect(re.exports.get(n)).toBe(va - 0x20000000 + 0x0fb50000);
    // the code bytes differ at relocation sites
    let diff = 0;
    for (let o = 0; o < pref.mapped.length; o++) if (pref.mapped[o] !== re.mapped[o]) diff++;
    expect(diff).toBeGreaterThan(100);
  });

  it("keeps module ranges disjoint and dispatches reads", () => {
    const r = set.execRanges();
    expect(r).toHaveLength(9);
    for (const m of mods) expect(set.moduleOf(m.entry)).toBe(m);
    expect(set.u16(0x00400000)).toBe(0x5a4d);
    expect(set.contains(0x0fb50000 + 4)).toBe(true);
    expect(set.contains(0x10000000)).toBe(false);
  });

  it("resolves intra-set imports and hides them from the HLE list", () => {
    expect(set.imports.some((i) => i.dll === "globals.dll" || i.dll === "xmlparse.dll")).toBe(false);
    const fromExe = set.intraImports.filter((i) => i.module === "hitman.exe");
    expect(fromExe.length).toBeGreaterThan(0);
    for (const i of fromExe) expect(i.target, i.import.name).not.toBeNull();
    expect(set.intraImports.filter((i) => i.import.dll === "xmlparse.dll").every((i) => i.target !== null)).toBe(true);
  });

  it("matches the single-image view of an unrebased module", () => {
    const solo = load("hitman.exe");
    expect(set.entry).toBe(solo.entry);
    expect(solo.imports.filter((i) => i.dll !== "globals.dll").length).toBe(set.imports.filter((i) => solo.importBySlot.has(i.iatSlot)).length);
  });
});
