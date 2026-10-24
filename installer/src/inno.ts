/**
 * Reader for the one Inno Setup layout this port supports: GOG's offline installer of Hitman: Codename 47
 * (Inno Setup 5.5.7, unicode, LZMA1, data embedded in the .exe). It finds the setup data inside the
 * installer, reads the file-location table and extracts files by SHA-1, so nothing but the
 * installer's own bytes is needed (the destination names come from the shipped manifest).
 * Format knowledge: the open-source innoextract project (zlib licence).
 */
import { LzmaStream } from "./lzma.ts";
import { type ByteSource, SliceSource, latin1, u16, u32 } from "./io.ts";

export interface DataEntry {
  firstSlice: number;
  chunkOffset: number;
  fileOffset: number;
  fileSize: number;
  chunkSize: number;
  sha1: string;
  /** CallInstructionOptimized: x86 call/jmp targets were made absolute by the compressor. */
  callFilter: boolean;
  compressed: boolean;
  encrypted: boolean;
}

export interface InnoSetup {
  version: string;
  dataOffset: number;
  entries: DataEntry[];
}

const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 4294967296;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** File offset of the RCDATA/11111 resource (the setup loader's offset table). */
function findLoaderTable(src: ByteSource): number {
  const dos = src.read(0, 64);
  const pe = u32(dos, 0x3c);
  const head = src.read(pe, 24 + 224);
  if (u32(head, 0) !== 0x4550) throw new Error("not a PE installer");
  const nsec = u16(head, 6), optSize = u16(head, 20);
  const rsrcRva = u32(head, 24 + 112);
  const secs = src.read(pe + 24 + optSize, nsec * 40);
  const toFile = (rva: number) => {
    for (let i = 0; i < nsec; i++) {
      const va = u32(secs, i * 40 + 12), raw = u32(secs, i * 40 + 20), size = Math.max(u32(secs, i * 40 + 8), u32(secs, i * 40 + 16));
      if (rva >= va && rva < va + size) return raw + (rva - va);
    }
    throw new Error("resource outside every section");
  };
  const rsrc = toFile(rsrcRva);
  const dir = (off: number, id: number): number => {
    const h = src.read(rsrc + off, 16);
    const n = u16(h, 12) + u16(h, 14);
    const ents = src.read(rsrc + off + 16, n * 8);
    for (let i = 0; i < n; i++) if (u32(ents, i * 8) === id) return u32(ents, i * 8 + 4) & 0x7fffffff;
    throw new Error(`resource id ${id} not found`);
  };
  const first = (off: number): number => {
    const ents = src.read(rsrc + off + 16, 8);
    return u32(ents, 4) & 0x7fffffff;
  };
  const type = dir(0, 10); // RT_RCDATA
  const name = dir(type, 11111);
  const dataEntry = first(name);
  return toFile(u32(src.read(rsrc + dataEntry, 16), 0));
}

/** Concatenates the payload of a block (4 KiB chunks, each preceded by a CRC32), checking the CRCs. */
function readBlock(src: ByteSource, pos: number): { data: Uint8Array; next: number } {
  const h = src.read(pos, 9);
  const stored = u32(h, 4);
  const compressed = h[8] !== 0;
  if (crc32(h.subarray(4, 9)) !== u32(h, 0)) throw new Error("inno: block header CRC mismatch");
  const raw = src.read(pos + 9, stored);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let o = 0; o < raw.length; ) {
    const n = Math.min(4096, raw.length - o - 4);
    if (n <= 0) throw new Error("inno: truncated block");
    const body = raw.subarray(o + 4, o + 4 + n);
    if (crc32(body) !== u32(raw, o)) throw new Error("inno: block chunk CRC mismatch");
    parts.push(body);
    total += n;
    o += 4 + n;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) (joined.set(p, at), (at += p.length));
  if (!compressed) return { data: joined, next: pos + 9 + stored };
  let given = false;
  const s = new LzmaStream(() => (given ? null : ((given = true), joined)));
  const out: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const buf = new Uint8Array(1 << 20);
    const n = s.read(buf);
    if (n === 0) break;
    out.push(buf.subarray(0, n));
    len += n;
  }
  const data = new Uint8Array(len);
  at = 0;
  for (const p of out) (data.set(p, at), (at += p.length));
  return { data, next: pos + 9 + stored };
}

const RECORD = 74; // first/last slice, chunk offset, file offset, file size, chunk size, SHA-1, filetime, version, flags

export function openInno(src: ByteSource): InnoSetup {
  const t = findLoaderTable(src);
  const tab = src.read(t, 12 + 4 * 8);
  if (latin1(tab, 0, 6) !== "rDlPtS") throw new Error("inno: unknown setup loader");
  const headerOffset = u32(tab, 12 + 4 * 5);
  const dataOffset = u32(tab, 12 + 4 * 6);
  const id = latin1(src.read(headerOffset, 64), 0, 64).replace(/\0.*$/, "");
  if (!/\(5\.5\.7\)/.test(id)) throw new Error(`inno: unsupported setup version "${id}"`);
  const first = readBlock(src, headerOffset + 64);
  const second = readBlock(src, first.next);
  const entries: DataEntry[] = [];
  // The decoder may emit a few garbage bytes past the last real record: only whole records count and
  // the caller matches them by SHA-1, so extra ones are never used.
  for (let o = 0; o + RECORD <= second.data.length; o += RECORD) {
    const d = second.data;
    const flags = u16(d, o + 72);
    entries.push({
      firstSlice: u32(d, o),
      chunkOffset: u32(d, o + 8),
      fileOffset: u64(d, o + 12),
      fileSize: u64(d, o + 20),
      chunkSize: u64(d, o + 28),
      sha1: hex(d.subarray(o + 36, o + 56)),
      callFilter: (flags & 0x10) !== 0,
      compressed: (flags & 0x80) !== 0,
      encrypted: (flags & 0x40) !== 0,
    });
  }
  return { version: id, dataOffset, entries };
}

