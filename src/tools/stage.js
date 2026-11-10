'use strict';
/**
 * tools/stage.js — reproducible release STAGING from an explicit allowlist, with privacy gates.
 *
 *   node tools/stage.js [--out DIR] [--node PATH-TO-node.exe]     build (default DIR: <repo>/../release/stage)
 *   node tools/stage.js --check DIR                               re-verify an existing staging folder (manifest + every gate)
 *
 * Layout produced:
 *   <out>/RUNTIME.txt  <out>/MANIFEST.txt
 *   <out>/app/ClaudeNotifier.exe   (the signed Node.js runtime, byte-identical, renamed)
 *   <out>/app/<application files>  <out>/app/THIRD-PARTY-NOTICES.txt  <out>/app/LICENSES/NODE-LICENSE.txt
 *
 * Safety properties:
 *   - allowlist only: nothing is copied by pattern, and an unexpected OR missing file fails the build;
 *   - the build happens in <out>.building and replaces <out> only after every gate passed (a failure leaves the old output alone);
 *   - an existing <out> is only replaced if it is recognisably a previous output of this tool (it contains MANIFEST.txt);
 *   - it never writes to, or deletes anything in, any other folder (existing stage / debug folders are never touched);
 *   - reproducible: the output depends only on the source files, the pinned runtime and the pinned licence (no timestamps, no
 *     absolute paths, no user name in any generated file) => two builds give a byte-identical MANIFEST.txt;
 *   - protected strings (your ntfy topic/token, user name, host name, home and source paths) are read in memory to be searched
 *     for, and are NEVER printed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

// ---- pinned inputs --------------------------------------------------------------------------------------------------------
const PINNED_NODE_VERSION = 'v24.18.0';
const PINNED_NODE_SHA256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
const PINNED_LICENSE_SHA256 = '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5';
const LICENSE_SOURCE = path.join(__dirname, 'licenses', 'NODE-LICENSE.txt');
const LICENSE_URL = `https://github.com/nodejs/node/blob/${PINNED_NODE_VERSION}/LICENSE`;
const RUNTIME_NAME = 'ClaudeNotifier.exe';

const APP_FILES = ['notifier.js', 'supervisor.js', 'merge-events.js', 'watch-sessions.js', 'log-tailer.js', 'policy.js', 'store.js', 'ntfy.js',
  'usage-monitor.js', 'claude-profile.js', 'devhooks.js', 'winpaths.js', 'onboarding.js', 'qr.js', 'theme.js', 'palette.js', 'setup-controller.js', 'setup-window.ps1', 'health.js', 'lock.js', 'paths.js', 'autostart.js', 'sounds.js', 'ui-host.ps1', 'app-shortcut.ps1', 'notify-once.ps1', 'Claude-Notifier.vbs'];
/** application files whose RELEASE content is not the file of the same name in the source tree (development hooks -> inert stub) */
const RELEASE_SOURCE = { 'devhooks.js': path.join(__dirname, 'release', 'devhooks.js') };
const sourceOf = (src, f) => RELEASE_SOURCE[f] || path.join(src, f);
/** names of development/test mechanisms: they must not appear anywhere in a distributed build */
const DEV_ONLY_STRINGS = [
  '--data-dir', '--sessions-dir', '--log-dir', '--dir', '--ui', '--control-stdin', '--dump-menu', '--no-lock', '--no-usage', '--usage-file',
  '--usage-poll-ms', '--usage-fresh-ms', '--usage-stale-gap-ms', '--health-grace-ms', '--health-blind-ms', '--health-stall-ms', '--health-limit',
  '--profile-refresh-ms', '--activity-margin-ms', '--duration', '--interval', '--hb-ms', '--gap', '--autostart-key', '--autostart-value',
  '--replay-days', '--once', '--stats', '--all-entrypoints', '--no-verify', '--verify-interval', '--blind-probe-ms', '--heartbeat-ms',
  '--mock-claude-processes', 'NOTIFIER_TEST_CRASH_MS', '--first-run-setup', '--system-theme',
];   // kept identical to DEV_CONTROLS in devhooks.js (test-step10 proves it)
const devControlRegex = (name) => new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
/** a system program started by bare name would be looked up through PATH: forbidden in shipped code (use winpaths.js) */
const BARE_LAUNCH = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`](powershell|pwsh|reg|explorer|tasklist|taskkill|cmd|wscript|cscript|where|sc|schtasks)(\.exe)?['"`]/;
const DEV_ENV_PATTERN = /process.env.NOTIFIER_[A-Z0-9_]+/;
const GENERATED_APP_FILES = ['THIRD-PARTY-NOTICES.txt'];
const LICENSE_REL = 'app/LICENSES/NODE-LICENSE.txt';
const ROOT_FILES = ['RUNTIME.txt', 'MANIFEST.txt'];
/** every file the package must contain, as forward-slash paths relative to the staging root (MANIFEST.txt lists all but itself) */
const EXPECTED = [...ROOT_FILES, ...APP_FILES.map((f) => `app/${f}`), ...GENERATED_APP_FILES.map((f) => `app/${f}`), `app/${RUNTIME_NAME}`, LICENSE_REL];

