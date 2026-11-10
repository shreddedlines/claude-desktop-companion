#!/usr/bin/env node
/**
 * test-step2.js — SYNTHETIC test of merge-events.js in isolated temp directories.
 * Never touches the real ~/.claude/sessions or Desktop logs (only reads two real session files to
 * borrow valid pid/procStart pairs of live claude.exe processes, so the stale-PID check passes).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'step2-'));
const SES = path.join(root, 'sessions'); const LOG = path.join(root, 'logs');
fs.mkdirSync(SES); fs.mkdirSync(LOG);
const MAIN = path.join(LOG, 'main.log'); const ROT = path.join(LOG, 'main1.log');

// borrow two live claude.exe pid/procStart pairs from the real registry (read-only)
const realDir = path.join(process.env.USERPROFILE, '.claude', 'sessions');
const pool = fs.readdirSync(realDir).filter((n) => /^\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(realDir, n), 'utf8')))
  .filter((j) => j.entrypoint === 'claude-desktop' && j.pid !== process.pid);
if (pool.length < 2) { console.error('need 2 live Desktop sessions to borrow pids'); process.exit(2); }
const mk = (real, name, cwd, host) => ({ real, name, cwd, host, file: path.join(SES, `${real.pid}.json`) });
const A = mk(pool[0], 'SYN-A', 'D:\\syn\\alpha', 'local_aaaaaaaa-0000-4000-8000-000000000001');
const B = mk(pool[1], 'SYN-B', 'D:\\syn\\beta', 'local_bbbbbbbb-0000-4000-8000-000000000002');
function setState(s, status, waitingFor, extra = {}) {
  const o = { ...s.real, name: s.name, cwd: s.cwd, hostSessionId: s.host, status, statusUpdatedAt: Date.now(), updatedAt: Date.now(), ...extra };
  delete o.waitingFor; if (waitingFor) o.waitingFor = waitingFor;
  fs.writeFileSync(s.file, JSON.stringify(o));
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const line = (level, text) => `${stamp()} [${level}] ${text}\n`;
const append = (...ls) => fs.appendFileSync(MAIN, ls.join(''));

// pre-existing history that must NOT be replayed (live tail starts at end of file)
fs.writeFileSync(MAIN, line('warn', `[CCD CycleHealth] ${A.host} api_error (success): msg-OLD should never appear`));
setState(A, 'idle'); setState(B, 'busy');

const events = []; let stderr = '';
const child = spawn(process.execPath, [path.join(__dirname, 'merge-events.js'), '--json', '--hold', '800', '--interval', '200',
  '--sessions-dir', SES, '--log-dir', LOG], { stdio: ['ignore', 'pipe', 'pipe'] });
let ob = '';
child.stdout.on('data', (d) => { ob += d; let i; while ((i = ob.indexOf('\n')) >= 0) { try { events.push(JSON.parse(ob.slice(0, i))); } catch { /* ignore */ } ob = ob.slice(i + 1); } });
child.stderr.on('data', (d) => { stderr += d; });

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const find = (type, p = () => true) => events.filter((e) => e.type === type && p(e));
let mark = 0; const since = () => events.slice(mark);

