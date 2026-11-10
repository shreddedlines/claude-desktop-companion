'use strict';
/**
 * tools/verify-stage.js — proves a staging folder WORKS and that its development controls are really gone.
 *
 *   node tools/verify-stage.js [DIR]        (default DIR: <repo>/../release/stage)
 *
 * Every staged run uses ClaudeNotifier.exe, a PATH that contains NOTHING useful (no node.exe, no PowerShell folder), and a
 * throw-away fake Windows profile, so your real data folder, ntfy configuration and Start Menu shortcut are never written.
 * The only thing read from the real machine is one read-only `--diagnose`.
 *   1. every release gate (manifest, allowlist, dependency closure, privacy scan, runtime signature / version / SHA-256)
 *   2. the renamed runtime runs JavaScript, has node:sqlite, and is process.execPath
 *   3. usage discovery in the staged build (the staged claude-profile.js called with sample process data)
 *   4. PRODUCTION IGNORES EVERY DEVELOPMENT CONTROL: the real notifier, supervisor, event stream and session watcher are started
 *      from the release folder with all the development flags and the crash variable set at once, and must behave as if
 *      none of them was given (tray mode, default folders, lock held, usage monitor on, no timers, no crash, no simulated input)
 *   5. this machine's discovery, read-only
 *   6. supervisor -> notifier -> merge-events -> watcher, headless, every process image is the staged exe, clean shutdown.
 *      The release has no no-tray mode, so this runs on a TEMPORARY COPY of the staged build with the development devhooks.js
 *      swapped in (the only difference); the copy is deleted afterwards and is never released.
 *   7. Claude-Notifier.vbs started by Explorer: the real tray host, the FIRST-RUN PHONE SETUP (topic created in the fake profile, the setup
 *      window opens by itself and can be used up to the subscribe page; the test message is never sent), then stopped
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const stage = require('./stage');
const winpaths = require('../winpaths');
const { Uia } = require('./uia');

const SYS32 = path.join(winpaths.systemRoot(), 'System32');
const NO_PATH = 'C:\\no-such-folder-claude-notifier';           // nothing on it: staged programs must not depend on PATH
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(250); } return !!fn(); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const sameFile = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const lastJson = (s) => { try { return JSON.parse(s.trim().split('\n').pop()); } catch { return null; } };
const killTree = (pid) => spawnSync(path.join(SYS32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });

function processes() {
  const out = execFileSync(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const a = JSON.parse(out); return Array.isArray(a) ? a : [a];
}
function descendants(rootPid, all) {
  const kids = new Map(); for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const res = []; const walk = (pid) => { for (const k of kids.get(pid) || []) { res.push(k); walk(k.ProcessId); } }; walk(rootPid); return res;
}
/** the phone setup window process started from the staged APP folder (CIM lookup by script path; command lines are never kept) */
function findSetupWindow(parentPid, appDir, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = spawnSync(winpaths.powershellExe(), ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*setup-window.ps1*' -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*${appDir.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' });
    const pid = Number((r.stdout || '').trim().split(/\s+/)[0]); if (pid) return pid;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return null;
}
function fakeProfile(work, name) {
  const home = path.join(work, name); const local = path.join(home, 'AppData', 'Local'); const roam = path.join(home, 'AppData', 'Roaming');
  for (const d of [path.join(home, '.claude', 'sessions'), path.join(roam, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), local]) fs.mkdirSync(d, { recursive: true });
  return { home, local, roam, dataDir: path.join(home, '.claude-notifier'), env: { USERPROFILE: home, HOME: home, APPDATA: roam, LOCALAPPDATA: local, PATH: NO_PATH } };
}
function run(exe, args, { cwd, env, ms = 40000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => resolve({ code, out, err }));
    setTimeout(() => { try { c.kill(); } catch { /* done */ } }, ms);
  });
}
/** starts a long-running staged program, lets it run for `liveMs`, sends simulated tray input, reports whether it is still alive, then kills its whole tree */
async function observe(exe, args, { cwd, env, liveMs = 7000, inspect = null } = {}) {
  const c = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); let out = ''; let err = ''; let exit = null;
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => { exit = code; }); c.stdin.on('error', () => {});
  await sleep(liveMs);
  let extra = null; if (inspect && exit === null) { try { extra = inspect(c.pid); } catch { /* reported by the caller */ } }
  c.stdin.write('toastOk\nexit\n'); await sleep(500);                        // simulated tray input: must do nothing in production
  const aliveAfterInput = exit === null;
  if (exit === null) killTree(c.pid);
  await sleep(600);
  return { aliveAtEnd: aliveAfterInput, exit: aliveAfterInput ? null : exit, out, err, extra };   // exit = the code only if the program ended BY ITSELF (not when we killed it)
}