const FORBIDDEN_EXT = /\.(db|sqlite|sqlite3|log|json|wav|map|bak|tmp|orig|rej|swp|lnk|env|pem|key|pfx|crt|ps1xml|pdb|ipdb)$/i;
const FORBIDDEN_NAME = /(^|\/)(test-|\.git|\.vscode|\.idea|node_modules|\.launchtest|\.stage|dbg|debug|scratch|tmp)/i;
const TEXT_EXT = /\.(js|ps1|vbs|txt)$/i;
const DEBUG_PATTERNS = [[/\bdebugger\s*;/, 'debugger statement'], [/\bconsole\.(trace|debug)\s*\(/, 'console.trace/debug call'], [/\b(describe|it|test)\.only\s*\(/, '.only( test filter'], [/\b(FIXME|XXX|HACKME)\b/, 'FIXME/XXX marker'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block']];
/** an ntfy topic as this app generates them (claude- + 16 look-alike-free characters): NO file may ever contain one */
const TOPIC_SHAPE = /claude-[a-hj-km-np-z2-9]{16}/;
/** the setup window only renders and reports clicks: network access or file / registry writes in it would be a defect */
const UI_ONLY_FORBIDDEN = /Invoke-WebRequest|Invoke-RestMethod|WebClient|HttpClient|Net\.Sockets|Out-File|Set-Content|Add-Content|WriteAllText|New-Item|Remove-Item|\[IO\.File\]|\[System\.IO\.File\]|Registry|HKCU/i;
const PERSONAL_PATH = /[A-Za-z]:[\\/]+(Users|Documents and Settings|claude_notification)\b/i;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (f) => sha256(fs.readFileSync(f));
const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (root, f) => path.relative(root, f).replace(/\\/g, '/');
const NO_NODE_PATH = [`${process.env.SystemRoot || 'C:\\Windows'}\\System32`, process.env.SystemRoot || 'C:\\Windows'].join(';');

function listFiles(root) {
  const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(rel(root, p)); } })(root);
  return out.sort();
}

/** strings that must never appear in the package. Read in memory only; never printed. */
function protectedStrings(repoRoot) {
  const strings = []; const add = (label, value, opts = {}) => { if (value && String(value).length >= (opts.min || 3)) strings.push({ label, value: String(value), wordOnly: !!opts.wordOnly, textOnly: !!opts.textOnly }); };
  try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-notifier', 'ntfy.json'), 'utf8')); add('ntfy topic', c.topic); add('ntfy token', c.token); } catch { /* no local config: nothing to leak */ }
  const user = os.userInfo().username; const host = os.hostname();
  add('Windows user name', user, { min: 2, wordOnly: true, textOnly: user.length < 6 });
  add('computer name', host, { min: 4, wordOnly: true });
  add('home folder', os.homedir(), { min: 6 });
  add('source folder', repoRoot, { min: 6 });
  add('source folder (parent)', path.dirname(repoRoot), { min: 6 });
  return strings;
}
const hasNeedle = (haystack, n, isBinary) => {
  if (isBinary && n.textOnly) return false;
  if (!n.wordOnly) return haystack.includes(n.value);
  if (isBinary) return haystack.includes(n.value);
  return new RegExp(`(^|[^A-Za-z0-9])${n.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(haystack);
};

// ---- the files the package needs, from the code itself ----------------------------------------------------------------------
/** static closure: every local require('./x') and every *.ps1 referenced from the shipped code must be in the package */
function dependencyProblems(appDir) {
  const have = new Set(fs.readdirSync(appDir).map((f) => f.toLowerCase())); const problems = [];
  for (const f of fs.readdirSync(appDir).filter((n) => /\.(js|vbs|ps1)$/i.test(n))) {
    const text = fs.readFileSync(path.join(appDir, f), 'utf8');
    for (const m of text.matchAll(/require\(\s*['"]\.\/([A-Za-z0-9_.-]+)['"]\s*\)/g)) { const t = /\.js$/i.test(m[1]) ? m[1] : `${m[1]}.js`; if (!have.has(t.toLowerCase())) problems.push(`${f} requires ./${m[1]}, which is not in the package`); }
    for (const m of text.matchAll(/['"]([A-Za-z0-9_-]+\.(?:ps1|vbs))['"]/g)) if (!have.has(m[1].toLowerCase())) problems.push(`${f} references ${m[1]}, which is not in the package`);
  }
  for (const entry of ['supervisor.js', 'notifier.js', 'merge-events.js', 'watch-sessions.js', 'ui-host.ps1', 'Claude-Notifier.vbs']) if (!have.has(entry.toLowerCase())) problems.push(`entry point ${entry} is missing`);
  return problems;
}

// ---- manifest ---------------------------------------------------------------------------------------------------------------
function buildManifest(root) {
  const lines = ['# Claude Notifier release manifest — sha256, size, path (sorted; no timestamps, no absolute paths)'];
  for (const f of listFiles(root).filter((x) => x !== 'MANIFEST.txt')) { const b = fs.readFileSync(path.join(root, f)); lines.push(`${sha256(b)} ${b.length} ${f}`); }
  return `${lines.join('\n')}\n`;
}
function manifestProblems(root) {
  const p = path.join(root, 'MANIFEST.txt'); if (!fs.existsSync(p)) return ['MANIFEST.txt is missing'];
  const listed = new Map(); for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const m = /^([0-9a-f]{64}) (\d+) (.+)$/.exec(l); if (m) listed.set(m[3], { sha: m[1], size: Number(m[2]) }); }
  const problems = []; const actual = listFiles(root).filter((x) => x !== 'MANIFEST.txt');
  for (const f of actual) { const e = listed.get(f); if (!e) { problems.push(`not in manifest: ${f}`); continue; } const b = fs.readFileSync(path.join(root, f)); if (b.length !== e.size || sha256(b) !== e.sha) problems.push(`hash/size mismatch: ${f}`); }
  for (const f of listed.keys()) if (!actual.includes(f)) problems.push(`listed but missing: ${f}`);
  return problems;
}

// ---- runtime verification (always on the STAGED copy) ----------------------------------------------------------------------------
function runtimeFacts(exe) {
  const out = { version: null, signature: null, signer: null, sha256: sha256File(exe) };
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: NO_NODE_PATH } }); out.version = v.status === 0 ? v.stdout.trim() : null;
  try {
    const j = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; @{status="$($s.Status)"; subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress`], { encoding: 'utf8' }));
    out.signature = j.status; out.signer = j.subject;
  } catch { out.signature = 'unknown'; }
  return out;
}
function runtimeProblems(exe) {
  const f = runtimeFacts(exe); const p = [];
  if (f.version !== PINNED_NODE_VERSION) p.push(`runtime version is ${f.version}, pinned ${PINNED_NODE_VERSION}`);
  if (f.signature !== 'Valid' || !/OpenJS Foundation/i.test(f.signer || '')) p.push(`runtime signature is not a valid OpenJS Foundation signature (${f.signature})`);
  if (f.sha256 !== PINNED_NODE_SHA256) p.push('runtime SHA-256 differs from the pinned value');
  return { problems: p, facts: f };
}

