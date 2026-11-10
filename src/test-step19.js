#!/usr/bin/env node
/**
 * test-step19.js -- Task 4 (dark mode), stage 4b: the Appearance preference inside the REAL notifier process.
 *
 * The notifier is started on scratch data folders (no tray: its menu / theme output is dumped; the real setup window is used for the
 * live test) and driven with the same menu ids the tray host sends. Proves: the three preferences, persistence across notifier restarts,
 * fallback for damaged settings, that changing the appearance never touches ntfy.json or the phone / notification / onboarding state, that
 * all existing menu actions still work, High Contrast, and live re-theming of an open setup window. A mock ntfy server stands in for
 * ntfy.sh (no network); your own configuration is never touched.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ntfy = require('./ntfy');
const palette = require('./palette');
const devhooks = require('./devhooks');
const stub = require('./tools/release/devhooks');
const { Uia } = require('./tools/uia');

const results = [];
const ONLY = process.env.T19_ONLY || ''; const want = (l) => !ONLY || ONLY.includes(l);
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = __dirname;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance19-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rd = (f) => fs.readFileSync(f, 'utf8');
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const near = (a, b, t = 6) => !!a && !!b && Math.max(...rgb(a).map((v, i) => Math.abs(v - rgb(b)[i]))) <= t;
const retried = [];
async function R(name, fn, tries = 3) {
  let last = [false, ''];
  for (let i = 1; i <= tries; i++) { try { last = await fn(); } catch (e) { last = [false, `error: ${e.message}`]; } if (last[0]) { if (i > 1) retried.push(name); check(name, true, i > 1 ? `needed ${i} attempts` : last[1]); return; } await sleep(700); }
  check(name, false, `${last[1]} (failed all ${tries} attempts)`);
}
async function until(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return !!(await fn()); }

// ---- mock ntfy ----
let server; let URLBASE; const received = [];
function startServer() { return new Promise((r) => { server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { received.push(JSON.parse(b)); } catch { /* ignore */ } res.writeHead(200); res.end('{}'); }); }); server.listen(0, '127.0.0.1', () => { URLBASE = `http://127.0.0.1:${server.address().port}`; r(); }); }); }

