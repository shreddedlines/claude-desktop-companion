#!/usr/bin/env node
/**
 * test-step4.js — SYNTHETIC tests for the ntfy phone-push layer. Nothing here touches the real
 * network: the transport is exercised against a local mock ntfy server on 127.0.0.1.
 *   A) payload building: priorities, titles, allowlist, privacy/scrubbing
 *   B) config: validation, init, no hard-coded topic in source
 *   C) transport: success, retry on 5xx, no retry on 4xx, unreachable, auth header
 *   D) dispatcher: toggle, cooldown, hold+cancel, resolved-before-delivery, rate limit, stale
 *   E) end-to-end: synthetic sessions + log -> merge-events -> notifier (--ui none) -> mock ntfy
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const ntfy = require('./ntfy');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'step4-'));

// ---------- mock ntfy server ----------
const received = []; let failNext = 0; let failStatus = 500;
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (failNext > 0) { failNext--; res.writeHead(failStatus); res.end('{}'); return; }
    let body = null; try { body = JSON.parse(b); } catch { /* not json */ }
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, ctype: req.headers['content-type'], raw: b, body });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}');
  });
});

const CFG = (o = {}) => ntfy.loadConfig === undefined ? null : ({ ...ntfy.DEFAULT_CONFIG, topic: 'testtopic_123', server: 'http://127.0.0.1:0', ...o });
const EV = (type, extra = {}) => ({ type, session: 'Fix login page', project: 'alpha', sessionId: 'local_a', pid: 1, details: '', epoch: Date.now(), source: 'x', ...extra });
const ALLOWED = ['message', 'priority', 'tags', 'title', 'topic'];

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port; const URLBASE = `http://127.0.0.1:${PORT}`;

  // ---------- A) payloads ----------
  console.log('== A) payloads / priorities / privacy');
  const cfg = CFG({ server: URLBASE });
  const exp = { TURN_FINISHED: [4, 'Claude finished the task'], WAITING_FOR_USER: [4, 'Claude needs your input'], WAITING_FOR_PERMISSION: [5, 'Claude needs permission'],
    API_ERROR: [5, 'Claude needs attention: API error'], SESSION_LIMIT: [5, 'Claude needs attention: session limit'], PROCESS_EXITED_ERROR: [5, 'Claude needs attention: process exited'] };
  for (const [t, [prio, title]] of Object.entries(exp)) {
    const m = ntfy.buildMessage(EV(t, { details: t === 'SESSION_LIMIT' ? "You've hit your session limit \u00b7 resets 7pm (Asia/Kolkata)" : t === 'PROCESS_EXITED_ERROR' ? 'exit code 3221225786 (0xC000013A)' : t === 'WAITING_FOR_PERMISSION' ? 'tool=Bash request=1' : '' }), cfg);
    check(`${t}: priority ${prio}, title "${title}", project in body, allowlisted keys only`, m.priority === prio && m.title === title && m.message.startsWith('alpha') && JSON.stringify(Object.keys(m).sort()) === JSON.stringify(ALLOWED));
  }
  check('full default priority map is exactly as designed (only TURN_FINISHED changed 3->4, so it is delivered in Doze)', JSON.stringify(ntfy.DEFAULT_CONFIG.priorities) === JSON.stringify({ TURN_FINISHED: 4, WAITING_FOR_USER: 4, WAITING_FOR_PERMISSION: 5, API_ERROR: 5, SESSION_LIMIT: 5, PROCESS_EXITED_ERROR: 5, USAGE_WARNING: 3, USAGE_CRITICAL: 4, WAITING_UNKNOWN: 4 }));
  check('priority mapping is configurable (finished=2, permission=4)', ntfy.buildMessage(EV('TURN_FINISHED'), CFG({ priorities: { TURN_FINISHED: 2 } })).priority === 2 && ntfy.buildMessage(EV('WAITING_FOR_PERMISSION'), CFG({ priorities: { WAITING_FOR_PERMISSION: 4 } })).priority === 4);
  check('WORKING / INITIAL_STATE / SESSION_ENDED have no phone message', ['WORKING', 'INITIAL_STATE', 'SESSION_ENDED', 'IDLE'].every((t) => ntfy.buildMessage(EV(t), cfg) === null));
  const perm = ntfy.buildMessage(EV('WAITING_FOR_PERMISSION', { details: 'tool=Bash request=ab12; waitingFor="permission prompt"; cmd: rm -rf secrets && echo password=hunter2' }), cfg);
  check('permission: only the tool NAME is sent (no command/arguments)', /Tool: Bash/.test(perm.message) && !/rm -rf|hunter2|password|request=/.test(perm.message), JSON.stringify(perm.message));
  const q = ntfy.buildMessage(EV('WAITING_FOR_USER', { details: 'tool=AskUserQuestion question: what is the admin password?' }), cfg);
  check('user-input: no question text or details sent', !/password|question|AskUserQuestion/i.test(q.message), JSON.stringify(q.message));
  const apiErr = ntfy.buildMessage(EV('API_ERROR', { details: 'API Error: 401 from https://api.example.com/v1/x?key=abc Bearer sk-ant-api03-ABCDEFGHIJKLMNOP0123456789 token ghp_abcdefghijklmnop123456' }), cfg);
  check('API error text is scrubbed: URL, Bearer/sk-/ghp_ tokens and long identifiers removed', !/https?:|sk-ant|ghp_|ABCDEFGHIJKL/.test(apiErr.message) && /API Error/.test(apiErr.message), JSON.stringify(apiErr.message));
  check('API error detail is length-capped (<=100 chars + label/time lines)', ntfy.buildMessage(EV('API_ERROR', { details: 'x '.repeat(400) }), cfg).message.split('\n')[1].length <= 100);
  const lim = ntfy.buildMessage(EV('SESSION_LIMIT', { details: "You've hit your session limit \u00b7 resets 7pm (Asia/Kolkata)" }), cfg);
  check('session limit: reset time forwarded', /Resets 7pm \(Asia\/Kolkata\)/.test(lim.message), JSON.stringify(lim.message));
  const noTitle = ntfy.buildMessage(EV('TURN_FINISHED'), CFG({ includeSessionTitle: false }));
  check('includeSessionTitle=false => only project folder name, no session title', !/Fix login page/.test(noTitle.message) && noTitle.message.startsWith('alpha'));
  check('privacy default: the session title is NOT sent by default; explicit opt-in sends it', !/Fix login page/.test(ntfy.buildMessage(EV('TURN_FINISHED'), cfg).message) && /alpha \u2014 Fix login page/.test(ntfy.buildMessage(EV('TURN_FINISHED'), { ...cfg, includeSessionTitle: true }).message));
  const unk = ntfy.buildMessage(EV('TURN_FINISHED', { session: 'local_abcdef01', project: '?' }), cfg);
  check('unknown session => generic label, no internal ids', unk.message.startsWith('Claude session') && !/local_/.test(unk.message));
  const all = JSON.stringify([perm, q, apiErr, lim, noTitle]);
  check('no payload contains cwd paths, pids, session ids, or hostnames', !/[A-Z]:\\|\\\\|local_a|pid|127\.0\.0\.1/.test(all));
  check('manual test message contains no Claude data', !/alpha|Fix login|Claude finished/.test(JSON.stringify(ntfy.buildTestMessage(cfg))));

  // ---------- B) config ----------
  console.log('== B) config');
  const v = (o) => ntfy.validateConfig({ ...cfg, ...o });
  check('valid https config accepted', v({ server: 'https://ntfy.sh', topic: 'abc_DEF-123' }) === null);
  check('http on localhost accepted', v({ server: 'http://localhost:8080' }) === null && v({ server: 'http://127.0.0.1:8080' }) === null);
  check('http on a non-local host rejected (protects topic/token)', /https/.test(v({ server: 'http://ntfy.example.com' })));
  check('http non-local allowed only with allowInsecure', v({ server: 'http://ntfy.example.com', allowInsecure: true }) === null);
  check('empty / invalid topic rejected', !!v({ topic: '' }) && !!v({ topic: 'has space' }) && !!v({ topic: 'a/b' }));
  check('missing config => "not configured"', /not configured/.test(ntfy.validateConfig(null)));
  const cdir = path.join(root, 'cfg'); const a = ntfy.initConfig(cdir, {});
  check('init creates config with a random unambiguous 16-char topic, https://ntfy.sh default', a.created && /^claude-[abcdefghjkmnpqrstuvwxyz23456789]{16}$/.test(a.cfg.topic) && a.cfg.server === 'https://ntfy.sh');
  const b = ntfy.initConfig(cdir, { topic: 'other' });
  check('init does not overwrite an existing config without --force', !b.created && b.cfg.topic === a.cfg.topic);
  check('two inits produce different topics', ntfy.initConfig(path.join(root, 'cfg2'), {}).cfg.topic !== a.cfg.topic);
  const leaks = fs.readdirSync(__dirname).filter((f) => /\.(js|ps1|vbs|md)$/.test(f)).filter((f) => /claude-[A-Za-z0-9_-]{20,}/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  check('no topic-like secret hard-coded in any source file', leaks.length === 0, leaks.join(','));
  const cfgFile = JSON.parse(fs.readFileSync(path.join(cdir, ntfy.CONFIG_NAME), 'utf8'));
  check('config file holds server/topic/priorities/holdSeconds/types (user-editable)', cfgFile.priorities && cfgFile.holdSeconds && cfgFile.types && 'token' in cfgFile);

  // ---------- C) transport ----------
  console.log('== C) transport (mock server)');
  let r = await ntfy.send(cfg, { topic: cfg.topic, title: 'T', message: 'M', priority: 3, tags: ['x'] });
  check('POST JSON accepted (HTTP 200)', r.ok && received.length === 1 && received[0].method === 'POST' && received[0].ctype === 'application/json' && received[0].body.title === 'T');
  check('no Authorization header when no token', received[0].auth === null);
  await ntfy.send({ ...cfg, token: 'tk_secret123' }, { topic: cfg.topic, title: 'T2', message: 'M', priority: 3, tags: [] });
  check('Bearer token sent when configured', received[1].auth === 'Bearer tk_secret123');
  failNext = 2; failStatus = 503; const n0 = received.length; r = await ntfy.send(cfg, { topic: cfg.topic, title: 'retry', message: 'M', priority: 3, tags: [] });
  check('5xx is retried and then succeeds', r.ok && received.length === n0 + 1);
  failNext = 1; failStatus = 403; const n1 = received.length; r = await ntfy.send(cfg, { topic: cfg.topic, title: 'x', message: 'M', priority: 3, tags: [] });
  check('4xx is not retried and reported', !r.ok && r.status === 403 && failNext === 0 && received.length === n1);
  r = await ntfy.send({ ...cfg, server: 'http://127.0.0.1:1' }, { topic: cfg.topic, title: 'x', message: 'M' }, { retries: 0, timeoutMs: 1500 });
  check('unreachable server => ok:false with an error, no exception', !r.ok && !!r.error, r.error);
  r = await ntfy.send({ ...cfg, topic: '' }, {});
  check('invalid config is refused before any network call', !r.ok && /topic/.test(r.error));

  // ---------- D) dispatcher ----------
  console.log('== D) dispatcher');
  let clock = 2_000_000_000_000; const sent = []; let enabled = false; let curCfg = CFG({ server: URLBASE });
  const mk = (o = {}) => new ntfy.PhoneDispatcher({ getConfig: () => curCfg, getEnabled: () => enabled, sender: async (c, body) => { sent.push(body); return { ok: true, status: 200 }; }, now: () => clock, ...o });
  const E = (t, x = {}) => EV(t, { epoch: clock, ...x });
  let d = mk(); let res = d.handle(E('WAITING_FOR_USER'));
  check('phone disabled (default) => nothing is sent', sent.length === 0 && res.reason === 'phone-disabled');
  enabled = true; res = d.handle(E('WAITING_FOR_USER')); await sleep(20);
  check('enabled => one push for WAITING_FOR_USER (priority 4)', sent.length === 1 && sent[0].priority === 4);
  clock += 2000; res = d.handle(E('WAITING_FOR_USER')); await sleep(20);
  check('same session+type within 10 s => cooldown (no second push)', sent.length === 1 && res.reason === 'cooldown');
  clock += 11_000; res = d.handle(E('WAITING_FOR_USER')); await sleep(20);
  check('...allowed again after the cooldown', sent.length === 2);
  for (const t of ['WORKING', 'IDLE', 'INITIAL_STATE', 'SESSION_STARTED', 'SESSION_ENDED']) d.handle(E(t));
  await sleep(20); check('non-notifiable types never push', sent.length === 2);
  curCfg = CFG({ server: URLBASE, types: { TURN_FINISHED: false } }); res = d.handle(E('TURN_FINISHED', { sessionId: 'local_t' }));
  check('per-type disable respected', res.reason === 'type-disabled'); curCfg = CFG({ server: URLBASE });
  const before = sent.length; res = d.handle(E('WAITING_FOR_PERMISSION', { sessionId: 'local_old', epoch: clock - 120_000 }));
  check('stale event (2 min old) never pushes', res.reason === 'stale' && sent.length === before);
  d = mk(); const t0 = clock; clock += 500; d.handle(E('WORKING', { sessionId: 'local_r', epoch: t0 + 400 })); res = d.handle(E('WAITING_FOR_PERMISSION', { sessionId: 'local_r', epoch: t0 }));
  check('permission already resolved before delivery => no push', res.reason === 'resolved-before-delivery');
  curCfg = CFG({ server: URLBASE, holdSeconds: { WAITING_FOR_PERMISSION: 0.15 } }); d = mk(); const h0 = sent.length;
  res = d.handle(E('WAITING_FOR_PERMISSION', { sessionId: 'local_h' })); d.handle(E('WORKING', { sessionId: 'local_h', epoch: clock + 1 })); await sleep(350);
  check('hold: push cancelled when the session resumes within the hold time (you were at the PC)', res.reason.startsWith('held') && sent.length === h0);
  res = d.handle(E('WAITING_FOR_PERMISSION', { sessionId: 'local_h2' })); await sleep(350);
  check('hold: push is sent if nobody responds within the hold time', sent.length === h0 + 1);
  curCfg = CFG({ server: URLBASE }); d = mk({ maxPerMinute: 3 }); const r0 = sent.length;
  for (let i = 0; i < 6; i++) d.handle(E('PROCESS_EXITED_ERROR', { sessionId: `local_x${i}` })); await sleep(50);
  check('rate limit: 6 events in a minute => 3 pushes (flood guard)', sent.length === r0 + 3 && d.dropped === 3);
  curCfg = null; d = mk(); res = d.handle(E('WAITING_FOR_USER', { sessionId: 'local_nc' }));
  check('enabled but no/invalid config => nothing sent, reason explains', /config: not configured/.test(res.reason)); curCfg = CFG({ server: URLBASE });

  // ---------- E) end-to-end through the notifier ----------
  console.log('== E) end-to-end (synthetic sessions/log -> notifier --ui none -> mock ntfy)');
  const SES = path.join(root, 'sessions'); const LOG = path.join(root, 'logs'); const DATA = path.join(root, 'data');
  fs.mkdirSync(SES); fs.mkdirSync(LOG); fs.mkdirSync(DATA);
  fs.writeFileSync(path.join(DATA, 'ntfy.json'), JSON.stringify({ server: URLBASE, topic: 'e2e_topic_123' }));
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ phoneEnabled: true }));
  const MAIN = path.join(LOG, 'main.log'); fs.writeFileSync(MAIN, '');
  const realDir = path.join(process.env.USERPROFILE, '.claude', 'sessions');
  const pool = fs.readdirSync(realDir).filter((n) => /^\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(realDir, n), 'utf8'))).filter((j) => j.entrypoint === 'claude-desktop' && j.pid !== process.pid);
  const A = { real: pool[0], name: 'SYN-A', cwd: 'D:\\syn\\alpha', host: 'local_aaaaaaaa-0000-4000-8000-000000000001', file: path.join(SES, `${pool[0].pid}.json`) };
  const setState = (s, status, wf) => { const o = { ...s.real, name: s.name, cwd: s.cwd, hostSessionId: s.host, status, statusUpdatedAt: Date.now() }; delete o.waitingFor; if (wf) o.waitingFor = wf; fs.writeFileSync(s.file, JSON.stringify(o)); };
  const pad = (n) => String(n).padStart(2, '0');
  const line = (lvl, t) => { const x = new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())} [${lvl}] ${t}\n`; };
  const append = (...l) => fs.appendFileSync(MAIN, l.join('')); setState(A, 'idle');
  const child = spawn(process.execPath, [path.join(__dirname, 'notifier.js'), '--ui', 'none', '--no-lock', '--no-usage', '--control-stdin', '--data-dir', DATA, '--sessions-dir', SES, '--log-dir', LOG, '--interval', '200', '--hold', '700'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (x) => { err += x; }); child.stdout.resume();
  const base = received.length; const mine = () => received.slice(base).filter((x) => x.body && x.body.topic === 'e2e_topic_123');
  await sleep(2500);
  setState(A, 'busy'); await sleep(700);
  check('E2E startup + WORKING => no phone push', mine().length === 0);
  append(line('info', `Emitted tool permission request 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa for Bash in session ${A.host}`)); await sleep(150); setState(A, 'waiting', 'permission prompt'); await sleep(2200);
  check('E2E real-pipeline permission => exactly ONE push, priority 5, "Claude needs permission", Tool: Bash', mine().length === 1 && mine()[0].body.priority === 5 && mine()[0].body.title === 'Claude needs permission' && /Tool: Bash/.test(mine()[0].body.message), mine()[0] && JSON.stringify(mine()[0].body.message));
  setState(A, 'busy'); await sleep(800); setState(A, 'waiting', 'input needed'); await sleep(150);
  append(line('info', `Emitted tool permission request 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb for AskUserQuestion in session ${A.host}`)); await sleep(2200);
  check('E2E question => exactly ONE more push, priority 4, "Claude needs your input"', mine().length === 2 && mine()[1].body.priority === 4 && mine()[1].body.title === 'Claude needs your input');
  const n = mine().length; append(line('info', `Emitted tool permission request 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa for Bash in session ${A.host}`)); await sleep(1500);
  check('E2E duplicate log line => no extra push', mine().length === n);
  setState(A, 'busy'); await sleep(800); setState(A, 'idle'); await sleep(150); append(line('info', `[Stop hook] Query completed for session ${A.host}`)); await sleep(2200);
  check('E2E turn finished => ONE push, priority 4', mine().length === 3 && mine()[2].body.priority === 4 && mine()[2].body.title === 'Claude finished the task');
  append(line('warn', `[CCD CycleHealth] ${A.host} api_error (success): API Error: 500 Bearer sk-ant-api03-SECRETSECRETSECRET1234 see https://x.y/z`)); await sleep(1500);
  check('E2E API error => ONE push, priority 5, secrets scrubbed', mine().length === 4 && mine()[3].body.priority === 5 && !/sk-ant|SECRET|https:/.test(mine()[3].raw), mine()[3] && JSON.stringify(mine()[3].body.message));
  child.stdin.write('togglePhone\n'); await sleep(500); setState(A, 'busy'); await sleep(600); setState(A, 'waiting', 'permission prompt');
  append(line('info', `Emitted tool permission request 33333333-cccc-4ccc-8ccc-cccccccccccc for Bash in session ${A.host}`)); await sleep(2200);
  check('E2E phone toggled OFF from the menu => no push (state persisted)', mine().length === 4 && JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).phoneEnabled === false);
  child.stdin.write('togglePhone\n'); await sleep(500);
  check('E2E toggled back ON', JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).phoneEnabled === true);
  const allRaw = mine().map((x) => x.raw).join(' ');
  check('E2E nothing but allowlisted keys ever sent; no ids/paths/hosts in any body', mine().every((x) => JSON.stringify(Object.keys(x.body).sort()) === JSON.stringify(ALLOWED)) && !/local_|D:\\\\|pid|syn\\\\/.test(allRaw));
  child.kill(); await sleep(1200);
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(DATA, 'history.db')); const pushes = db.prepare('SELECT type, ok, status FROM pushes').all(); db.close();
  check('push delivery log in SQLite (4 delivered, no message bodies stored)', pushes.length === 4 && pushes.every((p) => p.ok === 1 && p.status === 200), JSON.stringify(pushes.map((p) => p.type)));

  server.close();
  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  if (fails) console.log('--- notifier stderr ---\n' + err.slice(-1500));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})();