// ---- the scan -------------------------------------------------------------------------------------------------------------------
/**
 * All gates on a staging folder. Returns { problems: string[], info: string[], counts }.
 * `problems` empty => the package may be used. Protected strings are searched for but never included in a message.
 */
function scanStage(root, { repoRoot = path.resolve(__dirname, '..') } = {}) {
  const problems = []; const info = [];
  const files = listFiles(root);
  const missing = EXPECTED.filter((f) => !files.includes(f)); const extra = files.filter((f) => !EXPECTED.includes(f));
  if (missing.length) problems.push(`missing expected files: ${missing.join(', ')}`);
  if (extra.length) problems.push(`unexpected files in the package: ${extra.join(', ')}`);
  for (const f of files) if (FORBIDDEN_EXT.test(f) || FORBIDDEN_NAME.test(f)) problems.push(`forbidden file (type/name): ${f}`);
  problems.push(...manifestProblems(root));
  if (fs.existsSync(path.join(root, LICENSE_REL)) && sha256File(path.join(root, LICENSE_REL)) !== PINNED_LICENSE_SHA256) problems.push('Node.js licence text differs from the pinned SHA-256');
  const appDir = path.join(root, 'app'); if (fs.existsSync(appDir)) problems.push(...dependencyProblems(appDir));
  const exe = path.join(root, 'app', RUNTIME_NAME); let facts = null;
  if (fs.existsSync(exe)) { const r = runtimeProblems(exe); problems.push(...r.problems); facts = r.facts; }

  const needles = protectedStrings(repoRoot); const hitsBy = new Map();
  let scannedText = 0; let scannedBinary = 0;
  for (const f of files) {
    const full = path.join(root, f); const isText = TEXT_EXT.test(f);
    let data; try { data = isText ? fs.readFileSync(full, 'utf8') : fs.readFileSync(full); } catch { problems.push(`unreadable: ${f}`); continue; }
    if (isText) {
      scannedText++;
      if (PERSONAL_PATH.test(data)) problems.push(`${f}: contains a personal/machine path pattern`);
      if (!f.startsWith('app/LICENSES/')) for (const d of DEV_ONLY_STRINGS) if (devControlRegex(d).test(data)) problems.push(`${f}: development/test control present (${d})`);
      if (BARE_LAUNCH.test(data)) problems.push(`${f}: starts a system program by bare name (PATH lookup); use winpaths.js`);
      if (!f.startsWith('app/LICENSES/') && TOPIC_SHAPE.test(data)) problems.push(`${f}: contains a string shaped like an ntfy topic (a topic must never be shipped)`);
      if (f === 'app/setup-window.ps1') {
        if (/[^\x00-\x7F]/.test(data)) problems.push(`${f}: contains non-ASCII characters (Windows PowerShell 5.1 would misread them)`);
        if (UI_ONLY_FORBIDDEN.test(data)) problems.push(`${f}: the setup window must be user-interface only (found network / file / registry access)`);
      }
      if (DEV_ENV_PATTERN.test(data)) problems.push(`${f}: reads a NOTIFIER_* development environment variable`);
      for (const [re, what] of DEBUG_PATTERNS) if (re.test(data)) problems.push(`${f}: development artifact (${what})`);
      if (/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/.test(data.replace(/\u0000/g, ''))) info.push(`${f}: contains control characters`);
    } else scannedBinary++;
    for (const n of needles) if (hasNeedle(isText ? data : data, n, !isText)) { hitsBy.set(n.label, [...(hitsBy.get(n.label) || []), f]); }
  }
  for (const [label, fl] of hitsBy) problems.push(`protected string found (${label}) in: ${fl.join(', ')}`);
  // the development hooks module must be the inert production stub (identical to tools/release/devhooks.js)
  const dh = path.join(root, 'app', 'devhooks.js');
  if (fs.existsSync(dh)) {
    if (sha256File(dh) !== sha256File(RELEASE_SOURCE['devhooks.js'])) problems.push('app/devhooks.js is not the inert production stub (the development hooks must not ship)');
    else info.push('development hooks: inert production stub shipped (no mock process source, no crash injector)');
  }
  return { problems, info, facts, counts: { files: files.length, textScanned: scannedText, binaryScanned: scannedBinary, protectedStrings: needles.length, protectedLabels: needles.map((n) => n.label) } };
}

