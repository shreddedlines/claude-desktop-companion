#!/usr/bin/env node
/**
 * test-step8.js — Distribution Task 1: bundled Node runtime + launcher.
 *
 * Builds a staging folder (OUTSIDE the source tree) with tools/stage.js and proves that the staged copy runs with NO Node.js
 * reachable on PATH: ClaudeNotifier.exe (the renamed, signed, unmodified Node runtime) must be the image of the supervisor,
 * the notifier, merge-events and the session watcher, and a launch through Claude-Notifier.vbs started by Explorer (not a
 * descendant of Claude Desktop) must reach a running supervisor -> notifier -> tray host chain.
 * Everything runs in a fake Windows profile: the real data folder, config, topic and Start Menu shortcut are never touched.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(250); } return !!fn(); };
const P = __dirname;
const WORK = path.resolve(P, '..', 'stage-test');            // sibling of the source tree, removed at the end
const STAGE = path.join(WORK, 'stage');
const APP = path.join(STAGE, 'app');
const EXE = path.join(APP, 'ClaudeNotifier.exe');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

/** PATH with every directory that could contain a node.exe removed (system dirs only). */
const SYS = process.env.SystemRoot || 'C:\\Windows';
const NO_NODE_PATH = [`${SYS}\\System32`, SYS, `${SYS}\\System32\\Wbem`, `${SYS}\\System32\\WindowsPowerShell\\v1.0`].join(';');
const whereNode = () => spawnSync('where.exe', ['node'], { env: { ...process.env, PATH: NO_NODE_PATH }, encoding: 'utf8' });

