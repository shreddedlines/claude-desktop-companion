#!/usr/bin/env node
/**
 * test-step13.js — Task 3, stage 3: the phone setup WINDOW (setup-window.ps1 + setup-controller.js + onboarding.js).
 *
 * The REAL window is started and used like a person would use it: controls are found by their visible text and pressed, and the
 * screen is photographed. What it draws is decoded back with OpenCV (the QR codes), what it copies is read from the clipboard.
 * A scripted sender stands in for ntfy.sh (no network), data folders are scratch folders: your own configuration is never touched.
 * Needs an interactive desktop (the window has to be visible) and Python with OpenCV for the QR checks.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const winpaths = require('./winpaths');
const ntfy = require('./ntfy');
const onb = require('./onboarding');
const { Store } = require('./store');
const { SetupController } = require('./setup-controller');
const { Uia } = require('./tools/uia');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = __dirname;
const ROOT = path.resolve(P, '..', 'win-test13');
const TOPIC_RE = /^claude-[a-hj-km-np-z2-9]{16}$/;
const allLogs = [];

// ---- OpenCV: decode QR codes found in a screenshot ----------------------------------------------------------------------------------
const DECODER = `import cv2, json, sys
img = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)
classic = cv2.QRCodeDetector(); aruco = cv2.QRCodeDetectorAruco() if hasattr(cv2, 'QRCodeDetectorAruco') else None
got = []
for scale in (1.0, 0.75, 1.25, 1.5, 2.0):
    im = img if scale == 1.0 else cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    t, _, _ = classic.detectAndDecode(im)
    if t: got.append(t)
    if aruco is not None:
        t2, _, _ = aruco.detectAndDecode(im)
        if t2: got.append(t2)
sys.stdout.buffer.write(json.dumps(got, ensure_ascii=True).encode('ascii'))
`;
function decodeShot(file) { const r = spawnSync('python', [path.join(ROOT, 'dec.py'), file], { encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return []; } }
// clipboard helpers: each call checks the exit code and stderr. A failed call is RECORDED (a final check fails the suite) and returns null / false,
// so an assertion that depends on it fails visibly instead of comparing against an empty string.
const clipFaults = []; let clipCalls = 0;
function clipRun(what, args) {
  clipCalls++; const r = spawnSync(winpaths.powershellExe(), args, { encoding: 'utf8' }); const err = String(r.stderr || '').trim();
  if (r.error || r.status !== 0 || err) { clipFaults.push(`${what}: exit=${r.status}${r.error ? ' ' + r.error.code : ''} ${err.replace(/\s+/g, ' ').slice(0, 120)}`); return null; }
  return r;
}
const readClipboard = () => { const r = clipRun('read', ['-NoProfile', '-STA', '-Command', 'Get-Clipboard -Raw']); return r === null ? null : String(r.stdout || '').replace(/\r?\n$/, ''); };
const setClipboard = (t) => clipRun('write', ['-NoProfile', '-STA', '-Command', `Set-Clipboard -Value '${t}'`]) !== null;
const isGone = (v, topic) => v !== null && v !== topic;      // "removed" needs a successful read that no longer shows the topic
const COPIED = /removed from the clipboard again/;          // the window shows this only AFTER the copy has been made
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(40); } return !!(await fn()); };

// a stand-in for "another program has the clipboard open": opens it, holds it for -HoldMs, optionally puts other text on it when it lets go
const HOLDER = `param([long]$UntilMs = 0, [string]$Replace = '')
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading;
public static class H {
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint f, IntPtr m);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint f, UIntPtr n);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  public static void Run(IntPtr hwnd, long until, string replace) {
    bool ok = false; for (int i = 0; i < 400 && !ok; i++) { ok = OpenClipboard(hwnd); if (!ok) Thread.Sleep(5); }
    if (!ok) { Console.WriteLine("FAILED"); return; }
    Console.WriteLine("HELD"); Console.Out.Flush();
    while (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < until) Thread.Sleep(10);
    if (replace.Length > 0) {
      EmptyClipboard(); byte[] b = System.Text.Encoding.Unicode.GetBytes(replace + "\\0");
      IntPtr g = GlobalAlloc(0x0002, (UIntPtr)b.Length); IntPtr p = GlobalLock(g); Marshal.Copy(b, 0, p, b.Length); GlobalUnlock(g); SetClipboardData(13, g);
    }
    CloseClipboard(); Console.WriteLine("RELEASED"); Console.Out.Flush();
  }
}
'@
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form; $h = $f.Handle        # a real window owns the open clipboard, like any other program
[H]::Run($h, $UntilMs, $Replace)
`;
function startHolder(untilEpochMs, replace = '') {
  const child = spawn(winpaths.powershellExe(), ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'clip-hold.ps1'), '-UntilMs', String(untilEpochMs), '-Replace', replace], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const h = { child, out: '', exited: false, heldAt: null, releasedAt: null };
  child.stdout.on('data', (d) => { h.out += d; if (h.heldAt === null && /HELD/.test(h.out)) h.heldAt = Date.now(); if (h.releasedAt === null && /RELEASED/.test(h.out)) h.releasedAt = Date.now(); });
  child.on('exit', () => { h.exited = true; });
  h.waitHeld = () => until(() => h.heldAt !== null || h.exited, 8000).then(() => h.heldAt !== null);
  h.waitExit = (ms) => until(() => h.exited, ms);
  h.kill = () => { try { child.kill(); } catch { /* gone */ } };
  return h;
}