/** a TEMPORARY copy of a staged build with the development devhooks.js swapped in (everything else identical, exe hard-linked) */
function makeDevVariant(stageDir, work) {
  const src = path.join(stageDir, 'app'); const dst = path.join(work, 'dev-variant', 'app');
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const to = path.join(dst, e.name);
    if (e.name === stage.RUNTIME_NAME) { try { fs.linkSync(path.join(src, e.name), to); } catch { fs.copyFileSync(path.join(src, e.name), to); } } else fs.copyFileSync(path.join(src, e.name), to);
  }
  fs.copyFileSync(path.join(__dirname, '..', 'devhooks.js'), path.join(dst, 'devhooks.js'));
  return dst;
}

/**
 * Starts the production build with ALL development controls at once and checks that none of them did anything.
 * @param check (name, ok, extra) => void
 */
async function productionIgnoresDevControls(stageDir, work, check) {
  const APP = path.join(stageDir, 'app'); const EXE = path.join(APP, stage.RUNTIME_NAME);
  const evil = (n) => path.join(work, `evil-${n}`);                          // none of these folders may ever be created
  const mock = path.join(work, 'mock.json'); fs.writeFileSync(mock, JSON.stringify({ session: 1, procs: [] }));

  // ---- N1: the notifier ----------------------------------------------------------------------------------------------------
  const p1 = fakeProfile(work, 'prodN1');
  const n1 = [path.join(APP, 'notifier.js'), '--ui', 'none', '--data-dir', evil('data'), '--sessions-dir', evil('sess'), '--log-dir', evil('logs'), '--no-lock', '--no-usage', '--control-stdin', '--dump-menu',
    '--duration', '2', '--interval', '1', '--hold', '1', '--hb-ms', '1', '--gap', '1', '--usage-file', path.join(evil('usage'), 'plan-usage-history.json'), '--usage-poll-ms', '1', '--usage-fresh-ms', '1',
    '--usage-stale-gap-ms', '1', '--health-grace-ms', '1', '--health-blind-ms', '1', '--health-stall-ms', '1', '--health-limit', '1', '--profile-refresh-ms', '1', '--activity-margin-ms', '1',
    '--autostart-key', 'HKCU\\Software\\ClaudeNotifierEvilKey', '--autostart-value', 'Evil', '--mock-claude-processes', mock];
  const r1 = await observe(EXE, n1, { cwd: APP, env: { ...p1.env, NOTIFIER_TEST_CRASH_MS: '300' }, liveMs: 8000, inspect: (pid) => descendants(pid, processes()).map((p) => p.Name.toLowerCase()) });
  const log1 = read(path.join(p1.dataDir, 'notifier.log'));
  check('PRODUCTION notifier given EVERY development control at once is still running after 8 s: --duration, the crash variable and simulated stdin input did nothing', r1.aliveAtEnd && r1.exit === null, `exit=${r1.exit}`);
  check('...it runs in TRAY mode (the no-tray mode does not exist) with the DEFAULT data folder, not the one passed', /startup: pid=\d+ node=v24\.18\.0 ui=tray /.test(log1) && log1.includes(`data=${p1.dataDir}`) && !fs.existsSync(evil('data')));
  check('...the single-instance lock is held (the no-lock control was ignored)', fs.existsSync(path.join(p1.dataDir, 'notifier.lock')));
  check('...the usage monitor / profile detection is running (the no-usage control and the fixed usage file were ignored)', /usage profile: method=/.test(log1) && !fs.existsSync(evil('usage')));
  check('...the event stream uses the default sessions / log folders and the fixed 1200 ms hold (folder and timing overrides ignored)', log1.includes(`sessions-dir=${path.join(p1.home, '.claude', 'sessions')}`) && log1.includes('hold=1200ms') && !log1.includes('evil-') && !fs.existsSync(evil('sess')) && !fs.existsSync(evil('logs')));
  check('...no crash marker was written and no crash was logged (crash injector unavailable)', !fs.existsSync(path.join(p1.dataDir, 'test-crashed')) && !/CRASH|test crash/.test(log1));
  check('...no menu / toast JSON was printed (menu dump and simulated tray input unavailable)', !/"menu"/.test(r1.out) && !/"cmd":"toast"/.test(r1.out));
  check('...the real tray host (PowerShell, found without PATH) and the event-stream children are running', !!r1.extra && r1.extra.includes('powershell.exe') && r1.extra.filter((n) => n === 'claudenotifier.exe').length >= 2, r1.extra ? r1.extra.join(',') : 'no process data');

  // ---- N2: the supervisor --------------------------------------------------------------------------------------------------
  const p2 = fakeProfile(work, 'prodN2');
  const r2 = await observe(EXE, [path.join(APP, 'supervisor.js'), '--data-dir', evil('sup'), '--ui', 'none', '--duration', '2', '--no-lock', '--no-usage'], { cwd: APP, env: p2.env, liveMs: 8000 });
  const slog = read(path.join(p2.dataDir, 'supervisor.log')); const nlog = read(path.join(p2.dataDir, 'notifier.log'));
  check('PRODUCTION supervisor ignores its command line: it logs to the default data folder, never to the one passed', /started notifier pid=/.test(slog) && !fs.existsSync(evil('sup')));
  check('...it starts the notifier WITHOUT the arguments (tray mode, still running after 8 s although a duration was passed)', r2.aliveAtEnd && /ui=tray /.test(nlog) && (slog.match(/started notifier pid=/g) || []).length === 1);

  // ---- N3: the event stream child ---------------------------------------------------------------------------------------------
  const p3 = fakeProfile(work, 'prodN3');
  const r3 = await observe(EXE, [path.join(APP, 'merge-events.js'), '--json', '--sessions-dir', evil('s3'), '--log-dir', evil('l3'), '--interval', '1', '--duration', '1', '--replay-days', '3', '--hb-ms', '1'], { cwd: APP, env: p3.env, liveMs: 5000 });
  check('PRODUCTION event stream (merge-events) ignores folder, timing, duration and replay controls: default folders, still running after 5 s', r3.aliveAtEnd && r3.err.includes(`sessions-dir=${path.join(p3.home, '.claude', 'sessions')}`) && !r3.err.includes('evil-') && !fs.existsSync(evil('s3')));

  // ---- N4: the session watcher ------------------------------------------------------------------------------------------------
  const p4 = fakeProfile(work, 'prodN4');
  const r4 = await observe(EXE, [path.join(APP, 'watch-sessions.js'), '--dir', evil('w4'), '--once', '--stats', '--duration', '1', '--no-verify', '--all-entrypoints', '--verify-interval', '1', '--blind-probe-ms', '1', '--heartbeat-ms', '1', '--interval', '1'], { cwd: APP, env: p4.env, liveMs: 5000 });
  check('PRODUCTION session watcher ignores --once / --stats / --duration / folder and timing controls: keeps running, prints no statistics', r4.aliveAtEnd && !/\[stats\]/.test(r4.out + r4.err) && !fs.existsSync(evil('w4')));

  // ---- N5: diagnostics that must keep working, and PATH independence ---------------------------------------------------------
  const p5 = fakeProfile(work, 'prodN5');
  const d5 = lastJson((await run(EXE, [path.join(APP, 'notifier.js'), '--diagnose', '--data-dir', evil('d5'), '--activity-margin-ms', '1', '--mock-claude-processes', mock], { cwd: APP, env: p5.env })).out);
  check('--diagnose still works with PATH pointing nowhere (PowerShell found through the Windows folder) and ignores the data-folder / mock controls', !!d5 && d5.discovery.processLookup === 'ok' && d5.dataDir === p5.dataDir && !fs.existsSync(evil('d5')));
  const auto1 = (await run(EXE, [path.join(APP, 'notifier.js'), '--autostart-status'], { cwd: APP, env: p5.env })).out.trim();
  const auto2 = (await run(EXE, [path.join(APP, 'notifier.js'), '--autostart-status', '--autostart-key', 'HKCU\\Software\\ClaudeNotifierEvilKey', '--autostart-value', 'Evil'], { cwd: APP, env: p5.env })).out.trim();
  check('--autostart-status still works (reg.exe found without PATH) and the registry key / value override is ignored', /^autostart: /.test(auto1) && auto1 === auto2, auto1.slice(0, 40));
  const nst = (await run(EXE, [path.join(APP, 'notifier.js'), '--ntfy-status'], { cwd: APP, env: p5.env })).out;
  check('--ntfy-status still works in the production build and prints no topic', /config|not configured|missing/i.test(nst));
}

