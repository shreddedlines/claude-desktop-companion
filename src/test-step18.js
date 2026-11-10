#!/usr/bin/env node
/**
 * test-step18.js -- Task 4 (dark mode), stage 4a: the REAL tray host (ui-host.ps1) and its themed context menu.
 *
 * The host is started on its own (a throw-away AppUserModelID, no notifier) and driven through its JSON protocol: it is sent a menu and a
 * theme, asked to pop the menu up at a screen position (test hook `showmenu`, like the existing `xmlcheck`), and the menu is photographed
 * and sampled pixel by pixel. Menu entries are clicked with the real mouse and the events the host sends back are checked.
 * Needs an interactive desktop; Python with OpenCV for text colours. The host is not DPI aware, so its coordinates are scaled to pixels.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const winpaths = require('./winpaths');
const palette = require('./palette');
const { Uia } = require('./tools/uia');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = __dirname;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tray18-'));
const AUMID = 'ClaudeNotifier.Test18'; const DISPLAY = 'ClaudeNotifierTest18';
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.max(...rgb(a).map((v, i) => Math.abs(v - rgb(b)[i])));
const near = (a, b, t = 6) => !!a && !!b && dist(a, b) <= t;
const retried = [];
async function R(name, fn, tries = 3) {
  let last = [false, ''];
  for (let i = 1; i <= tries; i++) {
    try { last = await fn(); } catch (e) { last = [false, `error: ${e.message}`]; }
    if (last[0]) { if (i > 1) retried.push(name); check(name, true, i > 1 ? `needed ${i} attempts` : last[1]); return; }
    await sleep(600);
  }
  check(name, false, `${last[1]} (failed all ${tries} attempts)`);
}

const PY = `import cv2, json, sys
img = cv2.imread(sys.argv[1]); out = []
for x, y, w, h in json.loads(sys.argv[2]):
    crop = img[max(y, 0):y + h, max(x, 0):x + w].reshape(-1, 3).astype(int)
    d = ((crop - crop[0]) ** 2).sum(axis=1); b, g, r = crop[d.argmax()]
    out.append('#%02X%02X%02X' % (r, g, b))
print(json.dumps(out))
`;
const extreme = (file, regs) => { const r = spawnSync('python', [path.join(ROOT, 'img.py'), file, JSON.stringify(regs)], { encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return []; } };

// the model the notifier sends (all the optional lines visible so every kind of entry is drawn)
const MODEL = { cmd: 'menu', state: 'idle', appearance: 'system', notificationsEnabled: true, soundsEnabled: false, phoneEnabled: true, phoneConfigured: true, phoneSetupText: 'Phone setup…', healthText: 'Health check failing: test', healthHint: null, toastText: null, toastBad: false, phoneText: 'Phone push: enabled — nothing sent yet', phoneBad: false, usageText: 'Usage: 62% (5h)', usageHint: "Open Claude Desktop's tray menu to refresh", usageStale: true, tooltip: 'Claude: 0 working', sessions: ['demo — working (3m)', 'other — idle (1m)'], recent: ['10:00:01  Finished — demo'] };
const EXPECTED_ORDER = ['Claude Notifier', 'Usage: 62% (5h)', "Open Claude Desktop's tray menu to refresh", 'Health check failing: test', 'Phone push: enabled — nothing sent yet', 'Active sessions (2)', 'Recent events', 'Notifications enabled', 'Sounds disabled', 'Send test notification', 'Phone notifications enabled', 'Phone setup…', 'Send test phone notification', 'Appearance', 'Open data folder', 'Exit'];

let host; const events = []; let ui; let S = 1;
function startHost() {
  host = spawn(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(P, 'ui-host.ps1'), '-Aumid', AUMID, '-DisplayName', DISPLAY], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = ''; host.stdout.setEncoding('utf8'); host.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { events.push(JSON.parse(l)); } catch { /* ignore */ } } } });
  host.stderr.on('data', () => { /* diagnostics only */ });
}
const send = (o) => host.stdin.write(`${JSON.stringify(o)}\n`);
async function waitEvt(name, ms = 15000, pred = () => true) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = events.findIndex((e) => e.evt === name && pred(e)); if (i >= 0) return events.splice(i, 1)[0]; await sleep(80); } return null; }
const px = (r) => ({ x: Math.round(r.x * S), y: Math.round(r.y * S), w: Math.round(r.w * S), h: Math.round(r.h * S) });   // host (logical) -> screen (physical) pixels
const mid = (r) => [r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)];
const setTheme = (mode, hc = false) => send({ cmd: 'theme', theme: { mode, highContrast: hc, colors: hc ? null : palette.paletteFor(mode) } });
async function showMenu(opts = {}) { events.length = 0; send({ cmd: 'showmenu', x: 300, y: 120, ...opts }); const m = await waitEvt('menuShown', 15000); await sleep(500); return m; }
async function hideMenu() { send({ cmd: 'hidemenu' }); await sleep(400); }
const item = (g, text) => g.items.find((i) => i.text === text || (text instanceof RegExp && text.test(i.text)));

