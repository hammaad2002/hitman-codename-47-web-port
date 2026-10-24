/// <reference lib="webworker" />
/**
 * Translates the installed Hitman modules (from OPFS) into one WebAssembly module on the player's own
 * machine and caches it in OPFS as `hitman/cache/<name>`. Messages out: progress / done / error.
 */
import { initIced } from "iced-x86";
import icedWasmUrl from "../../node_modules/iced-x86/iced_x86_bg.wasm?url";
import { translateSet, type SetMetadata } from "../../recomp/src/translate-set.ts";
import { INSTALL_DIR, cacheName, moduleSetKey, readModules } from "./cache.ts";

// Address-level metadata for each supported module set, keyed by moduleSetKey().
const METADATA = import.meta.glob("../../metadata/*.json", { query: "?url", import: "default", eager: true }) as Record<string, string>;

self.onmessage = async () => {
  try {
    const opfs = await navigator.storage.getDirectory();
    const root = await opfs.getDirectoryHandle(INSTALL_DIR);
    const files = await readModules(root);
    const key = await moduleSetKey(files);
    const metaUrl = METADATA[`../../metadata/${key}.json`];
    if (!metaUrl) throw new Error(`This version of the game is not supported yet (module set ${key}).`);
    const meta = (await (await fetch(metaUrl)).json()) as SetMetadata;
    initIced(new Uint8Array(await (await fetch(icedWasmUrl)).arrayBuffer()));
    const t0 = performance.now();
    let last = 0;
    const out = translateSet(files, meta, (phase, done, total) => {
      const now = performance.now();
      if (now - last > 100) {
        last = now;
        postMessage({ type: "progress", phase, done, total });
      }
    });
    const cache = await root.getDirectoryHandle("cache", { create: true });
    // Drop translations of earlier module sets or translator versions.
    for await (const name of (cache as unknown as { keys(): AsyncIterable<string> }).keys()) if (name !== cacheName(key)) await cache.removeEntry(name).catch(() => {});
    const fh = await cache.getFileHandle(cacheName(key), { create: true });
    const h = await (fh as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }).createSyncAccessHandle();
    h.truncate(0);
    h.write(out.wasm, { at: 0 });
    h.flush();
    h.close();
    postMessage({
      type: "done",
      name: cacheName(key),
      seconds: (performance.now() - t0) / 1000,
      bytes: out.wasm.length,
      functions: out.functions,
      irreducible: out.irreducible,
    });
  } catch (err) {
    postMessage({ type: "error", message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  }
};