export interface Wanted {
  /** Destination paths (relative, forward slashes) of the file with this SHA-1. */
  dests: string[];
}

export interface ExtractSink {
  writeFile(path: string, data: Uint8Array): Promise<void> | void;
}

/** Inno's call-instruction filter, 5.3.9+ flavour: undoes the E8/E9 relative->absolute conversion in place. */
export function decodeCallFilter(buf: Uint8Array): void {
  let offset = 0;
  for (let i = 0; i < buf.length; ) {
    const b = buf[i++];
    offset++;
    if (b !== 0xe8 && b !== 0xe9) continue;
    if (0x10000 - ((offset - 1) % 0x10000) < 5) continue;
    if (i + 4 > buf.length) break;
    offset += 4;
    i += 4;
    if (buf[i - 1] === 0x00 || buf[i - 1] === 0xff) {
      const rel = ((buf[i - 4] | (buf[i - 3] << 8) | (buf[i - 2] << 16)) - (offset & 0xffffff)) | 0;
      buf[i - 4] = rel;
      buf[i - 3] = rel >> 8;
      buf[i - 2] = rel >> 16;
      if (rel & 0x800000) buf[i - 1] = ~buf[i - 1] & 0xff;
    }
  }
}

export interface ExtractReport {
  written: number;
  bytes: number;
  verified: number;
  mismatches: string[];
  missing: string[];
}

/**
 * Extract every entry whose SHA-1 is in `wanted`. Entries of one solid chunk are decoded in order
 * (the stream cannot be entered in the middle); every written file is checked against its SHA-1.
 */
export async function extractWanted(
  src: ByteSource,
  setup: InnoSetup,
  wanted: Map<string, Wanted>,
  sink: ExtractSink,
  onProgress?: (done: number, total: number, path: string) => void,
): Promise<ExtractReport> {
  const report: ExtractReport = { written: 0, bytes: 0, verified: 0, mismatches: [], missing: [] };
  const byChunk = new Map<string, DataEntry[]>();
  const seen = new Set<string>();
  for (const e of setup.entries) {
    if (!wanted.has(e.sha1) || seen.has(e.sha1)) continue;
    if (e.encrypted) throw new Error("inno: encrypted chunks are not supported");
    seen.add(e.sha1);
    const key = `${e.firstSlice}:${e.chunkOffset}`;
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key)!.push(e);
  }
  for (const sha of wanted.keys()) if (!seen.has(sha)) report.missing.push(...wanted.get(sha)!.dests);
  const totalFiles = seen.size;
  let done = 0;
  const scratch = new Uint8Array(1 << 20);
  for (const list of byChunk.values()) {
    list.sort((a, b) => a.fileOffset - b.fileOffset);
    const c = list[0];
    const start = setup.dataOffset + c.chunkOffset;
    if (latin1(src.read(start, 4), 0, 3) !== "zlb") throw new Error("inno: bad chunk magic");
    const body = new SliceSource(src, start + 4, c.chunkSize);
    let at = 0;
    const s = new LzmaStream(() => {
      if (at >= body.size) return null;
      const n = Math.min(4 << 20, body.size - at);
      const r = body.read(at, n);
      at += n;
      return r;
    }, true); // file data is LZMA2; the header blocks are LZMA1
    let pos = 0; // bytes of the decoded chunk consumed
    for (const e of list) {
      while (pos < e.fileOffset) {
        const n = s.read(scratch, 0, Math.min(scratch.length, e.fileOffset - pos));
        if (n === 0) throw new Error("inno: chunk ended early");
        pos += n;
      }
      const data = new Uint8Array(e.fileSize);
      let got = 0;
      while (got < data.length) {
        const n = s.read(data, got, data.length - got);
        if (n === 0) throw new Error("inno: chunk ended inside a file");
        got += n;
      }
      pos += data.length;
      if (e.callFilter) decodeCallFilter(data);
      const w = wanted.get(e.sha1)!;
      if (sha1hex(data) === e.sha1) report.verified++;
      else report.mismatches.push(w.dests[0]);
      for (const d of w.dests) {
        await sink.writeFile(d, data);
        report.written++;
        report.bytes += data.length;
      }
      onProgress?.(++done, totalFiles, w.dests[0]);
    }
  }
  return report;
}

// ---- Checksums -----------------------------------------------------------------------------

let crcTable: Uint32Array | undefined;
export function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sha1hex(data: Uint8Array): string {
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const n = data.length;
  const padded = new Uint8Array(((n + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(n / 0x20000000), false);
  dv.setUint32(padded.length - 4, (n << 3) >>> 0, false);
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) (f = (b & c) | (~b & d)), (k = 0x5a827999);
      else if (i < 40) (f = b ^ c ^ d), (k = 0x6ed9eba1);
      else if (i < 60) (f = (b & c) | (b & d) | (c & d)), (k = 0x8f1bbcdc);
      else (f = b ^ c ^ d), (k = 0xca62c1d6);
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h[0] += a, h[1] += b, h[2] += c, h[3] += d, h[4] += e;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
