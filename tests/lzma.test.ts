import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LzmaStream, lzmaDecode } from "../installer/src/lzma.ts";

/** Inno-style stream: 5-byte properties header, then the raw LZMA stream (python's FORMAT_ALONE minus its size field). */
function compress(data: Uint8Array, lc = 3, lp = 0, pb = 2): Uint8Array {
  const py = `import sys,lzma;d=sys.stdin.buffer.read();o=lzma.compress(d,format=lzma.FORMAT_ALONE,filters=[{"id":lzma.FILTER_LZMA1,"dict_size":1<<22,"lc":${lc},"lp":${lp},"pb":${pb}}]);sys.stdout.buffer.write(o[:5]+o[13:])`;
  const r = spawnSync("python3", ["-c", py], { input: data, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return new Uint8Array(r.stdout);
}

function rnd(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) (x = (Math.imul(x, 1103515245) + 12345) >>> 0), (b[i] = x >>> 24);
  return b;
}

describe("lzma", () => {
  it("round-trips empty, tiny, random and repetitive data", () => {
    const text = new TextEncoder().encode("hello hello hello world ".repeat(5000));
    const mixed = new Uint8Array(300000);
    mixed.set(rnd(100000, 7), 0);
    mixed.set(text.subarray(0, 100000), 100000);
    mixed.set(rnd(100000, 9), 200000);
    for (const d of [new Uint8Array([42]), rnd(65537), text, mixed]) expect(lzmaDecode(compress(d), d.length)).toEqual(d);
  });

  it("supports other lc/lp/pb and incremental reads", () => {
    const d = new TextEncoder().encode("abcabcabd".repeat(20000));
    expect(lzmaDecode(compress(d, 0, 2, 0), d.length)).toEqual(d);
    expect(lzmaDecode(compress(d, 4, 0, 4), d.length)).toEqual(d);
    const c = compress(d);
    let at = 0;
    const s = new LzmaStream(() => (at >= c.length ? null : c.subarray(at, (at += 1000))));
    const out = new Uint8Array(d.length);
    let got = 0;
    while (got < d.length) {
      const n = s.read(out, got, Math.min(777, d.length - got));
      if (!n) break;
      got += n;
    }
    expect(out).toEqual(d);
  });
});
