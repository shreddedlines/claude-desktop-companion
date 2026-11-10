#!/usr/bin/env node
/**
 * test-step6.js — regression tests for the reliability pass (C1 lifecycle, C2 health, I1 CPU, I2 cooldown,
 * I3 unknown waiting, I4 phone failures, I6 lock, I7 Windows toasts, I8 privacy).
 * Uses temp folders, a local mock ntfy server and a throw-away registry key. A few tests briefly start the
 * real tray host (a tray icon flashes; no toast is shown).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ntfy = require('./ntfy');
const { Policy } = require('./policy');
const { HealthCanary } = require('./health');
const lock = require('./lock');
const autostart = require('./autostart');
const { runSupervisor } = require('./supervisor');

const results = []; let skipped = 0;
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}  — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'step6-'));
const P = __dirname;
const procs = new Set();
const track = (c) => { procs.add(c); c.on('exit', () => procs.delete(c)); return c; };
const killAll = () => { for (const c of procs) { try { c.kill(); } catch { /* gone */ } } };
async function waitFor(fn, ms = 8000, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(step); } return !!fn(); }
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();

// ---- borrowed live Desktop sessions (valid pid + procStart pairs) ----------------------------------------------------
const realDir = path.join(process.env.USERPROFILE, '.claude', 'sessions');
const pool = fs.readdirSync(realDir).filter((n) => /^\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(realDir, n), 'utf8')))
  .filter((j) => j.entrypoint === 'claude-desktop' && j.pid !== process.pid);
if (pool.length < 2) { console.error('need 2 live Desktop sessions to borrow pids'); process.exit(2); }
const explorerPid = Number(ps('(Get-Process explorer | Select -First 1).Id'));
const sessFile = (dir, real, o = {}) => fs.writeFileSync(path.join(dir, `${real.pid}.json`), JSON.stringify({ ...real, ...o }));

