#!/usr/bin/env node
/**
 * test-step12.js — Task 3, stage 2: qr.js tested independently of everything else.
 *
 * Three independent kinds of evidence:
 *   1. structure: finder / timing / dark-module patterns, and the BCH-protected format and version information, checked bit by bit;
 *   2. capacity: the standard maximum byte counts for each version and level (a table that does NOT come from our code);
 *   3. DECODING with OpenCV (an independent QR decoder): every version x level at maximum capacity, all 8 masks, random lengths and
 *      contents, and the exact strings the app will encode. This test needs Python with OpenCV; without it the decoding checks FAIL
 *      (set QR_SKIP_DECODE=1 to skip them deliberately).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const qr = require('./qr');
const onb = require('./onboarding');
const ntfy = require('./ntfy');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const ROOT = path.resolve(__dirname, '..', 'qr-test12');

// deterministic pseudo-random numbers: failures are reproducible
let seed = 20260101; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const randText = (len, utf8 = false) => { const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/._-?=&%#@!~+ '; let s = ''; while (Buffer.byteLength(s) < len) { const c = utf8 && rnd() < 0.05 ? ['é', '日', 'ß'][Math.floor(rnd() * 3)] : alphabet[Math.floor(rnd() * alphabet.length)]; if (Buffer.byteLength(s + c) <= len) s += c; else s += 'a'; } return s; };

// ---- helpers: image writing + the OpenCV decoder -------------------------------------------------------------------------------
function pgm(modules, scale = 8, border = 4) {
  const n = modules.length; const sz = (n + 2 * border) * scale; const b = Buffer.alloc(sz * sz, 255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules[y][x]) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) b[((y + border) * scale + dy) * sz + (x + border) * scale + dx] = 0;
  return Buffer.concat([Buffer.from(`P5\n${sz} ${sz}\n255\n`), b]);
}
const DECODER = `import cv2, json, sys
# OpenCV's QR detector is known to miss some perfectly valid synthetic symbols at particular image sizes, so every symbol is tried with
# two OpenCV decoders at several scales. The test then requires (a) at least one variant to return EXACTLY the original text and
# (b) NO variant to ever return different text (a wrong decode would mean the encoder is broken).
man = json.load(open(sys.argv[1], encoding='utf-8'))
classic = cv2.QRCodeDetector()
aruco = cv2.QRCodeDetectorAruco() if hasattr(cv2, 'QRCodeDetectorAruco') else None
out = {}
for k, v in man.items():
    img = cv2.imread(v['file'], cv2.IMREAD_GRAYSCALE)
    got = []
    for scale in (1.0, 0.75, 1.25, 1.5, 2.0):
        im = img if scale == 1.0 else cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        t, _, _ = classic.detectAndDecode(im)
        if t: got.append(t)
        if aruco is not None:
            t2, _, _ = aruco.detectAndDecode(im)
            if t2: got.append(t2)
    out[k] = got
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=True).encode('ascii'))
`;
function opencvAvailable() { const r = spawnSync('python', ['-c', 'import cv2;print(cv2.__version__)'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }
let imgN = 0; const batch = {};
function queue(text, opts = {}, scale = 8, border = 4) { const q = qr.encode(text, opts); const id = `i${++imgN}`; const file = path.join(ROOT, `${id}.pgm`); fs.writeFileSync(file, pgm(q.modules, scale, border)); batch[id] = { file, text }; return { id, q }; }
function decodeBatch() {
  fs.writeFileSync(path.join(ROOT, 'dec.py'), DECODER); fs.writeFileSync(path.join(ROOT, 'man.json'), JSON.stringify(batch));
  const r = spawnSync('python', [path.join(ROOT, 'dec.py'), path.join(ROOT, 'man.json')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`decoder failed: ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

// ---- helpers: structure ------------------------------------------------------------------------------------------------------------
const bchFormatOk = (bits15) => { let rem = bits15; for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10); return rem === 0; };
function readFormat(m, copy) {
  const n = m.length; const b = [];
  if (copy === 1) { for (let i = 0; i <= 5; i++) b[i] = m[i][8]; b[6] = m[7][8]; b[7] = m[8][8]; b[8] = m[8][7]; for (let i = 9; i < 15; i++) b[i] = m[8][14 - i]; }
  else { for (let i = 0; i < 8; i++) b[i] = m[8][n - 1 - i]; for (let i = 8; i < 15; i++) b[i] = m[n - 15 + i][8]; }
  let v = 0; for (let i = 14; i >= 0; i--) v = (v << 1) | (b[i] ? 1 : 0);
  return v ^ 0x5412;
}
const FORMAT_ECL = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
function finderOk(m, ox, oy) {
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3)); const expect = ring !== 2; if (m[oy + y][ox + x] !== expect) return false; }
  return true;
}
function separatorsWhite(m) {
  const n = m.length;
  for (let i = 0; i < 8; i++) { if (m[7][i] || m[i][7] || m[7][n - 1 - i] || m[i][n - 8] || m[n - 8][i] || m[n - 1 - i][7]) return false; }
  return true;
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });

  // =========================================================================================================
  console.log('== A) capacity: the standard byte-mode table (independent of the code under test)');
  const STD = { 1: [17, 14, 11, 7], 2: [32, 26, 20, 14], 3: [53, 42, 32, 24], 4: [78, 62, 46, 34], 5: [106, 84, 60, 44], 6: [134, 106, 74, 58], 7: [154, 122, 86, 64], 8: [192, 152, 108, 84], 9: [230, 180, 130, 98], 10: [271, 213, 151, 119] };
  let capOk = true; const capBad = [];
  for (const [v, caps] of Object.entries(STD)) ['L', 'M', 'Q', 'H'].forEach((l, i) => { if (qr.capacityBytes(Number(v), l) !== caps[i]) { capOk = false; capBad.push(`v${v}${l}`); } });
  check('capacityBytes equals the standard table for all 10 versions x 4 levels', capOk, capBad.join(','));
  let fitOk = true;
  for (const [v, caps] of Object.entries(STD)) ['L', 'M', 'Q', 'H'].forEach((l, i) => {
    const full = qr.encode('a'.repeat(caps[i]), { ecl: l }); if (full.version !== Number(v)) fitOk = false;
    if (Number(v) < 10) { if (qr.encode('a'.repeat(caps[i] + 1), { ecl: l }).version !== Number(v) + 1) fitOk = false; } else { try { qr.encode('a'.repeat(caps[i] + 1), { ecl: l }); fitOk = false; } catch (e) { if (!(e instanceof RangeError)) fitOk = false; } }
  });
  check('a payload of exactly the capacity picks that version; one byte more picks the next (version 10 + 1 byte throws RangeError)', fitOk);
  const q0 = qr.encode('');
  check('the empty string encodes (version 1); sizes are 17 + 4 x version', q0.version === 1 && q0.size === 21 && qr.encode('a'.repeat(100)).size === 17 + 4 * qr.encode('a'.repeat(100)).version);
  let typeErr = false; try { qr.encode(123); } catch (e) { typeErr = e instanceof TypeError; }
  let eclErr = false; try { qr.encode('x', { ecl: 'Z' }); } catch (e) { eclErr = e instanceof RangeError; }
  check('a non-string and an unknown error-correction level are rejected with a clear error type', typeErr && eclErr);
  check('encoding is deterministic: the same input gives the identical matrix', JSON.stringify(qr.encode('ntfy://ntfy.sh/claude-abcdefghjkmnpqrs').modules) === JSON.stringify(qr.encode('ntfy://ntfy.sh/claude-abcdefghjkmnpqrs').modules));
  check('minVersion forces a larger symbol', qr.encode('hi', { minVersion: 5 }).version === 5);

  // =========================================================================================================
  console.log('== B) structure of the generated symbols');
  const samples = []; for (let v = 1; v <= 10; v++) for (const l of ['L', 'M', 'Q', 'H']) samples.push(qr.encode('a'.repeat(qr.capacityBytes(v, l)), { ecl: l }));
  check('three finder patterns (7x7 rings) at the right corners of all 40 symbols', samples.every((s) => finderOk(s.modules, 0, 0) && finderOk(s.modules, s.size - 7, 0) && finderOk(s.modules, 0, s.size - 7)));
  check('the white separators around the finder patterns are intact', samples.every((s) => separatorsWhite(s.modules)));
  check('timing patterns alternate dark/light along row 6 and column 6', samples.every((s) => { for (let i = 8; i < s.size - 8; i++) if (s.modules[6][i] !== (i % 2 === 0) || s.modules[i][6] !== (i % 2 === 0)) return false; return true; }));
  check('the always-dark module is present', samples.every((s) => s.modules[s.size - 8][8] === true));
  check('format information: both copies agree, pass the BCH check, and decode back to the level and mask that were used', samples.every((s) => { const a = readFormat(s.modules, 1); const b = readFormat(s.modules, 2); return a === b && bchFormatOk(a) && FORMAT_ECL[(a >>> 13) & 3] === s.ecl && ((a >>> 10) & 7) === s.mask; }));
  const withVer = samples.filter((s) => s.version >= 7);
  const readVersion = (m, which) => { const n = m.length; let v = 0; for (let i = 17; i >= 0; i--) { const a = n - 11 + (i % 3); const b = Math.floor(i / 3); v = (v << 1) | ((which === 1 ? m[b][a] : m[a][b]) ? 1 : 0); } return v; };
  check('version information (versions 7-10): both copies agree, pass the BCH check and decode to the version', withVer.length === 16 && withVer.every((s) => { const a = readVersion(s.modules, 1); const b = readVersion(s.modules, 2); let rem = a; for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1F25 << (i - 12); return a === b && rem === 0 && (a >>> 12) === s.version; }));
  check('alignment pattern: version 2 has the 5x5 pattern centred at (18,18)', (() => { const m = qr.encode('a'.repeat(30), { ecl: 'L' }).modules; if (qr.encode('a'.repeat(30), { ecl: 'L' }).version !== 2) return false; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (m[18 + dy][18 + dx] !== (Math.max(Math.abs(dx), Math.abs(dy)) !== 1)) return false; return true; })());
  const rows = qr.toRows(qr.encode('x').modules);
  check('toRows returns one 0/1 string per row, square', rows.length === 21 && rows.every((r) => /^[01]{21}$/.test(r)));
  const qrCode = fs.readFileSync(path.join(__dirname, 'qr.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('the encoder is a pure function: no randomness, no clock, no file, process or network access, no other module', !/Math\.random|Date\.now|crypto|process\.|require\(|fs\./.test(qrCode));

  // =========================================================================================================
  console.log('== C) decoded by an independent decoder (OpenCV)');
  const cv = process.env.QR_SKIP_DECODE === '1' ? 'skipped' : opencvAvailable();
  check('OpenCV is available for the decoding checks', !!cv, cv || 'python -c "import cv2" failed');
  if (cv && cv !== 'skipped') {
    const expectations = [];                                                       // [description, id list]
    const grp = (name, ids) => expectations.push([name, ids]);
    // C1: every version x level at maximum capacity
    const c1 = []; for (let v = 1; v <= 10; v++) for (const l of ['L', 'M', 'Q', 'H']) c1.push(queue(randText(qr.capacityBytes(v, l)), { ecl: l }).id);
    grp('every version (1-10) x every level (L/M/Q/H) at MAXIMUM capacity decodes to exactly the original text (40 symbols)', c1);
    // C2: all 8 masks
    const c2 = []; for (const t of ['ntfy://ntfy.sh/claude-abcdefghjkmnpqrs', 'https://play.google.com/store/apps/details?id=io.heckel.ntfy', 'HELLO WORLD', randText(60), randText(120), '0123456789']) for (let mask = 0; mask < 8; mask++) for (const l of ['M', 'Q']) { const r = queue(t, { ecl: l, mask }); if (r.q.mask !== mask) throw new Error('forced mask not applied'); c2.push(r.id); }
    grp('all 8 mask patterns decode (6 texts x 8 masks x levels M and Q = 96 symbols)', c2);
    // C3: random lengths and contents
    const c3 = []; for (let i = 0; i < 160; i++) c3.push(queue(randText(1 + Math.floor(rnd() * 120)), { ecl: ['L', 'M'][i % 2] }).id);
    grp('160 random texts of 1-120 bytes at levels L and M decode', c3);
    const c3u = []; for (let i = 0; i < 24; i++) c3u.push(queue(randText(10 + Math.floor(rnd() * 60), true), { ecl: 'M' }).id);
    grp('24 texts with non-ASCII characters (UTF-8) decode', c3u);
    // C4: the exact strings the app encodes
    const c4 = []; for (let i = 0; i < 30; i++) { const topic = `claude-${ntfy.friendlyRandom(16)}`; c4.push(queue(onb.deepLink({ server: 'https://ntfy.sh', topic })).id); }
    c4.push(queue(onb.PLAY_URL).id, queue(onb.FDROID_URL).id, queue(onb.deepLink({ server: 'http://127.0.0.1:8080', topic: 'claude-abcdefghjkmnpqrs' })).id, queue(onb.deepLink({ server: 'https://ntfy.example.org:8443', topic: 'claude-abcdefghjkmnpqrs' })).id);
    grp('the exact strings the app encodes (30 fresh deep links, Google Play and F-Droid URLs, self-hosted forms) decode', c4);
    // C5: other module sizes and quiet zones
    const c5 = []; for (const [sc, bd] of [[4, 4], [6, 4], [10, 4], [12, 4], [8, 6]]) c5.push(queue('ntfy://ntfy.sh/claude-abcdefghjkmnpqrs', {}, sc, bd).id);
    grp('the same symbol rendered at module sizes 4/6/8/10/12 px and different quiet zones decodes', c5);

    const out = decodeBatch();
    for (const [name, ids] of expectations) {
      const never = ids.filter((id) => !out[id].includes(batch[id].text));
      const wrong = ids.filter((id) => out[id].some((t) => t !== batch[id].text));
      const flaky = ids.filter((id) => out[id].length < 10 && out[id].includes(batch[id].text)).length;
      check(name, never.length === 0 && wrong.length === 0, never.length || wrong.length ? `${never.length} never decoded, ${wrong.length} decoded to DIFFERENT text, e.g. ${[...never, ...wrong].slice(0, 3).map((id) => `${id}(v${qr.encode(batch[id].text).version},len ${Buffer.byteLength(batch[id].text)})`).join(' ')}` : `${ids.length} symbols, every one decoded exactly (OpenCV missed some variants for ${flaky} of them: its detector is flaky, never wrong)`);
    }
    // C6: the decoder really rejects a damaged symbol (so the checks above are not vacuous)
    const dmg = qr.encode('ntfy://ntfy.sh/claude-abcdefghjkmnpqrs'); for (let y = 0; y < dmg.size; y++) for (let x = 0; x < dmg.size; x++) if (x > 6 && x < dmg.size - 7 && y > 6 && y < dmg.size - 7 && (x * 7 + y * 3) % 5 !== 0) dmg.modules[y][x] = !dmg.modules[y][x];
    const dfile = path.join(ROOT, 'damaged.pgm'); fs.writeFileSync(dfile, pgm(dmg.modules));
    for (const k of Object.keys(batch)) delete batch[k]; batch.damaged = { file: dfile, text: 'ntfy://ntfy.sh/claude-abcdefghjkmnpqrs' };
    check('CONTROL: a deliberately corrupted symbol is NOT decoded to the original text by ANY decoder variant (the decoder is a real check)', !decodeBatch().damaged.includes(batch.damaged.text));
  }

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
