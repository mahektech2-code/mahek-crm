/* ---------------------------------------------------------------------------
 * A minimal QR code encoder: byte mode, error correction L, versions 1–4
 * (up to 78 bytes). That is all an office's attendance code needs — a short
 * text like "MMI-ATT-104" — and it saves shipping a dependency, or sending the
 * code to Google Chart's QR service the way the source did (spec §5.1).
 *
 * Written from ISO/IEC 18004: Reed–Solomon over GF(256) with 0x11D, the
 * finder, timing and alignment patterns, the zig-zag data placement, the eight
 * masks scored by the standard's four penalty rules, and the BCH-coded format
 * bits.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

/** Data and EC codewords per version at level L (one block each for 1–4). */
const L_BLOCKS: Record<number, { data: number; ec: number }> = {
  1: { data: 19, ec: 7 },
  2: { data: 34, ec: 10 },
  3: { data: 55, ec: 15 },
  4: { data: 80, ec: 20 },
};

/** Byte-mode capacity at level L: data codewords less 4 mode bits and 8 count bits. */
export const QR_MAX_BYTES = 78;

/* ------------------------------------------------------------ Reed–Solomon */

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of the given degree, highest term implied, as coefficients. */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The EC codewords for `data`. */
export function rsRemainder(data: number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/* ------------------------------------------------------------ format bits */

/** The 15 format bits for level L and a mask, BCH-coded and XOR-masked. */
export function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask; // L is 01
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/* ---------------------------------------------------------------- encoder */

export type QrMatrix = { size: number; version: number; mask: number; dark: boolean[][] };

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Data codewords for byte mode at level L, padded to the version's capacity. */
export function dataCodewords(bytes: number[], version: number): number[] {
  const cap = L_BLOCKS[version].data;
  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < cap; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/**
 * Encodes `text` (UTF-8) as a QR code. Throws when it does not fit version 4
 * at level L — an attendance code is a dozen characters, so that is a typo.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8(text);
  const version = [1, 2, 3, 4].find((v) => bytes.length <= L_BLOCKS[v].data - 2);
  if (!version) throw new Error(`QR text too long: ${bytes.length} bytes, at most ${QR_MAX_BYTES}.`);
  const size = version * 4 + 17;
  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, d: boolean) => {
    dark[y][x] = d;
    fn[y][x] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(x, y, dist !== 2 && dist !== 4);
      }
  }
  // The one alignment pattern versions 2–4 have (the others sit on finders).
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Reserve the format areas (drawn per mask below) and the dark module.
  const drawFormat = (mask: number) => {
    const b = formatBits(mask);
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(b, i));
    setFn(8, 7, bit(b, 6));
    setFn(8, 8, bit(b, 7));
    setFn(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(b, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);

  // Data then EC, placed in the zig-zag.
  const data = dataCodewords(bytes, version);
  const all = [...data, ...rsRemainder(data, L_BLOCKS[version].ec)];
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < all.length * 8) {
          dark[y][x] = bit(all[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        let inv: boolean;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (inv) dark[y][x] = !dark[y][x];
      }
  };

  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const score = penalty(dark);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
    applyMask(m); // XOR undoes it
  }
  applyMask(best);
  drawFormat(best);
  return { size, version, mask: best, dark };
}

/** The standard's four penalty rules, which pick the most scannable mask. */
export function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < n; y++) lines.push(m[y]);
  for (let x = 0; x < n; x++) lines.push(m.map((row) => row[x]));
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 7 <= n; i++) {
      if (!finder.every((v, k) => line[i + k] === v)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
      const lightAfter = i + 11 <= n && [0, 1, 2, 3].every((k) => !line[i + 7 + k]);
      if (lightBefore || lightAfter) score += 40;
    }
  }
  for (let y = 0; y + 1 < n; y++)
    for (let x = 0; x + 1 < n; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  const darkCount = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  score += 10 * Math.floor(Math.abs((darkCount * 100) / (n * n) - 50) / 5);
  return score;
}

/** The code as one SVG path (a unit square per dark module), with a four-module quiet zone. */
export function qrSvgPath(q: QrMatrix, quiet = 4): { d: string; viewBox: string } {
  let d = "";
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++) if (q.dark[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const w = q.size + quiet * 2;
  return { d, viewBox: `0 0 ${w} ${w}` };
}
