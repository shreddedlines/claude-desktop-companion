'use strict';
/**
 * qr.js — a small, dependency-free QR Code encoder (ISO/IEC 18004), byte mode, versions 1-10, error correction L/M/Q/H.
 *
 * Used by the phone setup window to draw the "scan to subscribe" code. Inputs here are short (a deep link of about 40 characters,
 * a store URL of about 60), so versions 1-10 (up to 271 bytes at level L) are far more than enough; longer input throws.
 * It is verified in test-step12.js by decoding the generated symbols with an independent decoder (OpenCV).
 *
 *   const { encode, toRows } = require('./qr');
 *   const q = encode('ntfy://ntfy.sh/claude-<topic>');   // { version, size, ecl, mask, modules }
 *   toRows(q.modules)                                              // ['1110111...', ...]  one string per row, '1' = dark
 */

const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS = [1, 0, 3, 2];                                      // indexed by ECL ordinal: L=01, M=00, Q=11, H=10
// index = version (0 unused). Standard tables (ISO/IEC 18004 table 9), versions 1..10
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],      // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],     // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],     // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],     // H
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],               // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],               // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],               // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],               // H
];
const MAX_VERSION = 10;

// ---- capacity helpers ------------------------------------------------------------------------------------------------------
function rawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = (ver, ecl) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
const charCountBits = (ver) => (ver <= 9 ? 8 : 16);
/** the largest number of BYTES a symbol of this version and level can carry */
function capacityBytes(ver, ecl) { return Math.floor((dataCodewords(ver, ECL[ecl]) * 8 - 4 - charCountBits(ver)) / 8); }

// ---- Reed-Solomon over GF(256), polynomial 0x11D -------------------------------------------------------------------------------
function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1; let root = 1;
  for (let i = 0; i < degree; i++) { for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = gfMul(root, 0x02); }
  return r;
}
function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
  return r;
}

// ---- bit buffer -----------------------------------------------------------------------------------------------------------------
function appendBits(bits, value, len) { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); }

function buildCodewords(bytes, ver, eclIdx) {
  const bits = [];
  appendBits(bits, 0x4, 4);                                            // byte mode
  appendBits(bits, bytes.length, charCountBits(ver));
  for (const b of bytes) appendBits(bits, b, 8);
  const capBits = dataCodewords(ver, eclIdx) * 8;
  appendBits(bits, 0, Math.min(4, capBits - bits.length));             // terminator
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) appendBits(bits, pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; data.push(v); }

  // split into blocks, add error correction, interleave
  const nBlocks = NUM_BLOCKS[eclIdx][ver]; const eccLen = ECC_PER_BLOCK[eclIdx][ver];
  const rawCw = Math.floor(rawDataModules(ver) / 8);
  const nShort = nBlocks - (rawCw % nBlocks); const shortLen = Math.floor(rawCw / nBlocks);
  const div = rsDivisor(eccLen); const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const len = shortLen - eccLen + (i < nShort ? 0 : 1);
    const dat = data.slice(k, k + len); k += len;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);                                       // placeholder so short and long blocks interleave by column
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });
  return out;
}

// ---- matrix construction --------------------------------------------------------------------------------------------------------
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2; const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6]; for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

function makeMatrix(ver) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }      // timing patterns
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy)); const x = cx + dx; const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const pos = alignmentPositions(ver);
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  return { size, modules, isFn, set };
}

function drawFormat(M, eclIdx, mask) {
  const data = (FORMAT_BITS[eclIdx] << 3) | mask; let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412; const bit = (i) => ((bits >>> i) & 1) !== 0; const { size, set } = M;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);                                                                  // the always-dark module
}
function drawVersion(M, ver) {
  if (ver < 7) return;
  let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  const bits = (ver << 12) | rem; const { size, set } = M;
  for (let i = 0; i < 18; i++) { const dark = ((bits >>> i) & 1) !== 0; const a = size - 11 + (i % 3); const b = Math.floor(i / 3); set(a, b, dark); set(b, a, dark); }
}

function drawCodewords(M, cw) {
  const { size, modules, isFn } = M; let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j; const upward = ((right + 1) & 2) === 0; const y = upward ? size - 1 - vert : vert;
      if (!isFn[y][x] && i < cw.length * 8) { modules[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function applyMask(M, mask) { const { size, modules, isFn } = M; for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x]; }

function penalty(modules) {
  const size = modules.length; let score = 0;
  const runs = (get) => { for (let a = 0; a < size; a++) { let run = 1; for (let b = 1; b < size; b++) { if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1; } } };
  runs((a, b) => modules[a][b]); runs((a, b) => modules[b][a]);                              // rule 1: runs of 5+ in rows and columns
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = modules[y][x]; if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3; }   // rule 2: 2x2 blocks
  const pats = ['10111010000', '00001011101'];                                              // rule 3: finder-like patterns
  const line = (get) => { for (let a = 0; a < size; a++) { let s = ''; for (let b = 0; b < size; b++) s += get(a, b) ? '1' : '0'; for (const p of pats) { let i = s.indexOf(p); while (i >= 0) { score += 40; i = s.indexOf(p, i + 1); } } } };
  line((a, b) => modules[a][b]); line((a, b) => modules[b][a]);
  let dark = 0; for (const row of modules) for (const v of row) if (v) dark++;                // rule 4: dark/light balance
  score += Math.floor(Math.abs((dark * 20) - (size * size * 10)) / (size * size)) * 10;
  return score;
}

// ---- public API ----------------------------------------------------------------------------------------------------------------------
/**
 * @param {string} text
 * @param {{ecl?:'L'|'M'|'Q'|'H', minVersion?:number, mask?:number}} [opts]  mask forces one of the 8 masks (tests); default = best penalty
 * @returns {{version:number, size:number, ecl:string, mask:number, modules:boolean[][]}}
 */
function encode(text, { ecl = 'M', minVersion = 1, mask: forcedMask } = {}) {
  if (typeof text !== 'string') throw new TypeError('qr.encode expects a string');
  if (!(ecl in ECL)) throw new RangeError(`unknown error correction level ${ecl}`);
  const eclIdx = ECL[ecl]; const bytes = Buffer.from(text, 'utf8');
  let ver = Math.max(1, minVersion);
  while (ver <= MAX_VERSION && capacityBytes(ver, ecl) < bytes.length) ver++;
  if (ver > MAX_VERSION) throw new RangeError(`text is too long for a QR code here (${bytes.length} bytes; at most ${capacityBytes(MAX_VERSION, ecl)} at level ${ecl})`);
  const cw = buildCodewords([...bytes], ver, eclIdx);

  const build = (mask) => { const M = makeMatrix(ver); drawFormat(M, eclIdx, 0); drawVersion(M, ver); drawCodewords(M, cw); applyMask(M, mask); drawFormat(M, eclIdx, mask); return M; };
  let best = null;
  if (forcedMask !== undefined) best = { mask: forcedMask, M: build(forcedMask) };
  else for (let m = 0; m < 8; m++) { const M = build(m); const p = penalty(M.modules); if (!best || p < best.p) best = { mask: m, M, p }; }
  return { version: ver, size: best.M.size, ecl, mask: best.mask, modules: best.M.modules };
}

/** one string per row, '1' = dark module: the compact form the setup window receives */
const toRows = (modules) => modules.map((row) => row.map((v) => (v ? '1' : '0')).join(''));

module.exports = { encode, toRows, capacityBytes, MAX_VERSION, ECL };