let sn = 0;
/** an EXISTING installation: valid ntfy config pointing at the mock, phone enabled and confirmed, a few other settings */
function seed({ settings = {}, corruptSettings = false } = {}) {
  const base = path.join(ROOT, `w${++sn}`); const data = path.join(base, 'data'); const ses = path.join(base, 'sessions'); const logs = path.join(base, 'logs');
  for (const d of [data, ses, logs]) fs.mkdirSync(d, { recursive: true });
  ntfy.initConfig(data, { server: URLBASE });
  const s = { notificationsEnabled: true, soundsEnabled: false, phoneEnabled: true, phoneSetup: { state: 'confirmed', confirmedAt: 1700000000000 }, ...settings };
  fs.writeFileSync(path.join(data, 'settings.json'), corruptSettings ? '{ this is not json' : JSON.stringify(s, null, 2));
  return { base, data, ses, logs, ntfyFile: path.join(data, 'ntfy.json'), setFile: path.join(data, 'settings.json') };
}
function start(w, systemTheme = 'light', extra = []) {
  const args = [path.join(P, 'notifier.js'), '--ui', 'none', '--first-run-setup', '--control-stdin', '--dump-menu', '--no-lock', '--no-usage', '--system-theme', systemTheme, '--data-dir', w.data, '--sessions-dir', w.ses, '--log-dir', w.logs, '--interval', '200', '--hold', '700', ...extra];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; let err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; }); child.stdin.on('error', () => {});
  const lines = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const n = { child, exited: null, send: (id) => child.stdin.write(`${id}\n`), out: () => out, err: () => err,
    themes: () => lines().filter((l) => l.theme).map((l) => l.theme), menus: () => lines().filter((l) => l.menu).map((l) => l.menu), toasts: () => lines().filter((l) => l.cmd === 'toast'),
    lastTheme: () => { const t = n.themes(); return t[t.length - 1]; }, lastMenu: () => { const m = n.menus(); return m[m.length - 1] || {}; },
    log: () => { try { return rd(path.join(w.logs, 'notifier.log')) + rd(path.join(w.data, 'notifier.log')); } catch { try { return rd(path.join(w.data, 'notifier.log')); } catch { return ''; } } } };
  child.on('exit', (c) => { n.exited = c; });
  n.stop = async () => { if (n.exited === null) { try { n.send('exit'); } catch { /* gone */ } for (let i = 0; i < 40 && n.exited === null; i++) await sleep(150); if (n.exited === null) { try { child.kill(); } catch { /* gone */ } } } };
  return n;
}
/** the setup window started BY this notifier (parent = the notifier process): leftovers of other runs are never picked up */
async function findSetupWindow(parentPid) {
  for (let i = 0; i < 100; i++) {
    const r = require('child_process').spawnSync(require('./winpaths').powershellExe(), ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' AND ParentProcessId=${parentPid}" | Where-Object { $_.CommandLine -like '*setup-window.ps1*' } | Select-Object -First 1 -ExpandProperty ProcessId`], { encoding: 'utf8' });
    const pid = Number((r.stdout || '').trim()); if (pid) return pid; await sleep(300);
  }
  return 0;
}
const appearanceOnDisk = (w) => { try { return JSON.parse(rd(w.setFile)).appearance; } catch { return undefined; } };
const withoutAppearance = (w) => { const { appearance, ...rest } = JSON.parse(rd(w.setFile)); return JSON.stringify(rest); };

(async () => {
  await startServer();

  // =========================================================================================================
  if (want('A')) {
  console.log('== A) the three preferences, immediately applied, nothing else touched');
  {
    const w = seed(); const ntfyHash = sha(w.ntfyFile); const before = JSON.parse(rd(w.setFile));
    let n = start(w, 'light');
    check('an existing installation starts with the System preference: the tray is sent the Light theme (Windows is light) and the menu says "system"', await until(() => n.lastTheme() && n.lastMenu().appearance === 'system') && n.lastTheme().mode === 'light' && n.lastTheme().appearance === 'system');
    check('...the theme message carries exactly the Light palette (all 24 tokens)', JSON.stringify(n.lastTheme().colors) === JSON.stringify(palette.LIGHT));
    check('...starting did not write an appearance value into settings.json (the file is as it was)', rd(w.setFile) === JSON.stringify(before, null, 2));
    const count0 = n.themes().length;
    n.send('appearance:dark');
    check('"Dark": the theme message arrives at once (mode dark, Dark palette) and the menu check moves to "dark"', await until(() => n.lastTheme().mode === 'dark' && n.lastMenu().appearance === 'dark') && JSON.stringify(n.lastTheme().colors) === JSON.stringify(palette.DARK) && n.themes().length === count0 + 1);
    check('...it is stored through the Store: settings.json has appearance "dark"', await until(() => appearanceOnDisk(w) === 'dark'));
    check('...and ONLY that key changed: phoneEnabled, phoneSetup, notification and sound settings are exactly as before; ntfy.json is byte-identical', withoutAppearance(w) === JSON.stringify(before) && sha(w.ntfyFile) === ntfyHash);
    n.send('appearance:light');
    check('"Light": Light palette, stored', await until(() => n.lastTheme().mode === 'light' && n.lastTheme().appearance === 'light' && appearanceOnDisk(w) === 'light'));
    n.send('appearance:system');
    check('"System" with Windows light: follows Windows (light), stored as "system"', await until(() => n.lastMenu().appearance === 'system' && appearanceOnDisk(w) === 'system') && n.lastTheme().mode === 'light');
    const cnt = n.themes().length; n.send('appearance:system'); await sleep(900);
    check('choosing the preference that is already active sends no new theme (no needless repaint)', n.themes().length === cnt);
    const setBefore = rd(w.setFile); n.send('appearance:purple'); n.send('appearance:'); n.send('appearance:DARK'); await sleep(900);
    check('invalid choices (unknown word, empty, wrong case) are ignored: no theme message, settings.json unchanged', n.themes().length === cnt && rd(w.setFile) === setBefore && /invalid value ignored/.test(n.log()));
    check('...the log names the choices only (no colours, no topic)', !/claude-[a-hj-km-np-z2-9]{16}|#[0-9A-F]{6}/i.test(n.log()) && /appearance choice: now dark/.test(n.log()));
    check('the notifier stayed healthy and the ntfy.json hash never changed', n.exited === null && sha(w.ntfyFile) === ntfyHash);
    await n.stop();
    check('...and exited cleanly on request', n.exited === 0, `exit=${n.exited}`);
  }
  }

  // =========================================================================================================
  if (want('B')) {
  console.log('== B) persistence across notifier restarts; System follows Windows');
  {
    const w = seed(); let n = start(w, 'light');
    await until(() => n.lastMenu().appearance === 'system'); n.send('appearance:dark'); await until(() => appearanceOnDisk(w) === 'dark'); await n.stop();
    n = start(w, 'light');
    check('after a restart the stored "Dark" is still in force even though Windows is light (first theme message is Dark, menu check on "dark")', await until(() => n.lastTheme() && n.lastMenu().appearance === 'dark') && n.lastTheme().mode === 'dark' && n.themes()[0].mode === 'dark');
    check('...no flash of the wrong theme: the very first theme message of the new process is already Dark', n.themes()[0].mode === 'dark' && n.themes().length === 1);
    n.send('appearance:system'); await until(() => appearanceOnDisk(w) === 'system'); await n.stop();
    n = start(w, 'dark');
    check('"System" survives a restart and follows Windows: Windows dark => Dark theme', await until(() => n.lastTheme() && n.lastMenu().appearance) && n.lastTheme().mode === 'dark' && n.lastTheme().appearance === 'system' && n.lastMenu().appearance === 'system');
    await n.stop();
    n = start(w, 'light'); await until(() => n.lastTheme() && n.lastMenu().appearance);
    check('...and Windows light => Light theme with the same stored preference', n.lastTheme().mode === 'light' && appearanceOnDisk(w) === 'system'); await n.stop();
    n = start(w, 'light'); await until(() => n.lastTheme()); n.send('appearance:light'); await until(() => appearanceOnDisk(w) === 'light'); await n.stop();
    n = start(w, 'dark'); await until(() => n.lastTheme() && n.lastMenu().appearance);
    check('"Light" survives a restart even when Windows is dark', n.lastTheme().mode === 'light' && n.lastMenu().appearance === 'light'); await n.stop();
  }
  }

  // =========================================================================================================
  if (want('C')) {
  console.log('== C) fallback for damaged or odd settings (never "repaired" silently)');
  {
    const w = seed({ corruptSettings: true }); const junk = rd(w.setFile); const nh = sha(w.ntfyFile);
    const n = start(w, 'dark');
    check('a CORRUPT settings.json: the notifier starts, the preference falls back to System (Windows dark => Dark), the menu says "system"', await until(() => n.lastTheme() && n.lastMenu().appearance) && n.lastTheme().mode === 'dark' && n.lastMenu().appearance === 'system');
    await sleep(1500);
    check('...merely starting and reading does not overwrite the damaged file; ntfy.json untouched', rd(w.setFile) === junk && sha(w.ntfyFile) === nh);
    await n.stop();
    for (const bad of ['"purple"', '5', 'null', '["dark"]', '""']) {
      const w2 = seed({ settings: { appearance: JSON.parse(bad) } }); const text = rd(w2.setFile);
      const n2 = start(w2, 'light'); await until(() => n2.lastTheme() && n2.lastMenu().appearance);
      check(`a stored appearance of ${bad} behaves as System (Windows light => Light), and the file is not rewritten`, n2.lastTheme().mode === 'light' && n2.lastMenu().appearance === 'system' && rd(w2.setFile) === text);
      await n2.stop();
    }
  }
  }

  // =========================================================================================================
  if (want('D')) {
  console.log('== D) High Contrast');
  {
    const w = seed({ settings: { appearance: 'dark' } }); const nh = sha(w.ntfyFile);
    let n = start(w, 'contrast');
    check('with Windows High Contrast on, the tray is told "contrast" with NO palette, whatever the stored preference (Dark)', await until(() => n.lastTheme()) && n.lastTheme().mode === 'contrast' && n.lastTheme().highContrast === true && n.lastTheme().colors === null && n.lastTheme().appearance === 'dark');
    n.send('appearance:light'); await until(() => appearanceOnDisk(w) === 'light');
    check('...the preference can still be changed (and is stored) while High Contrast is on, but the mode stays "contrast"', n.lastTheme().mode === 'contrast' && n.lastMenu().appearance === 'light' && sha(w.ntfyFile) === nh);
    await n.stop();
    n = start(w, 'light'); await until(() => n.lastTheme());
    check('...when High Contrast is off again the stored preference applies (Light)', n.lastTheme().mode === 'light' && n.lastTheme().highContrast === false); await n.stop();
  }
  }

  // =========================================================================================================
  if (want('E')) {
  console.log('== E) every existing tray action still works through the notifier, and none resets the appearance');
  {
    const w = seed({ settings: { appearance: 'dark' } }); const nh = sha(w.ntfyFile);
    const n = start(w, 'light'); await until(() => n.lastMenu().appearance === 'dark');
    const settings = () => JSON.parse(rd(w.setFile));
    n.send('toggleNotifications'); check('"Notifications enabled" toggles notifications OFF and the model follows', await until(() => settings().notificationsEnabled === false && n.lastMenu().notificationsEnabled === false));
    n.send('toggleNotifications'); check('...and ON again', await until(() => settings().notificationsEnabled === true));
    n.send('toggleSounds'); check('"Sounds" toggles', await until(() => settings().soundsEnabled === true && n.lastMenu().soundsEnabled === true));
    n.send('togglePhone'); check('"Phone notifications" toggles OFF (confirmed setup)', await until(() => settings().phoneEnabled === false && n.lastMenu().phoneEnabled === false));
    n.send('togglePhone'); check('...and ON again without a new test (the setup was confirmed)', await until(() => settings().phoneEnabled === true));
    const t0 = n.toasts().length; n.send('test'); check('"Send test notification" shows a Windows toast request', await until(() => n.toasts().length > t0 && /Claude Notifier test/.test(JSON.stringify(n.toasts()[n.toasts().length - 1]))));
    received.length = 0; n.send('testPhone'); check('"Send test phone notification" sends ONE test to the (mock) ntfy server', await until(() => received.length === 1) && received[0].topic === JSON.parse(rd(w.ntfyFile)).topic);
    check('the phone menu label follows the model (set up, confirmed)', n.lastMenu().phoneConfigured === true && /Phone setup|phone/i.test(n.lastMenu().phoneSetupText));
    check('after all of these the appearance is still "dark", the menu model still has all its fields, and ntfy.json is byte-identical', settings().appearance === 'dark' && n.lastMenu().appearance === 'dark' && ['sessions', 'recent', 'tooltip', 'state', 'phoneSetupText'].every((k) => k in n.lastMenu()) && sha(w.ntfyFile) === nh);
    n.send('exit'); check('"Exit" shuts the notifier down (exit code 0)', await until(() => n.exited === 0, 8000), `exit=${n.exited} ${n.err().slice(0, 300)}`);
  }
  }

  // =========================================================================================================
  if (want('F')) {
  console.log('== F) an open setup window follows the appearance live, through the real notifier');
  {
    const ui = new Uia().start();
    const w = seed(); const nh = sha(w.ntfyFile);
    const n = start(w, 'light'); await until(() => n.lastMenu().appearance === 'system');
    n.send('phoneSetup');
    const childPid = await findSetupWindow(n.child.pid);
    check('the tray entry "Set up phone notifications" opens the real setup window (status page: this setup is confirmed)', !!childPid);
    if (childPid) {
      await ui.attach(childPid, 15000); await sleep(1200);
      const win = await ui.rect(); const pts = [[win.x + 20, win.y + Math.floor(win.h * 0.55)], [win.x + 20, win.y + win.h - 30]];
      const bgNow = async () => { for (let i = 0; i < 4; i++) { const c = await ui.pixels(pts); if (!c.includes('#000000')) return c; await sleep(250); } return await ui.pixels(pts); };
      await R('the window starts in Light (Windows is light, preference System)', async () => { const c = await bgNow(); return [near(c[0], palette.LIGHT.bg, 2), c[0]]; });
      for (const [id, mode, pal] of [['appearance:dark', 'Dark', palette.DARK], ['appearance:light', 'Light', palette.LIGHT], ['appearance:dark', 'Dark', palette.DARK], ['appearance:system', 'System (Windows light)', palette.LIGHT]]) {
        n.send(id);
        await R(`choosing ${mode} in the tray re-themes the OPEN window (no restart, no reopening)`, async () => { await sleep(800); const c = await bgNow(); return [near(c[0], pal.bg, 2) && near(c[1], pal.surface, 2), c.join(' ')]; });
      }
      check('the window stayed the same process, on the same page ("Phone notifications" status), still open', (await ui.exists('Turn off')) && require('child_process').spawnSync(require('./winpaths').powershellExe(), ['-NoProfile', '-Command', `(Get-Process -Id ${childPid} -ErrorAction SilentlyContinue).Id`], { encoding: 'utf8' }).stdout.trim() === String(childPid));
      check('...and the configuration, topic, ntfy.json and phone state were not touched by any of it', sha(w.ntfyFile) === nh && JSON.parse(rd(w.setFile)).phoneEnabled === true && JSON.parse(rd(w.setFile)).phoneSetup.state === 'confirmed');
      await ui.close(); await sleep(1500);
    }
    await n.stop(); await ui.stop();
    // High Contrast: the window gets system colours
    const w2 = seed(); const ui2 = new Uia().start(); const n2 = start(w2, 'contrast'); await until(() => n2.lastTheme()); n2.send('phoneSetup');
    const pid2 = await findSetupWindow(n2.child.pid);
    if (pid2) {
      await ui2.attach(pid2, 15000); await sleep(1200); const win = await ui2.rect(); const sysc = await ui2.syscolors();
      await R('High Contrast through the notifier: the setup window uses the Windows system colour, not the palette', async () => { const c = await ui2.pixels([[win.x + 20, win.y + Math.floor(win.h * 0.55)]]); return [near(c[0], sysc.Control, 2) && !near(c[0], palette.DARK.bg, 2), `${c[0]} sys=${sysc.Control}`]; });
      await ui2.close(); await sleep(1200);
    } else check('High Contrast: the setup window opened', false);
    await n2.stop(); await ui2.stop();
  }
  }

  // =========================================================================================================
  if (want('G')) {
  console.log('== G) production / development separation');
  {
    const dev = devhooks.options(['--system-theme', 'dark']); const prod = stub.options(['--system-theme', 'dark']);
    check('development: --system-theme sets the override; production stub: it sets nothing (no argument is read)', dev.systemTheme === 'dark' && prod.systemTheme === undefined && prod.dev === false);
    check('the control name exists only in the development module (and the build gate list), nowhere in production code', ['notifier.js', 'theme.js', 'palette.js', 'ui-host.ps1', 'setup-window.ps1', 'setup-controller.js', 'tools/release/devhooks.js'].every((f) => !/--system-theme/.test(rd(path.join(P, f)))));
    check('the notifier reads the real Windows setting unless the (development-only) option is present', /theme\.systemFromName\(D\.systemTheme\)\) \|\| theme\.detectSystem\(\)/.test(rd(path.join(P, 'notifier.js'))) && /if \(!D\.systemTheme\) themeState\.system = await theme\.detectSystemAsync\(\)/.test(rd(path.join(P, 'notifier.js'))));
    check('the appearance code never touches ntfy.json or the phone: no ntfy / onboarding call in the appearance block of the notifier', (() => { const src = rd(path.join(P, 'notifier.js')); const a = src.indexOf('// ---------- appearance:'); const b = src.indexOf('const setupWindow = new SetupController'); return a > 0 && b > a && !/ntfy\.|onboarding\.|phone\./.test(src.slice(a, b)); })());
  }
  }

  await new Promise((r) => server.close(r));
  const fails = results.filter((x) => !x).length;
  console.log(`\nstep19: ${results.length - fails}/${results.length} checks passed` + (retried.length ? `  (${retried.length} screen check(s) needed a retry: ${retried.join(' | ')})` : '  (no retries needed)'));
  if (!fails) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } } else console.log(`(scratch files kept: ${ROOT})`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { server && server.close(); } catch { /* ignore */ } process.exit(1); });
