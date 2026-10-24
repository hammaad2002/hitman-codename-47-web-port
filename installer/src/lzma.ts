/**
 * Streaming LZMA decoder for Inno Setup streams. LZMA1: a 5-byte header (properties byte,
 * little-endian dictionary size) followed by a raw stream with no size field and no end marker.
 * LZMA2 (used for the file data): one dictionary-size byte, then LZMA2 chunks. The caller
 * pulls as many output bytes as it needs; input arrives through a synchronous refill callback
 * (installers run in a Worker where reads are synchronous).
 */

export type Refill = () => Uint8Array | null;

const TOP = 1 << 24;
const BITS = 11;
const PROB_INIT = 1 << (BITS - 1);

// Probability array layout (offsets into one Uint16Array).
const IS_MATCH = 0; // [12 << 4]
const IS_REP = IS_MATCH + (12 << 4);
const IS_REP_G0 = IS_REP + 12;
const IS_REP_G1 = IS_REP_G0 + 12;
const IS_REP_G2 = IS_REP_G1 + 12;
const IS_REP0_LONG = IS_REP_G2 + 12; // [12 << 4]
const POS_SLOT = IS_REP0_LONG + (12 << 4); // [4 << 6]
const SPEC_POS = POS_SLOT + (4 << 6); // [115]
const ALIGN = SPEC_POS + 115; // [16]
const LEN_CODER = ALIGN + 16;
const REP_LEN_CODER = LEN_CODER + 514;
// Length coder: choice, choice2, low[16][8], mid[16][8], high[256]
const LEN_CHOICE = 0, LEN_CHOICE2 = 1, LEN_LOW = 2, LEN_MID = LEN_LOW + 128, LEN_HIGH = LEN_MID + 128;
const LITERAL = REP_LEN_CODER + 514;

export class LzmaStream {
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private readonly lzma2: boolean;
  private readonly dict: Uint8Array;
  private pos = 0; // position since the last dictionary reset (drives the lp/pb contexts)
  private chunkLeft = 0; // LZMA2: output bytes left in the current chunk
  private chunkKind = 0; // LZMA2: 0 none, 1 uncompressed, 2 lzma
  private chunkPacked = 0;
  private consumed = 0;
  private readonly probs: Uint16Array;
  private dictPos = 0;
  private dictFull = 0; // bytes of history available (capped at dict size)
  private range = 0xffffffff;
  private code = 0;
  private inBuf: Uint8Array = new Uint8Array(0);
  private inPos = 0;
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  private pendingLen = 0;
  private total = 0; // bytes produced so far
  private ended = false;

  private readonly refill: Refill;

  constructor(refill: Refill, lzma2 = false) {
    this.refill = refill;
    this.lzma2 = lzma2;
    if (lzma2) {
      const d = this.byte();
      if (d > 40) throw new Error("lzma2: bad dictionary size");
      const dictSize = d === 40 ? 1 << 30 : (2 | (d & 1)) * 2 ** ((d >> 1) + 11);
      this.dict = new Uint8Array(Math.max(4096, Math.min(dictSize, 1 << 30)));
      this.probs = new Uint16Array(LITERAL + (0x300 << 4));
      return;
    }
    const props = new Uint8Array(5);
    for (let i = 0; i < 5; i++) props[i] = this.byte();
    this.setProps(props[0]);
    const dictSize = (props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0;
    this.dict = new Uint8Array(Math.max(4096, Math.min(dictSize, 1 << 30)));
    this.probs = new Uint16Array(LITERAL + (0x300 << (this.lc + this.lp)));
    this.resetState();
    this.initCoder();
  }

  private setProps(p: number): void {
    if (p >= 9 * 5 * 5) throw new Error("lzma: bad properties");
    this.lc = p % 9;
    p = (p / 9) | 0;
    this.lp = p % 5;
    this.pb = (p / 5) | 0;
  }

  private resetState(): void {
    this.probs.fill(PROB_INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    this.pendingLen = 0;
  }

  private initCoder(): void {
    this.range = 0xffffffff;
    this.code = 0;
    if (this.byte() !== 0) throw new Error("lzma: bad range coder header");
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }

  /** Decompressed bytes produced so far. */
  get position(): number {
    return this.total;
  }

  private byte(): number {
    if (this.inPos >= this.inBuf.length) {
      const next = this.refill();
      if (!next || next.length === 0) {
        this.ended = true;
        throw new LzmaEnd();
      }
      this.inBuf = next;
      this.inPos = 0;
    }
    this.consumed++;
    return this.inBuf[this.inPos++];
  }

  private bit(i: number): number {
    const probs = this.probs;
    const p = probs[i];
    if (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
    const bound = (this.range >>> BITS) * p;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + (((1 << BITS) - p) >>> 5);
      return 0;
    }
    this.range -= bound;
    this.code -= bound;
    probs[i] = p - (p >>> 5);
    return 1;
  }

  private direct(n: number): number {
    let r = 0;
    while (n--) {
      if (this.range < TOP) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.byte()) >>> 0;
      }
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      r = ((r << 1) | b) >>> 0;
    }
    return r;
  }

