/**
 * Developer CLI: install the game from a disc image into a directory.
 *   node installer/src/cli.ts <disc.iso> <outdir>
 */
import { install } from "./install.ts";
import { DirSink, NodeFileSource } from "./node.ts";

const [isoPath, outDir] = process.argv.slice(2);
if (!isoPath || !outDir) {
  console.error("usage: node installer/src/cli.ts <disc.iso> <outdir>");
  process.exit(2);
}
const src = new NodeFileSource(isoPath);
const t0 = performance.now();
let last = 0;
const report = await install(src, new DirSink(outDir), {
  onProgress: (p) => {
    const now = performance.now();
    if (now - last > 1000 || p.phase === "done") {
      last = now;
      process.stderr.write(`\r${p.phase} ${p.done}/${p.total} ${p.path ?? ""}`.padEnd(100).slice(0, 100));
    }
  },
});
src.close();
console.error(`\nwrote ${report.written} files (${(report.bytes / 1e6).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s; SHA-1 verified ${report.verified}`);
if (report.mismatches.length) {
  console.error(`${report.mismatches.length} problems:\n  ${report.mismatches.slice(0, 20).join("\n  ")}`);
  process.exit(1);
}