let ui; let sn = 0;
/** one scenario = fresh data folder + store + onboarding (fake clock, scripted sender) + controller + the window */
function make({ facts = { claudeRunning: true, sessionsDirExists: true, liveSessions: 2, usage: { state: 'fresh' } }, beforeStart = null, clipMs = 60000 } = {}) {
  const dir = path.join(ROOT, `s${++sn}`); fs.mkdirSync(dir, { recursive: true });
  const store = new Store(dir); const clock = { t: 1_800_000_000_000 }; const sent = []; let reply = { ok: true, status: 200 };
  const o = new onb.Onboarding({ dir, store, now: () => clock.t, log: (m) => allLogs.push(m), send: async (cfg, body) => { sent.push({ cfg, body }); return typeof reply === 'function' ? reply() : reply; } });
  if (beforeStart) beforeStart({ dir, store, o }); else o.ensureConfig();
  const c = new SetupController({ onboarding: o, getFacts: () => facts, log: (m) => allLogs.push(m), refreshMs: 60_000, clipboardClearMs: clipMs });
  const s = { dir, store, o, c, clock, sent, setReply: (r) => { reply = r; }, topic: () => { const i = ntfy.inspectConfig(dir); return i.cfg && i.cfg.topic; } };
  s.names = async () => (await ui.list()).map((i) => i.name);
  s.has = async (t) => (await s.names()).some((n) => (t instanceof RegExp ? t.test(n) : n.includes(t)));
  s.waitFor = (t, ms = 12000) => ui.until(() => s.has(t), ms);
  s.waitGone = (t, ms = 12000) => ui.until(async () => !(await s.has(t)), ms);
  s.btn = async (name) => { const r = await ui.invoke(name); return r.ok; };
  s.open = async (page = null) => { c.open({ page }); await new Promise((r) => c.once('opened', r)); const a = await ui.attach(c.child.pid, 15000); await sleep(500); return a.ok; };
  s.close = async () => { if (c.isOpen()) { await ui.close(); await ui.until(() => !c.isOpen(), 6000); } c.kill(); store.close(); };
  return s;
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(path.join(ROOT, 'dec.py'), DECODER); fs.writeFileSync(path.join(ROOT, 'clip-hold.ps1'), HOLDER);
  ui = new Uia().start();
  const shots = (n) => path.join(ROOT, `${n}.png`);
  const hasCv = spawnSync('python', ['-c', 'import cv2'], { encoding: 'utf8' }).status === 0;

  // =========================================================================================================
  console.log('== A) the whole wizard, first run to "Phone notifications are ON"');
  let s = make();
  const attached = await s.open();
  check('the window opens on its own page and UI Automation can see it (title "Claude Notifier — Phone setup")', attached);
  check('first page: checklist with three green rows, "Next: connect your phone" and "Skip for now"', await s.has('Set up phone notifications') && await s.has('Claude Desktop is running') && await s.has('Watching 2 Claude Code sessions') && await s.has('Usage numbers are being read') && await s.has('Next: connect your phone') && await s.has('Skip for now'));
  const topic = s.topic();
  check('the topic is NOT on the first page (nothing secret is shown before it is needed)', !(await s.names()).some((n) => n.includes(topic)));
  check('opening the window moved the state to "in-progress" and phone push is still OFF', s.o.state() === 'in-progress' && s.store.settings.phoneEnabled !== true);
  await s.btn('Next: connect your phone');
  check('page 2 "Install ntfy on your phone" with the Google Play and F-Droid links', await s.waitFor('Step 1 of 3: Install ntfy on your phone') && await s.has('Open the Google Play page') && await s.has('Open the F-Droid page'));
  await ui.shot(shots('a-app'));
  if (hasCv) check('the QR code on page 2 decodes (OpenCV, from a screenshot of the window) to the official Google Play page of ntfy', decodeShot(shots('a-app')).includes(onb.PLAY_URL));
  await s.btn('Back'); check('Back returns to the first page', await s.waitFor('Next: connect your phone'));
  await s.btn('Next: connect your phone'); await s.waitFor('I have the ntfy app'); await s.btn('I have the ntfy app');
  check('page 3 "Subscribe to your private topic" shows the topic in a read-only box with a Copy button and the warning about sharing', await s.waitFor('Step 2 of 3: Subscribe to your private topic') && await s.has(topic) && await s.has('Copy') && await s.has(/Anyone who sees this code/));
  await ui.shot(shots('a-sub'));
  if (hasCv) check(`the QR code on page 3 decodes to the deep link ntfy://ntfy.sh/<topic> for THIS machine's topic`, decodeShot(shots('a-sub')).includes(`ntfy://ntfy.sh/${topic}`));
  const placed = setClipboard('placeholder-before-copy');
  await s.btn('Copy'); await s.waitFor(COPIED, 15000);          // the window raises this label only after the copy was made
  check('"Copy" puts exactly the topic on the clipboard', placed && readClipboard() === topic);
  check('...and tells the user that it disappears again after a minute', await s.has(/removed from the clipboard again/));
  await s.btn('Hide the code'); await sleep(500); await ui.shot(shots('a-hidden'));
  check('"Hide the code" hides the QR (it no longer decodes) and the button becomes "Show the code"', await s.has('Show the code') && (!hasCv || !decodeShot(shots('a-hidden')).includes(`ntfy://ntfy.sh/${topic}`)));
  await s.btn('Show the code'); await sleep(400);
  check('"Show the code" brings it back', await s.has('Hide the code'));
  await s.btn('Send test notification');
  check('"Send test notification" sends ONE generic test message (allowlisted keys, no project or session name)', await ui.until(() => s.sent.length === 1, 8000) && s.sent[0].body.topic === topic && JSON.stringify(Object.keys(s.sent[0].body).sort()) === JSON.stringify(['message', 'priority', 'tags', 'title', 'topic']) && /not a Claude event/.test(s.sent[0].body.message));
  check('page 4: "Sent to the ntfy server", "I got it" is enabled, and the wording does not claim delivery', await s.waitFor(/Sent to the ntfy server/) && await ui.until(() => ui.enabled('I got it'), 6000) && !(await s.has(/delivered|received it/i)));
  check('HTTP 200 is NOT confirmation: after the test was accepted, phone notifications are STILL OFF and the state is "test-sent"', s.store.settings.phoneEnabled !== true && s.o.state() === 'test-sent');
  await s.btn('I got it');
  check('"I got it" => "Phone notifications are ON" page; only now phoneEnabled is true and the state is "confirmed"', await s.waitFor('Phone notifications are ON') && await ui.until(() => s.store.settings.phoneEnabled === true, 5000) && s.o.isConfirmed());
  check('the success page explains that only the project and kind of event are sent, and where to find the setup again', await s.has(/never include your conversation/) && await s.has(/system tray/));
  await s.btn('Close'); await ui.until(() => !s.c.isOpen(), 6000);
  check('closing a confirmed setup leaves it confirmed and push ON (not "dismissed")', s.o.isConfirmed() && s.store.settings.phoneEnabled === true && !s.c.isOpen());
  await s.close();

  // =========================================================================================================
  console.log('== B) "Skip for now", closing the window, and the single-instance rule');
  s = make(); await s.open();
  const pid1 = s.c.child.pid; s.c.open(); await sleep(800);
  check('opening again while it is open does NOT start a second window (same process, brought to the front)', s.c.child.pid === pid1 && s.c.isOpen());
  await s.btn('Skip for now'); await ui.until(() => !s.c.isOpen(), 6000);
  check('"Skip for now" closes the window: state "dismissed", phone OFF, it will not open by itself again', s.o.state() === 'dismissed' && s.store.settings.phoneEnabled !== true && s.o.shouldAutoOpen() === false);
  await s.open();
  check('it can be opened again later (the tray item does this): state back to "in-progress"', s.o.state() === 'in-progress');
  await ui.close(); await ui.until(() => !s.c.isOpen(), 6000);
  check('closing the window with the X before finishing counts as "not now": dismissed, phone still OFF', s.o.state() === 'dismissed' && s.store.settings.phoneEnabled !== true);
  await s.close();

  // =========================================================================================================
  console.log('== C) the test did not arrive');
  s = make(); await s.open(); await s.btn('Next: connect your phone'); await s.waitFor('I have the ntfy app'); await s.btn('I have the ntfy app'); await s.waitFor('Send test notification'); await s.btn('Send test notification');
  await s.waitFor(/Sent to the ntfy server/); await ui.until(() => ui.enabled("I didn’t get it"), 6000);
  await s.btn("I didn’t get it");
  check('"I didn\'t get it" => the help page with the checklist (subscribe, spelling, Android 13 permission, online, stays OFF)', await s.waitFor(/Let.s find out why/) && await s.has(/tapped Subscribe/) && await s.has(/Copy and paste/) && await s.has(/Android 13/) && await s.has(/stay OFF/));
  check('...push stays OFF and the accepted test no longer counts', s.o.state() === 'test-failed' && s.store.settings.phoneEnabled !== true && s.o.confirm().ok === false);
  await s.btn('Send the test again'); await sleep(1200);
  check('sending again straight away is refused locally with a friendly wait message (nothing is sent to the server)', await s.waitFor(/Please wait a moment/) && s.sent.length === 1 && await s.has(/seconds/));
  s.clock.t += 11_000; await s.btn('Try again');
  check('after the wait, "Try again" sends and the page shows success', await ui.until(() => s.sent.length === 2, 8000) && await s.waitFor(/Sent to the ntfy server/));
  await ui.until(() => ui.enabled('I got it'), 6000); await s.btn('I got it');
  check('...and "I got it" now completes the setup', await s.waitFor('Phone notifications are ON') && s.store.settings.phoneEnabled === true);
  await s.btn('Close'); await s.close();

  // =========================================================================================================
  console.log('== D) failures are explained in plain words inside the window');
  const failures = [[{ ok: false, error: 'ENOTFOUND' }, /Can.t reach ntfy\.sh/, 'network down'], [{ ok: false, status: 429, error: 'HTTP 429' }, /asked us to slow down/, 'HTTP 429'], [{ ok: false, status: 503, error: 'HTTP 503' }, /having trouble/, 'server error'], [{ ok: false, error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, /secure connection .* blocked/, 'TLS interception']];
  for (const [reply, rx, label] of failures) {
    s = make(); s.setReply(reply); await s.open('subscribe'); await s.waitFor('Send test notification'); await s.btn('Send test notification');
    check(`${label}: the window shows the plain-words explanation and "Try again"; "I got it" stays disabled; push OFF`, await s.waitFor(rx) && await s.has('Try again') && !(await ui.enabled('I got it')) && s.store.settings.phoneEnabled !== true && s.o.state() !== 'test-sent');
    await s.close();
  }
  s = make(); s.setReply(() => { throw new Error('boom'); }); await s.open('subscribe'); await s.waitFor('Send test notification'); await s.btn('Send test notification');
  check('a sender that throws does not hang or crash the window: it shows a friendly failure and stays usable', await s.waitFor(/could not be sent/) && s.c.isOpen() && await ui.enabled('Try again'));
  s.setReply({ ok: true, status: 200 }); s.clock.t += 11_000; await s.btn('Try again');
  check('...and a retry then succeeds', await s.waitFor(/Sent to the ntfy server/));
  await s.close();

  // =========================================================================================================
  console.log('== E) reopening later: status page, turning phone notifications off and on');
  s = make({ beforeStart: ({ dir, store, o }) => { o.ensureConfig(); o._set({ state: 'confirmed', confirmedAt: 1 }); store.setSetting('phoneEnabled', true); } });
  await s.open();
  check('a confirmed setup reopens on the status page: "Phone notifications are ON" with all the actions', await s.waitFor(/Phone notifications are ON/) && await s.has('Turn off') && await s.has('Send a test') && await s.has('Show the code again') && await s.has(/Create a new topic/) && await s.has('Close'));
  await s.btn('Turn off');
  check('"Turn off" switches phone notifications OFF (setting, status line and button text all follow); setup stays confirmed', await ui.until(() => s.store.settings.phoneEnabled === false, 5000) && await s.waitFor(/Phone notifications are OFF/) && await s.waitFor('Turn on') && s.o.isConfirmed());
  await s.btn('Turn on');
  check('"Turn on" switches them back ON without a new test (the setup was confirmed before)', await ui.until(() => s.store.settings.phoneEnabled === true, 5000) && await s.waitFor('Turn off'));
  await s.btn('Send a test'); await s.waitFor(/Sent to the ntfy server/);
  check('"Send a test" from the status page sends one more test', s.sent.length === 1 && await s.waitFor('I got it'));
  await s.close();
  s = make({ beforeStart: ({ dir, store, o }) => { o.ensureConfig(); o._set({ state: 'confirmed', confirmedAt: 1 }); store.setSetting('phoneEnabled', true); } });
  await s.open(); await s.btn('Show the code again'); await s.waitFor('Step 2 of 3: Subscribe to your private topic'); await sleep(400); await ui.shot(shots('e-qr'));
  check('"Show the code again" shows the subscribe page so another phone can be added', await s.has('Send test notification') && (!hasCv || decodeShot(shots('e-qr')).includes(`ntfy://ntfy.sh/${s.topic()}`)));
  await s.close();

  // =========================================================================================================
  console.log('== F) creating a new topic (rotation)');
  s = make({ beforeStart: ({ dir, store, o }) => { o.ensureConfig(); o._set({ state: 'confirmed', confirmedAt: 1 }); store.setSetting('phoneEnabled', true); } });
  const oldTopic = s.topic(); await s.open(); await s.btn('Create a new topic…');
  const dlg1 = await ui.dialog('No');
  check('a confirmation dialog explains that the old subscription STOPS working and that phone notifications go OFF', dlg1.ok && /STOP working/.test(dlg1.text) && /switched OFF/.test(dlg1.text) && /new code/.test(dlg1.text));
  await sleep(600);
  check('answering "No" changes nothing (same topic, push still ON)', s.topic() === oldTopic && s.store.settings.phoneEnabled === true);
  await s.btn('Create a new topic…'); await ui.dialog('Yes');
  check('answering "Yes" creates a different topic and switches phone notifications OFF', await ui.until(() => s.topic() !== oldTopic && s.store.settings.phoneEnabled === false, 8000) && TOPIC_RE.test(s.topic()));
  check('the window goes to the subscribe page, shows a banner with the explanation and the NEW topic (not the old one)', await s.waitFor('Step 2 of 3: Subscribe to your private topic') && await s.waitFor(s.topic()) && !(await s.has(oldTopic)));
  await sleep(500); await ui.shot(shots('f-new'));
  check('...banner text says the old topic will stop working', await s.has(/old topic will stop working/));
  if (hasCv) check('the QR code now encodes the NEW deep link, not the old one', (() => { const got = decodeShot(shots('f-new')); return got.includes(`ntfy://ntfy.sh/${s.topic()}`) && !got.includes(`ntfy://ntfy.sh/${oldTopic}`); })());
  check('setup must be confirmed again: state "in-progress", not confirmed', s.o.state() === 'in-progress' && !s.o.isConfirmed() && s.o.setPhoneEnabled(true).ok === false);
  await s.close();

  // =========================================================================================================
  console.log('== G) damaged settings are never overwritten silently');
  s = make({ beforeStart: ({ dir }) => { fs.writeFileSync(path.join(dir, 'ntfy.json'), '{"server":"https://ntfy.sh","topic":"claude-abc'); } });
  const damaged = fs.readFileSync(path.join(s.dir, 'ntfy.json'), 'utf8'); await s.open();
  check('a damaged ntfy.json => the window opens on the "damaged" page and says nothing is changed by itself', await s.waitFor('The saved phone settings are damaged') && await s.has(/will not change them by itself/) && await s.has('Start over'));
  check('...the file is untouched and no topic was invented', fs.readFileSync(path.join(s.dir, 'ntfy.json'), 'utf8') === damaged && s.sent.length === 0);
  await s.btn('Start over');
  check('"Start over" keeps the damaged file as a backup, creates a valid configuration and returns to the first page', await ui.until(() => ntfy.inspectConfig(s.dir).problem === null && fs.readdirSync(s.dir).some((f) => /^ntfy\.json\.corrupt-\d{14}$/.test(f)), 8000) && fs.readFileSync(path.join(s.dir, fs.readdirSync(s.dir).find((f) => /^ntfy\.json\.corrupt-/.test(f))), 'utf8') === damaged && await s.waitFor('Next: connect your phone'));
  await s.close();

  // =========================================================================================================
  console.log('== H) checklist reflects what was found');
  s = make({ facts: {} }); await s.open();
  check('nothing found: warnings with plain instructions, and the phone setup is still possible', await s.has(/Claude Desktop was not found/) && await s.has(/Waiting for your first Claude Code session/) && await s.has(/Usage numbers are not available yet/) && await s.has('Next: connect your phone') && await ui.enabled('Next: connect your phone'));
  await s.close();
  s = make({ facts: { claudeRunning: true, sessionsDirExists: true, liveSessions: 1, usage: { state: 'ambiguous' } } }); await s.open();
  check('ambiguous profile: "More than one Claude profile is open"', await s.has(/More than one Claude profile is open/) && await s.has(/Watching 1 Claude Code session$/));
  await s.close();

  // =========================================================================================================
  console.log('== I) the clipboard is cleaned up');
  s = make({ clipMs: 6000 }); await s.open('subscribe');
  await s.waitFor('Copy'); const tp = s.topic(); await s.btn('Copy'); await s.waitFor(COPIED, 15000);
  check('the topic is on the clipboard right after Copy', readClipboard() === tp);
  await s.waitGone(COPIED, 20000);                              // the window removes the label when its clean-up has finished
  check('after the delay the topic is removed from the clipboard again (only if it still holds the topic)', isGone(readClipboard(), tp));
  await s.btn('Copy'); await s.waitFor(COPIED, 15000); const tCopied = Date.now();
  const userCopied = setClipboard('something the user copied later'); const tUser = Date.now() - tCopied;
  check('(test setup) the other copy was made well before the 6 s clean-up fired, so it really is "in the meantime"', userCopied && tUser < 3500, `${tUser} ms after the Copy`);
  await s.waitGone(COPIED, 20000);
  check('if the user copied something else in the meantime, that is left alone', readClipboard() === 'something the user copied later');
  await s.close();

  // =========================================================================================================
  console.log('== I2) the clean-up when ANOTHER PROGRAM has the clipboard open (contention, retry, warning)');
  // The clean-up interval is long (8 s) so that a slow start of the other program (PowerShell) can never be late for the moment the clean-up
  // fires; the other program is told ABSOLUTE times: it releases 0.2 s after the latest possible moment of the clean-up (tLabel + 8 s).
  const CLIP = 8000;
  // I2a: busy at the moment the clean-up fires, free again shortly after => it is retried and the topic is removed
  s = make({ clipMs: CLIP }); await s.open('subscribe'); await s.waitFor('Copy'); let tq = s.topic(); await s.btn('Copy'); await s.waitFor(COPIED, 15000); let tLabel = Date.now();
  let hold = startHolder(tLabel + CLIP + 200); const heldA = await hold.waitHeld();
  check('(test setup) another program holds the clipboard before the 8 s clean-up fires and lets go 0.2 s after it', heldA && hold.heldAt - tLabel < CLIP - 2500, `it had the clipboard ${hold.heldAt - tLabel} ms after the Copy`);
  const t0Ui = Date.now(); await s.names(); const uiLat = Date.now() - t0Ui;
  let tGone = null; const tEnd = Date.now() + CLIP + 6000;      // watch the label WHILE the other program still holds the clipboard
  let worstA = 0;
  while (Date.now() < tEnd && tGone === null) { const a = Date.now(); const present = await s.has(COPIED); worstA = Math.max(worstA, Date.now() - a); if (!present) tGone = Date.now(); else await sleep(60); }
  await hold.waitExit(6000); const tRel = hold.releasedAt;
  check('...the window still answers while the clipboard is locked (the retry does not block its UI thread)', Math.max(uiLat, worstA) < 700, `slowest UI query before, during and after the clean-up fired: ${Math.max(uiLat, worstA)} ms`);
  const goneA = tGone !== null;
  check('a busy clipboard is retried: the clean-up finishes only AFTER the other program let go, and the topic is removed', goneA && tRel !== null && tGone >= tRel - 150 && isGone(readClipboard(), tq), `finished ${tGone - tRel} ms after the release`);
  check('...and no warning is shown, because the clean-up worked', !(await s.has(/could not be removed/)));
  await s.close();

  // I2b: busy for longer than the retries last => a visible warning, the topic is NOT silently claimed to be gone
  s = make({ clipMs: CLIP }); await s.open('subscribe'); await s.waitFor('Copy'); tq = s.topic(); await s.btn('Copy'); await s.waitFor(COPIED, 15000); tLabel = Date.now();
  hold = startHolder(tLabel + CLIP + 15000); const heldB = await hold.waitHeld();
  check('(test setup) another program holds the clipboard before the 8 s clean-up fires and keeps it far longer than the retries last', heldB && hold.heldAt - tLabel < CLIP - 2500, `it had the clipboard ${hold.heldAt - tLabel} ms after the Copy`);
  let worst = 0; let warned = false; const tw = Date.now() + CLIP + 8000;
  while (Date.now() < tw && !warned) { const a = Date.now(); warned = await s.has(/Copy something else/); worst = Math.max(worst, Date.now() - a); if (!warned) await sleep(60); }
  check('the window stays responsive while the clean-up retries (slowest UI query until the warning appeared)', heldB && worst < 700, `${worst} ms`);
  check('when the clipboard stays locked the window shows a warning telling the user to copy something else', warned && heldB && !hold.exited);
  check('...the warning does not say the code was removed, and the retries are bounded (no endless polling: the warning is final)', !(await s.has(COPIED)) && (await s.has(/could not be removed/)));
  hold.kill(); await hold.waitExit(4000); await sleep(1500);
  check('...and the topic really is still there (the app told the truth)', readClipboard() === tq);
  await s.btn('Copy'); await s.waitFor(COPIED, 15000);
  check('a new Copy replaces the warning with the normal message', !(await s.has(/Copy something else/)) && await s.has(COPIED));
  await s.close();

  // I2c: busy when the clean-up fires, and the "user" copies something else at the very moment the other program lets go
  s = make({ clipMs: CLIP }); await s.open('subscribe'); await s.waitFor('Copy'); tq = s.topic(); await s.btn('Copy'); await s.waitFor(COPIED, 15000); tLabel = Date.now();
  hold = startHolder(tLabel + CLIP + 200, 'text another program put there'); const heldC = await hold.waitHeld(); await hold.waitExit(CLIP + 8000);
  check('(test setup) the clipboard was locked across the clean-up and then received other text', heldC && hold.heldAt - tLabel < CLIP - 2500 && hold.releasedAt !== null, `it had the clipboard ${hold.heldAt - tLabel} ms after the Copy`);
  const goneC = await s.waitGone(COPIED, 8000);
  check('unrelated content is never cleared: the retry sees other text and leaves it alone', goneC && readClipboard() === 'text another program put there');
  check('...and no warning is shown', !(await s.has(/could not be removed/)));
  await s.close();

  // =========================================================================================================
  console.log('== J) privacy and hygiene of the window process');
  s = make(); await s.open('subscribe'); const tpc = s.topic();
  const proc = JSON.parse(spawnSync(winpaths.powershellExe(), ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${s.c.child.pid}" | Select-Object CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8' }).stdout);
  check('the window process command line holds no topic (only the script path)', !proc.CommandLine.includes(tpc) && /setup-window\.ps1/.test(proc.CommandLine));
  const win = (await ui.attach(s.c.child.pid, 5000)).name;
  check('the window title is "Claude Notifier — Phone setup" and never contains the topic', /Claude Notifier .* Phone setup/.test(win) && !win.includes(tpc));
  const ps1 = fs.readFileSync(path.join(P, 'setup-window.ps1'), 'utf8');
  check('the window script is pure ASCII (Windows PowerShell 5.1 reads it correctly)', !/[^\x00-\x7F]/.test(ps1));
  check('the window script contains no network access and writes no file (it only renders and reports clicks)', !/Invoke-WebRequest|Invoke-RestMethod|WebClient|HttpClient|Net\.Sockets|Out-File|Set-Content|Add-Content|WriteAllText|New-Item|Remove-Item|\[IO\.File\]|\[System\.IO\.File\]|Registry|HKCU/i.test(ps1));
  check('links open only for the official hosts (play.google.com, f-droid.org, claude.ai) over https', /\^https:\/\/\(play\\\.google\\\.com\|f-droid\\\.org\|claude\\\.ai\)\//.test(ps1) && (ps1.match(/Start-Process/g) || []).length === 1);
  const killed = new Promise((r) => s.c.child.on('exit', r)); s.c.child.stdin.end();
  check('when the notifier goes away (stdin closed) the window closes by itself', await Promise.race([killed.then(() => true), sleep(8000).then(() => false)]));
  s.c.child = null; await s.close();
  check(`every clipboard helper call succeeded (exit code 0, nothing on stderr; ${clipCalls} calls)`, clipFaults.length === 0, clipFaults.join(' | '));
  check('every log line written during the whole suite names actions and states only: no topic, no deep link, no URL', allLogs.length > 10 && allLogs.every((l) => /^phone setup: /.test(l)) && !allLogs.some((l) => /claude-[a-hj-km-np-z2-9]{16}|ntfy:\/\/|https?:/.test(l)), `${allLogs.length} lines`);

  await ui.stop();
  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { ui && ui.stop(); } catch { /* ignore */ } try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