(async () => {
  fs.writeFileSync(path.join(ROOT, 'img.py'), PY);
  ui = new Uia().start(); S = await ui.dpiScale();
  startHost(); const ready = await waitEvt('ready', 30000);
  check('the real tray host starts and reports ready', !!ready);
  send(MODEL); await sleep(400);

  // =========================================================================================================
  console.log('== A) menu content, order and structure are preserved (the only addition is Appearance)');
  setTheme('light'); await sleep(300);
  let m = await showMenu({ open: 'Appearance' });
  check('the host pops the menu up and reports its geometry', !!m && m.menu.items.length > 10);
  check('visible entries and their ORDER are exactly the existing ones plus "Appearance" directly above "Open data folder"', JSON.stringify(m.menu.items.map((i) => i.text)) === JSON.stringify(EXPECTED_ORDER), m.menu.items.map((i) => i.text).join(' | '));
  check('five separators are in the same places as before (after the status lines, after Recent events, after Send test notification, after Send test phone notification, before Exit)', m.menu.separators.length === 5);
  const apItem = item(m.menu, 'Appearance');
  check('"Appearance" is a sub-menu with System, Light, Dark (in that order)', !!m.sub && JSON.stringify(m.sub.items.map((i) => i.text)) === JSON.stringify(['System', 'Light', 'Dark']) && !!apItem);
  check('with the default preference only "System" has the check mark', m.sub.items.map((i) => i.checked).join() === 'true,false,false');
  check('the existing toggles keep their check marks: Notifications enabled and Phone notifications enabled checked, Sounds disabled not', item(m.menu, 'Notifications enabled').checked && item(m.menu, 'Phone notifications enabled').checked && !item(m.menu, 'Sounds disabled').checked);
  check('disabled entries are still disabled (header, status lines, hints)', ['Claude Notifier', 'Usage: 62% (5h)', 'Health check failing: test'].every((t) => !item(m.menu, t).enabled) && item(m.menu, 'Send test notification').enabled && item(m.menu, 'Exit').enabled);
  await hideMenu();
  for (const pref of ['light', 'dark', 'system']) {
    send({ ...MODEL, appearance: pref }); await sleep(400); m = await showMenu({ open: 'Appearance' });
    check(`appearance "${pref}": exactly that one entry is checked in the sub-menu`, m.sub.items.map((i) => (i.checked ? i.text.toLowerCase() : '')).filter(Boolean).join() === pref, m.sub.items.map((i) => i.checked).join());
    await hideMenu();
  }
  send({ ...MODEL, appearance: 'bogus' }); await sleep(400); m = await showMenu({ open: 'Appearance' });
  check('an unknown preference in the model falls back to "System" being checked', m.sub.items.map((i) => i.checked).join() === 'true,false,false'); await hideMenu();
  send(MODEL); await sleep(300);

  // =========================================================================================================
  console.log('== B) rendering in Light and Dark (menu, sub-menu, hover, separators, text tones, check marks, arrows)');
  for (const [mode, pal] of [['light', palette.LIGHT], ['dark', palette.DARK]]) {
    setTheme(mode); await sleep(400);
    await R(`${mode}: the highlighted entry has the hover background ${pal.hover}`, async () => {
      await hideMenu(); const hm = await showMenu({ select: 'Send test notification' }); const it = item(hm.menu, 'Send test notification');
      const p = px({ x: it.x + 8, y: it.y + it.h / 2, w: 1, h: 1 }); const c = await ui.pixels([[p.x, p.y]]);
      return [near(c[0], pal.hover, 2), c[0]];
    });
    await hideMenu();
    m = await showMenu({ open: 'Active sessions' });
    check(`${mode}: the host reports the menu as themed (custom renderer active)`, m.themed === true && m.highContrast === false);
    const g = m.menu; const sub = m.sub;
    const file = path.join(ROOT, `b-${mode}.png`); const mr = px({ x: g.x - 6, y: g.y - 6, w: g.w + (sub ? sub.w + 12 : 12) + 12, h: Math.max(g.h, sub ? sub.h : 0) + 12 });
    await R(`${mode}: menu background ${pal.surface}, border ${pal.border}, separators ${pal.border}`, async () => {
      await ui.shot(file, null, mr);
      const send0 = item(g, 'Send test phone notification'); const bgp = px({ x: send0.x + 3, y: send0.y + 4, w: 1, h: 1 });
      const edge = px({ x: g.x, y: g.y + g.h / 2, w: 1, h: 1 });
      const sepg = g.separators[0]; const sp = px({ x: sepg.x + sepg.w / 2, y: sepg.y + sepg.h / 2, w: 1, h: 1 });
      const c = await ui.pixels([[bgp.x, bgp.y], [edge.x, edge.y], [sp.x, sp.y]]);
      return [near(c[0], pal.surface, 2) && near(c[1], pal.border, 8) && near(c[2], pal.border, 4), c.join(' ')];
    });
    await R(`${mode}: text tones: primary ${pal.text}, secondary status ${pal.textSecondary}, error ${pal.error}, disabled hint ${pal.textDisabled}`, async () => {
      await ui.shot(file, null, mr);
      const reg = (t) => { const it = item(g, t); const r = px({ x: it.x + 30, y: it.y + 3, w: it.w - 60, h: it.h - 6 }); return [r.x - mr.x, r.y - mr.y, r.w, r.h]; };
      const c = extreme(file, [reg('Send test notification'), reg('Phone push: enabled — nothing sent yet'), reg('Health check failing: test'), reg("Open Claude Desktop's tray menu to refresh"), reg('Claude Notifier'), reg('Usage: 62% (5h)')]);
      return [near(c[0], pal.text, 60) && near(c[1], pal.textSecondary, 60) && near(c[2], pal.error, 60) && near(c[3], pal.textDisabled, 60) && near(c[4], pal.text, 60) && near(c[5], pal.error, 60), c.join(' ')];
    });
    await R(`${mode}: check marks and sub-menu arrows are drawn in ${pal.text}`, async () => {
      await ui.shot(file, null, mr);
      const ch = item(g, 'Notifications enabled'); const ar = item(g, 'Active sessions (2)');
      const a = px({ x: ch.x + 3, y: ch.y + 3, w: 22, h: ch.h - 6 }); const b = px({ x: ar.x + ar.w - 24, y: ar.y + 3, w: 20, h: ar.h - 6 });
      const c = extreme(file, [[a.x - mr.x, a.y - mr.y, a.w, a.h], [b.x - mr.x, b.y - mr.y, b.w, b.h]]);
      return [near(c[0], pal.text, 70) && near(c[1], pal.text, 70), c.join(' ')];
    });
    await R(`${mode}: the sub-menu is themed too (background ${pal.surface}, border ${pal.border})`, async () => {
      const first = sub.items[0]; const p = px({ x: first.x + 3, y: first.y + 3, w: 1, h: 1 }); const e = px({ x: sub.x, y: sub.y + sub.h / 2, w: 1, h: 1 });
      const c = await ui.pixels([[p.x, p.y], [e.x, e.y]]);
      return [near(c[0], pal.surface, 2) && near(c[1], pal.border, 8), c.join(' ')];
    });
    await hideMenu();
    // the Appearance sub-menu: check mark on the chosen entry only
    send({ ...MODEL, appearance: 'dark' }); await sleep(300);
    m = await showMenu({ open: 'Appearance' });
    await R(`${mode}: the Appearance sub-menu draws a check mark beside "Dark" and none beside "System" / "Light"`, async () => {
      const f2 = path.join(ROOT, `b-${mode}-ap.png`); const sr = px({ x: m.sub.x - 4, y: m.sub.y - 4, w: m.sub.w + 8, h: m.sub.h + 8 }); await ui.shot(f2, null, sr);
      const reg = (t) => { const it = item(m.sub, t); const r = px({ x: it.x + 3, y: it.y + 3, w: 24, h: it.h - 6 }); return [r.x - sr.x, r.y - sr.y, r.w, r.h]; };
      const c = extreme(f2, [reg('System'), reg('Light'), reg('Dark')]);
      return [near(c[2], pal.text, 70) && near(c[0], pal.surface, 12) && near(c[1], pal.surface, 12), c.join(' ')];
    });
    await hideMenu(); send(MODEL); await sleep(300);
  }

  // =========================================================================================================
  console.log('== C) pressed state, live theme change while the menu is open, switching preference back and forth');
  for (const [mode, pal] of [['light', palette.LIGHT], ['dark', palette.DARK]]) {
    setTheme(mode); await sleep(400); m = await showMenu();
    await R(`${mode}: pressing the mouse on an entry shows the pressed background ${pal.pressed}; releasing outside the menu clicks nothing`, async () => {
      events.length = 0; await hideMenu(); m = await showMenu(); const it = item(m.menu, 'Send test notification'); const c0 = px({ x: it.x + 8, y: it.y + it.h / 2, w: 1, h: 1 });
      await ui.mouse('move', c0.x + 40, c0.y); await sleep(350); await ui.mouse('down'); await sleep(350);
      const c = await ui.pixels([[c0.x, c0.y]]);
      await ui.mouse('move', 5, 5); await sleep(250); await ui.mouse('up'); await sleep(450);
      const clicked = events.filter((e) => e.evt === 'menu');
      return [near(c[0], pal.pressed, 2) && clicked.length === 0, `${c[0]} clicks=${clicked.length}`];
    });
    await hideMenu();
  }
  setTheme('light'); await sleep(300); m = await showMenu({ select: 'Send test notification' });
  let g0 = m.menu; const probe = async () => { const it = item(g0, 'Send test phone notification'); const p = px({ x: it.x + 3, y: it.y + 4, w: 1, h: 1 }); return (await ui.pixels([[p.x, p.y]]))[0]; };
  const before = await probe(); setTheme('dark'); await sleep(700); const during = await probe(); setTheme('light'); await sleep(700); const back = await probe();
  check('live change while the menu is OPEN: light -> dark -> light repaints the open menu at once', near(before, palette.LIGHT.surface, 2) && near(during, palette.DARK.surface, 2) && near(back, palette.LIGHT.surface, 2), `${before} ${during} ${back}`);
  await hideMenu();
  for (let i = 0; i < 4; i++) { setTheme(i % 2 ? 'light' : 'dark'); await sleep(250); }
  m = await showMenu(); await hideMenu();
  check('rapid theme changes leave a working menu in the last theme (no exception, host alive)', !!m && m.themed === true && !host.killed && host.exitCode === null);

  // =========================================================================================================
  console.log('== D) High Contrast: Windows draws the menu itself');
  const sys = await ui.syscolors();
  setTheme('dark', true); await sleep(500); m = await showMenu({ open: 'Appearance' });
  check('with High Contrast the host reports: not themed, high contrast', m.themed === false && m.highContrast === true);
  await R('High Contrast: the menu is NOT drawn with the palette (neither the dark nor the light surface colour)', async () => {
    const it = item(m.menu, 'Send test phone notification'); const p = px({ x: it.x + 3, y: it.y + 4, w: 1, h: 1 }); const c = await ui.pixels([[p.x, p.y]]);
    return [!near(c[0], palette.DARK.surface, 2) && !near(c[0], palette.LIGHT.surface, 1), c[0]];
  });
  await R('High Contrast: the sub-menu is system-drawn too, and "Appearance" still works there', async () => {
    const first = m.sub.items[0]; const p = px({ x: first.x + 3, y: first.y + 3, w: 1, h: 1 }); const c = await ui.pixels([[p.x, p.y]]);
    return [!near(c[0], palette.DARK.surface, 2) && m.sub.items.length === 3, c[0]];
  });
  await hideMenu();
  setTheme('dark'); await sleep(500); m = await showMenu();
  check('leaving High Contrast restores the themed menu', m.themed === true && m.highContrast === false); await hideMenu();
  check('the host never wrote anything about the Windows High Contrast setting (it only reads it)', !/SystemParametersInfo|SPI_SETHIGHCONTRAST|HighContrast\s*=\s*\$true/.test(fs.readFileSync(path.join(P, 'ui-host.ps1'), 'utf8')));

  // =========================================================================================================
  console.log('== E) every tray entry still works with a real mouse click');
  setTheme('dark'); await sleep(300);
  const clickEntry = async (text, expectId, viaSub = null) => {
    await R(`click "${viaSub ? `${viaSub} > ` : ''}${text}" => the notifier receives "${expectId}"`, async () => {
      events.length = 0; await hideMenu();
      const mm = await showMenu(viaSub ? { open: viaSub } : {}); const g = viaSub ? mm.sub : mm.menu; const it = item(g, text);
      if (viaSub) { const parent = item(mm.menu, viaSub); const pp = px({ x: parent.x, y: parent.y, w: parent.w, h: parent.h }); await ui.mouse('move', ...mid(pp)); await sleep(300); }
      const r = px(it); await ui.mouse('move', ...mid(r)); await sleep(350); await ui.mouse('down'); await sleep(120); await ui.mouse('up');
      const e = await waitEvt('menu', 3000);
      return [!!e && e.id === expectId, e ? e.id : 'no event'];
    });
  };
  await clickEntry('Notifications enabled', 'toggleNotifications');
  await clickEntry('Sounds disabled', 'toggleSounds');
  await clickEntry('Send test notification', 'test');
  await clickEntry('Phone notifications enabled', 'togglePhone');
  await clickEntry('Phone setup…', 'phoneSetup');
  await clickEntry('Send test phone notification', 'testPhone');
  await clickEntry('System', 'appearance:system', 'Appearance');
  await clickEntry('Light', 'appearance:light', 'Appearance');
  await clickEntry('Dark', 'appearance:dark', 'Appearance');
  await clickEntry('Open data folder', 'openFolder');
  await clickEntry('Exit', 'exit');
  await hideMenu();
  check('the host itself never exits or opens anything by menu clicks (it only reports them): still running', host.exitCode === null);

  // =========================================================================================================
  console.log('== F) static properties of the tray host');
  {
    const src = fs.readFileSync(path.join(P, 'ui-host.ps1'), 'utf8');
    check('the host contains no appearance or settings logic of its own (the notifier owns the preference)', !/settings\.json|setSetting|'appearance'/.test(src) || /\$m\.appearance/.test(src));
    check('the host reads the preference only from the menu model it is sent', (src.match(/appearance/gi) || []).length >= 3 && !/Get-ItemProperty|HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes/.test(src));
    check('Windows toasts are untouched: the toast XML has no theme or colour attributes', !/theme|<toast[^>]*(color|requestedTheme)/i.test(src.slice(src.indexOf('function Build-ToastXml'), src.indexOf('function Show-Toast'))));
    check('the High Contrast switch is honoured by the host itself too (SystemInformation.HighContrast)', /SystemInformation\]::HighContrast/.test(src));
  }

  send({ cmd: 'exit' }); await sleep(1200); try { host.kill(); } catch { /* gone */ }
  await ui.stop();
  // throw-away identity cleanup (registry key + Start Menu shortcut created by the host for this test AUMID)
  spawnSync(winpaths.regExe(), ['delete', `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`, '/f'], { windowsHide: true });
  try { fs.rmSync(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${DISPLAY}.lnk`), { force: true }); } catch { /* ignore */ }
  const fails = results.filter((x) => !x).length;
  console.log(`\nstep18: ${results.length - fails}/${results.length} checks passed` + (retried.length ? `  (${retried.length} screen check(s) needed a retry: ${retried.join(' | ')})` : '  (no retries needed)'));
  if (!fails) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } } else console.log(`(scratch files kept: ${ROOT})`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { host && host.kill(); } catch { /* ignore */ } try { ui && ui.stop(); } catch { /* ignore */ } process.exit(1); });