// ---- mock ntfy -----------------------------------------------------------------------------------------------------
const received = [];
const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { received.push({ body: JSON.parse(b), raw: b }); } catch { /* ignore */ } res.writeHead(200); res.end('{}'); }); });

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const URLBASE = `http://127.0.0.1:${server.address().port}`;

  // =========================================================================================================
  console.log('== I1 CPU: the expensive process lookup is out of the hot path');
  const wdir = path.join(root, 'w1'); fs.mkdirSync(wdir);
  const A = pool[0]; const B = pool[1];
  sessFile(wdir, A, { name: 'W-VALID' });
  fs.writeFileSync(path.join(wdir, `${explorerPid}.json`), JSON.stringify({ ...A, pid: explorerPid, name: 'W-REUSED-PID' }));
  fs.writeFileSync(path.join(wdir, `${B.pid}.json`), JSON.stringify({ ...B, name: 'W-WRONG-START', procStart: '134000000000000000' }));
  const runWatcher = (args, ms, onStart) => new Promise((resolve) => {
    const c = track(spawn(process.execPath, [path.join(P, 'watch-sessions.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] }));
    let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    if (onStart) onStart(c); c.on('exit', () => resolve({ out, err }));
    setTimeout(() => { try { c.kill(); } catch { /* done */ } }, ms + 6000);
  });
  let w = await runWatcher(['--dir', wdir, '--interval', '200', '--duration', '8', '--stats', '--heartbeat-ms', '2000'], 8000);
  const stat = (e) => { const m = /lookups=(\d+) cpuMs=(\d+)/.exec(e); return m ? { lookups: +m[1], cpuMs: +m[2] } : null; };
  let s1 = stat(w.err);
  check('valid session detected (INITIAL)', /W-VALID \| .*INITIAL: IDLE|W-VALID.*INITIAL/.test(w.out));
  check('reused PID (explorer.exe) still rejected as stale', /stale file ignored.*not a claude\.exe process \(pid reused\)/.test(w.out) || /stale file ignored.*pid reused/.test(w.out));
  check('wrong creation time (PID-reuse protection) still rejected', /stale file ignored.*creation time != procStart/.test(w.out));
  check('8 s with a reused-PID stale file present => at most 2 PowerShell lookups (no refresh storm)', s1 && s1.lookups <= 2, s1 ? `lookups=${s1.lookups}` : 'no stats');
  check('heartbeat line reports files/live/stale and numeric CLI + desktop process counts', /-- heartbeat: files=\d+ live=\d+ stale=\d+ cli=\d+ desktop=\d+ lookupAgeSec=\d+ --/.test(w.out));
  const wdir2 = path.join(root, 'w2'); fs.mkdirSync(wdir2); sessFile(wdir2, A, { name: 'W2-A' });
  w = await runWatcher(['--dir', wdir2, '--interval', '200', '--duration', '10', '--stats', '--heartbeat-ms', '0'], 10000, () => { setTimeout(() => sessFile(wdir2, B, { name: 'W2-NEW' }), 4000); });
  s1 = stat(w.err);
  check('a session that appears later is verified (one extra lookup) and reported as NEW SESSION', /W2-NEW.*NEW SESSION: IDLE|NEW SESSION.*W2-NEW|W2-NEW \| .*\]  NEW SESSION/.test(w.out) && s1 && s1.lookups === 2, s1 ? `lookups=${s1.lookups}` : '');

  // A/B CPU on the REAL sessions folder: old cadence (3 s re-verification) vs the new default (5 min)
  const PS_COST_MS = 725;   // measured: CPU of one cold PowerShell CIM lookup on this machine (calibrated, 5 runs, 672-725 ms)
  const win = 24;
  const [oldRun, newRun] = await Promise.all([
    runWatcher(['--duration', String(win), '--stats', '--verify-interval', '3000', '--heartbeat-ms', '0'], win * 1000),
    runWatcher(['--duration', String(win), '--stats', '--heartbeat-ms', '0'], win * 1000),
  ]);
  const so = stat(oldRun.err); const sn = stat(newRun.err);
  const pct = (s) => ((s.cpuMs + s.lookups * PS_COST_MS) / (win * 1000) * 100);
  const steady = (s) => (s.cpuMs / (win * 1000) + PS_COST_MS / 300000) * 100;   // after: the one-off lookup is amortised over the 5-min re-verify interval
  console.log(`      CPU over ${win} s on the real sessions folder: BEFORE-cadence lookups=${so && so.lookups} node=${so && so.cpuMs}ms => ~${so && pct(so).toFixed(1)}% of a core; AFTER lookups=${sn && sn.lookups} node=${sn && sn.cpuMs}ms => ~${sn && pct(sn).toFixed(1)}% in this short window incl. the one-off first lookup, ~${sn && steady(sn).toFixed(2)}% steady-state`);
  check('BEFORE-equivalent cadence really is expensive (>=5 lookups in the window, >5% of a core)', so && so.lookups >= 5 && pct(so) > 5, so ? `${so.lookups} lookups, ${pct(so).toFixed(1)}%` : '');
  check('AFTER: at most 1 lookup in the window (the first sight of the sessions)', sn && sn.lookups <= 1, sn ? `${sn.lookups}` : '');
  check('AFTER: steady-state CPU is negligible (< 2% of a core incl. the amortised lookup) and < 15% of the old cost', sn && steady(sn) < 2 && steady(sn) < pct(so) * 0.15, sn ? `${steady(sn).toFixed(2)}% vs ${pct(so).toFixed(1)}% before` : '');

  // =========================================================================================================
  console.log('== I2 cooldown: a distinct prompt must never be swallowed');
  let clock = 3_000_000_000_000; const settings = { notificationsEnabled: true, soundsEnabled: true };
  const mkPol = () => new Policy({ getSettings: () => settings, now: () => clock });
  const E = (type, extra = {}) => ({ type, session: 'Fix login page', project: 'alpha', sessionId: 'local_a', pid: 1, details: '', epoch: clock, source: 'x', ...extra });
  const toasts = (r) => r.actions.filter((a) => a.kind === 'toast');
  let pol = mkPol(); let r1 = pol.handle(E('WAITING_FOR_PERMISSION', { details: 'tool=Bash request=aaaa1111' }));
  clock += 800; pol.handle(E('WORKING')); clock += 900;                       // answered 0.8 s later; the next prompt arrives 1.7 s after the first
  let r2 = pol.handle(E('WAITING_FOR_PERMISSION', { details: 'tool=Edit request=bbbb2222' }));
  check('prompt, answer, NEW prompt 1.7 s later (inside the 4 s cooldown) => BOTH notify', toasts(r1).length === 1 && toasts(r2).length === 1, `${r2.reason}`);
  pol = mkPol(); r1 = pol.handle(E('WAITING_FOR_PERMISSION', { details: 'request=aaaa1111' })); clock += 500; r2 = pol.handle(E('WAITING_FOR_PERMISSION', { details: 'request=bbbb2222' }));
  check('two DISTINCT pending prompts (different request ids, nothing answered) => both notify, separate toasts', toasts(r2).length === 1 && toasts(r1)[0].tag !== toasts(r2)[0].tag);
  pol = mkPol(); pol.handle(E('WAITING_FOR_PERMISSION', { details: 'request=aaaa1111' })); clock += 500; r2 = pol.handle(E('WAITING_FOR_PERMISSION', { details: 'request=aaaa1111' }));
  check('the SAME request id again within the cooldown => still suppressed (duplicate protection kept)', toasts(r2).length === 0 && r2.reason === 'cooldown');
  pol = mkPol(); pol.handle(E('WAITING_FOR_USER')); clock += 500; r2 = pol.handle(E('WAITING_FOR_USER'));
  check('identical event without ids, nothing resolved in between => suppressed (duplicate)', toasts(r2).length === 0 && r2.reason === 'cooldown');
  pol = mkPol(); pol.handle(E('WAITING_FOR_USER')); clock += 300; pol.handle(E('WORKING')); clock += 300; r2 = pol.handle(E('WAITING_FOR_USER'));
  check('file-only prompts (no ids): answer between them clears the cooldown => second notifies', toasts(r2).length === 1);
  pol = mkPol(); pol.handle(E('API_ERROR', { details: 'x' })); clock += 500; r2 = pol.handle(E('API_ERROR', { details: 'x' }));
  check('non-prompt events keep the original cooldown (API_ERROR twice in 0.5 s => one)', toasts(r2).length === 0);

  const sent = []; let dclock = 3_100_000_000_000; const cfgOn = { ...ntfy.DEFAULT_CONFIG, topic: 'tt_123', server: 'http://127.0.0.1:1' };
  const mkDisp = (o = {}) => new ntfy.PhoneDispatcher({ getConfig: () => cfgOn, getEnabled: () => true, sender: async (c, b) => { sent.push(b); return { ok: true }; }, now: () => dclock, ...o });
  const DE = (type, extra = {}) => E(type, { epoch: dclock, ...extra });
  let d = mkDisp(); sent.length = 0;
  d.handle(DE('WAITING_FOR_PERMISSION', { details: 'request=aaaa1111' })); dclock += 800; d.handle(DE('WORKING')); dclock += 900; d.handle(DE('WAITING_FOR_PERMISSION', { details: 'request=bbbb2222' })); await sleep(20);
  check('phone: prompt, answer, new prompt 1.7 s later (inside the 10 s cooldown) => BOTH pushed', sent.length === 2);
  d = mkDisp(); sent.length = 0; d.handle(DE('WAITING_FOR_PERMISSION', { details: 'request=aaaa1111' })); dclock += 300; d.handle(DE('WAITING_FOR_PERMISSION', { details: 'request=bbbb2222' })); await sleep(20);
  check('phone: two distinct pending prompts => both pushed', sent.length === 2);
  d = mkDisp(); sent.length = 0; d.handle(DE('WAITING_FOR_PERMISSION', { details: 'request=aaaa1111' })); await sleep(20); dclock += 300; d.handle(DE('WAITING_FOR_PERMISSION', { details: 'request=aaaa1111' })); await sleep(20);
  check('phone: the same request id twice => ONE push', sent.length === 1);

  // =========================================================================================================
  console.log('== I3 unknown waiting reasons');
  pol = mkPol(); let ru = pol.handle(E('WAITING_UNKNOWN', { details: 'from WORKING; waitingFor="dialog open"' }));
  check('unknown reason => persistent "Claude needs your attention" with project, session and the (safe) reason', toasts(ru).length === 1 && toasts(ru)[0].persistent && toasts(ru)[0].title === 'Claude needs your attention' && /alpha/.test(toasts(ru)[0].lines[0]) && toasts(ru)[0].lines.includes('Reason: dialog open') && toasts(ru)[0].sound === 'input');
  pol = mkPol(); ru = pol.handle(E('WAITING_UNKNOWN', { details: 'from WORKING; waitingFor=null' }));
  check('missing waitingFor => generic notification, no reason line', toasts(ru).length === 1 && toasts(ru)[0].lines.length === 1);
  pol = mkPol(); ru = pol.handle(E('WAITING_UNKNOWN', { details: 'waitingFor="<script>x</script> \\n secret=abc and a very very long unexpected explanation text here"' }));
  check('a weird/long reason string is never echoed into the notification', toasts(ru).length === 1 && toasts(ru)[0].lines.every((l) => !/script|secret/.test(l)) && toasts(ru)[0].lines.length === 1);
  pol = mkPol(); const tag = toasts(pol.handle(E('WAITING_UNKNOWN', { details: 'waitingFor="dialog open"' })))[0].tag; clock += 500;
  const rr = pol.handle(E('WORKING')); check('resuming retracts the unknown-waiting toast', rr.actions.some((a) => a.kind === 'retract' && a.tags.includes(tag)));
  pol = mkPol(); const k1 = toasts(pol.handle(E('WAITING_FOR_USER', { details: 'tool=AskUserQuestion request=11112222' })))[0]; const k2 = toasts(mkPol().handle(E('WAITING_FOR_PERMISSION', { details: 'tool=Bash request=33334444' })))[0];
  check('known reasons keep their specialised messages', k1.title === 'Claude needs your input' && k2.title === 'Claude needs permission' && k2.lines.includes('Tool: Bash'));
  const pm = ntfy.buildMessage(E('WAITING_UNKNOWN', { details: 'waitingFor="dialog open"', epoch: Date.now() }), cfgOn);
  check('phone: unknown waiting => "Claude needs your attention", priority 4, safe reason line, allowlisted keys', pm && pm.title === 'Claude needs your attention' && pm.priority === 4 && /Reason: dialog open/.test(pm.message) && JSON.stringify(Object.keys(pm).sort()) === JSON.stringify(['message', 'priority', 'tags', 'title', 'topic']));
  check('phone: an unsafe reason is dropped from the payload', !/Reason/.test(ntfy.buildMessage(E('WAITING_UNKNOWN', { details: 'waitingFor="a\\nb <x>"', epoch: Date.now() }), cfgOn).message));

  // =========================================================================================================
  console.log('== I4 phone failures (tray + Windows notice; no aggressive retry; cooldown not consumed by a failure)');
  let okMode = false; const st = []; let calls = 0;
  dclock = 3_200_000_000_000;
  d = new ntfy.PhoneDispatcher({ getConfig: () => cfgOn, getEnabled: () => true, now: () => dclock, sender: async () => { calls++; return okMode ? { ok: true, status: 200 } : { ok: false, error: 'timeout' }; }, onStatus: (s, tr) => st.push({ ...s, tr }) });
  d.handle(DE('API_ERROR', { sessionId: 'local_a', details: 'one' })); await sleep(20); dclock += 1000;
  d.handle(DE('API_ERROR', { sessionId: 'local_a', details: 'two' })); await sleep(20);
  check('a FAILED push does not consume the cooldown: the next identical event 1 s later is attempted again', calls === 2, `sender called ${calls}x`);
  check('after 2 failures: not "failing" yet (threshold 3)', st[1].failStreak === 2 && !st[1].failing);
  d.handle(DE('PROCESS_EXITED_ERROR', { sessionId: 'local_b', details: 'exit code 1' })); await sleep(20);
  check('3 failures in a row => failing, flagged ONCE (becameFailing) with the last error', st[2].failing && st[2].tr.becameFailing && st[2].lastError === 'timeout');
  dclock += 20000; d.handle(DE('SESSION_LIMIT', { sessionId: 'local_c', details: 'x' })); await sleep(20);
  check('4th failure keeps failing but does not re-announce', st[3].failing && !st[3].tr.becameFailing);
  okMode = true; dclock += 20000; d.handle(DE('API_ERROR', { sessionId: 'local_d', details: 'ok' })); await sleep(20);
  check('a server-accepted push clears the failing state (recovered)', !st[4].failing && st[4].tr.recovered && st[4].lastOkAt > 0);
  const callsBefore = calls; dclock += 1000; d.handle(DE('API_ERROR', { sessionId: 'local_d', details: 'ok' })); await sleep(20);
  check('after a SUCCESS the cooldown applies again (duplicate suppressed)', calls === callsBefore);
  { let line = ''; const dd = mkDisp({ log: (m) => { line += m; } }); dd.handle(DE('API_ERROR', { sessionId: 'local_f', details: 'x' })); await sleep(20); check('log line says server acceptance is not phone delivery', /phone delivery not confirmed/.test(line), line); }

  // =========================================================================================================
  console.log('== I6 lock: stale PID / PID reuse / identity');
  const lf = path.join(root, 'test.lock'); const bootMs = Date.now() - os.uptime() * 1000;
  check('no lock file => acquire', lock.checkLock({ file: path.join(root, 'none.lock') }).acquire);
  fs.writeFileSync(lf, 'garbage'); check('corrupt lock => recovered, with a reason', (() => { const x = lock.checkLock({ file: lf }); return x.acquire && /corrupt|recovered/.test(x.reason); })());
  fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, startMs: lock.selfStartMs() })); check('our own lock => acquire', lock.checkLock({ file: lf }).acquire);
  let deadPid = 60000; const aliveNow = (id) => { try { process.kill(id, 0); return true; } catch (e) { return e.code === 'EPERM'; } }; while (aliveNow(deadPid)) deadPid++;
  fs.writeFileSync(lf, JSON.stringify({ pid: deadPid, startMs: Date.now() - 1000 })); let dd1 = lock.checkLock({ file: lf });
  check('dead owner PID => stale lock recovered ("not running" logged)', dd1.acquire && /not running/.test(dd1.reason), dd1.reason);
  const kid = track(spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' })); await sleep(700);
  const kidStart = lock.processStartMs(kid.pid);
  check('processStartMs reads another process\'s real start time', kidStart && Math.abs(kidStart - Date.now()) < 20000);
  const selfStart = lock.processStartMs(process.pid);
  check('our recorded start time matches Windows\' own value (±3 s)', selfStart && Math.abs(selfStart - lock.selfStartMs()) < 3000, `${selfStart - lock.selfStartMs()} ms`);
  fs.writeFileSync(lf, JSON.stringify({ pid: kid.pid, startMs: kidStart })); dd1 = lock.checkLock({ file: lf });
  check('a genuinely running owner (PID + start time match) => refuse, reason logged', !dd1.acquire && /already running/.test(dd1.reason), dd1.reason);
  fs.writeFileSync(lf, JSON.stringify({ pid: kid.pid, startMs: kidStart - 3000 })); check('...3 s of clock jitter is tolerated', !lock.checkLock({ file: lf }).acquire);
  fs.writeFileSync(lf, JSON.stringify({ pid: kid.pid, startMs: kidStart - 60000 })); dd1 = lock.checkLock({ file: lf });
  check('PID REUSE: PID alive but it started at a different time than the lock says => recovered', dd1.acquire && /PID reuse/.test(dd1.reason), dd1.reason);
  fs.writeFileSync(lf, JSON.stringify({ pid: explorerPid, startMs: Date.now() - 30000 })); dd1 = lock.checkLock({ file: lf });
  check('PID REUSE by a real other program (explorer.exe) => recovered', dd1.acquire && /PID reuse/.test(dd1.reason), dd1.reason);
  fs.writeFileSync(lf, JSON.stringify({ pid: kid.pid, startMs: bootMs - 86400000 })); dd1 = lock.checkLock({ file: lf });
  check('lock written before the last boot => recovered without any process lookup', dd1.acquire && /before the last system boot/.test(dd1.reason), dd1.reason);
  fs.writeFileSync(lf, String(kid.pid)); dd1 = lock.checkLock({ file: lf });
  check('LEGACY plain-PID lock of a running owner => refuse (legacy noted)', !dd1.acquire && /legacy/.test(dd1.reason), dd1.reason);
  fs.writeFileSync(lf, String(kid.pid)); const hourAgo = new Date(Date.now() - 3600_000); fs.utimesSync(lf, hourAgo, hourAgo); dd1 = lock.checkLock({ file: lf });
  check('LEGACY lock + PID started AFTER the lock was written (reuse) => recovered', dd1.acquire && /PID reuse \(legacy/.test(dd1.reason), dd1.reason);
  fs.writeFileSync(lf, JSON.stringify({ pid: kid.pid, startMs: Date.now() - 1000 }));
  dd1 = lock.checkLock({ file: lf, startOf: () => null, imageOf: () => 'explorer.exe' });
  check('start time unreadable + image is not node.exe => recovered', dd1.acquire && /not a Node process/.test(dd1.reason), dd1.reason);
  dd1 = lock.checkLock({ file: lf, startOf: () => null, imageOf: () => 'node.exe' });
  check('start time unreadable + node.exe => refuses, but the reason is explicit (never silent)', !dd1.acquire && /could not be verified/.test(dd1.reason) && /delete the lock file/.test(dd1.reason), dd1.reason);
  try { kid.kill(); } catch { /* done */ }

  // notifier-level lock behaviour (real processes)
  const ldata = path.join(root, 'lockdata'); const lsess = path.join(root, 'lsess'); const llog = path.join(root, 'llog'); fs.mkdirSync(lsess); fs.mkdirSync(llog); fs.writeFileSync(path.join(llog, 'main.log'), '');
  const nargs = ['--ui', 'none', '--no-usage', '--data-dir', ldata, '--sessions-dir', lsess, '--log-dir', llog, '--interval', '500'];
  const startN = (extra = [], env = {}) => { const c = track(spawn(process.execPath, [path.join(P, 'notifier.js'), ...nargs, ...extra], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })); c.out = ''; c.err = ''; c.stdout.on('data', (x) => { c.out += x; }); c.stderr.on('data', (x) => { c.err += x; }); c.exited = null; c.on('exit', (code) => { c.exited = code; }); return c; };
  const logText = () => { try { return fs.readFileSync(path.join(ldata, 'notifier.log'), 'utf8'); } catch { return ''; } };
  const n1 = startN(); await waitFor(() => /started pid=/.test(logText()), 8000);
  const n2 = startN(); await waitFor(() => n2.exited !== null, 20000);
  check('a second instance refuses with exit code 0 and tells the user why (stdout + log)', n2.exited === 0 && /not started: already running/.test(n2.out) && /startup refused: already running/.test(logText()), n2.out.trim().slice(0, 120));
  n1.kill(); await waitFor(() => n1.exited !== null, 5000);
  check('(setup) the first instance was killed hard and left its lock behind', fs.existsSync(path.join(ldata, 'notifier.lock')));
  const n3 = startN(); await waitFor(() => /lock: stale lock/.test(logText()), 20000); await sleep(1500);
  check('start-up after a crash RECOVERS the stale lock, logs the reason, and keeps running', /lock: stale lock: owner process \d+ is not running \(recovered\)/.test(logText()) && n3.exited === null);
  n3.kill(); await waitFor(() => n3.exited !== null, 5000);

  // =========================================================================================================
  console.log('== C2 health canary: real blindness yes, idle/closed no');
  let hc = 4_000_000_000_000; const mkHc = (o = {}) => new HealthCanary({ now: () => hc, startedAt: hc, graceMs: 60_000, blindMs: 60_000, stallMs: 90_000, ...o });
  const HB = (h) => ({ type: 'HEARTBEAT', health: { files: 0, live: 0, stale: 0, cli: 0, desktop: 0, watcherAgeMs: 1000, ...h } });
  const advance = (c, sec, hb, step = 5) => { const evs = []; for (let t = 0; t < sec; t += step) { hc += step * 1000; if (hb) c.onHeartbeat(HB(hb)); evs.push(...c.evaluate().events); } return evs; };
  let c = mkHc(); let ev = advance(c, 6 * 3600, { cli: 4, live: 4, files: 4 }, 30);
  check('Claude IDLE for 6 hours (sessions visible, no events at all) => no warning', ev.length === 0 && c.status().ok);
  c = mkHc(); ev = advance(c, 3 * 3600, { cli: 0, live: 0, desktop: 0 }, 30);
  check('Claude CLOSED (no processes, no sessions) => no warning', ev.length === 0 && c.status().ok);
  c = mkHc(); ev = advance(c, 55, { cli: 3, live: 0 });
  check('CLI processes but no visible sessions during the start-up grace period => no warning yet', ev.length === 0);
  ev = advance(c, 120, { cli: 3, live: 0 });
  check('...sustained past grace + blind window => exactly ONE HEALTH_WARNING with an actionable message', ev.length === 1 && ev[0].type === 'HEALTH_WARNING' && /no sessions are visible/.test(ev[0].noticeLines[0]) && /Restart Claude Notifier/.test(ev[0].noticeLines[1]), ev[0] && ev[0].noticeLines.join(' | '));
  check('tray status shows the problem and what to do', !c.status().ok && /no sessions are visible/.test(c.status().text) && /Restart/.test(c.status().hint));
  ev = advance(c, 600, { cli: 3, live: 0 }); check('...no second toast while the same problem persists', ev.length === 0);
  ev = advance(c, 10, { cli: 3, live: 2 }); check('...sessions visible again => ONE HEALTH_CLEARED and the tray is clean', ev.length === 1 && ev[0].type === 'HEALTH_CLEARED' && c.status().ok);
  c = mkHc(); advance(c, 70, { cli: 3, live: 2 }); ev = advance(c, 40, { cli: 3, live: 0 }); ev.push(...advance(c, 30, { cli: 3, live: 2 }));
  check('a 40 s transient (sessions flicker) never warns', ev.length === 0);
  c = mkHc(); advance(c, 70, { cli: 2, live: 2 }); advance(c, 30, { cli: 2, live: 0 }); hc += 2 * 3600 * 1000; ev = c.evaluate().events; ev.push(...advance(c, 30, { cli: 2, live: 0 }));
  check('after a sleep/resume (2 h gap) the condition timers restart: no instant false alarm', ev.length === 0);
  c = mkHc({ limit: 4 }); const FE = (t, src) => ({ type: t, source: src });
  for (let i = 0; i < 3; i++) c.onEvent(FE('TURN_FINISHED', 'session-file')); ev = advance(c, 10, { cli: 1, live: 1 });
  check('3 session-file events without any matching log line => no warning yet', ev.length === 0);
  c.onEvent(FE('WAITING_FOR_PERMISSION', 'session-file')); ev = advance(c, 10, { cli: 1, live: 1 });
  check('4th in a row => LOG_BLIND warning ("log lines not matched"), once', ev.length === 1 && /log lines are not being matched/.test(ev[0].noticeLines[0]));
  c.onEvent(FE('TURN_FINISHED', 'session-file+main.log')); ev = advance(c, 10, { cli: 1, live: 1 });
  check('a corroborated event resets the counter and clears the warning', ev.length === 1 && ev[0].type === 'HEALTH_CLEARED');
  c = mkHc(); for (let i = 0; i < 6; i++) { c.onEvent(FE('WORKING', 'session-file')); c.onEvent(FE('API_ERROR', 'main.log')); } ev = advance(c, 10, { cli: 1, live: 1 });
  check('WORKING / API_ERROR (not correlated types) never count towards LOG_BLIND', ev.length === 0);
  c = mkHc({ limit: 4 }); for (let i = 0; i < 4; i++) c.onEvent(FE('TURN_FINISHED', 'main.log')); ev = advance(c, 10, { cli: 1, live: 1 });
  check('4 log-only events in a row => FILES_BLIND warning', ev.length === 1 && /status files are not changing/.test(ev[0].noticeLines[0]));
  c = mkHc(); advance(c, 100, { cli: 1, live: 1 }); ev = advance(c, 120, null);
  check('event-stream heartbeat missing > 90 s => STREAM_STALLED warning + stalled flag', ev.length === 1 && /event stream stopped/.test(ev[0].noticeLines[0]) && c.evaluate().stalled);
  c = mkHc({ renotifyMs: 30 * 60_000 }); advance(c, 70, { cli: 2, live: 0 }); ev = advance(c, 120, { cli: 2, live: 0 }); advance(c, 10, { cli: 2, live: 1 }); advance(c, 70, { cli: 2, live: 0 });
  ev = advance(c, 120, { cli: 2, live: 0 });
  check('re-occurrence within 30 min: tray shows it again but NO second toast', ev.length === 0 && !c.status().ok);
  check('health warnings are never pushed to the phone (no ntfy type, nothing sent)', ntfy.buildMessage({ type: 'HEALTH_WARNING', noticeLines: ['x'] }, cfgOn) === null && ntfy.buildMessage({ type: 'PHONE_FAILING', noticeLines: ['x'] }, cfgOn) === null);
  pol = mkPol(); const hw = pol.handle({ type: 'HEALTH_WARNING', session: 'Claude Notifier', project: '?', sessionId: 'health:warning', epoch: clock, noticeLines: ['Claude is running, but no sessions are visible', 'Restart Claude Notifier.'] });
  check('policy turns HEALTH_WARNING into ONE Windows toast with the summary and the action', toasts(hw).length === 1 && toasts(hw)[0].title === 'Claude Notifier health warning' && toasts(hw)[0].lines.length === 2);

  // =========================================================================================================
  console.log('== I8 privacy: session title off by default for the phone');
  const cdir = path.join(root, 'cfgs'); fs.mkdirSync(cdir);
  const wcfg = (o) => fs.writeFileSync(path.join(cdir, 'ntfy.json'), JSON.stringify({ server: 'https://ntfy.sh', topic: 'abc123_x', ...o }));
  const msg = (cfg, type = 'TURN_FINISHED') => ntfy.buildMessage(E(type, { epoch: Date.now(), details: 'tool=Bash request=1' }), cfg);
  wcfg({}); let lc = ntfy.loadConfig(cdir);
  check('a new/default config does not include the session title', lc.includeSessionTitle === false && !/Fix login page/.test(msg(lc).message));
  wcfg({ includeSessionTitle: true }); lc = ntfy.loadConfig(cdir);
  check('a LEGACY config (explicit true, no configVersion) is treated as opted OUT, and flagged for the log', lc.includeSessionTitle === false && lc.titleMigrated === true && !/Fix login page/.test(msg(lc).message));
  wcfg({ configVersion: 2, includeSessionTitle: true }); lc = ntfy.loadConfig(cdir);
  check('explicit opt-in (configVersion 2 + true) includes it', lc.includeSessionTitle === true && /alpha \u2014 Fix login page/.test(msg(lc).message));
  const types = ['TURN_FINISHED', 'WAITING_FOR_USER', 'WAITING_FOR_PERMISSION', 'WAITING_UNKNOWN', 'API_ERROR', 'SESSION_LIMIT', 'PROCESS_EXITED_ERROR'];
  wcfg({}); lc = ntfy.loadConfig(cdir);
  check('default config: NO phone payload for any event type contains the session title', types.every((t) => { const m = msg(lc, t); return m && !/Fix login page/.test(JSON.stringify(m)); }));
  check('payloads are metadata only: allowlisted keys, project folder + type + time, no paths/ids/hosts', types.every((t) => { const m = msg(lc, t); return JSON.stringify(Object.keys(m).sort()) === JSON.stringify(['message', 'priority', 'tags', 'title', 'topic']) && !/[A-Z]:\\|local_|127\.0\.0\.1/.test(JSON.stringify(m)); }));
  pol = mkPol(); const wt = toasts(pol.handle(E('WAITING_FOR_USER', { details: 'request=aaaa9999' })))[0];
  check('Windows notifications still show the session context', /alpha \u2014 Fix login page/.test(wt.lines[0]));
  check('ntfy-init writes configVersion 2 with the privacy default', (() => { const tmp = path.join(root, 'init'); const r = ntfy.initConfig(tmp, {}); return r.cfg.configVersion === 2 && r.cfg.includeSessionTitle === false && JSON.parse(fs.readFileSync(path.join(tmp, 'ntfy.json'), 'utf8')).includeSessionTitle === false; })());

  // =========================================================================================================
  console.log('== C1 lifecycle: supervisor, restart budget, clean shutdown, autostart');
  const fake = path.join(root, 'fake-child.js');
  fs.writeFileSync(fake, `const fs=require('fs');const a=process.argv.slice(2);const get=(k,d)=>{const i=a.indexOf(k);return i>=0?a[i+1]:d};
const plan=get('--plan','0').split(',').map(Number);const f=get('--state');let n=0;try{n=Number(fs.readFileSync(f,'utf8'))}catch{};fs.writeFileSync(f,String(n+1));
const code=plan[Math.min(n,plan.length-1)];const sl=n===0&&get('--sleep-first')!==undefined?Number(get('--sleep-first')):Number(get('--sleep','0'));setTimeout(()=>process.exit(code),sl);`);
  let supN = 0;
  const sup = (plan, o = {}, sleepMs = 0, sleepFirst = null) => { supN++; const st = path.join(root, `runs${supN}.txt`); const lg = path.join(root, `sup${supN}.log`); let gave = null;
    const h = runSupervisor({ script: fake, args: ['--plan', plan, '--state', st, '--sleep', String(sleepMs), ...(sleepFirst !== null ? ['--sleep-first', String(sleepFirst)] : [])], logFile: lg, backoffMs: 40, maxBackoffMs: 160, windowMs: 20000, maxRestarts: 5, onGiveUp: (x) => { gave = x; }, ...o });
    return { h, runs: () => { try { return Number(fs.readFileSync(st, 'utf8')); } catch { return 0; } }, log: () => { try { return fs.readFileSync(lg, 'utf8'); } catch { return ''; } }, gave: () => gave }; };
  let s = sup('0'); let res = await s.h.done;
  check('CLEAN exit (code 0) => supervisor stops, NO restart', res.reason === 'clean exit' && s.runs() === 1 && res.restarts === 0 && /not restarting/.test(s.log()));
  s = sup('3,3,0'); res = await s.h.done;
  check('crash, crash, then clean => exactly 2 restarts, logged with exit codes, then stops', s.runs() === 3 && res.restarts === 2 && (s.log().match(/exited with code 3/g) || []).length === 2 && /clean exit/.test(res.reason));
  s = sup('9', { maxRestarts: 3 }); res = await s.h.done;
  check('a notifier that ALWAYS crashes => bounded: 3 restarts then give-up (no infinite loop)', s.runs() === 4 && res.restarts === 3 && res.reason === 'restart budget exhausted' && res.exitCode === 1);
  check('give-up is announced once (Windows notice hook) and logged', s.gave() && s.gave().failures === 4 && /giving up/.test(s.log()));
  s = sup('9', { maxRestarts: 1, windowMs: 300 }, 450); await sleep(2600); s.h.stop(); res = await s.h.done;
  check('crashes spaced further apart than the window never exhaust the budget (healthy runs reset it)', s.runs() >= 4 && !s.gave() && res.reason === 'stop requested', `runs=${s.runs()}`);
  s = sup('0', {}, 60000); await sleep(600); s.h.stop(); res = await s.h.done; const runsAfterStop = s.runs(); await sleep(400);
  check('stop() kills the child and does NOT restart it', res.reason === 'stop requested' && runsAfterStop === 1 && s.runs() === 1 && res.restarts === 0);
  s = sup('0', {}, 0, 60000); await sleep(600); const m = /pid=(\d+)/.exec(s.log()); try { process.kill(Number(m[1])); } catch { /* gone */ } await s.h.done;
  check('a child killed from outside (signal/terminate) is treated as a crash and restarted', s.runs() === 2 && /unexpected/.test(s.log()));

  // real notifier under the supervisor
  const rdata = path.join(root, 'rdata'); const rsess = path.join(root, 'rsess'); const rlog = path.join(root, 'rlog'); fs.mkdirSync(rsess); fs.mkdirSync(rlog); fs.writeFileSync(path.join(rlog, 'main.log'), '');
  const nbase = ['--ui', 'none', '--no-lock', '--no-usage', '--data-dir', rdata, '--sessions-dir', rsess, '--log-dir', rlog, '--interval', '500'];
  process.env.NOTIFIER_TEST_CRASH_MS = '1500';
  const sr = runSupervisor({ script: path.join(P, 'notifier.js'), args: nbase, logFile: path.join(rdata.replace(/rdata$/, ''), 'rsup.log'), backoffMs: 300, maxBackoffMs: 600 });
  delete process.env.NOTIFIER_TEST_CRASH_MS;
  const nlog = () => { try { return fs.readFileSync(path.join(rdata, 'notifier.log'), 'utf8'); } catch { return ''; } };
  await waitFor(() => (nlog().match(/startup: pid=/g) || []).length >= 2, 15000); await sleep(1500);
  const slog = fs.readFileSync(path.join(root, 'rsup.log'), 'utf8');
  check('REAL notifier crash (uncaught exception) is written to the log with its stack', /CRASH uncaughtException: Error: test crash/.test(nlog()) && /process exit code=70/.test(nlog()));
  check('...the supervisor logs the exit code and RESTARTS it; the new instance starts and keeps running', /exited with code 70/.test(slog) && /restart 1\/5/.test(slog) && (nlog().match(/startup: pid=/g) || []).length === 2);
  sr.stop(); const rres = await sr.done; check('...and stopping the supervisor afterwards is clean (no further restart)', rres.reason === 'stop requested' && rres.restarts === 1);
  const cdata = path.join(root, 'cdata'); const csr = runSupervisor({ script: path.join(P, 'notifier.js'), args: ['--ui', 'none', '--no-lock', '--no-usage', '--data-dir', cdata, '--sessions-dir', rsess, '--log-dir', rlog, '--interval', '500', '--duration', '3'], logFile: path.join(root, 'csup.log') });
  const cres = await csr.done; const clog = fs.readFileSync(path.join(cdata, 'notifier.log'), 'utf8');
  check('CLEAN shutdown under the supervisor (notifier exits 0): logged with its reason, NOT restarted', cres.reason === 'clean exit' && cres.restarts === 0 && /shutting down: duration elapsed \(exit code 0\)/.test(clog) && (clog.match(/startup: pid=/g) || []).length === 1);
  const ex = startN(['--control-stdin'], {}); const edata = ldata; await waitFor(() => (logText().match(/started pid=/g) || []).length >= 3, 20000); await sleep(1200);
  ex.stdin.write('exit\n'); await waitFor(() => ex.exited !== null, 8000);
  check('tray "Exit" => exit code 0 with the reason logged (so a supervisor never restarts it)', ex.exited === 0 && /shutting down: user chose Exit in the tray menu \(exit code 0\)/.test(fs.readFileSync(path.join(edata, 'notifier.log'), 'utf8')));

  // real tray host dying
  const tdata = path.join(root, 'tdata');
  const tsr = runSupervisor({ script: path.join(P, 'notifier.js'), args: ['--no-lock', '--no-usage', '--data-dir', tdata, '--sessions-dir', rsess, '--log-dir', rlog, '--interval', '500'], logFile: path.join(root, 'tsup.log'), backoffMs: 300 });
  const tlog = () => { try { return fs.readFileSync(path.join(tdata, 'notifier.log'), 'utf8'); } catch { return ''; } };
  const hostPids = () => ps("Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*ui-host.ps1*' } | Where-Object { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.ParentProcessId)\"; $p -and $p.CommandLine -like '*tdata*' } | ForEach-Object { $_.ProcessId }").split(/\s+/).filter(Boolean);
  await waitFor(() => /ui ready/.test(tlog()), 25000); const hosts1 = hostPids();
  hosts1.forEach((id) => { try { process.kill(Number(id)); } catch { /* gone */ } });
  await waitFor(() => (tlog().match(/ui ready/g) || []).length >= 2, 30000); await sleep(1000);
  const tslog = fs.readFileSync(path.join(root, 'tsup.log'), 'utf8');
  check('REAL tray host killed => notifier logs it and exits non-zero (tray host died, exit code 1)', hosts1.length >= 1 && /tray host exited unexpectedly/.test(tlog()) && /shutting down: tray host died \(exit code 1\)/.test(tlog()));
  check('...the supervisor restarts the app and a NEW tray host comes up', /exited with code 1/.test(tslog) && (tlog().match(/ui ready/g) || []).length >= 2 && hostPids().length >= 1);
  tsr.stop(); await tsr.done; hostPids().forEach((id) => { try { process.kill(Number(id)); } catch { /* gone */ } });

  // autostart (throw-away registry key, never the real Run key)
  const tkey = `HKCU\\Software\\ClaudeNotifierTest_${process.pid}`; const tval = 'ClaudeNotifierTest';
  check('autostart starts disabled in a fresh key', !autostart.status({ key: tkey, value: tval }).enabled);
  const en = autostart.enable({ key: tkey, value: tval }); const sa = autostart.status({ key: tkey, value: tval });
  check('enable writes ONE per-user value that launches the hidden launcher (wscript + Claude-Notifier.vbs)', en.ok && sa.enabled && /wscript\.exe/i.test(sa.command) && /Claude-Notifier\.vbs/.test(sa.command), sa.command);
  check('the launcher starts the SUPERVISOR (watchdog), not the bare notifier', /supervisor\.js/.test(fs.readFileSync(path.join(P, 'Claude-Notifier.vbs'), 'utf8')));
  const cli = (a) => execFileSync(process.execPath, [path.join(P, 'notifier.js'), ...a, '--autostart-key', tkey, '--autostart-value', tval, '--data-dir', path.join(root, 'cli')], { encoding: 'utf8' });
  check('CLI --autostart-status / --autostart-disable work', /ENABLED/.test(cli(['--autostart-status'])) && /DISABLED/.test(cli(['--autostart-disable'])) && /disabled/.test(cli(['--autostart-status'])));
  autostart.disable({ key: tkey, value: tval }); try { execFileSync('reg.exe', ['delete', tkey, '/f'], { stdio: 'ignore' }); } catch { /* none */ }
  check('disable is idempotent and the throw-away key is gone', autostart.disable({ key: tkey, value: tval }).ok);

  // =========================================================================================================
  console.log('== end-to-end through the real notifier (--ui none): I2 + I3 + I8 + I7');
  const D = path.join(root, 'e2e'); const SS = path.join(root, 'e2e-s'); const LL = path.join(root, 'e2e-l'); fs.mkdirSync(D); fs.mkdirSync(SS); fs.mkdirSync(LL);
  const MAIN = path.join(LL, 'main.log'); fs.writeFileSync(MAIN, '');
  fs.writeFileSync(path.join(D, 'ntfy.json'), JSON.stringify({ server: URLBASE, topic: 'e2e_topic_6' })); fs.writeFileSync(path.join(D, 'settings.json'), JSON.stringify({ phoneEnabled: true }));
  const HA = 'local_aaaaaaaa-0000-4000-8000-000000000001';
  const setS = (status, wf) => { const o = { ...A, name: 'SYN-A', cwd: 'D:\\syn\\alpha', hostSessionId: HA, status, statusUpdatedAt: Date.now() }; delete o.waitingFor; if (wf) o.waitingFor = wf; fs.writeFileSync(path.join(SS, `${A.pid}.json`), JSON.stringify(o)); };
  const pad = (n) => String(n).padStart(2, '0'); const stampNow = () => { const x = new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`; };
  const appendReq = (id, tool = 'Bash') => fs.appendFileSync(MAIN, `${stampNow()} [info] Emitted tool permission request ${id} for ${tool} in session ${HA}\n`);
  setS('idle');
  const acts = []; const menus = []; let ob = ''; let err6 = '';
  const e2e = track(spawn(process.execPath, [path.join(P, 'notifier.js'), '--ui', 'none', '--no-lock', '--no-usage', '--control-stdin', '--dump-menu', '--data-dir', D, '--sessions-dir', SS, '--log-dir', LL, '--interval', '200', '--hold', '700', '--hb-ms', '1000'], { stdio: ['pipe', 'pipe', 'pipe'] }));
  e2e.stdout.on('data', (x) => { ob += x; let i; while ((i = ob.indexOf('\n')) >= 0) { try { const o = JSON.parse(ob.slice(0, i)); if (o.menu) menus.push(o.menu); else acts.push(o); } catch { /* ignore */ } ob = ob.slice(i + 1); } });
  e2e.stderr.on('data', (x) => { err6 += x; });
  const T = (re) => acts.filter((a) => a.cmd === 'toast' && re.test(a.tag)); const PUSH = (re) => received.filter((p) => re.test(p.body.title));
  await sleep(3500);
  appendReq('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); await sleep(150); setS('waiting', 'permission prompt'); await sleep(1700);
  setS('busy'); await sleep(300);
  appendReq('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); await sleep(150); setS('waiting', 'permission prompt'); await sleep(1900);
  const pt = T(/^WAITING_FOR_PERMISSION/);
  check('E2E I2: prompt, approve, a DIFFERENT prompt ~2.4 s later (inside the 4 s cooldown) => TWO toasts and TWO phone pushes', pt.length === 2 && pt[0].tag !== pt[1].tag && PUSH(/needs permission/).length === 2, `toasts=${pt.length} pushes=${PUSH(/needs permission/).length}`);
  appendReq('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); await sleep(1200);
  check('E2E I2: the duplicate log line for the SAME request id => nothing new', T(/^WAITING_FOR_PERMISSION/).length === 2 && PUSH(/needs permission/).length === 2);
  setS('busy'); await sleep(400); appendReq('33333333-cccc-4ccc-8ccc-cccccccccccc'); await sleep(150); setS('waiting', 'permission prompt'); await sleep(1700);
  appendReq('44444444-dddd-4ddd-8ddd-dddddddddddd'); await sleep(1700);
  check('E2E I2: two DISTINCT prompts pending at once (no answer between) => both notify', T(/^WAITING_FOR_PERMISSION/).length === 4 && PUSH(/needs permission/).length === 4, `toasts=${T(/^WAITING_FOR_PERMISSION/).length} pushes=${PUSH(/needs permission/).length}`);
  setS('busy'); await sleep(500); const before = received.length;
  setS('waiting', 'dialog open'); await sleep(1700);
  const un = T(/^WAITING_UNKNOWN/);
  check('E2E I3: status waiting + UNKNOWN reason => "Claude needs your attention" toast (persistent) with the reason', un.length === 1 && un[0].persistent && un[0].title === 'Claude needs your attention' && un[0].lines.includes('Reason: dialog open'), un[0] && un[0].lines.join(' | '));
  const up = PUSH(/needs your attention/);
  check('E2E I3: ...and a phone push (priority 4) with the safe reason', up.length === 1 && up[0].body.priority === 4 && /Reason: dialog open/.test(up[0].body.message));
  setS('busy'); await sleep(500);
  check('E2E I3: resuming retracts that toast', acts.some((a) => a.cmd === 'retract' && a.tags.includes(un[0].tag)));
  setS('waiting', null); await sleep(1700);
  check('E2E I3: waiting with NO waitingFor => generic attention toast without a reason line', T(/^WAITING_UNKNOWN/).length === 2 && T(/^WAITING_UNKNOWN/)[1].lines.length === 1);
  setS('busy'); await sleep(400); setS('waiting', 'input needed'); await sleep(1700);
  check('E2E I3: a KNOWN reason ("input needed") still gets the specialised input message', T(/^WAITING_FOR_USER/).length === 1 && T(/^WAITING_FOR_USER/)[0].title === 'Claude needs your input');
  const allRaw = received.map((x) => x.raw).join(' ');
  check('E2E I8: NO phone payload contains the session title (default config); project name is there', !/SYN-A/.test(allRaw) && /alpha/.test(allRaw), `pushes=${received.length}`);
  check('E2E I8: the Windows toasts DO keep the session context', T(/^WAITING_FOR_PERMISSION/)[0].lines[0].includes('SYN-A'));
  const lastMenu = () => menus[menus.length - 1];
  e2e.stdin.write('toastSetting:DisabledForUser\n'); await sleep(900);
  check('E2E I7: Windows reports notifications DISABLED => the tray says so, with how to fix it', lastMenu() && /Windows notifications are OFF.*DisabledForUser.*Settings > System > Notifications/.test(lastMenu().toastText || '') && lastMenu().toastBad === true, lastMenu() && lastMenu().toastText);
  e2e.stdin.write('toastSetting:Enabled\n'); await sleep(900);
  check('E2E I7: ...and it clears when they are enabled again', lastMenu() && !lastMenu().toastText);
  e2e.stdin.write('toastFail:boom\n'); e2e.stdin.write('toastFail:boom\n'); await sleep(900);
  check('E2E I7: repeated toast failures (ok:false) are surfaced in the tray, not just logged', lastMenu() && /Windows toasts are failing \(2 in a row: boom\)/.test(lastMenu().toastText || '') && lastMenu().toastBad);
  e2e.stdin.write('toastOk\n'); await sleep(900);
  check('E2E I7: a successful toast clears the failure state', lastMenu() && !lastMenu().toastText);
  check('E2E: the phone line in the tray never claims the phone received anything', lastMenu() && /last accepted by server \d\d:\d\d:\d\d \(phone delivery not confirmed\)/.test(lastMenu().phoneText || ''), lastMenu() && lastMenu().phoneText);
  e2e.kill(); await sleep(800);

  // phone failures end-to-end
  const D2 = path.join(root, 'e2e2'); fs.mkdirSync(D2); fs.writeFileSync(path.join(D2, 'settings.json'), JSON.stringify({ phoneEnabled: true }));
  const writeCfg = (server) => fs.writeFileSync(path.join(D2, 'ntfy.json'), JSON.stringify({ server, topic: 'e2e_topic_fail' }));
  writeCfg('http://127.0.0.1:1');
  const SS2 = path.join(root, 'e2e2-s'); const LL2 = path.join(root, 'e2e2-l'); fs.mkdirSync(SS2); fs.mkdirSync(LL2); const M2 = path.join(LL2, 'main.log'); fs.writeFileSync(M2, '');
  const acts2 = []; const menus2 = []; let ob2 = ''; let err2 = '';
  const e2 = track(spawn(process.execPath, [path.join(P, 'notifier.js'), '--ui', 'none', '--no-lock', '--no-usage', '--dump-menu', '--data-dir', D2, '--sessions-dir', SS2, '--log-dir', LL2, '--interval', '200', '--hb-ms', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  e2.stdout.on('data', (x) => { ob2 += x; let i; while ((i = ob2.indexOf('\n')) >= 0) { try { const o = JSON.parse(ob2.slice(0, i)); if (o.menu) menus2.push(o.menu); else acts2.push(o); } catch { /* ignore */ } ob2 = ob2.slice(i + 1); } });
  e2.stderr.on('data', (x) => { err2 += x; });
  await sleep(2500);
  const ap = (t) => fs.appendFileSync(M2, `${stampNow()} ${t}\n`);
  ap(`[warn] [CCD CycleHealth] ${HA} api_error (success): API Error: first`); await sleep(2800);
  ap(`[warn] [CCD CycleHealth] ${HA} api_error (success): API Error: second`); await sleep(2800);
  const failedLines = (err2.match(/phone: API_ERROR -> FAILED/g) || []).length;
  check('E2E I4: a failed push does not consume the cooldown: the same event type 3 s later is attempted again', failedLines === 2, `FAILED lines=${failedLines}`);
  check('E2E I4: ...no Windows "phone failing" notice yet after 2 failures', !acts2.some((a) => a.cmd === 'toast' && /^PHONE_FAILING/.test(a.tag)));
  ap(`[error] Session ${HA} query error: Claude Code process exited with code 1. stderr: [claude-code:test] x`); await sleep(3500);
  const pf = acts2.filter((a) => a.cmd === 'toast' && /^PHONE_FAILING/.test(a.tag));
  check('E2E I4: 3rd failure => ONE Windows notice "Phone push is failing" explaining what to check', pf.length === 1 && pf[0].title === 'Phone push is failing' && /Check the network, the ntfy server and the topic/.test(pf[0].lines.join(' ')));
  const lm = menus2[menus2.length - 1];
  check('E2E I4: the tray shows the failing state in red (count + last error)', lm && /Phone push FAILING \(3 failed in a row: [^)]+\)/.test(lm.phoneText || '') && lm.phoneBad === true, lm && lm.phoneText);
  const rcvBefore = received.length; writeCfg(URLBASE);
  ap(`[warn] [CCD CycleHealth] ${HA} api_error (success): API Error: third`); await sleep(2500);
  const lm2 = menus2[menus2.length - 1];
  check('E2E I4: after the server is reachable again, the next push clears the failing state in the tray', received.length === rcvBefore + 1 && lm2 && !lm2.phoneBad && /last accepted by server/.test(lm2.phoneText || ''), lm2 && lm2.phoneText);
  e2.kill(); await sleep(500);

  // health canary end-to-end (real heartbeat; needs a real Claude CLI process on this machine)
  console.log('== end-to-end health canary (real heartbeat)');
  fs.mkdirSync(path.join(root, 'empty-s'), { recursive: true });
  const probe = await new Promise((resolve) => { const c = track(spawn(process.execPath, [path.join(P, 'merge-events.js'), '--json', '--hb-ms', '700', '--sessions-dir', path.join(root, 'empty-s'), '--log-dir', LL, '--interval', '300'], { stdio: ['ignore', 'pipe', 'ignore'] })); let o = ''; c.stdout.on('data', (x) => { o += x; }); setTimeout(() => { try { c.kill(); } catch { /* done */ } resolve(o); }, 4500); });
  const hbs = probe.split('\n').filter((l) => l.includes('"HEARTBEAT"')).map((l) => JSON.parse(l)); const lastHb = hbs[hbs.length - 1];
  check('merge-events emits HEARTBEAT lines carrying the watcher\'s counts', hbs.length >= 2 && lastHb.health && Number.isFinite(lastHb.health.files) && 'cli' in lastHb.health && 'desktop' in lastHb.health);
  if (!lastHb || !(lastHb.health.cli > 0)) skip('E2E health: blind-pipeline detection', 'no Claude CLI process is running on this machine right now');
  else {
    const D3 = path.join(root, 'e2e3'); fs.mkdirSync(D3); const SS3 = path.join(root, 'e2e3-s'); fs.mkdirSync(SS3); fs.writeFileSync(path.join(D3, 'ntfy.json'), JSON.stringify({ server: URLBASE, topic: 'e2e_topic_health' })); fs.writeFileSync(path.join(D3, 'settings.json'), JSON.stringify({ phoneEnabled: true }));
    const setH = (on) => { const f = path.join(SS3, `${A.pid}.json`); if (on) fs.writeFileSync(f, JSON.stringify({ ...A, name: 'SYN-H', cwd: 'D:\\syn\\h', hostSessionId: HA, status: 'idle', statusUpdatedAt: Date.now() })); else try { fs.unlinkSync(f); } catch { /* none */ } };
    setH(true); const acts3 = []; const menus3 = []; let ob3 = '';
    const e3 = track(spawn(process.execPath, [path.join(P, 'notifier.js'), '--ui', 'none', '--no-lock', '--no-usage', '--dump-menu', '--data-dir', D3, '--sessions-dir', SS3, '--log-dir', LL, '--interval', '300', '--hb-ms', '700', '--health-grace-ms', '1500', '--health-blind-ms', '3000'], { stdio: ['ignore', 'pipe', 'ignore'] }));
    e3.stdout.on('data', (x) => { ob3 += x; let i; while ((i = ob3.indexOf('\n')) >= 0) { try { const o = JSON.parse(ob3.slice(0, i)); if (o.menu) menus3.push(o.menu); else acts3.push(o); } catch { /* ignore */ } ob3 = ob3.slice(i + 1); } });
    const hw3 = () => acts3.filter((a) => a.cmd === 'toast' && /^HEALTH_WARNING/.test(a.tag)); const pushes3 = () => received.filter((p) => p.body.topic === 'e2e_topic_health');
    await sleep(9000);
    check('E2E health: Claude running + an IDLE visible session for 9 s (well past grace + blind window) => NO warning', hw3().length === 0 && !(menus3[menus3.length - 1] || {}).healthText);
    setH(false); await sleep(14000);   // health is evaluated every 5 s and needs the condition to hold for 3 s: allow two ticks
    check('E2E health: CLI processes exist but the session files vanish => exactly ONE Windows warning', hw3().length === 1 && /no sessions are visible/.test(hw3()[0].lines[0]) && /Restart Claude Notifier/.test(hw3()[0].lines[1]), `toasts=${hw3().length}`);
    check('E2E health: the tray shows the warning and the action', /no sessions are visible/.test((menus3[menus3.length - 1] || {}).healthText || '') && /Restart/.test((menus3[menus3.length - 1] || {}).healthHint || ''));
    check('E2E health: NOTHING was sent to the phone for it', pushes3().length === 0);
    setH(true); await sleep(8000);
    check('E2E health: sessions visible again => the tray warning clears and there is no second toast', !(menus3[menus3.length - 1] || {}).healthText && hw3().length === 1);
    e3.kill(); await sleep(500);
  }

  // real tray host reports the notification setting
  console.log('== I7 real tray host');
  const host = track(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(P, 'ui-host.ps1'), '-Aumid', 'ClaudeNotifier.Companion'], { stdio: ['pipe', 'pipe', 'ignore'] }));
  let hout = ''; host.stdout.on('data', (x) => { hout += x; });
  await waitFor(() => /"evt":"ready"/.test(hout), 25000);
  const ready = hout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.evt === 'ready');
  check('the real tray host reports the Windows notification setting in its ready message', ready && typeof ready.toastSetting === 'string' && ready.toastSetting.length > 0, ready && ready.toastSetting);
  host.stdin.write(JSON.stringify({ cmd: 'menu', usageText: 'Usage: x', healthText: 'Notifier health: test', healthHint: 'do x', toastText: 'Windows notifications are OFF', toastBad: true, phoneText: 'Phone push FAILING', phoneBad: true, sessions: [], recent: [], state: 'idle', tooltip: 't', notificationsEnabled: true, soundsEnabled: true, phoneEnabled: true, phoneConfigured: true }) + '\n'); await sleep(1200);
  // REGRESSION (found in the pre-release run): the control-character stripping made EVERY toast fail with
  // 'Cannot find an overload for "Escape" and the argument count: "2"'. xmlcheck builds + parses the toast XML through the
  // same function a real toast uses, without showing anything.
  const xmlChecks = [
    { title: 'Claude needs permission', lines: ['alpha — SYN-A', 'Tool: Bash'], persistent: true },
    { title: 'Claude <needs> & "permission"', lines: ['name with control char \u0001 and bell \u0007', "it's é 中文 😀"], persistent: false },
    { title: 'x', lines: [null, '', 'tab\there\r\nnewline'], persistent: false },
  ];
  for (const x of xmlChecks) host.stdin.write(JSON.stringify({ cmd: 'xmlcheck', ...x }) + '\n');
  await waitFor(() => (hout.match(/"evt":"xmlcheck"/g) || []).length >= 3, 8000);
  const xr = hout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.evt === 'xmlcheck');
  check('REGRESSION: the tray host builds valid toast XML for plain, special-character and control-character text (no "Escape overload" failure)', xr.length === 3 && xr.every((o) => o.ok === true), JSON.stringify(xr.map((o) => o.ok || o.error)));
  const once = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(P, 'notify-once.ps1'), '-Title', 'Crash <b> &', '-Body', 'ctrl \u0001 and "quote"', '-CheckOnly'], { encoding: 'utf8', windowsHide: true });
  check('REGRESSION: notify-once.ps1 (the supervisor give-up notice) parses its toast XML too', /xml-ok/.test(once));
  host.stdin.write('{"cmd":"history"}\n'); await waitFor(() => /toastHistory/.test(hout), 5000);
  check('the tray host accepts the new status lines and stays responsive (no error event)', /toastHistory/.test(hout) && !/"evt":"error"/.test(hout), hout.includes('"evt":"error"') ? hout.slice(-200) : '');
  host.stdin.write('{"cmd":"exit"}\n'); await sleep(800);

  killAll(); server.close();
  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (fails) console.log(`--- notifier stderr (e2e) ---\n${err6.slice(-1200)}`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); killAll(); process.exit(1); });