/** @returns {Promise<{name:string, ok:boolean, extra?:string}[]>} */
async function verify(stageDir, { explorer = true, log = () => {} } = {}) {
  const results = []; const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
  stageDir = path.resolve(stageDir);
  const APP = path.join(stageDir, 'app'); const EXE = path.join(APP, stage.RUNTIME_NAME);
  const work = `${stageDir}.verify`; fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  try {
    // 1 ---------------------------------------------------------------------------------------------------------------------
    const scan = stage.scanStage(stageDir);
    check('release gates: manifest, allowlist, dependency closure, runtime (version, signature, SHA-256), privacy scan, no dev controls, no bare system-program launches', scan.problems.length === 0, scan.problems.slice(0, 2).join(' | '));
    check('claude-profile.js, winpaths.js and the licence notices are in the package', ['claude-profile.js', 'winpaths.js', 'LICENSES/NODE-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'].every((f) => fs.existsSync(path.join(APP, f))));
    if (scan.problems.length) return results;

    // 2 ---------------------------------------------------------------------------------------------------------------------
    const env0 = { ...process.env, PATH: NO_PATH };
    const w = spawnSync(path.join(SYS32, 'where.exe'), ['node'], { env: env0, encoding: 'utf8' });
    check('precondition: no node.exe (and nothing else) is reachable from the PATH used for every staged run', w.status !== 0);
    const v = spawnSync(EXE, ['-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(a)');d.prepare('insert into t values (?)').run(7);console.log(JSON.stringify({v:process.version,x:process.execPath,q:d.prepare('select a from t').get().a}))"], { env: env0, encoding: 'utf8', cwd: APP });
    let vi = {}; try { vi = JSON.parse(v.stdout.trim()); } catch { /* reported */ }
    check('the staged runtime runs JavaScript at the pinned version, process.execPath is itself, node:sqlite works', v.status === 0 && vi.v === stage.PINNED_NODE_VERSION && sameFile(vi.x, EXE) && vi.q === 7, v.stderr && v.stderr.trim().slice(0, 100));

    // 3 ---------------------------------------------------------------------------------------------------------------------
    const fp = fakeProfile(work, 'profileU'); const NOW = Date.now();
    const sample = (fh, sd) => JSON.stringify({ version: 2, samples: [{ t: NOW - 60_000, org: 'fake', u: { fh, sd } }] });
    const mk = (dir, content, ageMs) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'Preferences'), '{}'); if (content) { const f = path.join(dir, 'plan-usage-history.json'); fs.writeFileSync(f, content); const t = new Date(NOW - ageMs); fs.utimesSync(f, t, t); } return dir; };
    const A = mk(path.join(fp.local, 'Claude-Data', 'claude_famA'), sample(55, 30), 60_000); const B = mk(path.join(fp.roam, 'Claude-Account2'), sample(91, 92), 5_000);
    const proc = (udd, extra = {}) => ({ pid: 100 + Math.floor(Math.random() * 1e5), ppid: 1, exe: 'C:\\Program Files\\WindowsApps\\Claude_4.0_x64__x\\app\\Claude.exe', type: 'utility', udd, session: 1, ...extra });
    const procsFile = path.join(work, 'procs.json');
    const select = async (procs) => {
      fs.writeFileSync(procsFile, JSON.stringify({ session: 1, procs }));
      const code = "const cp=require(process.argv[1]);const j=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify(cp.selectProfile({procs:j.procs,session:j.session,env:JSON.parse(process.argv[3])})))";
      const r = await run(EXE, ['-e', code, path.join(APP, 'claude-profile.js'), procsFile, JSON.stringify({ USERPROFILE: fp.home, APPDATA: fp.roam, LOCALAPPDATA: fp.local })], { cwd: APP, env: { PATH: NO_PATH } });
      return lastJson(r.out);
    };
    let d = await select([proc(A), proc(A)]);
    check('usage discovery (staged module): one running profile => ITS usage file is selected, although another profile has a fresher one', d && d.method === 'process' && d.profile.label === 'Local/Claude-Data/claude_famA' && d.profile.state === 'valid' && /claude_famA/.test(d.path));
    d = await select([proc(A), proc(B)]);
    check('usage discovery (staged module): two running profiles with no session owner => ambiguous, nothing selected', d && d.ambiguous === true && d.path === null);
    fs.rmSync(path.join(A, 'plan-usage-history.json'));
    d = await select([proc(A)]);
    check('usage discovery (staged module): identified profile with a missing usage file => reported missing, no fallback to the other profile', d && d.profile.state === 'missing' && /claude_famA/.test(d.path));
    const dg = lastJson((await run(EXE, [path.join(APP, 'notifier.js'), '--diagnose'], { cwd: APP, env: fp.env })).out);
    check('--diagnose of the staged build holds no home folder and no account id (paths redacted)', !!dg && !JSON.stringify(dg).includes(fp.home) && !JSON.stringify(dg).includes('fake') && dg.discovery.processLookup === 'ok');

    // 4 ---------------------------------------------------------------------------------------------------------------------
    await productionIgnoresDevControls(stageDir, work, check);

    // 5 ---------------------------------------------------------------------------------------------------------------------
    const real = await run(EXE, [path.join(APP, 'notifier.js'), '--diagnose'], { cwd: APP, env: { PATH: NO_PATH } });
    const rj = lastJson(real.out);
    check('this machine (read-only --diagnose from the staged exe, PATH pointing nowhere): the process query works and a discovery method is reported', !!rj && rj.discovery && rj.discovery.processLookup === 'ok' && !!rj.discovery.method, rj ? `method=${rj.discovery.method}, selected=${rj.discovery.selected || 'none'}, usage=${rj.discovery.selectedUsageState || '-'}${rj.discovery.ambiguous ? ', AMBIGUOUS' : ''}` : (real.err || '').slice(0, 120));

    // 6 ---------------------------------------------------------------------------------------------------------------------
    const VAPP = makeDevVariant(stageDir, work); const VEXE = path.join(VAPP, stage.RUNTIME_NAME);
    const fpD = fakeProfile(work, 'profileD'); const dataD = path.join(fpD.home, '.claude-notifier'); const logsD = path.join(work, 'logsD'); fs.mkdirSync(logsD, { recursive: true });
    const sup = spawn(VEXE, [path.join(VAPP, 'supervisor.js'), '--ui', 'none', '--no-usage', '--duration', '14', '--data-dir', dataD, '--sessions-dir', path.join(fpD.home, '.claude', 'sessions'), '--log-dir', logsD, '--interval', '500'], { cwd: VAPP, env: { ...process.env, ...fpD.env }, stdio: 'ignore', windowsHide: true });
    let supExit = null; sup.on('exit', (c) => { supExit = c; });
    await waitFor(() => /started notifier pid=/.test(read(path.join(dataD, 'supervisor.log'))), 15000);
    await waitFor(() => fs.existsSync(path.join(dataD, 'sounds', 'attention.wav')), 15000); await sleep(1500);
    const kids = descendants(sup.pid, processes()).filter((p) => /^(node|ClaudeNotifier)\.exe$/i.test(p.Name));
    check('[dev-hooks copy of the staged build] supervisor -> notifier -> merge-events -> watcher are up, every one is the staged-build ClaudeNotifier.exe (image path checked)', kids.length >= 3 && kids.every((p) => sameFile(p.ExecutablePath, VEXE)) && !kids.some((p) => /^node\.exe$/i.test(p.Name)), `${kids.length} child runtimes`);
    check('generated sounds went to the per-user data folder, never into the application folder', fs.readdirSync(path.join(dataD, 'sounds')).length === 4 && !fs.readdirSync(APP).some((f) => /\.(wav|log|db|json|lock)$/i.test(f)));
    await waitFor(() => supExit !== null, 25000);
    check('clean shutdown: notifier exit 0 with its reason, supervisor does not restart and exits 0', supExit === 0 && /shutting down: duration elapsed \(exit code 0\)/.test(read(path.join(dataD, 'notifier.log'))) && (read(path.join(dataD, 'supervisor.log')).match(/started notifier pid=/g) || []).length === 1);
    await sleep(700);
    check('no ClaudeNotifier.exe of the copy is left running after the clean shutdown', processes().filter((p) => sameFile(p.ExecutablePath, VEXE)).length === 0);

    // 7 ---------------------------------------------------------------------------------------------------------------------
    if (explorer) {
      const fpE = fakeProfile(work, 'profileE'); const dataE = path.join(fpE.home, '.claude-notifier');
      const wrapper = path.join(work, 'explorer-launch.vbs');
      const setEnv = Object.entries(fpE.env).map(([k, val]) => `env("${k}") = "${val.replace(/"/g, '""')}"`).join('\r\n');
      fs.writeFileSync(wrapper, `Set sh = CreateObject("WScript.Shell")\r\nSet env = sh.Environment("Process")\r\n${setEnv}\r\nsh.Run "wscript.exe """"${path.join(APP, 'Claude-Notifier.vbs')}""""", 0, False\r\n`);
      const before = new Set(processes().map((p) => p.ProcessId));
      spawn(winpaths.explorerExe(), [wrapper], { detached: true, stdio: 'ignore' }).unref();
      const up = await waitFor(() => /startup: pid=/.test(read(path.join(dataE, 'notifier.log'))), 40000); await sleep(4000);
      const procs = processes();
      const supE = procs.find((p) => !before.has(p.ProcessId) && sameFile(p.ExecutablePath, EXE) && procs.some((c) => c.ParentProcessId === p.ProcessId && sameFile(c.ExecutablePath, EXE)) && !procs.some((q) => q.ProcessId === p.ParentProcessId && sameFile(q.ExecutablePath, EXE)));
      check('PRODUCTION: Claude-Notifier.vbs started by Explorer launches the staged supervisor (PATH pointing nowhere)', up && !!supE);
      if (supE) {
        const sk = descendants(supE.ProcessId, procs); const rt = sk.filter((p) => /^(node|ClaudeNotifier)\.exe$/i.test(p.Name)); const ps = sk.filter((p) => /^powershell\.exe$/i.test(p.Name));
        check('...with the notifier, merge-events and the watcher as staged ClaudeNotifier.exe and a real tray host (PowerShell)', rt.length >= 3 && rt.every((p) => sameFile(p.ExecutablePath, EXE)) && ps.length >= 1, `${rt.length} runtimes, ${ps.length} powershell`);
        check('...and no startup failure was logged', !/FATAL|uncaught|cannot find module|is not recognized/i.test(read(path.join(dataE, 'notifier.log'))));

        // ---- first-run phone setup in the real production tray build ----
        const cfgE = path.join(dataE, 'ntfy.json'); const setE = path.join(dataE, 'settings.json');
        const TOPIC = /^claude-[a-hj-km-np-z2-9]{16}$/;
        const gotCfg = await waitFor(() => { try { return TOPIC.test(JSON.parse(read(cfgE)).topic); } catch { return false; } }, 15000);
        let cfgJson = {}; try { cfgJson = JSON.parse(read(cfgE)); } catch { /* reported below */ }
        let setJson = {}; try { setJson = JSON.parse(read(setE)); } catch { /* no settings yet */ }
        check('PRODUCTION first run: a fresh topic was created on this (fake) machine, default server ntfy.sh, and phone notifications are OFF', gotCfg && cfgJson.server === 'https://ntfy.sh' && !cfgJson.token && setJson.phoneEnabled !== true);
        const winPid = findSetupWindow(supE.ProcessId, APP, 15000);
        check('...the phone setup window opened by itself (no Node on PATH, PowerShell found through the Windows folder)', !!winPid);
        if (winPid) {
          const ui = new Uia().start();
          const att = await ui.attach(winPid, 15000); await sleep(700);
          const nm = async () => (await ui.list()).map((i) => i.name);
          const nm0 = await nm();
          check('...it shows the checklist page and no topic yet', att.ok && nm0.includes('Next: connect your phone') && !nm0.some((x) => x.includes(cfgJson.topic)), `attach=${att.ok}${att.error ? ' ' + att.error : ''}, ${nm0.length} controls: ${nm0.map((x) => x.slice(0, 18)).join(' | ')}`);
          await ui.invoke('Next: connect your phone'); await ui.until(async () => (await nm()).includes('I have the ntfy app'), 8000);
          await ui.invoke('I have the ntfy app'); await ui.until(async () => (await nm()).includes('Send test notification'), 8000);
          check('...the subscribe page shows THIS machine\'s topic and the test button (the test is not sent here)', (await nm()).includes(cfgJson.topic) && (await nm()).includes('Send test notification'));
          await ui.close(); await sleep(2500);
          let after = {}; try { after = JSON.parse(read(setE)); } catch { /* reported below */ }
          check('...closing it counts as "not now": state dismissed, phone notifications still OFF, the configuration unchanged', after.phoneSetup && after.phoneSetup.state === 'dismissed' && after.phoneEnabled !== true && read(cfgE) === JSON.stringify(cfgJson, null, 2));
          await ui.stop();
        }
        check('the production notifier log of this first run never contains the topic, a deep link or a URL', !read(path.join(dataE, 'notifier.log')).includes(cfgJson.topic || '\u0000') && !/ntfy:\/\/|https?:\/\//.test(read(path.join(dataE, 'notifier.log'))));
        killTree(supE.ProcessId); await sleep(1500);
        check('the isolated instance is stopped afterwards (no stray ClaudeNotifier.exe)', processes().filter((p) => sameFile(p.ExecutablePath, EXE)).length === 0);
      } else check('(tray chain not found: the following checks are skipped)', false);
    }
    return results;
  } finally {
    try { for (const p of processes()) if (p.ExecutablePath && (sameFile(p.ExecutablePath, EXE) || sameFile(p.ExecutablePath, path.join(work, 'dev-variant', 'app', stage.RUNTIME_NAME)))) spawnSync(path.join(SYS32, 'taskkill.exe'), ['/PID', String(p.ProcessId), '/F'], { stdio: 'ignore' }); } catch { /* none running */ }   // only OUR staged exe, never another install
    await sleep(300);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort: our own scratch folder */ }
  }
}

module.exports = { verify, productionIgnoresDevControls, makeDevVariant, fakeProfile, observe, NO_PATH };

if (require.main === module) {
  const dir = process.argv[2] || path.join(path.resolve(__dirname, '..', '..'), 'release', 'stage');
  verify(dir, { log: console.log }).then((r) => { const bad = r.filter((x) => !x.ok).length; console.log(`\n${r.length - bad}/${r.length} verification checks passed`); process.exit(bad ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
}