(async () => {
  await sleep(2500); // initial scan
  check('INITIAL_STATE for both sessions', find('INITIAL_STATE').length === 2, `${find('INITIAL_STATE').length} events`);
  check('history before start not replayed (msg-OLD)', !events.some((e) => /msg-OLD/.test(e.details)));
  mark = events.length;

  // S1 WORKING
  setState(A, 'busy'); await sleep(900);
  check('S1 idle->busy => WORKING (session-file)', find('WORKING', (e) => e.session === 'SYN-A' && e.project === 'alpha').length === 1);

  // S2 permission: log first, status file 150 ms later -> must merge into ONE event
  append(line('info', `Emitted tool permission request 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa for Bash in session ${A.host}`));
  await sleep(150); setState(A, 'waiting', 'permission prompt'); await sleep(1800);
  let p = find('WAITING_FOR_PERMISSION');
  check('S2 permission pair (log first, file second) => exactly 1 merged event', p.length === 1 && /session-file/.test(p[0].source) && /main\.log/.test(p[0].source) && /tool=Bash/.test(p[0].details), p[0] ? `${p[0].source} | ${p[0].details}` : 'none');

  // S3 user question: status file first, log 150 ms later
  setState(A, 'busy'); await sleep(500);
  setState(A, 'waiting', 'input needed'); await sleep(150);
  append(line('info', `Emitted tool permission request 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb for AskUserQuestion in session ${A.host}`)); await sleep(1800);
  p = find('WAITING_FOR_USER');
  check('S3 user input (file first, log second) => exactly 1 merged event', p.length === 1 && /session-file/.test(p[0].source) && /main\.log/.test(p[0].source) && /AskUserQuestion/.test(p[0].details), p[0] ? `${p[0].source} | ${p[0].details}` : 'none');

  // S4 duplicate log lines (same request ids) => nothing new
  const n4 = events.length;
  append(line('info', `Emitted tool permission request 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa for Bash in session ${A.host}`),
    line('info', `Emitted tool permission request 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb for AskUserQuestion in session ${A.host}`));
  await sleep(1500);
  check('S4 duplicate permission log lines (same request id) produce no events', events.length === n4);

  // S5 turn finished: file busy->idle + Stop hook => 1 merged TURN_FINISHED
  setState(A, 'busy'); await sleep(500);
  setState(A, 'idle'); await sleep(200);
  append(line('info', `[Stop hook] Query completed for session ${A.host}`)); await sleep(1800);
  p = find('TURN_FINISHED');
  check('S5 busy->idle + Stop hook => exactly 1 merged TURN_FINISHED', p.length === 1 && /session-file/.test(p[0].source) && /main\.log/.test(p[0].source), p[0] ? p[0].source : 'none');

  // S6 API error / session limit with repeats + unhealthy-cycle companion line
  const err = (m) => line('warn', `[CCD CycleHealth] ${A.host} api_error (success): ${m}`);
  append(err('API Error: Unable to connect to API: msg-one'), err('API Error: Unable to connect to API: msg-one'),
    line('info', `[CCD CycleHealth] unhealthy cycle for ${A.host} (3s, hadFirstResponse=true, reason=api_error)`)); await sleep(400);
  append(err('API Error: Unable to connect to API: msg-one'), err('Failed to authenticate. API Error: 401 msg-two'));
  await sleep(300);
  const lim = err("You've hit your session limit · resets 7pm (Asia/Kolkata)");
  append(lim, lim); await sleep(1200);
  check('S6 identical API errors repeated 3x => 1 API_ERROR; distinct error => 2nd', find('API_ERROR').filter((e) => /msg-one|msg-two/.test(e.details)).length === 2);
  check('S6 session-limit line repeated 2x => 1 SESSION_LIMIT with reset text', find('SESSION_LIMIT').length === 1 && /resets 7pm \(Asia\/Kolkata\)/.test(find('SESSION_LIMIT')[0].details), find('SESSION_LIMIT')[0] && find('SESSION_LIMIT')[0].details);

  // S7 process-exit error (+ continuation lines that must be ignored), reported twice back-to-back
  const exit = line('error', `Session ${B.host} query error: Claude Code process exited with code 3221225786. stderr: [claude-code:unrecognized_model] {"model":"x"} { telemetryMessage: 'x' }`)
    + `${stamp()} [error] Session ${B.host} CLI stderr tail:\n[claude-code:unrecognized_model] {"model":"x"}\n  at somewhere (file.js:1:1)\n`;
  append(exit, exit); await sleep(1200);
  p = find('PROCESS_EXITED_ERROR');
  check('S7 process exit logged twice => 1 PROCESS_EXITED_ERROR (SYN-B), stack lines ignored', p.length === 1 && p[0].session === 'SYN-B' && /0xC000013A/.test(p[0].details) && /unrecognized_model/.test(p[0].details), p[0] ? p[0].details : 'none');

  // S8 partial line + UTF-8 character split across two writes
  const full = Buffer.from(err('API Error: msg-partial · tail-ok'), 'utf8');
  const cut = full.indexOf(Buffer.from('·', 'utf8')) + 1; // between the two bytes of "·"
  fs.appendFileSync(MAIN, full.subarray(0, cut)); await sleep(700);
  check('S8 half-written line emits nothing yet', !events.some((e) => /msg-partial/.test(e.details)));
  fs.appendFileSync(MAIN, full.subarray(cut)); await sleep(900);
  p = find('API_ERROR', (e) => /msg-partial/.test(e.details));
  check('S8 completed line (UTF-8 char split across reads) => 1 event, "·" intact', p.length === 1 && /msg-partial · tail-ok/.test(p[0].details), p[0] ? p[0].details : 'none');

  // S9 rotation by rename: unread tail in old file + first line in the new file
  const errA = (m) => err(`API Error: ${m}`);
  fs.appendFileSync(MAIN, errA('msg-rot-1'));
  fs.renameSync(MAIN, ROT);
  fs.writeFileSync(MAIN, errA('msg-rot-2 ' + 'x'.repeat(300))); // long on purpose (see S10)
  await sleep(1500);
  const r1 = find('API_ERROR', (e) => /msg-rot-1/.test(e.details)); const r2 = find('API_ERROR', (e) => /msg-rot-2/.test(e.details));
  check('S9 rename rotation: unread tail + new file both delivered exactly once', r1.length === 1 && r2.length === 1, `rot-1 from ${r1[0] && r1[0].source}, rot-2 from ${r2[0] && r2[0].source}`);
  check('S9 rotation reported by tailer', /log rotation detected: rename/.test(stderr));

  // S10 copy+truncate style rotation
  fs.truncateSync(MAIN, 0); await sleep(600);
  fs.appendFileSync(MAIN, errA('msg-trunc')); await sleep(1200);
  check('S10 truncate-in-place rotation => new content delivered once', find('API_ERROR', (e) => /msg-trunc/.test(e.details)).length === 1 && /log rotation detected: truncate/.test(stderr));

  // S11 session end: clean exit (file removed) and stale (process identity no longer matches)
  fs.unlinkSync(B.file); await sleep(900);
  setState(A, 'busy', null, { procStart: '134000000000000000' }); await sleep(1200);
  const ended = find('SESSION_ENDED');
  check('S11 file removed => SESSION_ENDED (SYN-B)', ended.some((e) => e.session === 'SYN-B' && /file removed/.test(e.details)));
  check('S11 PID/creation-time mismatch => SESSION_ENDED (SYN-A), no phantom WORKING', ended.some((e) => e.session === 'SYN-A' && /process gone/.test(e.details)));

  child.kill(); await sleep(300);
  console.log('\n--- merged stream produced by the test run ---');
  console.log('timestamp | session | project | event_type | details | source');
  for (const e of events) console.log(`${e.ts} | ${e.session} | ${e.project} | ${e.type} | ${e.details.slice(0, 90)} | ${e.source}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) console.log('--- stderr ---\n' + stderr);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
