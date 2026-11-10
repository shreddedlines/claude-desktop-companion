#!/usr/bin/env node
/**
 * test-step3.js — SYNTHETIC tests for the Step 3 layer (no real toasts are shown):
 *   A) policy.js unit tests with a fake clock
 *   B) store.js / sounds.js checks
 *   C) end-to-end: synthetic sessions + synthetic Desktop log -> merge-events -> notifier (--ui none) -> actions + SQLite
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Policy } = require('./policy');
const { Store } = require('./store');
const { ensureSounds } = require('./sounds');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'step3-'));

// ---------- A) policy ----------
console.log('== A) policy unit tests');
let clock = 1_000_000_000_000; const settings = { notificationsEnabled: true, soundsEnabled: true };
const mkPolicy = (o = {}) => new Policy({ getSettings: () => settings, now: () => clock, ...o });
const E = (type, extra = {}) => ({ type, session: 'My session', project: 'alpha', sessionId: 'local_a', pid: 1, details: '', epoch: clock, source: 'x', ...extra });
const toasts = (r) => r.actions.filter((a) => a.kind === 'toast');

let p = mkPolicy();
let r = p.handle(E('TURN_FINISHED'));
check('TURN_FINISHED => normal (non-persistent) toast "Claude finished the task" with project', toasts(r).length === 1 && !toasts(r)[0].persistent && toasts(r)[0].title === 'Claude finished the task' && /alpha/.test(toasts(r)[0].lines.join(' ')) && toasts(r)[0].sound === 'finished');
for (const t of ['WORKING', 'IDLE', 'INITIAL_STATE', 'SESSION_STARTED', 'SESSION_ENDED']) { clock += 10_000; r = p.handle(E(t)); check(`${t} => no toast`, toasts(r).length === 0); }
p = mkPolicy();
r = p.handle(E('WAITING_FOR_USER', { details: 'tool=AskUserQuestion request=1' }));
check('WAITING_FOR_USER => persistent "Claude needs your input" + sound "input" + project', toasts(r)[0].persistent && toasts(r)[0].title === 'Claude needs your input' && toasts(r)[0].sound === 'input' && /alpha/.test(toasts(r)[0].lines[0]));
p = mkPolicy();
r = p.handle(E('WAITING_FOR_PERMISSION', { details: 'tool=Bash request=1' }));
check('WAITING_FOR_PERMISSION => persistent "Claude needs permission" + distinct sound + tool line', toasts(r)[0].persistent && toasts(r)[0].title === 'Claude needs permission' && toasts(r)[0].sound === 'permission' && toasts(r)[0].lines.includes('Tool: Bash'));
for (const [t, d, what] of [['API_ERROR', 'API Error: 401 expired', 'API error'], ['SESSION_LIMIT', "You've hit your session limit \u00b7 resets 7pm (Asia/Kolkata)", 'Session limit reached'], ['PROCESS_EXITED_ERROR', 'exit code 1 (0x1)', 'Claude Code process exited unexpectedly']]) {
  p = mkPolicy(); r = p.handle(E(t, { details: d }));
  const a = toasts(r)[0];
  check(`${t} => persistent "Claude needs attention" + attention sound + details`, a && a.persistent && a.title === 'Claude needs attention' && a.sound === 'attention' && a.lines.includes(what) && a.lines.join(' ').includes(d.slice(0, 20)));
}
// retraction + resolved-before-delivery
p = mkPolicy(); r = p.handle(E('WAITING_FOR_PERMISSION')); const tag = toasts(r)[0].tag;
clock += 3000; r = p.handle(E('WORKING'));
check('WORKING after a permission toast => retract that persistent toast', r.actions.length === 1 && r.actions[0].kind === 'retract' && r.actions[0].tags.includes(tag));
clock += 100; r = p.handle(E('WORKING')); check('second WORKING => nothing more to retract', r.actions.length === 0);
p = mkPolicy(); const t0 = clock; clock += 500; p.handle(E('WORKING', { epoch: t0 + 400 }));
r = p.handle(E('WAITING_FOR_PERMISSION', { epoch: t0 })); // approved before the (held) event was delivered
check('WAITING resolved before delivery (late merged event) => dropped, no stale persistent toast', toasts(r).length === 0 && r.reason === 'resolved-before-delivery');
// anti-spam
p = mkPolicy(); clock += 100_000; p.handle(E('WAITING_FOR_USER')); clock += 2000; r = p.handle(E('WAITING_FOR_USER'));
check('same session+type again within 4 s => cooldown', toasts(r).length === 0 && r.reason === 'cooldown');
clock += 5000; r = p.handle(E('WAITING_FOR_USER')); check('...but allowed after the cooldown', toasts(r).length === 1);
p = mkPolicy(); clock += 100_000; let shown = 0, limited = 0;
for (let i = 0; i < 7; i++) { r = p.handle(E('TURN_FINISHED', { sessionId: `local_${i}` })); shown += toasts(r).length; limited += r.reason === 'burst-limited' ? 1 : 0; }
check('burst of 7 events from 7 sessions => 4 toasts, 3 rate-limited', shown === 4 && limited === 3, `shown=${shown} limited=${limited}`);
check('no summary before the window has passed', p.tick().length === 0);
{ const q = mkPolicy(); clock += 100_000; let n1 = 0; for (let i = 0; i < 10; i++) n1 += toasts(q.handle(E('PROCESS_EXITED_ERROR', { sessionId: `local_p${i}` }))).length;
  const q2 = mkPolicy(); let nf = 0; for (let i = 0; i < 4; i++) nf += toasts(q2.handle(E('TURN_FINISHED', { sessionId: `local_f${i}` }))).length; const rr = q2.handle(E('PROCESS_EXITED_ERROR', { sessionId: 'local_crash' }));
  check('attention/permission events are not starved by finished-toast chatter (separate buckets)', toasts(rr).length === 1 && nf === 4);
  check('flood guard: 10 persistent events from 10 sessions in one window => 8 shown', n1 === 8, `shown=${n1}`); clock += 11_000; q.tick(); }
clock += 11_000; const sum = p.tick();
check('after the window => ONE summary toast ("3 more Claude events")', sum.length === 1 && /3 more Claude events/.test(sum[0].lines[0]));
check('summary is emitted once only', p.tick().length === 0);
// settings
p = mkPolicy(); settings.notificationsEnabled = false; clock += 100_000;
r = p.handle(E('WAITING_FOR_USER')); check('notifications disabled => no toast (reason recorded)', toasts(r).length === 0 && r.reason === 'notifications-disabled');
settings.notificationsEnabled = true; settings.soundsEnabled = false; clock += 100_000;
r = p.handle(E('WAITING_FOR_PERMISSION', { sessionId: 'local_z' })); check('sounds disabled => toast without sound', toasts(r).length === 1 && toasts(r)[0].sound === null);
settings.soundsEnabled = true;
p = mkPolicy(); clock += 100_000; r = p.handle(E('API_ERROR', { epoch: clock - 120_000, details: 'old' }));
check('stale (2 min old) event never notifies', toasts(r).length === 0 && r.reason === 'stale');

// ---------- B) store + sounds ----------
console.log('== B) store / sounds');
const sdir = path.join(root, 'store'); let st = new Store(sdir);
check('history backend is SQLite (node:sqlite, no dependency)', st.backend === 'sqlite');
st.addEvent({ type: 'WAITING_FOR_USER', session: 's', project: 'alpha', epoch: 1, details: 'tool=X', source: 'main.log+session-file' }, { notified: true, reason: 'shown' });
st.addEvent({ type: 'WORKING', session: 's', project: 'alpha', epoch: 2 }, { notified: false, reason: 'no-notification-for-type' });
st.setSetting('soundsEnabled', false); st.close();
st = new Store(sdir);
check('settings persist across restart', st.settings.soundsEnabled === false && st.settings.notificationsEnabled === true);
check('history persists; recent() hides WORKING noise', st.count() === 2 && st.recent(10).length === 1 && st.recent(10)[0].type === 'WAITING_FOR_USER' && st.recent(10)[0].notified === 1);
st.close();
const wavs = ensureSounds(path.join(root, 'sounds')); const sizes = Object.values(wavs).map((f) => fs.statSync(f).size);
check('4 distinct WAV files generated with RIFF headers', Object.keys(wavs).length === 4 && new Set(sizes).size === 4 && Object.values(wavs).every((f) => fs.readFileSync(f).subarray(0, 4).toString() === 'RIFF'), sizes.join('/'));

// ---------- C) end-to-end through merge-events + notifier ----------
(async () => {
  console.log('== C) end-to-end (synthetic sessions + synthetic Desktop log, UI backend = none)');
  const SES = path.join(root, 'sessions'); const LOG = path.join(root, 'logs'); const DATA = path.join(root, 'data');
  fs.mkdirSync(SES); fs.mkdirSync(LOG);
  const MAIN = path.join(LOG, 'main.log');
  const realDir = path.join(process.env.USERPROFILE, '.claude', 'sessions');
  const pool = fs.readdirSync(realDir).filter((n) => /^\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(realDir, n), 'utf8'))).filter((j) => j.entrypoint === 'claude-desktop' && j.pid !== process.pid);
  const mk = (real, name, cwd, host) => ({ real, name, cwd, host, file: path.join(SES, `${real.pid}.json`) });
  const A = mk(pool[0], 'SYN-A', 'D:\\syn\\alpha', 'local_aaaaaaaa-0000-4000-8000-000000000001');
  const B = mk(pool[1], 'SYN-B', 'D:\\syn\\beta', 'local_bbbbbbbb-0000-4000-8000-000000000002');
  const setState = (s, status, wf) => { const o = { ...s.real, name: s.name, cwd: s.cwd, hostSessionId: s.host, status, statusUpdatedAt: Date.now() }; delete o.waitingFor; if (wf) o.waitingFor = wf; fs.writeFileSync(s.file, JSON.stringify(o)); };
  const pad = (n) => String(n).padStart(2, '0'); const d = () => new Date();
  const line = (lvl, t) => { const x = d(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())} [${lvl}] ${t}\n`; };
  const append = (...l) => fs.appendFileSync(MAIN, l.join(''));
  fs.writeFileSync(MAIN, ''); setState(A, 'idle'); setState(B, 'busy');

  const acts = []; let err = '';
  const child = spawn(process.execPath, [path.join(__dirname, 'notifier.js'), '--ui', 'none', '--no-lock', '--no-usage', '--control-stdin', '--data-dir', DATA,
    '--sessions-dir', SES, '--log-dir', LOG, '--interval', '200', '--hold', '700'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let ob = ''; child.stdout.on('data', (x) => { ob += x; let i; while ((i = ob.indexOf('\n')) >= 0) { try { acts.push(JSON.parse(ob.slice(0, i))); } catch { /* ignore */ } ob = ob.slice(i + 1); } });
  child.stderr.on('data', (x) => { err += x; });
  const T = (re) => acts.filter((a) => a.cmd === 'toast' && re.test(a.tag));
  await sleep(2500);
  check('startup/INITIAL_STATE => no notifications', acts.length === 0);

  setState(A, 'busy'); await sleep(900);
  check('WORKING => no notification', acts.length === 0);

  append(line('info', `Emitted tool permission request 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa for Bash in session ${A.host}`)); await sleep(150);
  setState(A, 'waiting', 'permission prompt'); await sleep(2200);
  let tt = T(/^WAITING_FOR_PERMISSION/);
  check('E2E permission (file+log merged) => exactly ONE persistent toast, project "alpha"', tt.length === 1 && tt[0].persistent && tt[0].title === 'Claude needs permission' && /alpha/.test(tt[0].lines[0]) && tt[0].soundName === 'permission', tt[0] && tt[0].lines.join(' / '));
  const permTag = tt[0] && tt[0].tag;

  setState(A, 'busy'); await sleep(1000);
  check('E2E session resumes (WORKING) => the permission toast is retracted', acts.some((a) => a.cmd === 'retract' && a.tags.includes(permTag)));

  setState(A, 'waiting', 'input needed'); await sleep(150);
  append(line('info', `Emitted tool permission request 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb for AskUserQuestion in session ${A.host}`)); await sleep(2200);
  tt = T(/^WAITING_FOR_USER/);
  check('E2E question (file+log merged) => exactly ONE persistent "Claude needs your input" toast', tt.length === 1 && tt[0].persistent && tt[0].title === 'Claude needs your input' && tt[0].soundName === 'input');

  const n = acts.length;
  append(line('info', `Emitted tool permission request 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa for Bash in session ${A.host}`), line('info', `Emitted tool permission request 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb for AskUserQuestion in session ${A.host}`)); await sleep(1800);
  check('E2E duplicate log lines => no extra notification', acts.length === n);

  setState(A, 'busy'); await sleep(1000); setState(A, 'idle'); await sleep(150);
  append(line('info', `[Stop hook] Query completed for session ${A.host}`)); await sleep(2200);
  tt = T(/^TURN_FINISHED/);
  check('E2E turn end (file+stop hook merged) => exactly ONE normal toast "Claude finished the task"', tt.length === 1 && !tt[0].persistent && tt[0].title === 'Claude finished the task');

  const err1 = (m) => line('warn', `[CCD CycleHealth] ${A.host} api_error (success): ${m}`);
  append(err1('API Error: Unable to connect'), err1('API Error: Unable to connect'), err1('API Error: Unable to connect')); await sleep(600);
  const lim = err1("You've hit your session limit \u00b7 resets 7pm (Asia/Kolkata)"); append(lim, lim);
  const ex = line('error', `Session ${B.host} query error: Claude Code process exited with code 3221225786. stderr: [claude-code:unrecognized_model] {}`); append(ex, ex);
  await sleep(1500);
  check('E2E API_ERROR x3 => 1 attention toast', T(/^API_ERROR/).length === 1 && T(/^API_ERROR/)[0].title === 'Claude needs attention');
  check('E2E SESSION_LIMIT x2 => 1 attention toast incl. reset time', T(/^SESSION_LIMIT/).length === 1 && T(/^SESSION_LIMIT/)[0].lines.join(' ').includes('resets 7pm (Asia/Kolkata)'));
  check('E2E PROCESS_EXITED_ERROR x2 => 1 attention toast (beta)', T(/^PROCESS_EXITED_ERROR/).length === 1 && /beta/.test(T(/^PROCESS_EXITED_ERROR/)[0].lines[0]));
  const total = acts.filter((a) => a.cmd === 'toast').length;
  check('E2E total toasts for the whole run = 6 (no spam)', total === 6, `total=${total}`);

  child.stdin.write('toggleNotifications\n'); await sleep(500);
  setState(A, 'waiting', 'permission prompt'); append(line('info', `Emitted tool permission request 33333333-cccc-4ccc-8ccc-cccccccccccc for Bash in session ${A.host}`)); await sleep(2200);
  check('E2E notifications disabled via menu => no new toast', acts.filter((a) => a.cmd === 'toast').length === total);
  child.stdin.write('toggleNotifications\n'); await sleep(400);

  child.kill(); await sleep(1500);
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(DATA, 'history.db'));
  const rows = db.prepare('SELECT type, notified, reason FROM events').all(); db.close();
  const cnt = (t, nn) => rows.filter((x) => x.type === t && x.notified === nn).length;
  check('SQLite history recorded the run', rows.length > 10 && cnt('WAITING_FOR_PERMISSION', 1) === 1 && cnt('WAITING_FOR_PERMISSION', 0) === 1 && rows.some((x) => x.reason === 'notifications-disabled'), `rows=${rows.length}`);
  check('settings file persisted the (re-enabled) toggle state', JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).notificationsEnabled === true);

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  if (fails) console.log('--- notifier stderr ---\n' + err.slice(-1500));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})();