  private tree(base: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(base + m);
    return m - (1 << bits);
  }

  private reverseTree(base: number, bits: number): number {
    let m = 1, sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }

  private len(base: number, posState: number): number {
    if (this.bit(base + LEN_CHOICE) === 0) return this.tree(base + LEN_LOW + (posState << 3), 3);
    if (this.bit(base + LEN_CHOICE2) === 0) return 8 + this.tree(base + LEN_MID + (posState << 3), 3);
    return 16 + this.tree(base + LEN_HIGH, 8);
  }

  /** Fill `out[off, off+len)`; returns the number of bytes written (less than `len` only at the end of the stream). */
  read(out: Uint8Array, off = 0, len = out.length - off): number {
    if (!this.lzma2) return this.run(out, off, len);
    let n = 0;
    try {
      while (n < len) {
        if (this.chunkLeft === 0 && !this.nextChunk()) break;
        const want = Math.min(len - n, this.chunkLeft);
        let got: number;
        if (this.chunkKind === 1) {
          for (let i = 0; i < want; i++) this.putByte((out[off + n + i] = this.byte()));
          got = want;
        } else {
          got = this.run(out, off + n, want);
          if (got < want) throw new Error("lzma2: chunk ended early");
        }
        n += got;
        this.chunkLeft -= got;
        if (this.chunkLeft === 0 && this.chunkKind === 2) while (this.consumed < this.chunkPacked) this.byte();
      }
    } catch (e) {
      if (!(e instanceof LzmaEnd)) throw e;
    }
    return n;
  }

  /** Parse the next LZMA2 chunk header; false at the end marker. */
  private nextChunk(): boolean {
    const c = this.byte();
    if (c === 0) {
      this.ended = true;
      return false;
    }
    if (c < 0x80) {
      if (c > 2) throw new Error("lzma2: bad control byte");
      if (c === 1) (this.dictFull = 0), (this.dictPos = 0), (this.pos = 0);
      this.chunkLeft = ((this.byte() << 8) | this.byte()) + 1;
      this.chunkKind = 1;
      return true;
    }
    this.chunkLeft = (((c & 0x1f) << 16) | (this.byte() << 8) | this.byte()) + 1;
    const packed = ((this.byte() << 8) | this.byte()) + 1;
    const mode = (c >> 5) & 3;
    if (mode === 3) (this.dictFull = 0), (this.dictPos = 0), (this.pos = 0);
    if (mode >= 2) {
      this.setProps(this.byte());
      if (this.lc + this.lp > 4) throw new Error("lzma2: bad properties");
    }
    if (mode >= 1) this.resetState();
    this.consumed = 0;
    this.chunkPacked = packed;
    this.chunkKind = 2;
    this.initCoder();
    return true;
  }

  private putByte(b: number): void {
    this.dict[this.dictPos] = b;
    if (++this.dictPos === this.dict.length) this.dictPos = 0;
    if (this.dictFull < this.dict.length) this.dictFull++;
    this.pos++;
    this.total++;
  }

