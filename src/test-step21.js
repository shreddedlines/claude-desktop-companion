#!/usr/bin/env node
/**
 * test-step21.js -- the GRAPHICAL Inno Setup wizard of the installer, driven like a person (real mouse clicks, screenshots) in the ISOLATED
 * test identity (the --test installers, a fake Windows profile, <repository root>\installer-test). Covers: the default state of the
 * startup / desktop checkboxes, the optional desktop shortcut, "Launch now", an upgrade that pre-selects an existing startup entry, deliberately
 * un-ticking it, cancelling, and a failing installation (message shown). Also proves that the real production installer script and output, the
 * verified stage and the real user data / startup value were not touched.
 * Needs tools/build-installer.js --test --version 1.0.0 and 1.0.1. Opens real installer windows on the desktop for a few minutes.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const winpaths = require('./winpaths');

const ROOT = path.resolve(__dirname, '..');
const V1 = path.join(ROOT, 'installer', 'out-test', 'ClaudeNotifierSetup-test-1.0.0.exe');
const V2 = path.join(ROOT, 'installer', 'out-test', 'ClaudeNotifierSetup-test-1.0.1.exe');
const DRIVER = path.join(__dirname, 'tools', 'installer-test', 'wizard-driver.ps1');
const STOP = path.join(__dirname, 'tools', 'installer', 'stop-notifier.ps1');
const WORK = path.join(ROOT, 'installer-test'); const APP = path.join(WORK, 'app'); const PROFILE = path.join(WORK, 'profile'); const DATA = path.join(PROFILE, '.claude-notifier');
const SHOTS = path.join(WORK, 'shots');
const GUID = '{6A1F0D3E-7C52-4B9E-8D14-0E2B5A97C3F1}';
const APP_NAME = 'Claude Notifier (installer test)';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; const RUN_VALUE = 'ClaudeNotifierInstallerTest';
const UNINST_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}_is1`;
const AUMID_TEST_KEY = 'HKCU\\Software\\Classes\\AppUserModelId\\ClaudeNotifier.InstallerTest';
const FAKE = { USERPROFILE: PROFILE, HOME: PROFILE, APPDATA: path.join(PROFILE, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(PROFILE, 'AppData', 'Local') };
const F_PROGRAMS = path.join(FAKE.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'); const F_DESKTOP = path.join(PROFILE, 'Desktop');
const SC_START = path.join(F_PROGRAMS, `${APP_NAME}.lnk`); const SC_DESK = path.join(F_DESKTOP, `${APP_NAME}.lnk`);

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(300); } return !!(await fn()); };
const reg = (args) => { const r = spawnSync(winpaths.regExe(), args, { encoding: 'utf8', windowsHide: true }); return { code: r.status, out: String(r.stdout || '') }; };
const ps = (cmd) => spawnSync(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).stdout.trim();
const runValue = () => { const r = reg(['query', RUN_KEY, '/v', RUN_VALUE]); if (r.code !== 0) return null; const m = new RegExp(`${RUN_VALUE}\\s+REG_SZ\\s+(.*)`).exec(r.out); return m ? m[1].trim() : ''; };
const uninstallVersion = () => { const m = /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(reg(['query', UNINST_KEY, '/v', 'DisplayVersion']).out); return m ? m[1] : null; };
const STARTUP_CMD = `wscript.exe "${path.join(APP, 'Claude-Notifier.vbs')}"`;

// ---- the wizard driver ----
const wiz = (action, a1 = '', a2 = '') => { const r = spawnSync(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-File', DRIVER, action, String(a1), String(a2)], { encoding: 'utf8', windowsHide: true }); try { return JSON.parse(r.stdout.trim()); } catch { return { ok: false, error: `driver: ${r.stdout.slice(0, 160)}${r.stderr.slice(0, 160)}` }; } };
let sacBlocks = 0;
/** starts the GRAPHICAL wizard (no silent switches); a start that Smart App Control refuses is retried and counted */
async function launchWizard(exe, dir = APP, extra = []) {
  for (let i = 1; i <= 8; i++) {
    let c; let err = false;
    try { c = spawn(exe, [`/DIR=${dir}`, ...extra], { env: { ...process.env, ...FAKE }, stdio: 'ignore' }); } catch { err = true; }
    if (c) { c.on('error', () => { err = true; }); }
    const exit = c ? new Promise((r) => c.on('exit', (code) => r(code))) : Promise.resolve(null);
    if (!err) for (let k = 0; k < 40 && !err; k++) { const info = wiz('info'); if (info.ok) return { c, exit, info }; await sleep(400); }
    sacBlocks++; console.log(`  (Windows refused to start ${path.basename(exe)}: Smart App Control, attempt ${i}/8)`); await sleep(4000);
  }
  throw new Error('the wizard could not be started');
}
const buttons = (i) => (i.buttons || []).map((b) => b.name);
const onPage = (i, re) => !!i && i.ok && re.test((i.texts || []).join(' | '));
async function waitFor(re, ms = 30000) { let i; await until(() => { i = wiz('info'); return onPage(i, re); }, ms); return i; }
/** ticked checkbox = accent-blue fill: counts blue pixels around the centre of a row of the checklist */
function rowBlue(info, row) { const [lx, ly] = info.list; const r = wiz('blue', lx + 12, ly + 15 + row * 30); return r.ok ? r.blue : -1; }
const isTicked = (info, row) => rowBlue(info, row) > 12;
function toggleRow(info, row) { const [lx, ly] = info.list; wiz('click', lx + 12, ly + 15 + row * 30); }
const shot = (name) => { fs.mkdirSync(SHOTS, { recursive: true }); wiz('shot', path.join(SHOTS, `${name}.png`)); };
/** Next / Install until the "Finish" button shows */
async function toFinish() {
  const t0 = Date.now(); let i;
  while (Date.now() - t0 < 180000) {
    i = wiz('info'); const b = i.ok ? buttons(i) : [];
    if (b.includes('Finish')) return i;
    if (b.includes('Install')) wiz('button', 'Install'); else if (b.includes('Next')) wiz('button', 'Next');
    await sleep(900);
  }
  return i;
}
// ---- what runs from the installed folder ----
function procs() {
  const q = APP.replace(/'/g, "''");
  const t = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.ExecutablePath -like '${q}\\*' -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*${q}\\*')) } | Select-Object ProcessId,Name,@{n='Cmd';e={ if ($_.CommandLine) { $_.CommandLine } else { '' } }} | ConvertTo-Json -Compress`);
  if (!t) return []; const j = JSON.parse(t); return Array.isArray(j) ? j : [j];
}
const supervisors = () => procs().filter((p) => p.Name === 'ClaudeNotifier.exe' && /supervisor\.js/.test(p.Cmd));
function stopApp() { spawnSync(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', STOP], { env: { ...process.env, CN_APPDIR: APP }, windowsHide: true }); }
async function silentUninstall() {
  for (let cycle = 1; cycle <= 6; cycle++) {
    let started = false;
    for (let i = 0; i < 2 && !started; i++) { try { const c = spawn(path.join(APP, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { env: { ...process.env, ...FAKE }, stdio: 'ignore', windowsHide: true }); c.on('error', () => {}); started = true; } catch { sacBlocks++; await sleep(3000); } }
    if (started) { await until(() => !fs.existsSync(APP) || fs.readdirSync(APP).length === 0, 60000); if (!fs.existsSync(APP)) return true; }
    console.log(`  (uninstaller refused or incomplete, regenerating it: cycle ${cycle})`);
    const c = spawn(V2, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${APP}`], { env: { ...process.env, ...FAKE }, stdio: 'ignore', windowsHide: true }); c.on('error', () => {}); await new Promise((r) => { c.on('exit', r); c.on('error', r); }); await sleep(1500);
  }
  return false;
}
function realSnapshot() {
  const d = path.join(os.homedir(), '.claude-notifier'); const s = {};
  for (const f of ['ntfy.json', 'settings.json']) s[f] = fs.existsSync(path.join(d, f)) ? sha(path.join(d, f)) : null;
  s.run = reg(['query', RUN_KEY, '/v', 'ClaudeNotifier']).out.trim(); s.aumid = reg(['query', 'HKCU\\Software\\Classes\\AppUserModelId\\ClaudeNotifier.Companion']).out.trim();
  const prog = ps("[Environment]::GetFolderPath('Programs')"); s.lnk = fs.existsSync(path.join(prog, 'Claude Notifier.lnk')) ? sha(path.join(prog, 'Claude Notifier.lnk')) : null;
  return s;
}
const PROD = ['prototype/tools/installer/ClaudeNotifier.iss', 'prototype/tools/installer/stop-notifier.ps1', 'prototype/tools/build-installer.js', 'installer/out/ClaudeNotifierSetup.exe', 'release/stage/MANIFEST.txt'];
const prodHashes = () => PROD.map((p) => sha(path.join(ROOT, p)).slice(0, 24)).join(' ');

(async () => {
  for (const f of [V1, V2, DRIVER]) if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(2); }
  if (fs.existsSync(WORK) && !fs.existsSync(path.join(WORK, '.installer-test'))) { console.error(`${WORK} exists and is not ours`); process.exit(2); }
  const prod0 = prodHashes(); const real0 = realSnapshot();
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true }); fs.writeFileSync(path.join(WORK, '.installer-test'), 'x');
  for (const d of [FAKE.APPDATA, FAKE.LOCALAPPDATA, F_PROGRAMS, F_DESKTOP, path.join(PROFILE, '.claude', 'sessions'), DATA]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ notificationsEnabled: true, phoneEnabled: false, appearance: 'dark', phoneSetup: { state: 'dismissed' } }, null, 2));
  fs.writeFileSync(path.join(DATA, 'ntfy.json'), JSON.stringify({ server: 'https://ntfy.sh', topic: 'claude-abcdefghjkmnpqrs', token: '' }, null, 2));
  const data0 = ['settings.json', 'ntfy.json'].map((f) => sha(path.join(DATA, f))).join(' ');
  const dataNow = () => ['settings.json', 'ntfy.json'].map((f) => sha(path.join(DATA, f))).join(' ');
  const nothingInstalled = () => !fs.existsSync(path.join(APP, 'ClaudeNotifier.exe')) && uninstallVersion() === null && !fs.existsSync(SC_START) && !fs.existsSync(SC_DESK) && runValue() === null;
  try {
    console.log('== 1) cancelling the wizard');
    check('(test setup) nothing of the test identity is installed', nothingInstalled());
    let w = await launchWizard(V1);
    check('the wizard opens (title "Setup - Claude Notifier ...") on the "Select Additional Tasks" page with Next and Cancel', /^Setup - Claude Notifier/.test(w.info.title) && onPage(w.info, /Select Additional Tasks/) && buttons(w.info).includes('Next') && buttons(w.info).includes('Cancel'), w.info.title);
    check('FRESH INSTALL: the startup checkbox is UNCHECKED by default', !isTicked(w.info, 1), `blue pixels ${rowBlue(w.info, 1)}`);
    check('FRESH INSTALL: the desktop shortcut checkbox is UNCHECKED by default', !isTicked(w.info, 0), `blue pixels ${rowBlue(w.info, 0)}`);
    shot('1-tasks-fresh');
    wiz('button', 'Cancel'); await sleep(1500);
    let d = wiz('dialog');
    check('"Cancel" asks for confirmation in plain words ("Setup is not complete ... Exit Setup?") with Yes and No', d.ok && /Setup is not complete/.test((d.texts || []).join(' ')) && /Exit Setup\?/.test((d.texts || []).join(' ')) && (d.buttons || []).includes('Yes') && (d.buttons || []).includes('No'));
    shot('1-cancel-dialog');
    wiz('dialog', 'No'); await sleep(1200);
    check('answering "No" keeps the wizard open on the same page', onPage(wiz('info'), /Select Additional Tasks/));
    wiz('button', 'Cancel'); await sleep(1200); wiz('dialog', 'Yes');
    const code = await Promise.race([w.exit, sleep(15000).then(() => 'timeout')]);
    check('answering "Yes" closes Setup', code !== 'timeout' && !wiz('info').ok, `exit code ${code}`);
    check('after cancelling NOTHING was installed: no files, no shortcut, no uninstall entry, no startup entry', nothingInstalled());

    console.log('== 2) a failing installation shows a clear message');
    const blocked = path.join(WORK, 'blocked-target'); fs.writeFileSync(blocked, 'this is a FILE, so Setup cannot create a folder with this name');
    w = await launchWizard(V1, blocked);
    let t0 = Date.now(); let dlg = null;
    while (Date.now() - t0 < 90000 && !dlg) {
      const i = wiz('info'); const b = i.ok ? buttons(i) : [];
      const dd = wiz('dialog'); if (dd.ok && /\S/.test((dd.texts || []).join('')) && !/Exit Setup/.test(dd.title || '')) { dlg = dd; break; }
      if (b.includes('Install')) wiz('button', 'Install'); else if (b.includes('Next')) wiz('button', 'Next');
      await sleep(900);
    }
    shot('2-failure-dialog');
    check('Setup tells the user what went wrong in a dialog (it could not create the folder)', !!dlg && /unable|cannot|could not|error|directory|folder/i.test((dlg.texts || []).join(' ')), dlg ? (dlg.texts || []).join(' ').replace(/\s+/g, ' ').slice(0, 180) : 'no dialog appeared');
    if (dlg) { const label = (dlg.buttons || []).find((x) => /OK|Cancel|Abort/i.test(x)); wiz('dialog', label || '*'); await sleep(1500); const dd2 = wiz('dialog'); if (dd2.ok) wiz('dialog', (dd2.buttons || []).find((x) => /OK|Yes|Cancel/i.test(x)) || '*'); }
    const code2 = await Promise.race([w.exit, sleep(20000).then(() => 'timeout')]);
    for (let k = 0; k < 4 && !wiz('info').ok === false; k++) { const i = wiz('info'); if (i.ok && buttons(i).includes('Cancel')) { wiz('button', 'Cancel'); await sleep(1000); wiz('dialog', 'Yes'); await sleep(1500); } }
    check('the failed installation ends with a non-zero exit code and leaves nothing behind (no uninstall entry, shortcut or startup entry)', code2 !== 0 && uninstallVersion() === null && !fs.existsSync(SC_START) && !fs.existsSync(SC_DESK) && runValue() === null, `exit code ${code2}`);
    try { fs.unlinkSync(blocked); } catch { /* */ }

    console.log('== 3) fresh installation through the wizard: desktop shortcut ticked, startup left alone, "Launch now" as offered');
    w = await launchWizard(V1);
    check('fresh: both boxes unchecked', onPage(w.info, /Select Additional Tasks/) && !isTicked(w.info, 0) && !isTicked(w.info, 1));
    toggleRow(w.info, 0); await sleep(500);
    check('clicking the desktop-shortcut checkbox ticks it (and only it)', isTicked(w.info, 0) && !isTicked(w.info, 1), `desktop=${rowBlue(w.info, 0)} startup=${rowBlue(w.info, 1)}`);
    shot('3-tasks-desktop-ticked');
    let fin = await toFinish();
    shot('3-finish');
    check('the last page is "Finish" with the "Launch Claude Notifier now" option, ticked by default', !!fin && fin.ok && buttons(fin).includes('Finish') && !!fin.list && isTicked(fin, 0), fin && fin.list ? `blue ${rowBlue(fin, 0)}` : 'no checklist');
    wiz('button', 'Finish');
    const up = await until(() => supervisors().length === 1, 40000); await sleep(3000);
    check('"Finish" with "Launch now" ticked starts the app exactly once (one watchdog from the installed folder)', up && supervisors().length === 1);
    check('the ticked desktop shortcut exists, the Start Menu shortcut exists, and NO startup entry was created', fs.existsSync(SC_DESK) && fs.existsSync(SC_START) && runValue() === null);
    check('the uninstall entry shows 1.0.0 and the user data is untouched', uninstallVersion() === '1.0.0' && dataNow() === data0);

    console.log('== 4) upgrade through the wizard, "Launch now" un-ticked');
    stopApp(); await until(() => procs().length === 0, 20000);
    w = await launchWizard(V2);
    shot('4-tasks-upgrade');
    check('upgrade without a startup entry: the startup box is unchecked', onPage(w.info, /Select Additional Tasks/) && !isTicked(w.info, 1), `blue ${rowBlue(w.info, 1)}`);
    fin = await toFinish();
    check('the finish page offers "Launch now" again (the app was not running)', !!fin && fin.ok && !!fin.list && isTicked(fin, 0));
    toggleRow(fin, 0); await sleep(500);
    check('clicking it un-ticks it', !isTicked(fin, 0));
    shot('4-finish-unticked');
    wiz('button', 'Finish'); await sleep(9000);
    check('"Finish" with "Launch now" un-ticked does NOT start the app', supervisors().length === 0 && procs().length === 0);
    check('the uninstall entry now shows 1.0.1 (upgraded in place) and the user data is untouched', uninstallVersion() === '1.0.1' && dataNow() === data0);

    console.log('== 5) upgrade pre-selects an existing startup entry');
    reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', STARTUP_CMD, '/f']);
    w = await launchWizard(V2);
    shot('5-tasks-existing-startup');
    check('the startup checkbox is PRE-TICKED because an entry exists (the desktop shortcut keeps its earlier choice)', onPage(w.info, /Select Additional Tasks/) && isTicked(w.info, 1), `startup blue ${rowBlue(w.info, 1)}, desktop blue ${rowBlue(w.info, 0)}`);
    fin = await toFinish(); toggleRow(fin, 0); await sleep(400); wiz('button', 'Finish'); await sleep(7000);
    check('finishing keeps exactly ONE startup entry with the same command', runValue() === STARTUP_CMD && (reg(['query', RUN_KEY]).out.match(new RegExp(`^\\s+${RUN_VALUE}\\s`, 'gm')) || []).length === 1, String(runValue()));

    console.log('== 6) deliberately un-ticking the startup box removes the entry');
    w = await launchWizard(V2);
    check('pre-ticked again', onPage(w.info, /Select Additional Tasks/) && isTicked(w.info, 1));
    toggleRow(w.info, 1); await sleep(500);
    check('clicking the startup checkbox un-ticks it', !isTicked(w.info, 1));
    shot('6-startup-unticked');
    fin = await toFinish(); wiz('button', 'Finish');
    await until(() => runValue() === null, 15000);
    check('after the installation the startup entry is GONE (the user chose it)', runValue() === null);
    await until(() => supervisors().length === 1, 40000); await sleep(2500);
    check('(the finish page was left ticked, so the app started once)', supervisors().length === 1);
    check('user data is still untouched after all wizard runs', dataNow() === data0);
  } finally {
    stopApp(); reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    for (let k = 0; k < 3; k++) { const i = wiz('info'); if (!i.ok) break; wiz('button', 'Cancel'); await sleep(900); wiz('dialog', 'Yes'); await sleep(1500); }
  }
  console.log('== 7) cleanup through the uninstaller, then the real machine');
  const un = await silentUninstall();
  check('the uninstaller removes the application, both shortcuts and the uninstall entry; the data stays', un && !fs.existsSync(SC_START) && !fs.existsSync(SC_DESK) && uninstallVersion() === null && runValue() === null && fs.existsSync(path.join(DATA, 'settings.json')) && ['settings.json', 'ntfy.json'].map((f) => sha(path.join(DATA, f))).join(' ') === data0);
  reg(['delete', AUMID_TEST_KEY, '/f']);
  const real1 = realSnapshot();
  check('the real data folder, startup value, toast registration and real Start Menu shortcut are unchanged', JSON.stringify(real1) === JSON.stringify(real0));
  check('the real PRODUCTION installer script, stop script, build script, ClaudeNotifierSetup.exe and the verified stage manifest are byte-identical to before these tests', prodHashes() === prod0);
  console.log(`\nWindows Smart App Control refused ${sacBlocks} start(s) of unsigned installer files during this run (each one retried)`);
  const fails = results.filter((x) => !x).length;
  console.log(`\nstep21: ${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { stopApp(); reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']); } catch { /* */ } process.exit(1); });
