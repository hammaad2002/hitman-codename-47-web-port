/**
 * Hitman module-set CLI.
 * node recomp/src/cli-set.ts metadata <gameDir> [--out metadata/<key>.json]
 * node recomp/src/cli-set.ts gen-wasm <gameDir> --meta metadata/<key>.json [--out work/gen-wasm]
 * Output of gen-wasm is translated game code: write it under work/ only, never commit it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Program } from "./cfg.ts";
import { MODULE_TABLE, buildSetMetadata, loadSet, rootEntries, translateSet, type SetMetadata } from "./translate-set.ts";

const [cmd, dir] = process.argv.slice(2);
const opt = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
if ((cmd !== "metadata" && cmd !== "gen-wasm") || !dir) {
  console.error("usage: node recomp/src/cli-set.ts metadata|gen-wasm <gameDir> [--meta file] [--out path]");
  process.exit(2);
}
const names = readdirSync(dir);
const files = new Map<string, Uint8Array>();
for (const { name } of MODULE_TABLE) {
  const real = names.find((n) => n.toLowerCase() === name.toLowerCase());
  if (!real) throw new Error(`${name} not found in ${dir}`);
  files.set(name, new Uint8Array(readFileSync(join(dir, real))));
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

if (cmd === "metadata") {
  const set = loadSet(files);
  const prog = new Program(set, { entries: rootEntries(set) });
  const t0 = performance.now();
  prog.discover({ speculate: true });
  const modules = set.modules.map((m) => ({ name: m.name, sha256: sha(files.get(m.name)!), size: files.get(m.name)!.length, base: m.imageBase }));
  const meta = buildSetMetadata(prog, modules);
  const key = sha(new TextEncoder().encode(modules.map((m) => m.sha256).join(""))).slice(0, 16);
  const path = opt("--out") ?? `metadata/${key}.json`;
  writeFileSync(path, JSON.stringify(meta) + "\n");
  console.log(`metadata: ${meta.entries.length} functions, ${meta.noreturn.length} no-return, ${meta.jumpTargets.length} jump tables in ${(performance.now() - t0).toFixed(0)} ms -> ${path}`);
} else {
  const meta = JSON.parse(readFileSync(opt("--meta")!, "utf8")) as SetMetadata;
  for (const m of meta.modules) if (sha(files.get(m.name)!) !== m.sha256) throw new Error(`${m.name} is not the supported build`);
  const res = translateSet(files, meta);
  const out = opt("--out") ?? "work/gen-wasm";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "game.wasm"), res.wasm);
  console.log(`${res.functions} functions, discover ${res.ms.discover.toFixed(0)} ms, translate ${res.ms.translate.toFixed(0)} ms, ${(res.wasm.length / 1048576).toFixed(1)} MB (${res.irreducible} irreducible)`);
}
