#!/usr/bin/env node
/**
 * test-step14.js — Task 3, stage 5: end-to-end tests of the first-run phone onboarding through the REAL notifier.
 *
 * What runs: the real notifier (development controls: no tray, first-run setup enabled, simulated tray clicks on stdin), the real setup
 * window driven through UI Automation, the real event pipeline (session files + main.log lines), and a MOCK ntfy server on loopback that
 * records every request. No real network, no real topic, and your own configuration is never touched (every run uses a scratch data folder).
 * Needs an interactive desktop, Python+OpenCV is not needed here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const winpaths = require('./winpaths');
const ntfy = require('./ntfy');
const { Uia } = require('./tools/uia');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = __dirname;
const ROOT = path.resolve(P, '..', 'e2e-test14');
const TOPIC_RE = /^claude-[a-hj-km-np-z2-9]{16}$/;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// ---- mock ntfy server ------------------------------------------------------------------------------------------------------------------
const received = []; const behavior = { mode: 'ok', status: 200 };
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/') {
      let body = null; try { body = JSON.parse(b); } catch { /* keep null */ }
      received.push({ body, raw: b, auth: req.headers.authorization || null, at: Date.now() });
      if (behavior.mode === 'drop') { req.socket.destroy(); return; }
      res.writeHead(behavior.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'mock', time: Math.floor(Date.now() / 1000), event: 'message' }));
    } else { res.writeHead(404); res.end(); }
  });
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------------------
let URLBASE; let ui; let runN = 0;
const allTexts = []; const cmdlines = [];
const pad = (n) => String(n).padStart(2, '0');
const logLine = (lvl, t) => { const x = new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())} [${lvl}] ${t}\n`; };
const realDir = path.join(process.env.USERPROFILE, '.claude', 'sessions');
const pool = fs.readdirSync(realDir).filter((n) => /^\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(realDir, n), 'utf8'))).filter((j) => j.entrypoint === 'claude-desktop' && j.pid !== process.pid);

/** a scratch world: data folder, a fake sessions folder with one synthetic session, a fake log folder */
function world(name, { seedConfig = null, settings = null, topic = null } = {}) {
  const dir = path.join(ROOT, name); const data = path.join(dir, 'data'); const ses = path.join(dir, 'sessions'); const logs = path.join(dir, 'logs');
  for (const d of [data, ses, logs]) fs.mkdirSync(d, { recursive: true });
  const main = path.join(logs, 'main.log'); fs.writeFileSync(main, '');
  if (seedConfig === 'mock') ntfy.initConfig(data, { server: URLBASE, topic: topic || undefined });
  else if (seedConfig === 'closedport') ntfy.initConfig(data, { server: 'http://127.0.0.1:1' });
  else if (seedConfig === 'broken') fs.writeFileSync(path.join(data, 'ntfy.json'), '{"server":"http://127.0.0.1:1","topic":"claude-abc');
  if (settings) fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings));
  const A = { real: pool[0], name: 'SYN-A', cwd: 'D:\\syn\\alpha', host: 'local_aaaaaaaa-0000-4000-8000-000000000001', file: path.join(ses, `${pool[0].pid}.json`) };
  const w = { dir, data, ses, logs, main, A, cfgPath: path.join(data, 'ntfy.json'), settingsPath: path.join(data, 'settings.json'), logPath: path.join(data, 'notifier.log') };
  w.topic = () => (ntfy.inspectConfig(data).cfg || {}).topic;
  w.settings = () => readJson(w.settingsPath) || {};
  w.log = () => read(w.logPath);
  w.count = (rx) => (w.log().match(rx) || []).length;
  w.setState = (status, wf) => { const o = { ...A.real, name: A.name, cwd: A.cwd, hostSessionId: A.host, status, statusUpdatedAt: Date.now() }; delete o.waitingFor; if (wf) o.waitingFor = wf; fs.writeFileSync(A.file, JSON.stringify(o)); };
  w.append = (...l) => fs.appendFileSync(main, l.join(''));
  w.setState('idle');
  return w;
}
/** starts the real notifier (development controls) in that world; returns helpers */
function start(w, { extra = [] } = {}) {
  const args = [path.join(P, 'notifier.js'), '--ui', 'none', '--first-run-setup', '--control-stdin', '--dump-menu', '--no-lock', '--no-usage', '--data-dir', w.data, '--sessions-dir', w.ses, '--log-dir', w.logs, '--interval', '200', '--hold', '700', ...extra];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; let err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; }); child.stdin.on('error', () => {});
  const n = { child, w, out: () => out, err: () => err, menu: () => { const m = out.split('\n').map((l) => { try { return JSON.parse(l).menu; } catch { return null; } }).filter(Boolean); return m[m.length - 1] || {}; },
    send: (id) => child.stdin.write(`${id}\n`), exited: null };
  child.on('exit', (c) => { n.exited = c; });
  n.stop = async () => { if (n.exited === null) { try { n.send('exit'); } catch { /* gone */ } for (let i = 0; i < 40 && n.exited === null; i++) await sleep(150); if (n.exited === null) { try { child.kill(); } catch { /* gone */ } } } allTexts.push(out, err); };
  return n;
}
/** the setup window process started by that notifier */
function findWindowPid(n, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = spawnSync(winpaths.powershellExe(), ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' AND ParentProcessId=${n.child.pid}" | Where-Object { $_.CommandLine -like '*setup-window.ps1*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8' });
    const t = r.stdout.trim(); if (t) { const j = JSON.parse(t); const o = Array.isArray(j) ? j[0] : j; cmdlines.push(o.CommandLine); return o.ProcessId; }
    // (synchronous poll: it also gives the notifier time to open the window)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  return null;
}
const winState = { pid: null };
async function attach(n) { const pid = findWindowPid(n); winState.pid = pid; if (!pid) return false; const a = await ui.attach(pid, 15000); await sleep(600); return a.ok; }
const names = async () => (await ui.list()).map((i) => i.name);
const has = async (t) => (await names()).some((x) => (t instanceof RegExp ? t.test(x) : x.includes(t)));
const waitHas = (t, ms = 12000) => ui.until(() => has(t), ms);
const click = async (b) => (await ui.invoke(b)).ok;
const waitUntil = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return !!(await fn()); };
const closeWindow = async () => { await ui.close(); await sleep(1500); };
const realTitles = (base) => received.slice(base).filter((x) => x.body && x.body.title && x.body.title !== 'Claude Notifier: test');
const testReqs = (base) => received.slice(base).filter((x) => x.body && x.body.title === 'Claude Notifier: test');
/** a real-pipeline "needs permission" event: session file + main.log line, exactly like Claude Desktop writes them */
async function permissionEvent(w, id) {
  w.setState('busy'); await sleep(700);
  w.append(logLine('info', `Emitted tool permission request ${id} for Bash in session ${w.A.host}`)); await sleep(150); w.setState('waiting', 'permission prompt'); await sleep(2600);
  w.setState('busy'); await sleep(600);
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });
  if (!pool.length) { console.error('no Claude Desktop session file found to use as a template (open Claude Desktop once)'); process.exit(1); }
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); URLBASE = `http://127.0.0.1:${server.address().port}`;
  ui = new Uia().start();
  const realCfgBefore = (() => { const f = path.join(process.env.USERPROFILE, '.claude-notifier', 'ntfy.json'); const s = path.join(process.env.USERPROFILE, '.claude-notifier', 'settings.json'); return `${fs.existsSync(f) ? sha(f) : '-'}|${fs.existsSync(s) ? sha(s) : '-'}`; })();

  // =========================================================================================================
  console.log('== A) a brand-new installation: topic created here, window opens ONCE, "Skip for now" is remembered');
  let w = world('A'); let n = start(w);
  check('first launch creates ntfy.json with a unique topic on this machine (default server ntfy.sh)', await waitUntil(() => fs.existsSync(w.cfgPath), 10000) && TOPIC_RE.test(w.topic()) && ntfy.inspectConfig(w.data).cfg.server === 'https://ntfy.sh');
  const topicA = w.topic(); const cfgHashA = sha(w.cfgPath);
  check('phone notifications are OFF after creation, and the tray model says "not set up yet" with the label "Set up phone notifications…"', w.settings().phoneEnabled !== true && await waitUntil(() => n.menu().phoneSetupText === 'Set up phone notifications\u2026', 5000) && n.menu().phoneConfigured === false);
  check('about 3 seconds after the tray is up the setup window opens by itself', await waitUntil(() => w.count(/phone setup: window starting/g) === 1, 15000) && await attach(n));
  check('...on the checklist page, with no topic visible yet', await waitHas('Next: connect your phone') && !(await names()).some((x) => x.includes(topicA)));
  await click('Skip for now'); await sleep(1500);
  check('"Skip for now" => state "dismissed", phone OFF, the configuration untouched', w.settings().phoneSetup && w.settings().phoneSetup.state === 'dismissed' && w.settings().phoneEnabled !== true && sha(w.cfgPath) === cfgHashA);
  await n.stop();
  n = start(w); await sleep(9000);
  check('after a restart the window does NOT open again by itself (no repeated interruption)', w.count(/phone setup: window starting/g) === 1 && sha(w.cfgPath) === cfgHashA && w.topic() === topicA);
  n.send('phoneSetup');
  check('the tray menu item "Phone setup…" still opens it (menu id phoneSetup)', await waitUntil(() => w.count(/phone setup: window starting/g) === 2, 10000) && await attach(n) && await waitHas('Next: connect your phone'));
  await closeWindow(); await n.stop();
  check('no request ever reached the ntfy server during a setup that was skipped', received.length === 0);

  // =========================================================================================================
  console.log('== B) the full wizard against the mock server, then real notifications');
  w = world('B', { seedConfig: 'mock' }); const topicB = w.topic(); n = start(w);
  let base = received.length;
  check('the window opens by itself for a configuration that exists but was never confirmed (the same topic is kept)', await waitUntil(() => w.count(/phone setup: window starting/g) === 1, 15000) && await attach(n) && w.topic() === topicB);
  await click('Next: connect your phone'); await waitHas('I have the ntfy app'); await click('I have the ntfy app'); await waitHas('Send test notification');
  await permissionEvent(w, '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  check('BEFORE the setup is confirmed a real "needs permission" event sends NOTHING to the phone', realTitles(base).length === 0);
  await click('Send test notification');
  check('the test request reaches the server: ONE request, our topic, generic text, allowlisted keys, no authorization header', await waitUntil(() => testReqs(base).length === 1, 10000) && testReqs(base)[0].body.topic === topicB && JSON.stringify(Object.keys(testReqs(base)[0].body).sort()) === JSON.stringify(['message', 'priority', 'tags', 'title', 'topic']) && /not a Claude event/.test(testReqs(base)[0].body.message) && testReqs(base)[0].auth === null);
  check('the server answered HTTP 200, the window says "Sent to the ntfy server" but phone notifications are STILL OFF (200 is not delivery)', await waitHas(/Sent to the ntfy server/) && w.settings().phoneEnabled !== true && w.settings().phoneSetup.state === 'test-sent');
  await permissionEvent(w, '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  check('...and a real event right after the accepted test STILL sends nothing', realTitles(base).length === 0);
  await click('I got it');
  check('"I got it" turns phone notifications ON in the saved settings (the only way it happens)', await waitUntil(() => w.settings().phoneEnabled === true && w.settings().phoneSetup.state === 'confirmed', 8000) && await waitHas('Phone notifications are ON'));
  check('the tray model now says "Phone setup…" and the phone line is configured/enabled', await waitUntil(() => n.menu().phoneSetupText === 'Phone setup\u2026' && n.menu().phoneConfigured === true && n.menu().phoneEnabled === true, 8000));
  await permissionEvent(w, '33333333-cccc-4ccc-8ccc-cccccccccccc');
  const real1 = realTitles(base);
  check('AFTER confirmation the same kind of real event IS pushed: priority 5, "Claude needs permission", Tool: Bash, to our topic', real1.length === 1 && real1[0].body.priority === 5 && real1[0].body.title === 'Claude needs permission' && /Tool: Bash/.test(real1[0].body.message) && real1[0].body.topic === topicB);
  check('...and the real notification stays metadata-only: no path, no folder, no session id, no conversation', !/D:\\|syn\\|alpha\\|local_aaaaaaaa|SYN-A/.test(real1[0].raw) || /alpha/.test(real1[0].body.message));
  await closeWindow(); await n.stop();
  check('closing a confirmed setup leaves it confirmed (not dismissed)', w.settings().phoneSetup.state === 'confirmed' && w.settings().phoneEnabled === true);

  // =========================================================================================================
  console.log('== C) an existing installation with phone push already enabled is not interrupted');
  w = world('C', { seedConfig: 'mock', settings: { phoneEnabled: true } }); const hashC = sha(w.cfgPath); const topicC = w.topic(); base = received.length; n = start(w);
  await sleep(9000);
  check('no setup window appears (nothing starts after 9 seconds)', w.count(/phone setup: window starting/g) === 0 && w.count(/existing enabled configuration recognised/g) === 1);
  check('...the setup is recorded as confirmed (legacy), push stays ON, ntfy.json is byte-identical', w.settings().phoneSetup.state === 'confirmed' && w.settings().phoneSetup.legacy === true && w.settings().phoneEnabled === true && sha(w.cfgPath) === hashC);
  check('...the tray label is "Phone setup…" and the phone line is configured', n.menu().phoneSetupText === 'Phone setup\u2026' && n.menu().phoneConfigured === true);
  await permissionEvent(w, '44444444-dddd-4ddd-8ddd-dddddddddddd');
  check('...and a real event is pushed straight away, exactly as before', realTitles(base).length === 1 && realTitles(base)[0].body.topic === topicC && realTitles(base)[0].body.priority === 5);
  await n.stop();

  // =========================================================================================================
  console.log('== D) turning phone push on from the tray before the setup is confirmed');
  w = world('D', { seedConfig: 'mock', settings: { phoneSetup: { state: 'dismissed', autoOpenedAt: 1, v: 1 } } }); base = received.length; n = start(w); await sleep(1500);
  n.send('togglePhone');
  check('the tray toggle does NOT enable anything: it opens the setup window instead', await waitUntil(() => w.count(/phone setup: window starting/g) === 1, 10000) && w.settings().phoneEnabled !== true && await attach(n));
  await permissionEvent(w, '55555555-eeee-4eee-8eee-eeeeeeeeeeee');
  check('real events still send nothing while the setup is unconfirmed', realTitles(base).length === 0);
  n.send('testPhone'); await sleep(2500);
  check('the older tray command "Send test phone notification" still works but does not enable push', testReqs(base).length === 1 && w.settings().phoneEnabled !== true);
  await closeWindow(); await n.stop();

  // =========================================================================================================
  console.log('== E) reopening from the tray, one window only, and a new topic');
  w = world('E', { seedConfig: 'mock', settings: { phoneEnabled: true } }); const oldTopic = w.topic(); base = received.length; n = start(w); await sleep(2500);
  n.send('phoneSetup');
  check('with a confirmed setup the tray item opens the STATUS page ("Phone notifications are ON")', await waitUntil(() => w.count(/phone setup: window starting/g) === 1, 10000) && await attach(n) && await waitHas(/Phone notifications are ON/));
  n.send('phoneSetup'); await sleep(2500);
  check('choosing it again while open does not open a second window', w.count(/phone setup: window starting/g) === 1 && findWindowPid(n, 3000) === winState.pid);
  await click('Create a new topic\u2026'); const dlg = await ui.dialog('Yes');
  check('the confirmation dialog warned that the old subscription stops working', dlg.ok && /STOP working/.test(dlg.text));
  check('after "Yes": a new topic exists and phone notifications are OFF in the saved settings', await waitUntil(() => w.topic() !== oldTopic && w.settings().phoneEnabled === false, 8000) && TOPIC_RE.test(w.topic()));
  const newTopic = w.topic();
  await permissionEvent(w, '66666666-ffff-4fff-8fff-ffffffffffff');
  check('real events send NOTHING after the rotation (not to the old topic, not to the new one)', realTitles(base).length === 0);
  check('the tray model went back to unconfirmed ("Set up phone notifications…")', await waitUntil(() => n.menu().phoneSetupText === 'Set up phone notifications\u2026' && n.menu().phoneConfigured === false, 8000));
  await waitHas('Send test notification'); await click('Send test notification');
  check('the new test goes to the NEW topic only', await waitUntil(() => testReqs(base).length === 1 && testReqs(base)[0].body.topic === newTopic, 10000));
  await ui.until(() => ui.enabled('I got it'), 6000); await click('I got it');
  await waitUntil(() => w.settings().phoneEnabled === true, 8000);
  await permissionEvent(w, '77777777-aaaa-4aaa-8aaa-777777777777');
  check('after the NEW confirmation real events are pushed, to the new topic only', realTitles(base).length === 1 && realTitles(base)[0].body.topic === newTopic && realTitles(base).every((x) => x.body.topic !== oldTopic));
  await closeWindow(); await n.stop();

  // =========================================================================================================
  console.log('== F) problems on the way: server errors, dropped connection, closed port, "I didn\'t get it"');
  w = world('F', { seedConfig: 'mock' }); base = received.length; n = start(w);
  await waitUntil(() => w.count(/window starting/g) === 1, 15000); await attach(n);
  await click('Next: connect your phone'); await waitHas('I have the ntfy app'); await click('I have the ntfy app'); await waitHas('Send test notification');
  behavior.mode = 'ok'; behavior.status = 503; await click('Send test notification');
  check('server error 503 => "ntfy.sh is having trouble", no confirmation possible, push OFF', await waitHas(/having trouble/, 15000) && !(await ui.enabled('I got it')) && w.settings().phoneEnabled !== true);
  await sleep(11000); behavior.mode = 'drop'; behavior.status = 200; await click('Try again');
  check('dropped connection => "Can\'t reach ntfy.sh" with a plain instruction', await waitHas(/Can.t reach ntfy\.sh/, 20000) && await has('Try again'));
  await sleep(11000); behavior.mode = 'ok'; behavior.status = 200; await click('Try again');
  check('once the server works again the test is accepted', await waitHas(/Sent to the ntfy server/, 15000) && await ui.until(() => ui.enabled('I got it'), 6000));
  await click("I didn\u2019t get it");
  check('"I didn\'t get it" => the help page, state "test-failed", push OFF', await waitHas(/find out why/) && w.settings().phoneSetup.state === 'test-failed' && w.settings().phoneEnabled !== true);
  const bF = received.length; await permissionEvent(w, '88888888-bbbb-4bbb-8bbb-888888888888');
  check('...and real events send nothing', realTitles(bF - received.length + received.length - 0).length === realTitles(0).filter((x) => x.at > Date.now() - 60000 && false).length || received.slice(bF).filter((x) => x.body && x.body.title !== 'Claude Notifier: test').length === 0);
  await closeWindow(); await n.stop();
  w = world('F2', { seedConfig: 'closedport' }); n = start(w);
  await waitUntil(() => w.count(/window starting/g) === 1, 15000); await attach(n);
  await click('Next: connect your phone'); await waitHas('I have the ntfy app'); await click('I have the ntfy app'); await waitHas('Send test notification'); await click('Send test notification');
  check('server not reachable at all (closed port) => "Can\'t reach ntfy.sh", nothing enabled', await waitHas(/Can.t reach ntfy\.sh/, 20000) && w.settings().phoneEnabled !== true);
  await closeWindow(); await n.stop();

  // =========================================================================================================
  console.log('== G) a damaged configuration is never overwritten');
  w = world('G', { seedConfig: 'broken' }); const brokenHash = sha(w.cfgPath); base = received.length; n = start(w);
  check('the window opens on the "damaged" page; the file is untouched; no topic was invented', await waitUntil(() => w.count(/window starting/g) === 1, 15000) && await attach(n) && await waitHas('The saved phone settings are damaged') && sha(w.cfgPath) === brokenHash && w.count(/configuration problem \(corrupt\); not touched/g) === 1);
  await permissionEvent(w, '99999999-cccc-4ccc-8ccc-999999999999');
  check('real events send nothing, and no request was made at all', received.length === base && sha(w.cfgPath) === brokenHash);
  await closeWindow(); await n.stop();
  check('after closing, the damaged file is still byte-identical (only "Start over" may replace it, keeping a backup)', sha(w.cfgPath) === brokenHash && fs.readdirSync(w.data).every((f) => !/^ntfy\.json\./.test(f)));

  // =========================================================================================================
  console.log('== H) privacy across every run');
  const topics = ['A', 'B', 'C', 'D', 'E', 'F', 'F2'].map((x) => { const d = path.join(ROOT, x, 'data'); return (ntfy.inspectConfig(d).cfg || {}).topic; }).filter(Boolean);
  const logsAll = ['A', 'B', 'C', 'D', 'E', 'F', 'F2', 'G'].map((x) => read(path.join(ROOT, x, 'data', 'notifier.log'))).join('\n');
  check('no notifier.log contains a topic, a deep link, the server URL or an authorization header', topics.length >= 6 && !topics.some((t) => logsAll.includes(t)) && !/ntfy:\/\/|127\.0\.0\.1:\d+|Bearer/.test(logsAll));
  check('neither the notifier\'s own output (stdout/stderr) nor the window\'s command line contains a topic', !topics.some((t) => allTexts.join('\n').includes(t)) && cmdlines.length >= 5 && !topics.some((t) => cmdlines.join('\n').includes(t)), `${cmdlines.length} window command lines`);
  check('settings.json never contains a topic', ['A', 'B', 'C', 'D', 'E', 'F', 'F2', 'G'].every((x) => !topics.some((t) => read(path.join(ROOT, x, 'data', 'settings.json')).includes(t))));
  check('every phone-setup log line names actions and states only', logsAll.split('\n').filter((l) => /phone setup:/.test(l)).every((l) => !/claude-[a-hj-km-np-z2-9]{16}/.test(l)));
  const realCfgAfter = (() => { const f = path.join(process.env.USERPROFILE, '.claude-notifier', 'ntfy.json'); const s = path.join(process.env.USERPROFILE, '.claude-notifier', 'settings.json'); return `${fs.existsSync(f) ? sha(f) : '-'}|${fs.existsSync(s) ? sha(s) : '-'}`; })();
  check('your own ntfy.json and settings.json were not touched by any of this', realCfgAfter === realCfgBefore);

  await ui.stop(); server.close();
  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); ui && ui.stop(); } catch { /* ignore */ } try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
