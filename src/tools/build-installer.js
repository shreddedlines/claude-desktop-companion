'use strict';
/**
 * tools/build-installer.js -- builds ClaudeNotifierSetup.exe (Inno Setup 6) from a COPY of the verified release stage.
 *
 *   node tools/build-installer.js [--version 1.0.0] [--test] [--out DIR] [--name BASENAME]
 *
 *   1. `stage.js --check` on the release stage (read-only); the stage itself is never written
 *   2. the stage is copied to <work>/payload and every copied file is re-verified against MANIFEST.txt
 *   3. ISCC compiles tools/installer/ClaudeNotifier.iss; stop-notifier.ps1 is embedded as an encoded command
 *   --test builds the isolated variant (own app id / shortcut / startup value / toast key) used by test-step20.js
 * Nothing here is shipped inside the installer except the payload; this tool needs no network.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');                         // the repository root (the folder above src)
const STAGE = path.join(ROOT, 'release', 'stage');
const ISCC = path.join(ROOT, 'tools', 'innosetup', 'ISCC.exe');
const IS = path.join(__dirname, 'installer');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const TEST = process.argv.includes('--test');
const VERSION = arg('--version', '1.0.0');
const OUT = arg('--out', path.join(ROOT, 'installer', TEST ? 'out-test' : 'out'));
const NAME = arg('--name', TEST ? `ClaudeNotifierSetup-test-${VERSION}` : 'ClaudeNotifierSetup');
const WORK = path.join(ROOT, 'installer', 'work');
const fail = (m) => { console.error(`build-installer: ${m}`); process.exit(1); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

if (!fs.existsSync(ISCC)) fail(`Inno Setup compiler not found at ${ISCC}`);
const chk = spawnSync(process.execPath, [path.join(__dirname, 'stage.js'), '--check', STAGE], { encoding: 'utf8' });
if (chk.status !== 0) fail(`the release stage failed stage.js --check:\n${chk.stdout}${chk.stderr}`);
console.log((chk.stdout.trim().split('\n').pop()));

// the payload: a separate copy (only our own previous copy is ever replaced)
const payload = path.join(WORK, 'payload');
if (fs.existsSync(WORK) && !fs.existsSync(path.join(WORK, '.installer-work'))) fail(`${WORK} exists and is not ours`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true }); fs.writeFileSync(path.join(WORK, '.installer-work'), 'x');
fs.cpSync(STAGE, payload, { recursive: true });
const lines = fs.readFileSync(path.join(payload, 'MANIFEST.txt'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
let bad = 0;
for (const l of lines) { const m = /^([0-9a-f]{64}) (\d+) (.+)$/.exec(l); if (!m || sha(path.join(payload, m[3])) !== m[1]) bad++; }
if (bad) fail(`${bad} payload file(s) differ from the manifest`);
console.log(`payload: ${lines.length} files + MANIFEST.txt copied to a separate folder and verified against the manifest`);

// the stop script, as a PowerShell -EncodedCommand (UTF-16LE base64)
const stopB64 = Buffer.from(fs.readFileSync(path.join(IS, 'stop-notifier.ps1'), 'utf8'), 'utf16le').toString('base64');
fs.mkdirSync(OUT, { recursive: true });
const defs = [`/DPayloadDir=${payload}`, `/DOutDir=${OUT}`, `/DOutName=${NAME}`, `/DAppVersion=${VERSION}`, `/DStopB64=${stopB64}`, ...(TEST ? ['/DTestMode=1'] : [])];
const r = spawnSync(ISCC, [...defs, path.join(IS, 'ClaudeNotifier.iss')], { encoding: 'utf8' });
const tail = (r.stdout || '').trim().split('\n').slice(-6).join('\n');
if (r.status !== 0) fail(`ISCC failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
console.log(tail);
const exe = path.join(OUT, `${NAME}.exe`);
console.log(`built ${exe}  ${fs.statSync(exe).size} bytes  sha256 ${sha(exe)}`);
