#!/usr/bin/env node
/**
 * Lists a PE executable's imports: one `dll!name` line per import (in image order), then a
 * summary line `N imports: dll count, ...` sorted by count descending.
 *
 *   node tools/gen-imports.mjs <exe>
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { PeImage } from "../recomp/src/pe.ts";

if (process.argv.length !== 3) {
  console.error(`usage: ${basename(process.argv[1])} <exe>`);
  process.exit(2);
}

const image = new PeImage(new Uint8Array(readFileSync(process.argv[2])));
const counts = new Map();
for (const im of image.imports) {
  console.log(`${im.dll}!${im.name}`);
  counts.set(im.dll, (counts.get(im.dll) ?? 0) + 1);
}
const sorted = [...counts].sort((a, b) => b[1] - a[1]);
console.log(`${image.imports.length} imports: ${sorted.map(([dll, n]) => `${dll} ${n}`).join(", ")}`);
