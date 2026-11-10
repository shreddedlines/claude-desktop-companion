'use strict';
/**
 * sounds.js — generates the four alert sounds as small WAV files (16-bit mono PCM) so the app has no
 * dependency on OS sound files and each state sounds distinct:
 *   finished   soft two-note ding (up)                     ~0.5 s
 *   input      rising three-note chime                     ~0.8 s
 *   permission urgent alternating double-pitch pulses x4   ~1.0 s
 *   attention  two descending-rising siren sweeps          ~1.3 s
 */
const fs = require('fs');
const path = require('path');

const SR = 22050;

function seg(freqFn, dur, vol = 0.6) {
  const n = Math.floor(SR * dur); const out = new Float32Array(n); let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; const f = freqFn(t / dur);
    phase += (2 * Math.PI * f) / SR;
    const attack = Math.min(1, i / (SR * 0.01));
    const release = Math.min(1, (n - i) / (SR * 0.06));
    out[i] = Math.sin(phase) * vol * attack * release;
  }
  return out;
}
const silence = (d) => new Float32Array(Math.floor(SR * d));
const cat = (...parts) => { const len = parts.reduce((a, p) => a + p.length, 0); const o = new Float32Array(len); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };

const SOUNDS = {
  finished: () => cat(seg(() => 659, 0.16, 0.45), seg(() => 880, 0.28, 0.45)),
  input: () => cat(seg(() => 659, 0.16), silence(0.02), seg(() => 784, 0.16), silence(0.02), seg(() => 1047, 0.3)),
  permission: () => cat(...[0, 1, 2, 3].flatMap((i) => [seg(() => (i % 2 ? 1400 : 1000), 0.13, 0.7), silence(0.07)])),
  attention: () => cat(seg((x) => 900 - 400 * x, 0.35, 0.7), seg((x) => 500 + 400 * x, 0.35, 0.7), seg((x) => 900 - 400 * x, 0.35, 0.7), seg((x) => 500 + 400 * x, 0.25, 0.7)),
};

function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 32767 | 0, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Writes any missing WAVs into dir and returns { name: absolutePath }. */
function ensureSounds(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const paths = {};
  for (const [name, gen] of Object.entries(SOUNDS)) {
    const p = path.join(dir, `${name}.wav`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, toWav(gen()));
    paths[name] = p;
  }
  return paths;
}

module.exports = { ensureSounds, SOUNDS, toWav };