// ---- build ----------------------------------------------------------------------------------------------------------------------
function noticesText(version) {
  return [
    'Claude Notifier — third-party notices', '',
    `This product bundles the Node.js ${version} runtime, unmodified, as ${RUNTIME_NAME}.`,
    'Node.js is copyright Node.js contributors and is licensed under the terms in LICENSES\\NODE-LICENSE.txt',
    `(also at ${LICENSE_URL}). Node.js source: https://nodejs.org/download/release/${version}/node-${version}.tar.gz`,
    'The executable keeps its original Authenticode signature (OpenJS Foundation).', '',
    'Claude Notifier itself uses no other third-party code.', '',
  ].join('\r\n');
}
function runtimeText(facts) {
  return `Node.js runtime ${facts.version} (official, unmodified, renamed ${RUNTIME_NAME})\r\nSigner: ${facts.signer}\r\nSHA256: ${facts.sha256}\r\n`;
}

function build({ src = path.resolve(__dirname, '..'), out, nodePath = process.execPath, log = console.log } = {}) {
  const fail = (m) => { const e = new Error(m); e.stageFailure = true; throw e; };
  out = path.resolve(out);
  if (out === src || out.startsWith(src + path.sep) || src.startsWith(out + path.sep)) fail('the staging folder must be outside (and not contain) the source folder');
  const building = `${out}.building`;
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'MANIFEST.txt'))) fail(`${out} exists and is not a previous output of this tool (no MANIFEST.txt): refusing to touch it`);
  if (fs.existsSync(building)) { if (!fs.existsSync(path.join(building, '.stage-building')) && !fs.existsSync(path.join(building, 'MANIFEST.txt'))) fail(`${building} exists and is not ours: refusing to touch it`); fs.rmSync(building, { recursive: true, force: true }); }

  // inputs first (before anything is created)
  for (const f of APP_FILES) if (!fs.existsSync(sourceOf(src, f))) fail(`missing source file ${f}`);
  if (!fs.existsSync(LICENSE_SOURCE)) fail(`Node.js licence text missing: ${LICENSE_SOURCE}`);
  if (sha256File(LICENSE_SOURCE) !== PINNED_LICENSE_SHA256) fail('tools/licenses/NODE-LICENSE.txt does not match the pinned SHA-256');
  const pre = runtimeProblems(nodePath); if (pre.problems.length) fail(`input runtime rejected: ${pre.problems.join('; ')}`);

  try {
    fs.mkdirSync(path.join(building, 'app', 'LICENSES'), { recursive: true });
    fs.writeFileSync(path.join(building, '.stage-building'), 'x');
    for (const f of APP_FILES) fs.copyFileSync(sourceOf(src, f), path.join(building, 'app', f));
    fs.copyFileSync(nodePath, path.join(building, 'app', RUNTIME_NAME));
    fs.copyFileSync(LICENSE_SOURCE, path.join(building, LICENSE_REL));
    fs.writeFileSync(path.join(building, 'app', 'THIRD-PARTY-NOTICES.txt'), noticesText(PINNED_NODE_VERSION));
    fs.writeFileSync(path.join(building, 'RUNTIME.txt'), runtimeText(pre.facts));
    fs.writeFileSync(path.join(building, 'MANIFEST.txt'), '');
    fs.rmSync(path.join(building, '.stage-building'));
    fs.writeFileSync(path.join(building, 'MANIFEST.txt'), buildManifest(building));
    const scan = scanStage(building, { repoRoot: src });
    if (scan.problems.length) fail(`release gates failed:\n  - ${scan.problems.join('\n  - ')}`);
    // replace the previous output only now
    if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(building, out);
    return { out, scan };
  } catch (e) {
    try { fs.rmSync(building, { recursive: true, force: true }); } catch { /* best effort: it is our own temporary folder */ }
    throw e;
  }
}

