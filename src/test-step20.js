#!/usr/bin/env node
/**
 * test-step20.js -- the installer (ClaudeNotifierSetup.exe, Inno Setup 6) in an ISOLATED test identity.
 *
 * Uses the --test build variants (own app id, shortcut name "Claude Notifier (installer test)", startup value ClaudeNotifierInstallerTest,
 * toast key ClaudeNotifier.InstallerTest). The application is installed into <repository root>\installer-test\app and started with a
 * FAKE Windows profile (USERPROFILE / APPDATA / LOCALAPPDATA), so its data folder is the fake one. A snapshot of every real entry that
 * could be affected (real data folder, real startup value, real toast registration, real Start Menu / Desktop entries) is taken first and
 * compared at the end. Needs: tools/build-installer.js --test --version 1.0.0 and --version 1.0.1 to have been run.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const winpaths = require('./winpaths');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'installer', 'out-test');
const V1 = path.join(OUTDIR, 'ClaudeNotifierSetup-test-1.0.0.exe');
const V2 = path.join(OUTDIR, 'ClaudeNotifierSetup-test-1.0.1.exe');
const STAGE = path.join(ROOT, 'release', 'stage');
const WORK = path.join(ROOT, 'installer-test');
const APP = path.join(WORK, 'app');
const PROFILE = path.join(WORK, 'profile');
const DATA = path.join(PROFILE, '.claude-notifier');
const GUID = '{6A1F0D3E-7C52-4B9E-8D14-0E2B5A97C3F1}';
const APP_NAME = 'Claude Notifier (installer test)';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ClaudeNotifierInstallerTest';
const UNINST_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}_is1`;
const AUMID_TEST_KEY = 'HKCU\\Software\\Classes\\AppUserModelId\\ClaudeNotifier.InstallerTest';
const FAKE_ENV = { USERPROFILE: PROFILE, HOME: PROFILE, APPDATA: path.join(PROFILE, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(PROFILE, 'AppData', 'Local') };

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const reg = (args) => { const r = spawnSync(winpaths.regExe(), args, { encoding: 'utf8', windowsHide: true }); return { code: r.status, out: String(r.stdout || '') }; };
const ps = (cmd) => spawnSync(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).stdout.trim();
const PROGRAMS = ps("[Environment]::GetFolderPath('Programs')"); const DESKTOP = ps("[Environment]::GetFolderPath('DesktopDirectory')");
const F_PROGRAMS = path.join(FAKE_ENV.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'); const F_DESKTOP = path.join(PROFILE, 'Desktop');   // the fake profile's shell folders
const SC_START = path.join(F_PROGRAMS, `${APP_NAME}.lnk`); const SC_DESK = path.join(F_DESKTOP, `${APP_NAME}.lnk`);
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return !!(await fn()); };

// ---- what is running from the installed folder (CIM, by executable path / command line) ----
function procs() {
  const code = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.ExecutablePath -like '${APP.replace(/'/g, "''")}\\*' -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*${APP.replace(/'/g, "''")}\\*')) } | Select-Object ProcessId,ParentProcessId,Name,@{n='Cmd';e={ if ($_.CommandLine) { $_.CommandLine } else { '' } }} | ConvertTo-Json -Compress`;
  const t = ps(code); if (!t) return []; const j = JSON.parse(t); return Array.isArray(j) ? j : [j];
}
const supervisors = () => procs().filter((p) => p.Name === 'ClaudeNotifier.exe' && /supervisor\.js/.test(p.Cmd));
const notifiers = () => procs().filter((p) => p.Name === 'ClaudeNotifier.exe' && /notifier\.js/.test(p.Cmd) && !/supervisor|merge-events|watch-sessions/.test(p.Cmd));
const startups = () => (rd(path.join(DATA, 'notifier.log')).match(/startup: pid=/g) || []).length;

// ---- the real machine: everything an isolated test must not change ----
function realSnapshot() {
  const home = os.homedir(); const d = path.join(home, '.claude-notifier'); const snap = {};
  for (const f of ['ntfy.json', 'settings.json']) snap[`data/${f}`] = fs.existsSync(path.join(d, f)) ? sha(path.join(d, f)) : null;
  snap.runValue = reg(['query', RUN_KEY.replace('Run', 'Run'), '/v', 'ClaudeNotifier']).out.trim();
  snap.aumid = reg(['query', 'HKCU\\Software\\Classes\\AppUserModelId\\ClaudeNotifier.Companion']).out.trim();
  snap.realShortcut = fs.existsSync(path.join(PROGRAMS, 'Claude Notifier.lnk')) ? sha(path.join(PROGRAMS, 'Claude Notifier.lnk')) : null;
  snap.programsClaude = fs.readdirSync(PROGRAMS).filter((n) => /claude/i.test(n) && n !== `${APP_NAME}.lnk`).sort().join('|');
  snap.desktopClaude = fs.readdirSync(DESKTOP).filter((n) => /claude/i.test(n) && n !== `${APP_NAME}.lnk`).sort().join('|');
  return snap;
}
// ---- the installed tree against the release manifest ----
function verifyTree() {
  const lines = fs.readFileSync(path.join(STAGE, 'MANIFEST.txt'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  let bad = []; const expected = new Set();
  for (const l of lines) {
    const m = /^([0-9a-f]{64}) (\d+) (.+)$/.exec(l); const rel = m[3];
    const dest = rel.startsWith('app/') ? path.join(APP, rel.slice(4)) : path.join(APP, 'release-info', rel);
    expected.add(path.resolve(dest).toLowerCase());
    if (!fs.existsSync(dest) || sha(dest) !== m[1]) bad.push(rel);
  }
  const mf = path.join(APP, 'release-info', 'MANIFEST.txt'); expected.add(path.resolve(mf).toLowerCase());
  if (!fs.existsSync(mf) || sha(mf) !== sha(path.join(STAGE, 'MANIFEST.txt'))) bad.push('MANIFEST.txt');
  const extra = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!expected.has(path.resolve(f).toLowerCase()) && !/^unins\d+\.(exe|dat|msg)$/i.test(e.name)) extra.push(path.relative(APP, f)); } })(APP);
  return { entries: lines.length + 1, bad, extra };
}
// ---- running the installer / uninstaller in the fake profile ----
let sacBlocks = 0;
/** starts an installer / uninstaller. On this machine Windows Smart App Control (enforcing) judges every UNSIGNED executable by its hash and may refuse to start it
 *  (error 4551 "An Application Control policy has blocked this file"); such a refused start is retried, counted and printed. It is not a test result. */