  private run(out: Uint8Array, off: number, len: number): number {
    let n = 0;
    const dict = this.dict;
    const dsize = dict.length;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
        const put = (b: number) => {
      this.putByte(b);
      out[off + n++] = b;
    };
    try {
      while (n < len) {
        if (this.pendingLen > 0) {
          let src = this.dictPos - this.rep0 - 1;
          if (src < 0) src += dsize;
          while (this.pendingLen > 0 && n < len) {
            put(dict[src]);
            if (++src === dsize) src = 0;
            this.pendingLen--;
          }
          continue;
        }
        const posState = this.pos & pbMask;
        const st = this.state;
        if (this.bit(IS_MATCH + (st << 4) + posState) === 0) {
          // Literal.
          const prev = this.dictFull > 0 ? dict[(this.dictPos === 0 ? dsize : this.dictPos) - 1] : 0;
          const base = LITERAL + 0x300 * (((this.pos & lpMask) << this.lc) + (prev >> (8 - this.lc)));
          let sym = 1;
          if (st >= 7) {
            let match = dict[(this.dictPos - this.rep0 - 1 + dsize) % dsize];
            while (sym < 0x100) {
              const mb = (match >> 7) & 1;
              match <<= 1;
              const b = this.bit(base + ((1 + mb) << 8) + sym);
              sym = (sym << 1) | b;
              if (mb !== b) break;
            }
          }
          while (sym < 0x100) sym = (sym << 1) | this.bit(base + sym);
          put(sym & 0xff);
          this.state = st < 4 ? 0 : st < 10 ? st - 3 : st - 6;
          continue;
        }
        let length: number;
        if (this.bit(IS_REP + st) === 0) {
          // Simple match.
          this.rep3 = this.rep2;
          this.rep2 = this.rep1;
          this.rep1 = this.rep0;
          length = this.len(LEN_CODER, posState);
          this.state = st < 7 ? 7 : 10;
          const lenState = length < 4 ? length : 3;
          const slot = this.tree(POS_SLOT + (lenState << 6), 6);
          if (slot < 4) {
            this.rep0 = slot;
          } else {
            const nd = (slot >> 1) - 1;
            let dist = ((2 | (slot & 1)) << nd) >>> 0;
            if (slot < 14) dist = (dist + this.reverseTree(SPEC_POS + dist - slot - 1, nd)) >>> 0;
            else dist = (dist + this.direct(nd - 4) * 16 + this.reverseTree(ALIGN, 4)) >>> 0;
            this.rep0 = dist;
            if (dist === 0xffffffff) {
              this.ended = true; // end marker
              break;
            }
          }
        } else {
          if (this.dictFull === 0) throw new Error("lzma: corrupt stream");
          if (this.bit(IS_REP_G0 + st) === 0) {
            if (this.bit(IS_REP0_LONG + (st << 4) + posState) === 0) {
              // Short rep: one byte from rep0.
              this.state = st < 7 ? 9 : 11;
              put(dict[(this.dictPos - this.rep0 - 1 + dsize) % dsize]);
              continue;
            }
          } else {
            let dist: number;
            if (this.bit(IS_REP_G1 + st) === 0) {
              dist = this.rep1;
            } else {
              if (this.bit(IS_REP_G2 + st) === 0) {
                dist = this.rep2;
              } else {
                dist = this.rep3;
                this.rep3 = this.rep2;
              }
              this.rep2 = this.rep1;
            }
            this.rep1 = this.rep0;
            this.rep0 = dist;
          }
          length = this.len(REP_LEN_CODER, posState);
          this.state = st < 7 ? 8 : 11;
        }
        if (this.rep0 >= this.dictFull) throw new Error("lzma: distance beyond the dictionary");
        this.pendingLen = length + 2;
      }
    } catch (e) {
      if (!(e instanceof LzmaEnd)) throw e;
    }
    return n;
  }

  get finished(): boolean {
    return this.ended;
  }
}

class LzmaEnd extends Error {}

/** Decode a whole in-memory stream (header included) into exactly `size` bytes. */
export function lzmaDecode(input: Uint8Array, size: number): Uint8Array {
  let given = false;
  const s = new LzmaStream(() => (given ? null : ((given = true), input)));
  const out = new Uint8Array(size);
  const n = s.read(out);
  if (n !== size) throw new Error(`lzma: stream ended after ${n} of ${size} bytes`);
  return out;
}