module.exports = { TOPIC_SHAPE, UI_ONLY_FORBIDDEN, BARE_LAUNCH, devControlRegex, sourceOf, RELEASE_SOURCE, DEV_ONLY_STRINGS, build, scanStage, manifestProblems, buildManifest, dependencyProblems, runtimeProblems, runtimeFacts, protectedStrings, listFiles, EXPECTED, APP_FILES, PINNED_NODE_VERSION, PINNED_NODE_SHA256, PINNED_LICENSE_SHA256, RUNTIME_NAME, LICENSE_REL };

if (require.main === module) {
  const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  try {
    if (argv.includes('--check')) {
      const dir = path.resolve(opt('--check', '')); const scan = scanStage(dir);
      for (const i of scan.info) console.log(`info: ${i}`);
      if (scan.problems.length) { console.error(`CHECK FAILED:\n  - ${scan.problems.join('\n  - ')}`); process.exit(1); }
      console.log(`check OK: ${scan.counts.files} files, manifest matches, ${scan.counts.protectedStrings} protected strings searched in ${scan.counts.textScanned} text + ${scan.counts.binaryScanned} binary files, 0 hits`);
      process.exit(0);
    }
    const out = opt('--out', path.join(path.resolve(__dirname, '..', '..'), 'release', 'stage'));
    const r = build({ out, nodePath: opt('--node', process.execPath) });
    for (const i of r.scan.info) console.log(`info: ${i}`);
    console.log(`staged ${r.scan.counts.files} files into ${r.out}`);
    console.log(`runtime ${r.scan.facts.version}, signature ${r.scan.facts.signature} (${(r.scan.facts.signer || '').split(',')[0]}), sha256 ${r.scan.facts.sha256.slice(0, 16)}… (matches the pinned value)`);
    console.log(`scan: manifest verified, dependency closure complete, ${r.scan.counts.protectedStrings} protected strings searched in ${r.scan.counts.textScanned} text + ${r.scan.counts.binaryScanned} binary files, 0 hits`);
  } catch (e) {
    console.error(`STAGE FAILED: ${e.stageFailure ? e.message : (e && e.stack) || e}`); process.exit(1);
  }
}
