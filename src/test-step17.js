#!/usr/bin/env node
/**
 * test-step17.js -- Task 4 (dark mode), stage 3: Light / Dark / High Contrast in the REAL phone setup window.
 *
 * The real window is started (setup-window.ps1 + setup-controller.js) and photographed: pixel colours of the window, footer, buttons
 * (normal / hover / pressed / disabled / keyboard focus), text boxes, banner, links and QR boxes are compared with palette.js; the
 * QR codes are decoded again with OpenCV in every mode; the confirmation dialog, live theme switching and High Contrast are exercised.
 * The theme is chosen through a mutable stand-in for the notifier's theme provider; a scripted sender replaces ntfy.sh, data folders are
 * scratch folders. Needs an interactive desktop and Python with OpenCV (cv2, numpy).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ntfy = require('./ntfy');
const onb = require('./onboarding');
const { Store } = require('./store');
const { SetupController } = require('./setup-controller');
const { Uia } = require('./tools/uia');
const palette = require('./palette');
const theme = require('./theme');

const results = [];
const ONLY = process.env.T17_ONLY || ''; const want = (l) => !ONLY || ONLY.includes(l);
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = __dirname;
const ROOT = path.resolve(P, '..', 'theme-test17');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.max(...rgb(a).map((v, i) => Math.abs(v - rgb(b)[i])));
const near = (a, b, t = 6) => !!a && !!b && dist(a, b) <= t;

const PY = `import cv2, json, sys
img = cv2.imread(sys.argv[1]); mode = sys.argv[2]
if mode == 'extreme':      # per region: the colour farthest from the region's corner pixel (the text / mark colour)
    out = []
    for x, y, w, h in json.loads(sys.argv[3]):
        crop = img[max(y, 0):y + h, max(x, 0):x + w].reshape(-1, 3).astype(int)
        d = ((crop - crop[0]) ** 2).sum(axis=1); b, g, r = crop[d.argmax()]
        out.append('#%02X%02X%02X' % (r, g, b))
    print(json.dumps(out))
elif mode == 'qrbox':      # the white square box of the QR code: largest nearly square pure-white region
    import numpy as np
    mask = (img.min(axis=2) >= 254).astype('uint8') * 255
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in cs:
        x, y, w, h = cv2.boundingRect(c)
        if w > 120 and 0.9 < w / float(h) < 1.1 and (best is None or w * h > best[2] * best[3]): best = (x, y, w, h)
    print(json.dumps(list(best) if best else []))
else:                      # QR decoding, classic + aruco, several scales
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    classic = cv2.QRCodeDetector(); aruco = cv2.QRCodeDetectorAruco() if hasattr(cv2, 'QRCodeDetectorAruco') else None
    got = []
    for scale in (1.0, 0.75, 1.25, 1.5, 2.0):
        im = gray if scale == 1.0 else cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        t, _, _ = classic.detectAndDecode(im)
        if t: got.append(t)
        if aruco is not None:
            t2, _, _ = aruco.detectAndDecode(im)
            if t2: got.append(t2)
    print(json.dumps(got))
`;
const pix = async (pts) => { let r = []; for (let i = 0; i < 4; i++) { r = await ui.pixels(pts); if (!r.includes('#000000')) return r; await sleep(250); } try { const w = await ui.rect(); await ui.shot(path.join(ROOT, `fail-${++failShots}.png`), null, { x: Math.max(0, w.x - 300), y: Math.max(0, w.y - 150), w: w.w + 600, h: w.h + 300 }); } catch { /* diagnostics only */ } return r; };
let failShots = 0;
/** a screen-sampling check: retried (and every retry reported) because the desktop is shared: a moved mouse or a window brought to the front by someone else during a measurement is not a defect, a real defect fails every attempt */
const retried = [];
async function R(name, fn, tries = 3) {
  let last = [false, '']; let shown = '';
  for (let i = 1; i <= tries; i++) {
    try { last = await fn(); } catch (e) { last = [false, `error: ${e.message}`]; }
    if (last[0]) { if (i > 1) { retried.push(name); shown = `needed ${i} attempts`; } check(name, true, shown || last[1]); return; }
    await sleep(600);
  }
  let fg = ''; try { const r = await ui.req({ cmd: 'fg' }); fg = ` [foreground: ${r.process} "${String(r.title).slice(0, 40)}"]`; } catch { /* diagnostics only */ }
  check(name, false, `${last[1]} (failed all ${tries} attempts)${fg}`);
}
const py = (file, mode, extra = '') => { const r = spawnSync('python', [path.join(ROOT, 'img.py'), file, mode, ...(extra ? [extra] : [])], { encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return []; } };

// ---- scenario factory: fresh data folder, store, onboarding, controller with a MUTABLE theme, the real window ----
let ui; let sn = 0; const allErrors = []; const themeMsgs = [];
function make({ appearance = 'light', systemLight = true, highContrast = false, beforeStart = null, confirmed = false } = {}) {
  const dir = path.join(ROOT, `s${++sn}`); fs.mkdirSync(dir, { recursive: true });
  const store = new Store(dir); const sent = [];
  const o = new onb.Onboarding({ dir, store, send: async (cfg, body) => { sent.push(body); return { ok: true, status: 200 }; }, log: () => {} });
  if (beforeStart) beforeStart({ dir, store, o }); else o.ensureConfig();
  if (confirmed) { o._set({ state: 'confirmed', confirmedAt: 1 }); store.setSetting('phoneEnabled', true); }
  const ref = { appearance, systemLight, highContrast };
  const c = new SetupController({ onboarding: o, getFacts: () => ({ claudeRunning: true, sessionsDirExists: true, liveSessions: 2, usage: { state: 'fresh' } }), log: () => {}, refreshMs: 600000, getTheme: () => theme.resolveTheme(ref.appearance, ref) });
  const send0 = c._send.bind(c); c._send = (obj) => { if (obj.cmd === 'theme') themeMsgs.push(obj.theme); send0(obj); };
  c.on('event', (e) => { if (e.evt === 'error') allErrors.push(e); });
  let closed = 0; c.on('dismissed', () => { closed++; });
  const s = { dir, store, o, c, ref, sent, closedCount: () => closed, topic: () => { const i = ntfy.inspectConfig(dir); return i.cfg && i.cfg.topic; } };
  s.names = async () => (await ui.list()).map((i) => i.name);
  s.find = async (t) => (await s.names()).find((n) => (t instanceof RegExp ? t.test(n) : n === t));
  s.has = async (t) => !!(await s.find(t));
  s.waitFor = (t, ms = 12000) => ui.until(() => s.has(t), ms);
  s.open = async (page = null) => { c.open({ page }); await new Promise((r) => c.once('opened', r)); const a = await ui.attach(c.child.pid, 15000); await sleep(900); s.win = await ui.rect(); return a.ok; };
  s.close = async () => { if (c.isOpen()) { await ui.close(); await ui.until(() => !c.isOpen(), 6000); } c.kill(); store.close(); };
  s.themed = (mode, ms = 8000) => new Promise((res) => { const t = setTimeout(() => res(false), ms); const h = (m) => { if (m === mode) { clearTimeout(t); c.off('themed', h); res(true); } }; c.on('themed', h); });
  /** window shot + a list of {name: control text} -> extreme colours of each control's text */
  s.shot = async (file) => { await ui.shot(file); s.win = await ui.rect(); return file; };
  s.textColors = async (file, names, inset = 0) => {
    const regs = []; for (const n of names) { const r = await ui.rect(n); regs.push(r ? [r.x - s.win.x + inset, r.y - s.win.y + inset, Math.max(1, r.w - 2 * inset), Math.max(1, r.h - 2 * inset)] : [0, 0, 1, 1]); }
    return py(file, 'extreme', JSON.stringify(regs));
  };
  s.bgPoints = () => [[s.win.x + 20, s.win.y + Math.floor(s.win.h * 0.55)], [s.win.x + 20, s.win.y + s.win.h - 30]];
  s.decode = (file) => py(file, 'qr');
  s.qrBox = (file) => { const b = py(file, 'qrbox'); return b.length ? { x: s.win.x + b[0], y: s.win.y + b[1], w: b[2], h: b[3] } : null; };
  return s;
}
const pageProbe = { check: 'Next: connect your phone', app: 'Step 1 of 3: Install ntfy on your phone', subscribe: 'Step 2 of 3: Subscribe to your private topic', test: 'Step 3 of 3: Check your phone', help: /Let.s find out why/, done: 'Phone notifications are ON', status: 'Phone notifications', problem: 'The saved phone settings are damaged' };
const pageTitle = { check: 'Set up phone notifications', app: 'Step 1 of 3: Install ntfy on your phone', subscribe: 'Step 2 of 3: Subscribe to your private topic', test: 'Step 3 of 3: Check your phone', help: /Let.s find out why/, done: 'Phone notifications are ON', status: 'Phone notifications', problem: 'The saved phone settings are damaged' };
const pageTone = { done: 'success', problem: 'error' };

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(path.join(ROOT, 'img.py'), PY);
  const hasCv = spawnSync('python', ['-c', 'import cv2, numpy'], { encoding: 'utf8' }).status === 0;
  check('Python with OpenCV is available for the pixel and QR checks', hasCv);
  ui = new Uia().start();
  const shots = (n) => path.join(ROOT, `${n}.png`);
  const MODES = { light: palette.LIGHT, dark: palette.DARK };

  // =========================================================================================================
  if (want('A')) {
  console.log('== A) every page in Light and Dark: window, footer, title and tone colours, dark title bar');
  for (const [mode, pal] of Object.entries(MODES)) {
    for (const pg of Object.keys(pageProbe)) {
      const s = make({ appearance: mode, confirmed: pg === 'status', beforeStart: pg === 'problem' ? ({ dir }) => { fs.writeFileSync(path.join(dir, 'ntfy.json'), '{"server":"https://ntfy.sh","topic":"claude-abc'); } : null });
      await s.open(pg === 'problem' ? null : pg); await s.waitFor(pageProbe[pg]); await sleep(300);
      const wantTone = pal[pageTone[pg] || 'text'];
      await R(`${mode}/${pg}: window background is ${pal.bg}, footer ${pal.surface}, title colour ${wantTone}, title bar ${mode === 'dark' ? 'dark' : 'light'}`, async () => {
        const f = await s.shot(shots(`a-${mode}-${pg}`)); const bg = await pix(s.bgPoints());
        const title = await s.find(pageTitle[pg]); const tc = title ? (await s.textColors(f, [title]))[0] : null; const tb = await ui.darkTitle();
        return [near(bg[0], pal.bg, 2) && near(bg[1], pal.surface, 2) && near(tc, wantTone, 48) && !!tb && tb.dark === (mode === 'dark'), `bg=${bg} title=${tc} dark=${tb && tb.dark}`];
      });
      if (pg === 'status') {
        const names = (await ui.list()).filter((i2) => !i2.offscreen).map((i2) => i2.name);
        check(`${mode}/status: all five footer buttons are visible (the second row used to be cut off)`, ['Close', 'Show the code again', 'Send a test', 'Turn off'].every((n) => names.includes(n)) && names.some((n) => /Create a new topic/.test(n)));
      }
      await s.close();
    }
  }
  }

  // =========================================================================================================
  if (want('B')) {
  console.log('== B) tones: success / warning / error / secondary text, links, topic box, banner');
  for (const [mode, pal] of Object.entries(MODES)) {
    let s = make({ appearance: mode }); await s.open(); await s.waitFor('Next: connect your phone');
    await R(`${mode}: success row text is ${pal.success}, secondary text ${pal.textSecondary}`, async () => {
      const f = await s.shot(shots(`b-${mode}-check`)); const col = await s.textColors(f, [await s.find(/Claude Desktop is running/), await s.find(/never block the phone setup/)]);
      return [near(col[0], pal.success, 48) && near(col[1], pal.textSecondary, 48), col.join(' ')];
    });
    await s.close();
    s = make({ appearance: mode }); await s.open('app'); await s.waitFor('Open the Google Play page');
    await R(`${mode}: link colour is ${pal.link}`, async () => { const f = await s.shot(shots(`b-${mode}-app`)); const col = await s.textColors(f, ['Open the Google Play page']); return [near(col[0], pal.link, 48), col[0]]; });
    await s.close();
    s = make({ appearance: mode }); await s.open('subscribe'); const topic = s.topic(); await s.waitFor(topic); await sleep(300);
    await R(`${mode}: warning text is ${pal.warning}`, async () => { const f = await s.shot(shots(`b-${mode}-sub`)); const col = await s.textColors(f, [await s.find(/Anyone who sees this code/)]); return [near(col[0], pal.warning, 48), col[0]]; });
    await R(`${mode}: the topic is shown in ${pal.text} on a ${pal.surface} box inside a ${pal.borderStrong} frame`, async () => {
      const f = await s.shot(shots(`b-${mode}-sub2`)); const col = await s.textColors(f, [topic]); const tr = await ui.rect(topic);
      const px = await pix([[tr.x + 3, tr.y + 3], [tr.x - 4, tr.y + Math.floor(tr.h / 2)]]);
      return [near(col[0], pal.text, 60) && near(px[0], pal.surface, 2) && near(px[1], pal.borderStrong, 3), `text=${col[0]} box=${px}`];
    });
    // banner (the "old topic will stop working" notice after a rotation uses this label)
    s.c._send({ cmd: 'notice', text: 'Banner test text for the theme check.' }); await s.waitFor(/Banner test text/); await sleep(300);
    await R(`${mode}: the banner uses the notice colours (${pal.noticeBg} background)`, async () => { const br = await ui.rect(await s.find(/Banner test text/)); const px = (await pix([[br.x + 4, br.y + 4]]))[0]; return [near(px, pal.noticeBg, 2), `banner px=${px}`]; });
    // keyboard: Tab until the topic box has focus => its frame turns into the focus colour
    await R(`${mode}: while the topic box has the keyboard focus, its frame is the focus colour ${pal.focus}`, async () => {
      await ui.foreground(); const tr = await ui.rect(topic); let frame = null;
      for (let i = 0; i < 16 && !frame; i++) { await ui.key(9); await sleep(250); if ((await ui.focused()) === topic) frame = (await pix([[tr.x - 4, tr.y + Math.floor(tr.h / 2)]]))[0]; }
      return [near(frame, pal.focus, 3), `frame=${frame}`];
    });
    await s.close();
  }
  }

  // =========================================================================================================
  if (want('C')) {
  console.log('== C) buttons: normal, hover, pressed, disabled and keyboard focus');
  const mid = (r) => r.y + Math.floor(r.h / 2);
  for (const [mode, pal] of Object.entries(MODES)) {
    const s = make({ appearance: mode }); await s.open(); await s.waitFor('Next: connect your phone'); await sleep(300);
    const prim = await ui.rect('Next: connect your phone'); const sec = await ui.rect('Skip for now');
    const face = async (r) => (await pix([[r.x + 5, mid(r)]]))[0];
    const edge = async (r) => (await pix([[r.x, mid(r)]]))[0];
    const away = async () => { await ui.mouse('move', s.win.x + s.win.w + 60, s.win.y + 100); await sleep(250); };
    const press = async (r) => {   // hover, press, release OUTSIDE the button (so it is not clicked) -> [hoverFace, pressedFace]
      await ui.foreground(); await ui.mouse('move', r.x + r.w / 2, mid(r)); await sleep(450); const h = await face(r);
      await ui.mouse('down'); await sleep(350); const d = await face(r); await away(); await ui.mouse('up'); await sleep(300); return [h, d];
    };
    await R(`${mode}: primary button face ${pal.accent}; secondary face ${pal.buttonBg} with a ${pal.borderStrong} border`, async () => { await away(); const v = [await face(prim), await face(sec), await edge(sec)]; return [near(v[0], pal.accent, 2) && near(v[1], pal.buttonBg, 2) && near(v[2], pal.borderStrong, 4), v.join(' ')]; });
    await R(`${mode}: secondary button hover ${pal.buttonHover}, pressed ${pal.buttonPressed}; releasing outside the button does not click it`, async () => { const [h, d] = await press(sec); return [near(h, pal.buttonHover, 2) && near(d, pal.buttonPressed, 2) && s.c.isOpen(), `${h} ${d}`]; });
    await R(`${mode}: primary button hover ${pal.accentHover}, pressed ${pal.accentPressed}`, async () => { const [h, d] = await press(prim); return [near(h, pal.accentHover, 2) && near(d, pal.accentPressed, 2) && s.c.isOpen(), `${h} ${d}`]; });
    await R(`${mode}: moving the pointer away restores the normal faces`, async () => { await away(); return [near(await face(sec), pal.buttonBg, 2) && near(await face(prim), pal.accent, 2), `${await face(sec)} ${await face(prim)}`]; });
    // keyboard focus (rings show after keyboard use only)
    const tabTo = async (name) => { for (let i = 0; i < 9; i++) { await ui.key(9); await sleep(300); if ((await ui.focused()) === name) return true; } return false; };
    await R(`${mode}: no focus ring before any keyboard use`, async () => { await ui.mouse('move', s.win.x + 60, s.win.y + 460); await ui.mouse('down'); await sleep(100); await ui.mouse('up'); await sleep(350); const b = await pix([[sec.x + 1, mid(sec)], [prim.x + 1, mid(prim)]]); return [!near(b[0], pal.focus, 3) && !near(b[1], pal.focus, 3), b.join(' ')]; });
    await R(`${mode}: Tab reaches the secondary button "Skip for now" and it shows the ${pal.focus} ring`, async () => { await ui.foreground(); const got = await tabTo('Skip for now'); const ring = await pix([[sec.x + 1, mid(sec)]]); return [got && near(ring[0], pal.focus, 3), `ring=${ring}`]; });
    await R(`${mode}: Tab reaches the PRIMARY button, which shows the ${pal.focus} outer ring and an inner ring in ${pal.accentText}`, async () => { await ui.foreground(); const got = await tabTo('Next: connect your phone'); const pr = await pix([[prim.x + 1, mid(prim)], [prim.x + 3, mid(prim)]]); return [got && near(pr[0], pal.focus, 3) && near(pr[1], pal.accentText, 3), pr.join(' ')]; });
    await R(`${mode}: after a mouse click the keyboard ring is gone (rings are for keyboard use)`, async () => { await ui.mouse('move', s.win.x + 60, s.win.y + 460); await ui.mouse('down'); await sleep(100); await ui.mouse('up'); await sleep(350); const a = await pix([[prim.x + 1, mid(prim)], [prim.x + 3, mid(prim)]]); return [!near(a[0], pal.focus, 3), a.join(' ')]; });
    await s.close();
    // disabled
    const d = make({ appearance: mode }); await d.open('test'); await d.waitFor('Step 3 of 3: Check your phone'); await sleep(300);
    await R(`${mode}: a disabled button has the ${pal.disabledBg} face, ${pal.border} border and ${pal.textDisabled} text`, async () => {
      const g = await d.shot(shots(`c-${mode}-test`)); const got = await ui.rect('I got it'); const dis = await pix([[got.x + 5, mid(got)], [got.x, mid(got)]]); const dtext = await d.textColors(g, ['I got it'], 6);
      return [!(await ui.enabled('I got it')) && near(dis[0], pal.disabledBg, 2) && near(dis[1], pal.border, 4) && near(dtext[0], pal.textDisabled, 40), `${dis} text=${dtext}`];
    });
    check(`${mode}: a disabled button is not pressable (BM_CLICK is refused) and does nothing`, !(await ui.invoke('I got it')).ok && d.o.state() !== 'confirmed');
    await d.close();
  }
  }

  // =========================================================================================================
  if (want('D')) {
  console.log('== D) the QR codes stay black on white in every mode, and decode');
  const modes3 = [['light', { appearance: 'light' }], ['dark', { appearance: 'dark' }], ['system(dark)', { appearance: 'system', systemLight: false }], ['high contrast', { appearance: 'dark', highContrast: true }]];
  for (const [label, opts] of modes3) {
    const s = make(opts); await s.open('subscribe'); const topic = s.topic(); await s.waitFor(topic); await sleep(400);
    const f = await s.shot(shots(`d-${label.replace(/\W+/g, '')}`)); const q = s.qrBox(f);
    if (!q) { check(`${label}: the QR box is visible to UI Automation`, false, 'no white square found'); await s.close(); continue; }
    const qrp = await pix([[q.x + 2, q.y + 2], [q.x + q.w - 3, q.y + q.h - 3], [q.x + Math.floor(q.w / 2), q.y + 2]]);
    const mods = py(f, 'extreme', JSON.stringify([[q.x - s.win.x, q.y - s.win.y, q.w, q.h]]));
    check(`${label}: the QR box is pure white (#FFFFFF) with pure black modules (#000000)`, qrp.every((c) => c === '#FFFFFF') && mods[0] === '#000000', `${qrp} ${mods}`);
    check(`${label}: the QR code decodes to the deep link of this machine's topic`, hasCv && s.decode(f).includes(`ntfy://ntfy.sh/${topic}`));
    await s.close();
  }
  { const s = make({ appearance: 'dark' }); await s.open('app'); await s.waitFor('Open the Google Play page'); await sleep(300); const f = await s.shot(shots('d-app-dark'));
    check('dark: the Google Play QR on the install page decodes to the official ntfy page', hasCv && s.decode(f).includes(onb.PLAY_URL)); await s.close(); }
  }

  // =========================================================================================================
  if (want('E')) {
  console.log('== E) the themed confirmation dialog (replaces the native message box)');
  for (const [mode, pal] of Object.entries(MODES)) {
    const s = make({ appearance: mode, confirmed: true }); const old = s.topic(); await s.open(); await s.waitFor(/Create a new topic/);
    await ui.invoke(await s.find(/Create a new topic/));
    const d = await ui.dialog('No', true);
    const msg = "Create a new topic?\r\n\r\nThe ntfy subscription on your phone for the current topic will STOP working, and phone notifications will be switched OFF until you scan the new code and confirm a new test.\r\n\r\nContinue?";
    check(`${mode}: the dialog is titled "Create a new topic" and keeps the exact wording about the old subscription stopping and phone notifications going OFF`, d.ok && d.title === 'Create a new topic' && d.text.startsWith(msg), d.title);
    await sleep(500); const dr = await ui.rect(null, true); const df = path.join(ROOT, `e-${mode}-dlg.png`); await ui.shot(df, null, dr);
    const dp = await pix([[dr.x + 14, dr.y + 50], [dr.x + 14, dr.y + dr.h - 20]]);
    const dtb = await ui.darkTitle(true);
    check(`${mode}: dialog background ${pal.bg}, footer ${pal.surface}, ${mode === 'dark' ? 'dark' : 'light'} title bar`, near(dp[0], pal.bg, 2) && near(dp[1], pal.surface, 2) && dtb && dtb.dark === (mode === 'dark'), `${dp} dark=${dtb && dtb.dark}`);
    const yes = await ui.rect('Yes'); const no = await ui.rect('No');
    const bp = await pix([[yes.x + 5, yes.y + Math.floor(yes.h / 2)], [no.x + 5, no.y + Math.floor(no.h / 2)]]);
    check(`${mode}: "No" is the highlighted default button (${pal.accent}); "Yes" is the plain button (${pal.buttonBg}); order reads Yes, No`, near(bp[1], pal.accent, 2) && near(bp[0], pal.buttonBg, 2) && yes.x < no.x, bp.join(' '));
    const tcol = py(df, 'extreme', JSON.stringify([[84, 70, 340, 26]]));
    check(`${mode}: dialog text colour is ${pal.text}`, near(tcol[0], pal.text, 60), tcol[0]);
    await ui.foreground(); check(`${mode}: "No" has the keyboard focus when the dialog opens`, await ui.until(async () => (await ui.focused()) === 'No', 4000));
    await ui.key(0x1B, true); await sleep(900);   // Escape
    check(`${mode}: Escape answers "No": nothing changes (same topic, phone notifications still ON) and the window stays open`, s.topic() === old && s.store.settings.phoneEnabled === true && s.c.isOpen() && !(await s.has('Yes')));
    await ui.invoke(await s.find(/Create a new topic/)); await ui.dialog('Yes');
    check(`${mode}: "Yes" still creates a new topic and switches phone notifications OFF`, await ui.until(() => s.topic() !== old && s.store.settings.phoneEnabled === false, 8000));
    await s.close();
  }
  }

  // =========================================================================================================
  if (want('F')) {
  console.log('== F) live theme changes: no restart, no reset');
  {
    const s = make({ appearance: 'light', confirmed: false }); await s.open('subscribe'); const topic = s.topic(); await s.waitFor(topic);
    const ntfyFile = path.join(s.dir, 'ntfy.json'); const ntfyHash = sha(ntfyFile); const setFile = path.join(s.dir, 'settings.json'); const pid0 = s.c.child.pid;
    const bgNow = async () => (await pix(s.bgPoints()))[0];
    check('starts in Light', near(await bgNow(), palette.LIGHT.bg, 2));
    const seen = [];
    for (const [ap, hc, expectMode, expectBg] of [['dark', false, 'dark', palette.DARK.bg], ['light', false, 'light', palette.LIGHT.bg], ['dark', false, 'dark', palette.DARK.bg], ['dark', true, 'contrast', null], ['system', false, 'light', palette.LIGHT.bg]]) {
      s.ref.appearance = ap; s.ref.highContrast = hc; const wait = s.themed(expectMode); const sent = s.c.applyTheme(); const ok = await wait; await sleep(350);
      const bg = await bgNow(); seen.push(`${ap}${hc ? '+hc' : ''}->${expectMode}:${bg}`);
      const sysc = expectMode === 'contrast' ? (await ui.syscolors()).Control : null;
      check(`live: ${ap}${hc ? ' + High Contrast' : ''} => the open window re-themes to ${expectMode} (${expectBg || 'system Control colour'}) without closing`, sent && ok && (expectBg ? near(bg, expectBg, 2) : near(bg, sysc, 2)) && s.c.isOpen() && s.c.child.pid === pid0, `${bg}`);
    }
    check('live: same process, same page (subscribe), same topic, no close/dismiss, no error events', s.c.child.pid === pid0 && (await s.has('Send test notification')) && (await s.has(topic)) && s.closedCount() === 0 && allErrors.length === 0);
    check('live: applying an unchanged theme sends nothing (no needless repaint)', s.c.applyTheme() === false && s.c.applyTheme(true) === true);
    check('live: switching themes did not touch ntfy.json, did not create settings, and did not enable phone notifications', sha(ntfyFile) === ntfyHash && s.store.settings.phoneEnabled !== true && s.o.state() !== 'confirmed' && (!fs.existsSync(setFile) || (JSON.parse(fs.readFileSync(setFile, 'utf8')).appearance || 'system') === 'system'));
    // live switch with the dialog open
    await s.close();
    const t = make({ appearance: 'light', confirmed: true }); await t.open(); await t.waitFor(/Create a new topic/);
    await ui.invoke(await t.find(/Create a new topic/)); await ui.dialog('No', true); await sleep(500);
    let dr = await ui.rect(null, true); const dpx = async () => (await pix([[dr.x + 14, dr.y + 50]]))[0];
    const lightDlg = await dpx();
    t.ref.appearance = 'dark'; const w = t.themed('dark'); t.c.applyTheme(); await w; await sleep(400);
    check('live: a confirmation dialog that is open when the theme changes is re-themed too (light -> dark), still open', near(lightDlg, palette.LIGHT.bg, 2) && near(await dpx(), palette.DARK.bg, 2) && (await ui.darkTitle(true)).dark === true);
    await ui.key(0x1B, true); await sleep(600);
    check('live: the dialog answered No afterwards, the window is still open', t.c.isOpen() && t.store.settings.phoneEnabled === true);
    await t.close();
  }
  }

  // =========================================================================================================
  if (want('G')) {
  console.log('== G) High Contrast keeps the Windows system colours');
  {
    const sc = await ui.syscolors();
    const s = make({ appearance: 'dark', highContrast: true }); await s.open('check'); await s.waitFor('Next: connect your phone'); await sleep(400);
    const f = await s.shot(shots('g-hc'));
    const bg = await pix(s.bgPoints()); const tb = await ui.darkTitle();
    const lastTheme = themeMsgs[themeMsgs.length - 1];
    check('High Contrast overrides even an explicit Dark preference: the window is told "contrast" and gets NO palette', lastTheme && lastTheme.mode === 'contrast' && lastTheme.highContrast === true && lastTheme.colors === null);
    check('...the window and footer use the Windows system colour (Control; footer = Window), not the palette', near(bg[0], sc.Control, 2) && near(bg[1], sc.Window, 2) && !near(bg[0], palette.DARK.bg, 2) && !near(bg[0], palette.LIGHT.bg, 1), `${bg} sys=${sc.Control}`);
    const prim = await ui.rect('Next: connect your phone'); const face = (await pix([[prim.x + prim.w / 2 | 0, prim.y + 6]]))[0];
    check('...buttons are the native Windows buttons (not the palette accent / button colours)', !near(face, palette.DARK.accent, 8) && !near(face, palette.LIGHT.accent, 8) && !near(face, palette.DARK.buttonBg, 2), face);
    const tcol = await s.textColors(f, ['Set up phone notifications']);
    check('...text is the system text colour (ControlText)', near(tcol[0], sc.ControlText, 40), `${tcol[0]} sys=${sc.ControlText}`);
    check('...the title bar is left to Windows (not forced dark)', tb && tb.dark === false);
    await s.close();
    const t = make({ appearance: 'light', highContrast: false }); await t.open('subscribe'); await t.waitFor(t.topic()); t.ref.highContrast = true; const w = t.themed('contrast'); t.c.applyTheme(); await w; await sleep(400);
    const f2 = await t.shot(shots('g-hc-live')); const q = t.qrBox(f2); const qp = await pix([[q.x + 2, q.y + 2]]);
    check('High Contrast: the QR box is still white and the QR still decodes', qp[0] === '#FFFFFF' && hasCv && t.decode(f2).includes(`ntfy://ntfy.sh/${t.topic()}`));
    await t.close();
    check('this test never changes the Windows High Contrast setting (it only tells the window; see test-step15 for the registry reading)', !/SystemParametersInfo|HIGHCONTRAST|SPI_SETHIGHCONTRAST/.test(fs.readFileSync(path.join(P, 'tools', 'uia-agent.ps1'), 'utf8')));
  }
  }

  // =========================================================================================================
  if (want('H')) {
  console.log('== H) static properties of the window script');
  {
    const ps1 = fs.readFileSync(path.join(P, 'setup-window.ps1'), 'utf8');
    check('setup-window.ps1 is pure ASCII', !/[^\x00-\x7F]/.test(ps1));
    check('...and has no network, file-write or registry access', !/Invoke-WebRequest|Invoke-RestMethod|WebClient|HttpClient|Net\.Sockets|Out-File|Set-Content|Add-Content|WriteAllText|New-Item|Remove-Item|\[IO\.File\]|\[System\.IO\.File\]|Registry|HKCU/i.test(ps1));
    check('...contains no palette colour: no #RRGGBB literal and no FromArgb (all colours arrive as tokens); the only literal colours are the QR white / black', !/#[0-9A-Fa-f]{6}\b/.test(ps1.replace(/'\^#\[0-9A-Fa-f\]\{6\}\$'/g, '')) && !/FromArgb/.test(ps1) && (ps1.match(/Color\]::White/g) || []).length >= 2 && /Color\]::Black/.test(ps1));
    check('...the QR box is never themed (the theme walk skips PictureBox) and its colour is fixed white', /elseif \(\$c -is \[System\.Windows\.Forms\.PictureBox\]\) \{ \}/.test(ps1) && /\$pb\.BackColor = \[System\.Drawing\.Color\]::White/.test(ps1));
    check('...the dark title bar call is wrapped in try/catch, returns false instead of throwing on Windows without it, and tries both attribute numbers (20 and 19)', /DwmSetWindowAttribute\(h, 20, ref v, 4\)/.test(ps1) && /DwmSetWindowAttribute\(h, 19, ref v, 4\)/.test(ps1) && /catch \(Exception\) \{ return false; \}/.test(ps1));
    check('...the window stays invisible (Opacity 0) until the theme and first model are applied, with a safety timeout', /\$form\.Opacity = 0/.test(ps1) && /Show-Page \$start; \$form\.Opacity = 1/.test(ps1) && /\$script:ticks -gt 30/.test(ps1));
    check('...High Contrast is also detected by the window itself (SystemInformation.HighContrast), in addition to the notifier telling it', /SystemInformation\]::HighContrast/.test(ps1));
    check('...no native MessageBox is used any more (the themed dialog replaced it)', !/MessageBox/.test(ps1));
    check('...it never reads or writes the appearance setting (UI only: no settings access of any kind)', !/['"]appearance['"]|setSetting|settings\.json/i.test(ps1));
    const ctl = fs.readFileSync(path.join(P, 'setup-controller.js'), 'utf8');
    check('setup-controller.js sends colours only from palette.js and never writes settings itself', /palette\.paletteFor/.test(ctl) && !/setSetting|writeFile/.test(ctl));
  }
  }

  // =========================================================================================================
  console.log('== I) no window error and no data touched');
  check('the window reported no error event in the whole suite', allErrors.length === 0, JSON.stringify(allErrors.slice(0, 2)));
  check('theme messages carried exactly the palette tokens (light/dark) or no colours (contrast); nothing else', themeMsgs.length > (ONLY ? 0 : 20) && themeMsgs.every((t) => (t.mode === 'contrast' ? t.colors === null : (t.mode === 'light' || t.mode === 'dark') && JSON.stringify(Object.keys(t.colors)) === JSON.stringify(palette.TOKENS) && JSON.stringify(t.colors) === JSON.stringify(palette.paletteFor(t.mode)))), `${themeMsgs.length} messages`);

  await ui.stop();
  const fails = results.filter((x) => !x).length;
  console.log(`\nstep17: ${results.length - fails}/${results.length} checks passed` + (retried.length ? `  (${retried.length} screen-sampling check(s) needed a retry: ${retried.join(' | ')})` : '  (no retries needed)'));
  if (!fails) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } } else console.log(`(scratch files kept for inspection: ${ROOT})`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { ui && ui.stop(); } catch { /* ignore */ } process.exit(1); });
