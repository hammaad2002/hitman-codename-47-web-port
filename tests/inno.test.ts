import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IsoImage } from "../installer/src/iso9660.ts";
import { SliceSource } from "../installer/src/io.ts";
import { extractWanted, openInno, sha1hex } from "../installer/src/inno.ts";
import { DirSink, NodeFileSource } from "../installer/src/node.ts";

const iso = "Hitman_Codename_47.iso";
describe.skipIf(!existsSync(iso))("inno installer", () => {
  it("extracts every manifest file with a matching SHA-1", async () => {
    const img = new NodeFileSource(iso);
    const isoFs = new IsoImage(img);
    const exe = isoFs.list().find((e) => !e.isDir)!;
    const src = new SliceSource(img, exe.offset, exe.size);
    const setup = openInno(src);
    expect(setup.version).toContain("5.5.7");
    const manifest = JSON.parse(readFileSync("installer/manifest.json", "utf8")) as { dest: string; sha1: string }[];
    const wanted = new Map<string, { dests: string[] }>();
    for (const m of manifest) (wanted.get(m.sha1) ?? wanted.set(m.sha1, { dests: [] }).get(m.sha1)!).dests.push(m.dest);
    const dir = mkdtempSync(join(tmpdir(), "hitman-inno-"));
    const r = await extractWanted(src, setup, wanted, new DirSink(dir));
    expect(r.missing).toEqual([]);
    expect(r.mismatches).toEqual([]);
    expect(r.verified).toBe(wanted.size);
    // the extracted hitman.exe is byte-identical to innoextract's
    expect(sha1hex(new Uint8Array(readFileSync(join(dir, "hitman.exe"))))).toBe(sha1hex(new Uint8Array(readFileSync("work/game/app/hitman.exe"))));
  }, 600000);
});
