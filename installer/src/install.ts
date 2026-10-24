/**
 * Installs Hitman: Codename 47 from the player's disc image: finds the GOG installer on the ISO 9660
 * volume, reads its Inno Setup data and writes the manifest's files (verified by SHA-1) into the sink.
 */
import { patchHitmanIni } from "./hitman-ini.ts";
import { extractWanted, openInno, type Wanted } from "./inno.ts";
import { type ByteSource, type FileSink, SliceSource } from "./io.ts";
import { IsoImage } from "./iso9660.ts";
import manifest from "../manifest.json" with { type: "json" };

export const PRODUCT_NAME = "Hitman: Codename 47";

export interface InstallProgress {
  phase: "scan" | "extract" | "done";
  done: number;
  total: number;
  path?: string;
}

export interface InstallOptions {
  onProgress?: (p: InstallProgress) => void;
}

export interface InstallReport {
  written: number;
  bytes: number;
  verified: number;
  mismatches: string[];
}

/** The installer is the one big .exe on the disc (GOG names it setup_hitman_codename_47_*.exe). */
function findInstaller(image: IsoImage): { offset: number; size: number } {
  const exes = image.list().filter((e) => !e.isDir && /\.exe$/i.test(e.name));
  if (!exes.length) throw new Error("This disc image has no installer program: is it the GOG Hitman: Codename 47 disc?");
  return exes.sort((a, b) => b.size - a.size)[0];
}

export async function install(iso: ByteSource, sink: FileSink, opts: InstallOptions = {}): Promise<InstallReport> {
  opts.onProgress?.({ phase: "scan", done: 0, total: 1 });
  const exe = findInstaller(new IsoImage(iso));
  const src = new SliceSource(iso, exe.offset, exe.size);
  const setup = openInno(src);
  const wanted = new Map<string, Wanted>();
  for (const m of manifest as { dest: string; sha1: string }[]) {
    const w = wanted.get(m.sha1) ?? { dests: [] };
    w.dests.push(m.dest);
    wanted.set(m.sha1, w);
  }
  // Hitman.ini is rewritten after extraction (renderer choice), so collect it instead of writing it directly.
  let ini: Uint8Array | undefined;
  const collecting: FileSink = {
    writeFile(path, data) {
      if (path.toLowerCase() === "hitman.ini") ini = data;
      else return sink.writeFile(path, data);
    },
  };
  const r = await extractWanted(src, setup, wanted, collecting, (done, total, path) => opts.onProgress?.({ phase: "extract", done, total, path }));
  if (r.missing.length) throw new Error(`The installer is missing ${r.missing.length} expected files (first: ${r.missing[0]}): not a supported build.`);
  if (!ini) throw new Error("The installer has no Hitman.ini: not a supported build.");
  await sink.writeFile("Hitman.ini", new TextEncoder().encode(patchHitmanIni(new TextDecoder().decode(ini))));
  opts.onProgress?.({ phase: "done", done: r.written, total: r.written });
  return { written: r.written, bytes: r.bytes, verified: r.verified, mismatches: r.mismatches };
}