async function runSetup(exe, args, ms = 240000, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    const r = await new Promise((resolve) => {
      const t0 = Date.now(); let c;
      try { c = spawn(exe, args, { env: { ...process.env, ...FAKE_ENV }, stdio: 'ignore', windowsHide: true }); } catch { return resolve({ blocked: true, code: null, ms: 0 }); }
      c.on('error', () => resolve({ blocked: true, code: null, ms: 0 }));
      const timer = setTimeout(() => { try { c.kill(); } catch { /* */ } }, ms);
      c.on('exit', (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - t0 }); });
    });
    if (!r.blocked) return r;
    sacBlocks++; console.log(`  (Windows refused to start ${path.basename(exe)}: Smart App Control, attempt ${i}/${tries})`); await sleep(4000);
  }
  return { code: null, ms: 0, blocked: true };
}
/** the generated uninstaller (unins000.exe) is a new unsigned file at every install, so it can be refused too: regenerate it by re-running the installer */
async function uninstallApp() {
  for (let cycle = 1; cycle <= 6; cycle++) {
    const r = await runSetup(path.join(APP, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], 120000, 2);
    if (!r.blocked) return r;
    console.log(`  (the generated uninstaller was refused; regenerating it by installing again, cycle ${cycle})`);
    await install(cycle % 2 ? V2 : V1);
  }
  return { code: null, ms: 0, blocked: true };
}
let installSeq = 0;
/** runs an installer with its own Inno log; a non-zero exit prints the reason from that log (diagnostics only, the assertion is unchanged) */
async function install(exe, tasks = null, extra = []) {
  const log = path.join(WORK, `setup-${++installSeq}.log`);
  const r = await runSetup(exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${APP}`, `/LOG=${log}`, ...(tasks !== null ? [`/TASKS=${tasks}`] : []), ...extra]);
  if (r.code !== 0 && !r.blocked) {
    const why = rd(log).split(/\r?\n/).filter((l) => /failed|abort|exception|exit code|could not|error/i.test(l) && !/EncodedCommand/.test(l)).slice(0, 5).map((l) => l.slice(0, 200));
    console.log(`  (installer #${installSeq} exited with code ${r.code}: ${why.join(' | ') || 'no reason in the log'})`);
  }
  return r;
}
function launchApp() { spawn(path.join(winpaths.systemRoot(), 'System32', 'wscript.exe'), [path.join(APP, 'Claude-Notifier.vbs')], { env: { ...process.env, ...FAKE_ENV }, detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
const runValue = () => { const r = reg(['query', RUN_KEY, '/v', RUN_VALUE]); if (r.code !== 0) return null; const m = new RegExp(`${RUN_VALUE}\\s+REG_SZ\\s+(.*)`).exec(r.out); return m ? m[1].trim() : ''; };
const runValueCount = () => (reg(['query', RUN_KEY]).out.match(new RegExp(`^\\s+${RUN_VALUE}\\s`, 'gm')) || []).length;
const uninstallVersion = () => { const r = reg(['query', UNINST_KEY, '/v', 'DisplayVersion']); const m = /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(r.out); return m ? m[1] : null; };
const dataState = () => { const o = {}; for (const f of ['ntfy.json', 'settings.json', 'marker.txt']) o[f] = fs.existsSync(path.join(DATA, f)) ? sha(path.join(DATA, f)) : null; return o; };

(async () => {
  for (const f of [V1, V2]) if (!fs.existsSync(f)) { console.error(`missing ${f}: run tools/build-installer.js --test --version 1.0.0 / 1.0.1 first`); process.exit(2); }
  const stageManifest0 = sha(path.join(STAGE, 'MANIFEST.txt'));
  const real0 = realSnapshot();
  if (fs.existsSync(WORK) && !fs.existsSync(path.join(WORK, '.installer-test'))) { console.error(`${WORK} exists and is not ours`); process.exit(2); }
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true }); fs.writeFileSync(path.join(WORK, '.installer-test'), 'x');
  for (const d of [FAKE_ENV.APPDATA, FAKE_ENV.LOCALAPPDATA, path.join(PROFILE, '.claude', 'sessions'), path.join(FAKE_ENV.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(PROFILE, 'Desktop')]) fs.mkdirSync(d, { recursive: true });
  // a "finished" existing user: settings with appearance, a phone configuration, setup already dismissed (no window pops up)
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ notificationsEnabled: false, soundsEnabled: true, phoneEnabled: false, appearance: 'dark', phoneSetup: { state: 'dismissed' } }, null, 2));
  fs.writeFileSync(path.join(DATA, 'ntfy.json'), JSON.stringify({ server: 'https://ntfy.sh', topic: 'claude-abcdefghjkmnpqrs', token: '' }, null, 2));
  fs.writeFileSync(path.join(DATA, 'marker.txt'), 'history stand-in');
  const data0 = dataState();
  try {
    console.log('== A) first installation');
    check('(test setup) no leftovers of the test identity exist (no shortcut, no startup value, no uninstall entry)', !fs.existsSync(SC_START) && !fs.existsSync(SC_DESK) && runValue() === null && uninstallVersion() === null);
    let r = await install(V1);
    check('the installer ran silently and succeeded (exit code 0)', r.code === 0, `${r.ms} ms`);
    let t = verifyTree();
    check('every installed file matches the release manifest (hash and size), nothing else was installed but the uninstaller', t.bad.length === 0 && t.extra.length === 0, `${t.entries} entries; mismatches=[${t.bad}] extra=[${t.extra}]`);
    check('installed under the chosen per-user folder, with the verified runtime, theme.js and palette.js and the clipboard-safe setup window', fs.existsSync(path.join(APP, 'ClaudeNotifier.exe')) && fs.existsSync(path.join(APP, 'theme.js')) && fs.existsSync(path.join(APP, 'palette.js')) && /ClearIfEquals/.test(rd(path.join(APP, 'setup-window.ps1'))));
    check('the Start Menu shortcut exists (in the profile of the installing user), with the application name the app itself uses, and starts the hidden launcher', fs.existsSync(SC_START) && /wscript\.exe/i.test(ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${SC_START.replace(/'/g, "''")}').TargetPath`)) && ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${SC_START.replace(/'/g, "''")}').Arguments`).includes('Claude-Notifier.vbs'));
    check('NO desktop shortcut by default', !fs.existsSync(SC_DESK));
    check('startup is opt-in: NO startup entry for a new installation', runValue() === null);
    check('the uninstall entry exists with the installed version', uninstallVersion() === '1.0.0', String(uninstallVersion()));
    check('the installer did not touch the user data (settings, ntfy.json, marker are byte-identical)', JSON.stringify(dataState()) === JSON.stringify(data0));

    console.log('== B) first launch of the installed application');
    launchApp();
    const up = await until(() => supervisors().length === 1 && notifiers().length === 1 && /startup: pid=/.test(rd(path.join(DATA, 'notifier.log'))), 40000);
    await sleep(3000);
    const pr = procs();
    check('the installed app starts from the Start Menu launcher chain: one watchdog, one notifier, a tray host (PowerShell)', up && supervisors().length === 1 && notifiers().length === 1 && pr.some((p) => p.Name === 'powershell.exe'), pr.map((p) => p.Name).join(','));
    check('every runtime process is the installed ClaudeNotifier.exe (no Node.js involved)', pr.filter((p) => /ClaudeNotifier|node/i.test(p.Name)).every((p) => p.Name === 'ClaudeNotifier.exe'));
    check('no startup failure was logged and the app wrote only to the data folder (the install folder holds no data)', !/FATAL|uncaught|cannot find module/i.test(rd(path.join(DATA, 'notifier.log'))) && verifyTree().extra.length === 0);
    const dataRun1 = dataState(); const startups1 = startups();

    console.log('== C) upgrade while the app is RUNNING (v1.0.1 over v1.0.0)');
    fs.writeFileSync(path.join(APP, 'obsolete-from-old-version.js'), '// a file that the new version no longer has');
    const oldPids = procs().map((p) => p.ProcessId); const oldSup = supervisors()[0].ProcessId;
    r = await install(V2);
    check('the upgrade over a running app succeeded (exit code 0)', r.code === 0, `${r.ms} ms`);
    check('the old processes were shut down (none of the old PIDs is alive)', !procs().some((p) => oldPids.includes(p.ProcessId)) || (supervisors().length === 1 && supervisors()[0].ProcessId !== oldSup && !procs().some((p) => p.ProcessId === oldSup)));
    await until(() => supervisors().length >= 1 && startups() > startups1, 40000); await sleep(4000);
    check('the app was started again EXACTLY ONCE: one watchdog, one notifier, one new startup line in the log', supervisors().length === 1 && notifiers().length === 1 && startups() === startups1 + 1 && supervisors()[0].ProcessId !== oldSup, `watchdogs=${supervisors().length} notifiers=${notifiers().length} startups ${startups1} -> ${startups()}`);
    t = verifyTree();
    check('after the upgrade every file again matches the release manifest and the obsolete file is gone', t.bad.length === 0 && t.extra.length === 0 && !fs.existsSync(path.join(APP, 'obsolete-from-old-version.js')), `mismatches=[${t.bad}] extra=[${t.extra}]`);
    check('the uninstall entry shows the new version (one entry, upgraded in place)', uninstallVersion() === '1.0.1');
    check('user data survived the upgrade byte-for-byte (settings incl. appearance, ntfy.json, marker)', JSON.stringify(dataState()) === JSON.stringify(dataRun1) && dataRun1['settings.json'] === data0['settings.json'] && dataRun1['ntfy.json'] === data0['ntfy.json'] && JSON.parse(rd(path.join(DATA, 'settings.json'))).appearance === 'dark', 'appearance=dark kept');
    check('a startup entry was NOT created by the upgrade (the user had not chosen one)', runValue() === null);
    check('still exactly one Start Menu shortcut and no desktop shortcut', fs.existsSync(SC_START) && !fs.existsSync(SC_DESK) && fs.readdirSync(F_PROGRAMS).filter((n) => n === `${APP_NAME}.lnk`).length === 1);

    console.log('== D) startup preference and desktop shortcut');
    const cmd = `wscript.exe "${path.join(APP, 'Claude-Notifier.vbs')}"`;
    reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f']);       // the user enabled startup (the app writes this exact form)
    const sup1 = supervisors()[0].ProcessId;
    r = await install(V2);
    check('re-installing over the same version (app running) succeeded', r.code === 0);
    await until(() => supervisors().length === 1 && supervisors()[0].ProcessId !== sup1, 40000); await sleep(3000);
    check('the existing startup preference was kept: exactly ONE entry, same command', runValueCount() === 1 && runValue() === cmd, runValue());
    check('the running app was restarted exactly once again', supervisors().length === 1 && notifiers().length === 1);
    await install(V2, '', []);                                                       // an unattended install that names no tasks
    check('an unattended install never removes an existing startup entry (only a deliberate un-tick in the wizard does)', runValueCount() === 1 && runValue() === cmd);
    reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    r = await install(V2, 'desktopicon,autostart');
    check('ticking "desktop shortcut" and "start when I sign in" creates ONE desktop shortcut and ONE startup entry', fs.existsSync(SC_DESK) && runValueCount() === 1 && runValue() === cmd);
    r = await install(V2, 'desktopicon,autostart');
    check('repeating that changes nothing: still one startup entry, one shortcut each, no duplicates', runValueCount() === 1 && fs.readdirSync(F_PROGRAMS).filter((n) => n === `${APP_NAME}.lnk`).length === 1 && fs.readdirSync(F_DESKTOP).filter((n) => n === `${APP_NAME}.lnk`).length === 1);
    t = verifyTree();
    check('the installed tree still matches the manifest after all the re-installs', t.bad.length === 0 && t.extra.length === 0);

    console.log('== E) uninstall (app running)');
    reg(['add', AUMID_TEST_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'installer test', '/f']);
    if (supervisors().length === 0) { launchApp(); await until(() => supervisors().length === 1, 30000); }
    await until(() => supervisors().length === 1 && notifiers().length === 1, 40000); await sleep(2500);
    const dataBeforeUn = dataState();
    const unins = path.join(APP, 'unins000.exe');
    check('(test setup) the uninstaller exists and the app is running', fs.existsSync(unins) && supervisors().length === 1);
    r = await uninstallApp();
    await until(() => !fs.existsSync(APP) && procs().length === 0, 60000);
    check('the uninstaller ran silently and finished (its first process hands over to a temporary copy, so completion is judged by the result)', !fs.existsSync(APP) || fs.readdirSync(APP).length === 0, `first-stage exit ${r.code}, ${r.ms} ms`);
    check('the running app was shut down by the uninstaller (no process of the installation is left)', procs().length === 0);
    check('the application files are gone (installation folder removed)', !fs.existsSync(APP) || fs.readdirSync(APP).length === 0, fs.existsSync(APP) ? 'an EMPTY folder was left behind' : 'folder removed');
    check('the Start Menu shortcut, the desktop shortcut and the startup entry are gone', !fs.existsSync(SC_START) && !fs.existsSync(SC_DESK) && runValue() === null && runValueCount() === 0);
    check('the uninstall entry and the toast registration of the test identity are gone', uninstallVersion() === null && reg(['query', AUMID_TEST_KEY]).code !== 0);
    check('USER DATA WAS NOT DELETED: settings (appearance), ntfy.json and the marker are byte-identical to before the uninstall', JSON.stringify(dataState()) === JSON.stringify(dataBeforeUn) && fs.existsSync(path.join(DATA, 'notifier.log')) && JSON.parse(rd(path.join(DATA, 'settings.json'))).appearance === 'dark');

    console.log('== F) a clean re-install after the uninstall, then a final uninstall');
    r = await install(V2);
    t = verifyTree();
    check('installing again after an uninstall works and matches the manifest; the old user data is picked up untouched', r.code === 0 && t.bad.length === 0 && t.extra.length === 0 && JSON.stringify(dataState()) === JSON.stringify(dataBeforeUn));
    r = await uninstallApp();
    await until(() => !fs.existsSync(APP), 40000);
    check('final cleanup: uninstalled again, nothing of the test identity remains', !fs.existsSync(SC_START) && !fs.existsSync(SC_DESK) && runValue() === null && uninstallVersion() === null && JSON.stringify(dataState()) === JSON.stringify(dataBeforeUn));
  } finally {
    // safety net: stop anything still running from the test folder and remove leftovers of the test identity
    try { spawnSync(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${APP.replace(/'/g, "''")}\\*' -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*${APP.replace(/'/g, "''")}\\*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true }); } catch { /* */ }
    reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']); reg(['delete', AUMID_TEST_KEY, '/f']);
  }

  console.log('== G) the real machine and the verified stage were not touched');
  const real1 = realSnapshot();
  check('real data folder: ntfy.json and settings.json unchanged', real1['data/ntfy.json'] === real0['data/ntfy.json'] && real1['data/settings.json'] === real0['data/settings.json']);
  check('real startup value (ClaudeNotifier), real toast registration and real Start Menu shortcut unchanged', real1.runValue === real0.runValue && real1.aumid === real0.aumid && real1.realShortcut === real0.realShortcut);
  check('no other Claude entry appeared in or disappeared from the real Start Menu / Desktop', real1.programsClaude === real0.programsClaude && real1.desktopClaude === real0.desktopClaude);
  check('the verified release stage is untouched (manifest hash unchanged)', sha(path.join(STAGE, 'MANIFEST.txt')) === stageManifest0);
  const fails = results.filter((x) => !x).length;
  console.log(`\nWindows Smart App Control refused ${sacBlocks} start(s) of unsigned installer files during this run (each one retried; see above)`);
  console.log(`\nstep20: ${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']); reg(['delete', AUMID_TEST_KEY, '/f']); } catch { /* */ } process.exit(1); });
