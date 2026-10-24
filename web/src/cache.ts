/** OPFS locations shared by the page and its workers. */
import { MODULE_TABLE } from "../../recomp/src/translate-set.ts";
import { TRANSLATOR_VERSION } from "../../recomp/src/version.ts";

export const INSTALL_DIR = "hitman";
/** Present in INSTALL_DIR while an install is in progress (or was interrupted). */
export const INSTALLING_MARKER = ".installing";

/** Bumped when shipped metadata / translation inputs change (invalidates OPFS game wasm cache). */
export const TRANSLATE_ENTRY_HINTS = "meta1";

/** Cached in-browser translation of a given module set (by its key) for this translator version. */
export function cacheName(key: string): string {
  return `game-${key}-t${TRANSLATOR_VERSION}-${TRANSLATE_ENTRY_HINTS}.wasm`;
}

export async function sha256(bytes: BufferSource): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The installed module files (hitman.exe and its DLLs), read whole. */
export async function readModules(root: FileSystemDirectoryHandle): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const { name } of MODULE_TABLE) files.set(name, new Uint8Array(await (await (await root.getFileHandle(name)).getFile()).arrayBuffer()));
  return files;
}

/** Key of a module set: first 16 hex chars of sha256 over the concatenated per-module sha256 strings (docs/ARCH.md). */
export async function moduleSetKey(files: Map<string, Uint8Array>): Promise<string> {
  let all = "";
  for (const { name } of MODULE_TABLE) all += await sha256(files.get(name)!.slice());
  return (await sha256(new TextEncoder().encode(all))).slice(0, 16);
}
