/**
 * Save backups. The game keeps its player list in Hitman.sav and each profile under Save/ in the
 * install; exporting a ZIP of those is the only backup. Restoring puts them back in place.
 */
import { INSTALL_DIR } from "./cache.ts";
import { writeOpfsFile } from "./opfs-write.ts";
import { makeZip, readZip } from "./zip.ts";

const MAX_SAVE_BYTES = 64 << 20;
const SAVE_ROOT_FILE = "hitman.sav";

export interface SaveFile {
  /** Path relative to the install, forward slashes: "Hitman.sav" or "Save/...". */
  name: string;
  data: Uint8Array<ArrayBuffer>;
  date: Date;
}

async function installRoot(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(INSTALL_DIR);
}

async function collect(dir: FileSystemDirectoryHandle, prefix: string, out: SaveFile[]): Promise<void> {
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind === "directory") await collect(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, out);
    else {
      try {
        const f = await (handle as FileSystemFileHandle).getFile();
        out.push({ name: prefix + name, data: new Uint8Array(await f.arrayBuffer()), date: new Date(f.lastModified) });
      } catch {
        // Removed while listing.
      }
    }
  }
}

/** The player list and profile files currently stored in the install. */
export async function listSaves(): Promise<SaveFile[]> {
  const out: SaveFile[] = [];
  try {
    const root = await installRoot();
    try {
      const f = await (await root.getFileHandle("Hitman.sav")).getFile();
      out.push({ name: "Hitman.sav", data: new Uint8Array(await f.arrayBuffer()), date: new Date(f.lastModified) });
    } catch {
      // No player list yet.
    }
    try {
      await collect(await root.getDirectoryHandle("Save"), "Save/", out);
    } catch {
      // No Save folder yet.
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A ZIP of all saved data, or null when there is nothing to back up. */
export async function exportSaves(): Promise<Blob | null> {
  const saves = await listSaves();
  if (!saves.length) return null;
  return new Blob([makeZip(saves)], { type: "application/zip" });
}

export interface ImportPlan {
  files: { name: string; data: Uint8Array<ArrayBuffer> }[];
  settings?: Uint8Array<ArrayBuffer>;
  overwrites: string[];
}

function canonical(path: string): string | null {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.split("/").includes("..")) return null;
  if (p.toLowerCase() === SAVE_ROOT_FILE) return "Hitman.sav";
  const m = /(?:^|\/)(save\/.+)$/i.exec(p);
  return m ? `Save/${m[1].slice(5)}` : null;
}

/** Validate chosen files (a backup ZIP, or a Hitman.sav) before writing anything. */
export async function planImport(files: File[]): Promise<ImportPlan> {
  const found = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      for (const e of await readZip(new Uint8Array(await f.arrayBuffer()))) {
        const name = canonical(e.name);
        if (name) found.set(name, e.data);
      }
    } else if (f.name.toLowerCase() === SAVE_ROOT_FILE) {
      found.set("Hitman.sav", new Uint8Array(await f.arrayBuffer()));
    } else {
      throw new Error(`${f.name} is not a Hitman save (expected Hitman.sav or a backup .zip)`);
    }
  }
  if (!found.size) throw new Error("no Hitman save files found in the selection");
  for (const [name, data] of found) if (data.length > MAX_SAVE_BYTES) throw new Error(`${name} has an unexpected size (${data.length} bytes)`);
  const existing = new Set((await listSaves()).map((s) => s.name));
  return { files: [...found].map(([name, data]) => ({ name, data })), overwrites: [...found.keys()].filter((n) => existing.has(n)) };
}

export async function applyImport(plan: ImportPlan): Promise<void> {
  for (const f of plan.files) await writeOpfsFile([INSTALL_DIR, ...f.name.split("/")], f.data);
}
