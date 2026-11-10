#!/usr/bin/env node
/**
 * test-step10.js — Distribution Task 2: release packaging and privacy validation (tools/stage.js, tools/verify-stage.js).
 *
 * Builds real staging folders in a scratch folder next to the source tree and attacks them: tampering, planted secrets,
 * personal paths, debug artifacts, missing files, bad runtimes. Nothing here touches your existing stage / debug folders,
 * your personal data folder, or any ntfy configuration (a FAKE home with a fake topic is used to prove the secret scan works).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const stage = require('./tools/stage');
const { verify } = require('./tools/verify-stage');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const P = __dirname;
const WORK = path.resolve(P, '..', 'release-test10');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read = (f) => fs.readFileSync(f, 'utf8');
const quiet = () => {};
const tryBuild = (o) => { try { return { ok: true, r: stage.build({ log: quiet, ...o }) }; } catch (e) { return { ok: false, msg: String(e.message || e) }; } };
const treeHashes = (root) => Object.fromEntries(stage.listFiles(root).map((f) => [f, sha(path.join(root, f))]));
const copyTree = (from, to) => { fs.cpSync(from, to, { recursive: true }); };

/** a copy of the shippable source (the allowlist) that a test can poison */
function sourceCopy(name) {
  const d = path.join(WORK, name); fs.mkdirSync(d, { recursive: true });
  for (const f of stage.APP_FILES) fs.copyFileSync(path.join(P, f), path.join(d, f));
  return d;
}
/** run fn with USERPROFILE pointing at a fake home that holds a fake ntfy config (os.homedir() follows it on Windows) */
function withFakeHome(topic, token, fn) {
  const home = path.join(WORK, `home-${Math.random().toString(36).slice(2, 8)}`); fs.mkdirSync(path.join(home, '.claude-notifier'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-notifier', 'ntfy.json'), JSON.stringify({ server: 'https://ntfy.sh', topic, ...(token ? { token } : {}) }));
  const old = process.env.USERPROFILE; process.env.USERPROFILE = home;
  try { return fn(home); } finally { process.env.USERPROFILE = old; }
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  const protectedBefore = fs.existsSync(path.join(os.homedir(), '.claude-notifier')) ? stage.listFiles(path.join(os.homedir(), '.claude-notifier')).map((f) => `${f}:${fs.statSync(path.join(os.homedir(), '.claude-notifier', f)).mtimeMs}`).filter((x) => !/log|lock|history\.db|state|sounds/.test(x)).join('|') : '';

  // =========================================================================================================
  console.log('== A) structure of the release package');
  const S1 = path.join(WORK, 'out1');
  const b1 = tryBuild({ out: S1 });
  check('the build succeeds with the real source, the pinned runtime and the pinned licence', b1.ok, b1.msg);
  const files = stage.listFiles(S1);
  check('the package is EXACTLY the allowlist: 27 application files + runtime + notices + licence + RUNTIME.txt + MANIFEST.txt = 32 files', files.length === 32 && JSON.stringify(files) === JSON.stringify([...stage.EXPECTED].sort()), `${files.length} files`);
  check('all required modules are present, including the new claude-profile.js and the VBS launcher', ['app/claude-profile.js', 'app/onboarding.js', 'app/qr.js', 'app/theme.js', 'app/palette.js', 'app/setup-controller.js', 'app/setup-window.ps1', 'app/winpaths.js', 'app/devhooks.js', 'app/notifier.js', 'app/supervisor.js', 'app/merge-events.js', 'app/watch-sessions.js', 'app/Claude-Notifier.vbs', 'app/ui-host.ps1', 'app/ClaudeNotifier.exe'].every((f) => files.includes(f)));
  check('runtime licence notices are present: THIRD-PARTY-NOTICES.txt + LICENSES/NODE-LICENSE.txt (pinned SHA-256)', files.includes('app/THIRD-PARTY-NOTICES.txt') && sha(path.join(S1, stage.LICENSE_REL)) === stage.PINNED_LICENSE_SHA256 && /Node\.js is licensed for use as follows/.test(read(path.join(S1, stage.LICENSE_REL))) && /v24\.18\.0/.test(read(path.join(S1, 'app', 'THIRD-PARTY-NOTICES.txt'))));
  check('no tests, development scripts, data, logs, databases, json or sound files are packaged', !files.some((f) => /(^|\/)test-|\/tools\/|\.(db|sqlite|log|json|wav|map|bak|tmp)$/i.test(f)));
  check('every application file is a byte-identical copy of its source (devhooks.js is the one deliberate exception: it is the inert production stub)', stage.APP_FILES.every((f) => sha(path.join(S1, 'app', f)) === sha(stage.sourceOf(P, f))) && stage.APP_FILES.filter((f) => sha(path.join(S1, 'app', f)) !== sha(path.join(P, f))).join() === 'devhooks.js');
  check('dependency closure is complete: every require("./x") and every referenced .ps1/.vbs resolves inside the package', stage.dependencyProblems(path.join(S1, 'app')).length === 0);
  const gen = [read(path.join(S1, 'RUNTIME.txt')), read(path.join(S1, 'MANIFEST.txt')), read(path.join(S1, 'app', 'THIRD-PARTY-NOTICES.txt'))].join('\n');
  check('generated files hold no absolute path, user name, host name or timestamp', !/[A-Za-z]:\\/.test(gen.replace(/CN=|O=/g, '')) && !new RegExp(`(^|[^A-Za-z0-9])${os.userInfo().username}([^A-Za-z0-9]|$)`, 'i').test(gen) && !gen.includes(os.hostname()) && !/20\d\d-\d\d-\d\d|T\d\d:\d\d/.test(gen));
  const rt = stage.runtimeFacts(path.join(S1, 'app', stage.RUNTIME_NAME));
  check('bundled runtime: version v24.18.0, signature Valid (OpenJS Foundation), SHA-256 equals the pinned value', rt.version === 'v24.18.0' && rt.signature === 'Valid' && /OpenJS Foundation/.test(rt.signer) && rt.sha256 === stage.PINNED_NODE_SHA256);
  check('RUNTIME.txt records exactly those facts', read(path.join(S1, 'RUNTIME.txt')).includes(rt.sha256) && read(path.join(S1, 'RUNTIME.txt')).includes('v24.18.0'));
  check('the licence file in the repository matches the pinned SHA-256', sha(path.join(P, 'tools', 'licenses', 'NODE-LICENSE.txt')) === stage.PINNED_LICENSE_SHA256);
  const s1 = stage.scanStage(S1);
  check('scanStage on the fresh package: 0 problems', s1.problems.length === 0, s1.problems.join(' | '));
  check('the scan covered text files AND the 92 MB runtime, with every protected category (topic?, token?, user, host, home, source)', s1.counts.textScanned >= 31 && s1.counts.binaryScanned === 1 && ['Windows user name', 'computer name', 'home folder', 'source folder'].every((l) => s1.counts.protectedLabels.includes(l)), s1.counts.protectedLabels.join(','));
  check('the scan reports that the inert production stub of the development hooks is what ships', s1.info.some((i) => /inert production stub shipped/.test(i)));

  // =========================================================================================================
  console.log('== B) reproducibility');
  const S2 = path.join(WORK, 'out2'); const b2 = tryBuild({ out: S2 });
  check('a second build in a different folder succeeds', b2.ok, b2.msg);
  check('MANIFEST.txt is byte-identical between two independent builds', read(path.join(S1, 'MANIFEST.txt')) === read(path.join(S2, 'MANIFEST.txt')));
  check('every file in the two packages has the same SHA-256', JSON.stringify(treeHashes(S1)) === JSON.stringify(treeHashes(S2)));
  const before = treeHashes(S1); const b3 = tryBuild({ out: S1 });
  check('rebuilding over an existing package works (it carries a MANIFEST.txt) and produces the identical result', b3.ok && JSON.stringify(treeHashes(S1)) === JSON.stringify(before), b3.msg);
  check('no ".building" scratch folder is left behind by successful builds', !fs.existsSync(`${S1}.building`) && !fs.existsSync(`${S2}.building`));

  // =========================================================================================================
  console.log('== C) the manifest and scans detect tampering (on copies of a good package)');
  // copies of a good package; the 92 MB runtime is HARD-LINKED (never modified) unless the test itself edits it
const T = (name, mutate, { realExeCopy = false } = {}) => { const d = path.join(WORK, name); for (const f of stage.listFiles(S2)) { const to = path.join(d, f); fs.mkdirSync(path.dirname(to), { recursive: true }); if (f === 'app/ClaudeNotifier.exe' && !realExeCopy) fs.linkSync(path.join(S2, f), to); else fs.copyFileSync(path.join(S2, f), to); } mutate(d); return stage.scanStage(d); };
  let r = T('t-edit', (d) => fs.appendFileSync(path.join(d, 'app', 'policy.js'), '\n// edited after the build\n'));
  check('an application file edited after the build => hash mismatch', r.problems.some((p) => /hash\/size mismatch: app\/policy\.js/.test(p)));
  r = T('t-extra-json', (d) => fs.writeFileSync(path.join(d, 'app', 'ntfy.json'), '{"topic":"x"}'));
  check('a stray ntfy.json in the package => unexpected + forbidden + not in manifest', r.problems.some((p) => /unexpected files.*ntfy\.json/.test(p)) && r.problems.some((p) => /forbidden file.*ntfy\.json/.test(p)) && r.problems.some((p) => /not in manifest: app\/ntfy\.json/.test(p)));
  for (const f of ['history.db', 'notifier.log', 'settings.json', 'usage-state.json', 'attention.wav', 'test-step4.js', 'debug.txt', 'x.bak']) {
    r = T(`t-extra-${f}`, (d) => fs.writeFileSync(path.join(d, 'app', f), 'x'));
    check(`a stray ${f} => rejected`, r.problems.some((p) => new RegExp(f.replace('.', '\\.')).test(p)));
  }
  r = T('t-missing', (d) => fs.rmSync(path.join(d, 'app', 'claude-profile.js')));
  check('claude-profile.js missing => missing file + manifest + dependency-closure failures (the bug that once broke the staged app)', r.problems.some((p) => /missing expected files.*claude-profile\.js/.test(p)) && r.problems.some((p) => /requires \.\/claude-profile, which is not in the package/.test(p)));
  r = T('t-ps1-missing', (d) => fs.rmSync(path.join(d, 'app', 'notify-once.ps1')));
  check('a referenced PowerShell helper missing => dependency failure', r.problems.some((p) => /references notify-once\.ps1/.test(p)));
  r = T('t-license', (d) => fs.appendFileSync(path.join(d, stage.LICENSE_REL), 'x'));
  check('licence text altered => rejected against the pinned SHA-256', r.problems.some((p) => /licence text differs/.test(p)));
  r = T('t-exe', (d) => { const f = path.join(d, 'app', stage.RUNTIME_NAME); const fd = fs.openSync(f, 'r+'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, 5_000_000); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, 5_000_000); fs.closeSync(fd); }, { realExeCopy: true });
  check('one flipped byte in the bundled runtime => manifest mismatch, pinned SHA-256 mismatch AND the signature is no longer valid', r.problems.some((p) => /hash\/size mismatch: app\/ClaudeNotifier\.exe/.test(p)) && r.problems.some((p) => /SHA-256 differs/.test(p)) && r.problems.some((p) => /signature/.test(p)));
  r = T('t-path', (d) => fs.appendFileSync(path.join(d, 'app', 'store.js'), '\n// see C:\\Users\\Someone\\project\n'));
  check('a personal path pattern (C:\\Users\\...) in a shipped file => rejected', r.problems.some((p) => /store\.js: contains a personal\/machine path/.test(p)));
  r = T('t-src', (d) => fs.appendFileSync(path.join(d, 'app', 'store.js'), `\n// ${P}\n`));
  check('the source-folder path in a shipped file => rejected (exact source path; plus the personal-path pattern whenever the source folder matches it)', (!/[A-Za-z]:[\\/]+(Users|Documents and Settings|claude_notification)\b/i.test(P) || r.problems.some((p) => /store\.js: contains a personal\/machine path/.test(p))) && r.problems.some((p) => /protected string found \(source folder/.test(p)));
  r = T('t-dbg', (d) => fs.appendFileSync(path.join(d, 'app', 'health.js'), '\ndebugger;\nconsole.debug("x");\n'));
  check('a debugger statement / console.debug => rejected as development artifacts', r.problems.filter((p) => /health\.js: development artifact/.test(p)).length === 2);
  r = T('t-fixme', (d) => fs.appendFileSync(path.join(d, 'app', 'lock.js'), '\n// FIXME later\n'));
  check('a FIXME marker => rejected', r.problems.some((p) => /lock\.js: development artifact \(FIXME/.test(p)));
  const user = os.userInfo().username;
  r = T('t-user', (d) => fs.appendFileSync(path.join(d, 'app', 'paths.js'), `\n// written by ${user} on this machine\n`));
  check('the Windows user name as a whole word in a shipped file => rejected (even a 2-letter name)', r.problems.some((p) => /protected string found \(Windows user name\).*paths\.js/.test(p)));
  r = T('t-host', (d) => fs.appendFileSync(path.join(d, 'app', 'paths.js'), `\n// host ${os.hostname()}\n`));
  check('the computer name in a shipped file => rejected', r.problems.some((p) => /protected string found \(computer name\).*paths\.js/.test(p)));
  r = T('t-home', (d) => fs.appendFileSync(path.join(d, 'app', 'paths.js'), `\n// ${os.homedir()}\n`));
  check('the home folder path in a shipped file => rejected', r.problems.some((p) => /protected string found \(home folder\)/.test(p)));
  r = T('t-dev-hooks', (d) => fs.copyFileSync(path.join(P, 'devhooks.js'), path.join(d, 'app', 'devhooks.js')));
  check('shipping the DEVELOPMENT devhooks.js instead of the stub => rejected (not the stub, and both mechanism names are found)', r.problems.some((p) => /not the inert production stub/.test(p)) && r.problems.some((p) => /mock-claude-processes/.test(p)) && r.problems.some((p) => /NOTIFIER_TEST_CRASH_MS/.test(p)));
  r = T('t-dev-mock', (d) => fs.appendFileSync(path.join(d, 'app', 'notifier.js'), "\nconst m = argv.indexOf('--mock-claude-processes');\n"));
  check('the mock flag name reappearing in ANY shipped file => rejected', r.problems.some((p) => /notifier\.js: development\/test control present \(--mock-claude-processes\)/.test(p)));
  r = T('t-dev-env', (d) => fs.appendFileSync(path.join(d, 'app', 'health.js'), '\nconst x = process.env.NOTIFIER_ANYTHING;\n'));
  check('any process.env.NOTIFIER_* development variable in a shipped file => rejected', r.problems.some((p) => /health\.js: reads a NOTIFIER_\* development environment variable/.test(p)));
  r = T('t-dev-crash', (d) => fs.appendFileSync(path.join(d, 'app', 'lock.js'), '\n// NOTIFIER_TEST_CRASH_MS\n'));
  check('the crash-injector variable name in a comment of a shipped file => rejected as well', r.problems.some((p) => /lock\.js: development\/test control present \(NOTIFIER_TEST_CRASH_MS\)/.test(p)));
  for (const [name, snippet] of [['--no-lock', "const x = argv.includes('--no-lock');"], ['--data-dir', "const d = opt('--data-dir', 'x');"], ['--ui', "const u = opt('--ui', 'tray');"], ['--control-stdin', '// --control-stdin'], ['--duration', "opt('--duration', 0)"], ['--usage-file', 'const f = "--usage-file";']]) {
    r = T('t-ctl' + name, (d) => fs.appendFileSync(path.join(d, 'app', 'policy.js'), '\n' + snippet + '\n'));
    check('the development control ' + name + ' appearing in ANY shipped file (code or comment) => rejected', r.problems.some((p) => p.includes('policy.js: development/test control present (' + name + ')')));
  }
  r = T('t-ctl-ok', (d) => fs.appendFileSync(path.join(d, 'app', 'policy.js'), '\n// the --directory of the project and --interval-free text are fine; so is --diagnose, --ntfy-status and --hold\n'));
  check('look-alike words and the legitimate options (--diagnose, --ntfy-status, --hold) are NOT flagged (no false positives)', !r.problems.some((p) => /development\/test control/.test(p)));
  for (const [what, code] of [["spawn('powershell.exe', [])", "spawn('powershell.exe', ['-NoProfile']);"], ["execFileSync('reg', ...)", "execFileSync('reg', ['query', 'x']);"], ["spawnSync('tasklist.exe', ...)", "spawnSync('tasklist.exe', []);"], ["spawn('explorer.exe', ...)", "spawn('explorer.exe', ['x']);"], ['execFile("powershell", ...)', 'execFile("powershell", ["-Command", "x"]);']]) {
    r = T('t-bare-' + Math.random().toString(36).slice(2, 8), (d) => fs.appendFileSync(path.join(d, 'app', 'store.js'), '\n' + code + '\n'));
    check('a system program started by bare name (' + what + ') => rejected: it would be looked up through PATH', r.problems.some((p) => /store\.js: starts a system program by bare name/.test(p)));
  }
  r = T('t-bare-ok', (d) => fs.appendFileSync(path.join(d, 'app', 'store.js'), "\nspawn(winpaths.powershellExe(), ['-NoProfile']);\nspawn(process.execPath, ['x']);\n"));
  check('launching through winpaths.powershellExe() / process.execPath is accepted', !r.problems.some((p) => /bare name/.test(p)));
  r = T('t-topicshape', (d) => fs.appendFileSync(path.join(d, 'app', 'health.js'), '\n// example claude-abcdefghjkmnpqrs\n'));
  check('a string shaped like an ntfy topic (claude- + 16 characters) in ANY shipped file => rejected, even if it is not the real one', r.problems.some((p) => /health\.js: contains a string shaped like an ntfy topic/.test(p)));
  r = T('t-ascii', (d) => fs.appendFileSync(path.join(d, 'app', 'setup-window.ps1'), '\n# caf\u00e9\n'));
  check('a non-ASCII character in setup-window.ps1 => rejected (PowerShell 5.1 reads BOM-less files as ANSI)', r.problems.some((p) => /setup-window\.ps1: contains non-ASCII/.test(p)));
  for (const bad of ['Invoke-WebRequest http://x', 'Set-Content -Path x -Value y', '$x = New-Object System.Net.WebClient', 'Remove-Item x', "Set-ItemProperty HKCU:\\Software\\x -Name y -Value z"]) {
    r = T('t-ui-' + Math.random().toString(36).slice(2, 7), (d) => fs.appendFileSync(path.join(d, 'app', 'setup-window.ps1'), '\n' + bad + '\n'));
    check('network / file / registry access in the setup window (' + bad.split(' ')[0] + ') => rejected: it must be user-interface only', r.problems.some((p) => /setup-window\.ps1: the setup window must be user-interface only/.test(p)));
  }
  r = T('t-missing-onb', (d) => fs.rmSync(path.join(d, 'app', 'onboarding.js')));
  check('onboarding.js missing => missing file + dependency-closure failure (notifier and setup-controller require it)', r.problems.some((p) => /missing expected files.*onboarding\.js/.test(p)) && r.problems.some((p) => /requires \.\/onboarding, which is not in the package/.test(p)));
  r = T('t-missing-win', (d) => fs.rmSync(path.join(d, 'app', 'setup-window.ps1')));
  check('setup-window.ps1 missing => dependency failure (setup-controller references it)', r.problems.some((p) => /references setup-window\.ps1/.test(p)));
  r = T('t-missing-qr', (d) => fs.rmSync(path.join(d, 'app', 'qr.js')));
  check('qr.js missing => dependency-closure failure', r.problems.some((p) => /requires \.\/qr, which is not in the package/.test(p)));

  const TOPIC = 'claude-FAKEtopicXq7Z2m9p'; const TOKEN = 'tk_FAKEtokenAAAA1111BBBB';
  withFakeHome(TOPIC, TOKEN, () => {
    let x = T('t-topic', (d) => fs.appendFileSync(path.join(d, 'app', 'ntfy.js'), `\n// default topic ${TOPIC}\n`));
    check('an ntfy topic (from the configuration scanned in memory) in a shipped file => rejected; the message does not repeat it', x.problems.some((p) => /protected string found \(ntfy topic\).*ntfy\.js/.test(p)) && !x.problems.join('').includes(TOPIC));
    x = T('t-token', (d) => fs.appendFileSync(path.join(d, 'app', 'ntfy.js'), `\n// ${TOKEN}\n`));
    check('an ntfy token in a shipped file => rejected; not repeated in the message', x.problems.some((p) => /protected string found \(ntfy token\)/.test(p)) && !x.problems.join('').includes(TOKEN));
    x = T('t-topic-exe', (d) => fs.appendFileSync(path.join(d, 'app', stage.RUNTIME_NAME), TOPIC), { realExeCopy: true });
    check('the topic appended inside the runtime binary is found too (binary scan)', x.problems.some((p) => /protected string found \(ntfy topic\).*ClaudeNotifier\.exe/.test(p)));
    x = stage.scanStage(S2);
    check('the same clean package still passes with a topic and token configured (no false positive)', x.problems.length === 0 && x.counts.protectedLabels.includes('ntfy topic') && x.counts.protectedLabels.includes('ntfy token'), x.problems.join('|'));
  });

  // =========================================================================================================
  console.log('== D) builds fail safely');
  const keep = path.join(WORK, 'keep'); const kb = tryBuild({ out: keep }); const keepHash = JSON.stringify(treeHashes(keep));
  const bad = tryBuild({ out: keep, nodePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe') });
  check('a wrong runtime binary is rejected before anything is built', !bad.ok && /input runtime rejected/.test(bad.msg));
  check('...and the existing good package is left completely untouched, with no scratch folder', JSON.stringify(treeHashes(keep)) === keepHash && !fs.existsSync(`${keep}.building`));
  const poisoned = sourceCopy('src-poisoned'); fs.appendFileSync(path.join(poisoned, 'notifier.js'), '\n// C:\\Users\\Someone\\secret\n');
  const pb = tryBuild({ src: poisoned, out: keep });
  check('a source file containing a personal path makes the whole build FAIL with a clear message', !pb.ok && /release gates failed/.test(pb.msg) && /personal\/machine path/.test(pb.msg));
  check('...the previous good package is NOT replaced and the failed attempt is cleaned up', JSON.stringify(treeHashes(keep)) === keepHash && !fs.existsSync(`${keep}.building`));
  const fresh = path.join(WORK, 'never-created'); const pb2 = tryBuild({ src: poisoned, out: fresh });
  check('a failed first build leaves no output folder at all', !pb2.ok && !fs.existsSync(fresh) && !fs.existsSync(`${fresh}.building`));
  const missingSrc = sourceCopy('src-missing'); fs.rmSync(path.join(missingSrc, 'claude-profile.js'));
  const mb = tryBuild({ src: missingSrc, out: path.join(WORK, 'm-out') });
  check('a missing source file fails the build before anything is written', !mb.ok && /missing source file claude-profile\.js/.test(mb.msg) && !fs.existsSync(path.join(WORK, 'm-out')));
  const unrec = path.join(WORK, 'unrecognised'); fs.mkdirSync(unrec); fs.writeFileSync(path.join(unrec, 'precious.txt'), 'mine');
  const ub = tryBuild({ out: unrec });
  check('an existing folder that is not a previous output (no MANIFEST.txt) is never overwritten', !ub.ok && /not a previous output/.test(ub.msg) && read(path.join(unrec, 'precious.txt')) === 'mine');
  const ib = tryBuild({ out: path.join(P, 'inside-source') });
  check('an output folder inside the source tree is refused', !ib.ok && /outside/.test(ib.msg) && !fs.existsSync(path.join(P, 'inside-source')));
  const pb3 = tryBuild({ out: path.dirname(P) });
  check('an output folder that CONTAINS the source tree is refused as well', !pb3.ok);
  const leftover = `${path.join(WORK, 'lo')}.building`; fs.mkdirSync(leftover); fs.writeFileSync(path.join(leftover, 'foreign.txt'), 'not ours');
  const lb = tryBuild({ out: path.join(WORK, 'lo') });
  check('a foreign ".building" folder is not deleted', !lb.ok && fs.existsSync(path.join(leftover, 'foreign.txt')));
  withFakeHome(TOPIC, null, () => {
    const tp = sourceCopy('src-topic'); fs.appendFileSync(path.join(tp, 'ntfy.js'), `\n// ${TOPIC}\n`);
    const tb = tryBuild({ src: tp, out: path.join(WORK, 't-out') });
    check('a build whose source contains the configured topic FAILS, never prints it, and produces nothing', !tb.ok && /ntfy topic/.test(tb.msg) && !tb.msg.includes(TOPIC) && !fs.existsSync(path.join(WORK, 't-out')));
  });

  // =========================================================================================================
  console.log('== E) command line behaviour');
  const cli = (args) => spawnSync(process.execPath, [path.join(P, 'tools', 'stage.js'), ...args], { encoding: 'utf8' });
  let c = cli(['--check', S2]);
  check('stage.js --check on a good package exits 0 and reports the counts', c.status === 0 && /check OK: 32 files/.test(c.stdout) && /0 hits/.test(c.stdout), c.stdout.trim().split('\n').pop());
  const tc = path.join(WORK, 'cli-tamper'); for (const f of stage.listFiles(S2)) { const to = path.join(tc, f); fs.mkdirSync(path.dirname(to), { recursive: true }); f === 'app/ClaudeNotifier.exe' ? fs.linkSync(path.join(S2, f), to) : fs.copyFileSync(path.join(S2, f), to); } fs.appendFileSync(path.join(tc, 'app', 'ntfy.js'), '\n// x\n');
  c = cli(['--check', tc]);
  check('stage.js --check on a tampered package exits 1 and names the problem', c.status === 1 && /CHECK FAILED/.test(c.stderr) && /ntfy\.js/.test(c.stderr));
  check('the CLI never prints protected strings (user, host, home, source path) even when a gate fails', !c.stderr.includes(os.homedir()) && !c.stderr.includes(os.hostname()));
  c = cli(['--out', path.join(P, 'tools', 'x-out')]);
  check('stage.js build with an unsafe --out exits 1 with "STAGE FAILED"', c.status === 1 && /STAGE FAILED/.test(c.stderr) && !fs.existsSync(path.join(P, 'tools', 'x-out')));

  // =========================================================================================================
  console.log('== F) the staged build WORKS (tools/verify-stage.js against a fresh package)');
  const vr = await verify(S2, { explorer: true });
  for (const x of vr) check(`verify-stage: ${x.name}`, x.ok, x.extra);
  check('verify-stage ran every section (gates, runtime, discovery x4, chain x4, Explorer launch x4)', vr.length >= 17 && vr.every((x) => x.ok), `${vr.length} checks`);
  check('the verification scratch folder was removed', !fs.existsSync(`${S2}.verify`));

  // =========================================================================================================
  console.log('== H) production build: no development / test controls, no PATH dependence');
  const dev = require('./devhooks'); const stub = path.join(P, 'tools', 'release', 'devhooks.js'); const stubSrc = read(stub); const stubMod = require(stub);
  check('the production stub exports DEV_HOOKS=false, an empty control list and the same function names as the development module', stubMod.DEV_HOOKS === false && stubMod.DEV_CONTROLS.length === 0 && dev.DEV_HOOKS === true && JSON.stringify(Object.keys(stubMod).filter((k) => k !== 'DEV_CONTROLS').sort()) === JSON.stringify(Object.keys(dev).filter((k) => k !== 'DEV_CONTROLS').sort()));
  check('the stub never touches process.env or process.argv, requires nothing, and names no control', !/process\.(env|argv)/.test(stubSrc) && !/require\(/.test(stubSrc) && !stage.DEV_ONLY_STRINGS.some((d) => stage.devControlRegex(d).test(stubSrc)));
  check('the build gate list (stage.js) is IDENTICAL to the development module\'s control list (no control can be added to one and forgotten in the other)', JSON.stringify([...stage.DEV_ONLY_STRINGS].sort()) === JSON.stringify([...dev.DEV_CONTROLS].sort()), stage.DEV_ONLY_STRINGS.length + ' controls');
  const argsFor = (name) => (/^--(no-|control-|dump-|once|stats|all-)/.test(name) ? [name] : [name, '5']);
  const optionControls = dev.DEV_CONTROLS.filter((n) => n.startsWith('--') && n !== '--mock-claude-processes');   // the mock source has its own function (tested separately)
  const devSet = optionControls.filter((n) => { const o = dev.options(argsFor(n)); return Object.entries(o).some(([k, v]) => k !== 'dev' && k !== 'passthrough' && v !== undefined && v !== false); });
  check('CONTROL: in the development module every one of the ' + optionControls.length + ' option controls DOES set an override', devSet.length === optionControls.length, optionControls.filter((n) => !devSet.includes(n)).join(','));
  const stubSet = dev.DEV_CONTROLS.filter((n) => { const o = stubMod.options(argsFor(n)); return Object.keys(o).some((k) => k !== 'dev' && k !== 'passthrough') || o.dev !== false || o.passthrough.length !== 0; });
  check('PRODUCTION stub: NONE of the controls sets anything, the supervisor passthrough stays empty, whatever is passed', stubSet.length === 0 && stubMod.options(dev.DEV_CONTROLS.flatMap(argsFor)).passthrough.length === 0, stubSet.join(','));
  check('the stub ignores the mock process source in every spelling and the crash injector in every setting', stubMod.mockProcessSource(['--mock-claude-processes', 'x.json']) === null && stubMod.mockProcessSource(['--mock-claude-processes=x.json']) === null && stubMod.forwardToMerge({ sessionsDir: 'x', intervalMs: 1 }).length === 0 && stubMod.forwardToWatcher({ sessionsDir: 'x' }).length === 0);
  const cdir = path.join(WORK, 'stubcrash'); fs.mkdirSync(cdir);
  stubMod.installCrashInjector({ env: { NOTIFIER_TEST_CRASH_MS: '10' }, uiMode: 'none', dataDir: cdir });
  await new Promise((res) => setTimeout(res, 200));
  check('the stub ignores NOTIFIER_TEST_CRASH_MS: no timer fires, no marker file, no exception', !fs.existsSync(path.join(cdir, 'test-crashed')));
  const shipped = stage.listFiles(S2).filter((f) => /\.(js|ps1|vbs|txt)$/i.test(f) && !f.startsWith('app/LICENSES/'));
  const offenders = shipped.flatMap((f) => stage.DEV_ONLY_STRINGS.filter((d) => stage.devControlRegex(d).test(read(path.join(S2, f)))).map((d) => f + ':' + d)).concat(shipped.filter((f) => /process\.env\.NOTIFIER_/.test(read(path.join(S2, f)))));
  check('no shipped file contains the name of ANY development control, or any process.env.NOTIFIER_* use', offenders.length === 0, offenders.join(', '));
  check('the shipped devhooks.js is byte-identical to the stub, and differs from the development file of the same name', sha(path.join(S2, 'app', 'devhooks.js')) === sha(stub) && sha(stub) !== sha(path.join(P, 'devhooks.js')));
  check('every entry script reads its options through devhooks only (no argv parsing of development controls left in the shipped entry scripts)', ['notifier.js', 'supervisor.js', 'merge-events.js', 'watch-sessions.js'].every((n) => /require\('\.\/devhooks'\)/.test(read(path.join(S2, 'app', n)))));

  // --- system programs are found through the Windows folder, never through PATH ---
  const winp = require('./winpaths');
  check('winpaths: PowerShell, reg, tasklist and explorer resolve to existing files inside %SystemRoot%', [winp.powershellExe(), winp.regExe(), winp.tasklistExe(), winp.explorerExe()].every((x) => path.isAbsolute(x) && fs.existsSync(x) && x.toLowerCase().startsWith(winp.systemRoot().toLowerCase())));
  check('winpaths: a poisoned or relative SystemRoot is rejected (falls back to C:\\Windows), PATH is never consulted', winp.systemRoot({ SystemRoot: 'relative\\x', windir: 'Z:\\does-not-exist' }) === 'C:\\Windows' && !/process\.env\.PATH/i.test(read(path.join(P, 'winpaths.js'))));
  const shippedJs = stage.listFiles(S2).filter((f) => /^app\/[^/]+\.js$/.test(f));
  check('no shipped script starts powershell / reg / explorer / tasklist / wscript / cmd by bare name', shippedJs.every((f) => !stage.BARE_LAUNCH.test(read(path.join(S2, f)))));
  check('every place that starts PowerShell goes through winpaths.powershellExe()', shippedJs.filter((f) => /powershell/i.test(read(path.join(S2, f))) && /(spawn|execFile)/.test(read(path.join(S2, f)))).every((f) => /winpaths\.powershellExe\(\)/.test(read(path.join(S2, f)))));
  const NOWHERE = 'C:\\no-such-folder-claude-notifier';
  const hp0 = path.join(WORK, 'pathless'); for (const d of [path.join(hp0, '.claude', 'sessions'), path.join(hp0, 'AppData', 'Local'), path.join(hp0, 'AppData', 'Roaming')]) fs.mkdirSync(d, { recursive: true });
  const pathless = await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(P, 'notifier.js'), '--diagnose'], { env: { ...process.env, PATH: NOWHERE, USERPROFILE: hp0, HOME: hp0, LOCALAPPDATA: path.join(hp0, 'AppData', 'Local'), APPDATA: path.join(hp0, 'AppData', 'Roaming') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let o = ''; c.stdout.on('data', (x) => { o += x; }); c.on('exit', () => resolve(o)); setTimeout(() => { try { c.kill(); } catch { /* done */ } }, 30000); });
  let pj = null; try { pj = JSON.parse(pathless.trim().split('\n').pop()); } catch { /* reported */ }
  check('with PATH pointing nowhere the notifier still finds PowerShell (the process query works): regression test for the PATH dependence', !!pj && pj.discovery.processLookup === 'ok');

  // --- behaviour: the SAME controls against the development tree (honoured) and the release (ignored) ---
  const hp = path.join(WORK, 'hooks-profile'); const hLocal = path.join(hp, 'AppData', 'Local'); const hRoam = path.join(hp, 'AppData', 'Roaming');
  for (const d of [path.join(hp, '.claude', 'sessions'), hLocal, hRoam, path.join(hp, 'logs')]) fs.mkdirSync(d, { recursive: true });
  const hEnv = { USERPROFILE: hp, HOME: hp, LOCALAPPDATA: hLocal, APPDATA: hRoam };
  const mockFile = path.join(WORK, 'hooks-mock.json');
  fs.writeFileSync(mockFile, JSON.stringify({ session: 1, procs: [{ pid: 4242, ppid: 1, exe: 'C:\\x\\Claude.exe', type: 'utility', udd: path.join(hLocal, 'Claude-Data', 'MOCKED_MARKER_PROFILE'), session: 1 }] }));
  const runN = (exe, script, args, env) => new Promise((resolve) => { const c = spawn(exe, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let o = ''; c.stdout.on('data', (x) => { o += x; }); c.stderr.on('data', () => {}); c.on('exit', (code) => resolve({ code, o })); setTimeout(() => { try { c.kill(); } catch { /* done */ } }, 30000); });
  const lastJ = (o) => { try { return JSON.parse(o.trim().split('\n').pop()); } catch { return null; } };
  const devApp = path.join(P, 'notifier.js');
  const devDiag = lastJ((await runN(process.execPath, devApp, ['--diagnose', '--mock-claude-processes', mockFile], hEnv)).o);
  check('CONTROL (development tree): --mock-claude-processes IS honoured', !!devDiag && devDiag.discovery.selected === 'Local/Claude-Data/MOCKED_MARKER_PROFILE' && devDiag.discovery.method === 'process');
  const devData = path.join(WORK, 'dev-data-dir'); const devDiag2 = lastJ((await runN(process.execPath, devApp, ['--diagnose', '--data-dir', devData], hEnv)).o);
  check('CONTROL (development tree): --data-dir IS honoured', !!devDiag2 && devDiag2.dataDir === devData);
  const devCrash = await runN(process.execPath, devApp, ['--ui', 'none', '--no-usage', '--no-lock', '--duration', '4', '--data-dir', path.join(WORK, 'dev-crash-data'), '--sessions-dir', path.join(hp, '.claude', 'sessions'), '--log-dir', path.join(hp, 'logs'), '--interval', '500'], { ...hEnv, NOTIFIER_TEST_CRASH_MS: '300' });
  check('CONTROL (development tree): NOTIFIER_TEST_CRASH_MS DOES crash the notifier (exit 70, marker file written) and --ui none / --duration / --no-lock work', devCrash.code === 70 && fs.existsSync(path.join(WORK, 'dev-crash-data', 'test-crashed')), 'exit ' + devCrash.code);

  const vwork = path.join(WORK, 'prod-neg'); fs.mkdirSync(vwork, { recursive: true });
  await require('./tools/verify-stage').productionIgnoresDevControls(S2, vwork, (name, ok, extra) => check(name, ok, extra));

  // =========================================================================================================
  console.log('== G) nothing outside the scratch folder was touched');
  const protectedAfter = fs.existsSync(path.join(os.homedir(), '.claude-notifier')) ? stage.listFiles(path.join(os.homedir(), '.claude-notifier')).map((f) => `${f}:${fs.statSync(path.join(os.homedir(), '.claude-notifier', f)).mtimeMs}`).filter((x) => !/log|lock|history\.db|state|sounds/.test(x)).join('|') : '';
  check('the personal data folder configuration files (ntfy.json, settings.json) are unchanged', protectedAfter === protectedBefore);
  check('the source tree gained no files (no stray output / scratch inside prototype)', !fs.readdirSync(P).some((f) => /^(inside-source|x-out|out|stage)/.test(f)) && !fs.existsSync(path.join(P, 'tools', 'x-out')));

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