function fakeProfile(name) {
  const home = path.join(WORK, name);
  for (const d of ['.claude\\sessions', 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs', 'AppData\\Local']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return { home, env: { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), PATH: NO_NODE_PATH } };
}
function processes() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const a = JSON.parse(out); return Array.isArray(a) ? a : [a];
}
function descendants(rootPid, all) {
  const kids = new Map(); for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const res = []; const walk = (pid) => { for (const k of kids.get(pid) || []) { res.push(k); walk(k.ProcessId); } }; walk(rootPid); return res;
}
const sameFile = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  const realData = path.join(os.homedir(), '.claude-notifier');
  const realFiles = () => (fs.existsSync(realData) ? fs.readdirSync(realData).map((f) => `${f}:${fs.statSync(path.join(realData, f)).mtimeMs}`).filter((x) => !/^(notifier|supervisor)\.log|history\.db|\.lock|state/.test(x)).sort().join('|') : '');
  const realBefore = realFiles();

  // =========================================================================================================
  console.log('== A) launcher script');
  const vbs = read(path.join(P, 'Claude-Notifier.vbs'));
  check('the launcher derives every path from its OWN location (ScriptFullName), with no drive letter or user path', /GetParentFolderName\(WScript\.ScriptFullName\)/.test(vbs) && !/[A-Za-z]:\\/.test(vbs.replace(/'.*$/gm, '')));
  check('the working directory is set to the application folder', /sh\.CurrentDirectory\s*=\s*dir/.test(vbs));
  check('it starts the bundled ClaudeNotifier.exe next to the script with supervisor.js', /runtime\s*=\s*dir\s*&\s*"\\ClaudeNotifier\.exe"/.test(vbs) && /sh\.Run\s+""""\s*&\s*runtime/.test(vbs) && /supervisor\.js/.test(vbs));
  check('"node" on PATH is used ONLY as a development-checkout fallback when the bundled exe is absent', /If fso\.FileExists\(runtime\) Then[\s\S]*Else[\s\S]*sh\.Run "node /.test(vbs) && (vbs.match(/"node /g) || []).length === 1);

  // =========================================================================================================
  console.log('== B) staging build (separate folder, allowlist, scan gate)');
  const st = spawnSync(process.execPath, [path.join(P, 'tools', 'stage.js'), '--out', STAGE], { encoding: 'utf8' });
  check('tools/stage.js succeeds', st.status === 0, (st.stdout || st.stderr).trim().split('\n').slice(-1)[0]);
  const all = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : all.push(path.relative(STAGE, p).replace(/\\/g, '/')); } })(STAGE);
  check('the staging folder is outside the source tree', !STAGE.toLowerCase().startsWith(P.toLowerCase() + path.sep));
  check('no tests, data, logs, databases, json or wav files are packaged', !all.some((f) => /(^|\/)test-|\.(db|log|json|wav|sqlite)$/i.test(f)), all.filter((f) => /test-|\.(db|log|json|wav)$/i.test(f)).join(','));
  check('the package is exactly the 27 app files + ClaudeNotifier.exe + notices/licence + RUNTIME.txt + MANIFEST.txt', all.length === 32 && all.includes('app/ClaudeNotifier.exe') && all.includes('RUNTIME.txt') && all.includes('MANIFEST.txt') && all.includes('app/Claude-Notifier.vbs'), `files=${all.length}`);
  check('the runtime is a byte-identical copy of the signed Node.js v24.18.0 binary', sha(EXE) === sha(process.execPath) && /v24\.18\.0/.test(read(path.join(STAGE, 'RUNTIME.txt'))) && /OpenJS Foundation/.test(read(path.join(STAGE, 'RUNTIME.txt'))));
  const sig = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${EXE}').Status`], { encoding: 'utf8' }).trim();
  check('the renamed executable still has a VALID Authenticode signature (not modified)', sig === 'Valid', sig);
  const inside = spawnSync(process.execPath, [path.join(P, 'tools', 'stage.js'), '--out', path.join(P, '.stage-must-fail')], { encoding: 'utf8' });
  check('stage.js refuses to build inside the source folder', inside.status !== 0 && !fs.existsSync(path.join(P, '.stage-must-fail')));
  const secrets = (() => { try { const c = JSON.parse(read(path.join(realData, 'ntfy.json'))); return [c.topic, c.token].filter(Boolean); } catch { return []; } })();
  const hits = all.filter((f) => { const b = fs.readFileSync(path.join(STAGE, f)); return secrets.some((s) => b.includes(s)); });
  check('no trace of the real ntfy topic/token anywhere in the package (values not printed)', hits.length === 0, `${secrets.length} secret(s) checked`);

  // =========================================================================================================
  console.log('== C) the renamed runtime works with NO Node on PATH');
  const w = whereNode();
  check('precondition: "node" is NOT resolvable with the test PATH (system Node untouched, only the PATH of the test processes is changed)', w.status !== 0 && !/node\.exe/i.test(w.stdout || ''));
  const env0 = { ...process.env, PATH: NO_NODE_PATH };
  const v = spawnSync(EXE, ['-e', 'console.log(JSON.stringify({v:process.version,exec:process.execPath}))'], { env: env0, encoding: 'utf8' });
  let vi = {}; try { vi = JSON.parse(v.stdout.trim()); } catch { /* reported below */ }
  check('ClaudeNotifier.exe runs JavaScript, reports v24.18.0 and process.execPath = itself', v.status === 0 && vi.v === 'v24.18.0' && sameFile(vi.exec, EXE), vi.exec);
  const sq = spawnSync(EXE, ['-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(a)');d.prepare('insert into t values (?)').run(7);console.log(d.prepare('select a from t').get().a)"], { env: env0, encoding: 'utf8' });
  check('node:sqlite (history store) works inside the renamed runtime', sq.status === 0 && sq.stdout.trim() === '7');
  const sp = spawnSync(EXE, ['-e', "const cp=require('child_process');console.log(cp.spawnSync(process.execPath,['-p','process.execPath'],{encoding:'utf8'}).stdout.trim())"], { env: env0, encoding: 'utf8' });
  check('a child spawned through process.execPath is the bundled exe again', sameFile(sp.stdout.trim(), EXE), sp.stdout.trim());

  // =========================================================================================================
  console.log('== D) supervisor -> notifier -> merge-events -> watcher chain, headless, bundled exe only, clean shutdown (on a temporary dev-hooks copy: the release itself has no no-tray mode)');
  const VAPP = require('./tools/verify-stage').makeDevVariant(STAGE, WORK); const VEXE = path.join(VAPP, 'ClaudeNotifier.exe');
  const fpD = fakeProfile('profileD'); const dataD = path.join(fpD.home, '.claude-notifier'); const logsD = path.join(WORK, 'logsD'); fs.mkdirSync(logsD, { recursive: true });
  const sup = spawn(VEXE, [path.join(VAPP, 'supervisor.js'), '--ui', 'none', '--no-usage', '--duration', '14', '--data-dir', dataD, '--sessions-dir', path.join(fpD.home, '.claude', 'sessions'), '--log-dir', logsD, '--interval', '500'],
    { cwd: VAPP, env: { ...process.env, ...fpD.env }, stdio: 'ignore', windowsHide: true });
  let supExit = null; sup.on('exit', (c) => { supExit = c; });
  await waitFor(() => /started notifier pid=/.test(read(path.join(dataD, 'supervisor.log'))), 15000);
  await waitFor(() => fs.existsSync(path.join(dataD, 'sounds', 'attention.wav')) && /watcher|heartbeat|startup/i.test(read(path.join(dataD, 'notifier.log'))), 15000);
  await sleep(1500);
  let tree = descendants(sup.pid, processes()).filter((p) => /^(node|ClaudeNotifier)\.exe$/i.test(p.Name));
  const names = tree.map((p) => p.Name.toLowerCase());
  check('the chain is up: supervisor -> notifier -> merge-events -> watcher (3 child runtimes under the supervisor)', tree.length >= 3, `${tree.length} child runtimes`);
  check('EVERY runtime process in the chain is ClaudeNotifier.exe from the staging folder (process image checked, not just argv)', tree.length >= 3 && tree.every((p) => sameFile(p.ExecutablePath, VEXE)), tree.map((p) => p.Name).join(','));
  check('no process in the chain is a node.exe', !names.includes('node.exe'));
  check('generated sounds are in the per-user data directory, NOT the application folder', fs.readdirSync(path.join(dataD, 'sounds')).length === 4 && !fs.readdirSync(APP).some((f) => /\.wav$/i.test(f)) && !fs.existsSync(path.join(APP, 'sounds')));
  check('all notifier data (logs, db, settings) landed in the fake profile data folder, none in the app folder', fs.existsSync(path.join(dataD, 'notifier.log')) && !fs.readdirSync(APP).some((f) => /\.(log|db|json|lock)$/i.test(f)) && fs.readdirSync(APP).length === 30);
  await waitFor(() => supExit !== null, 25000);
  const nlog = read(path.join(dataD, 'notifier.log')); const slog = read(path.join(dataD, 'supervisor.log'));
  check('clean shutdown: notifier exits 0 with its reason, supervisor sees a CLEAN exit, does not restart, and exits 0', supExit === 0 && /shutting down: duration elapsed \(exit code 0\)/.test(nlog) && /not restarting|clean exit/i.test(slog) && (slog.match(/started notifier pid=/g) || []).length === 1);
  await sleep(800);
  const left = processes().filter((p) => sameFile(p.ExecutablePath, VEXE));
  check('no ClaudeNotifier.exe process is left after shutdown', left.length === 0, `${left.length} left`);

  // =========================================================================================================
  console.log('== E) the real launcher: Claude-Notifier.vbs started by Explorer, tray included, no Node on PATH');
  const fpE = fakeProfile('profileE'); const dataE = path.join(fpE.home, '.claude-notifier');
  const wrapper = path.join(WORK, 'explorer-launch.vbs');
  const setEnv = Object.entries(fpE.env).map(([k, val]) => `env("${k}") = "${val.replace(/"/g, '""')}"`).join('\r\n');
  fs.writeFileSync(wrapper, `Set sh = CreateObject("WScript.Shell")\r\nSet env = sh.Environment("Process")\r\n${setEnv}\r\nsh.Run "wscript.exe """"${path.join(APP, 'Claude-Notifier.vbs')}""""", 0, False\r\n`);
  const before = new Set(processes().map((p) => p.ProcessId));
  spawn('explorer.exe', [wrapper], { detached: true, stdio: 'ignore' }).unref();   // parent = Explorer, not Claude Desktop
  const up = await waitFor(() => /startup: pid=/.test(read(path.join(dataE, 'notifier.log'))) && /tray|ui host|host ready|ready/i.test(read(path.join(dataE, 'notifier.log'))), 40000);
  await sleep(4000);
  const procs = processes();
  const supE = procs.find((p) => !before.has(p.ProcessId) && sameFile(p.ExecutablePath, EXE) && procs.some((c) => c.ParentProcessId === p.ProcessId && sameFile(c.ExecutablePath, EXE)) && !procs.some((q) => q.ProcessId === p.ParentProcessId && sameFile(q.ExecutablePath, EXE)));
  check('the Explorer-launched VBS started the chain (notifier logged its startup in the isolated data folder)', up && !!supE, supE ? `supervisor pid ${supE.ProcessId}` : 'no supervisor found');
  if (supE) {
    const kids = descendants(supE.ProcessId, procs);
    const rt = kids.filter((p) => /^(node|ClaudeNotifier)\.exe$/i.test(p.Name)); const ps = kids.filter((p) => /^powershell\.exe$/i.test(p.Name));
    const anc = []; for (let q = procs.find((p) => p.ProcessId === supE.ParentProcessId); q && anc.length < 8; q = procs.find((p) => p.ProcessId === q.ParentProcessId)) anc.push(q.Name.toLowerCase());
    check('launch lineage: started by the launcher (wscript.exe, which exits right after), with no Claude Desktop / node / shell ancestor', (anc.length === 0 || anc[0] === 'wscript.exe') && !anc.some((n) => /^(claude|node|cmd|bash|powershell)\.exe$/.test(n)), anc.length ? anc.join(' <- ') : 'wscript.exe already exited (orphaned, as expected)');
    check('supervisor, notifier, merge-events and the session watcher are all ClaudeNotifier.exe (>=3 children)', rt.length >= 3 && rt.every((p) => sameFile(p.ExecutablePath, EXE)) && !rt.some((p) => /^node\.exe$/i.test(p.Name)), `${rt.length} children`);
    check('the real tray host (ui-host.ps1 under PowerShell) is running as a child of the notifier', ps.length >= 1, `${ps.length} powershell child(ren)`);
    const hostLog = read(path.join(dataE, 'notifier.log'));
    check('the notifier reported a running tray host and no startup failure', !/FATAL|uncaught|cannot find module|ENOENT.*ClaudeNotifier|is not recognized/i.test(hostLog) && !/ui host (exited|failed)/i.test(hostLog), hostLog.split('\n').filter(Boolean).slice(-1)[0]);
    check('nothing from this run leaked into the real personal data folder (config/topic/settings untouched)', realFiles() === realBefore);
    // shut the isolated instance down: kill the tree starting at the supervisor (the tray "Exit" click is covered by the headless clean-exit check above)
    spawnSync('taskkill.exe', ['/PID', String(supE.ProcessId), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1500);
    const rest = processes().filter((p) => sameFile(p.ExecutablePath, EXE));
    check('the isolated instance is fully stopped afterwards (no stray ClaudeNotifier.exe, no tray host)', rest.length === 0, `${rest.length} left`);
  } else { for (let i = 0; i < 6; i++) check('Explorer-launched chain', false, 'skipped: chain did not start'); }
  check('the real personal data folder is unchanged by this whole suite', realFiles() === realBefore);

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { for (const p of processes()) if (sameFile(p.ExecutablePath, EXE)) spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } process.exit(1); });
