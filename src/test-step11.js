#!/usr/bin/env node
/**
 * test-step11.js — Task 3, stage 1: the onboarding state machine and the ntfy configuration lifecycle (onboarding.js, ntfy.js additions).
 * Everything runs in scratch folders next to the source tree with a fake sender: nothing real is sent, and your own
 * %USERPROFILE%\.claude-notifier is never touched.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ntfy = require('./ntfy');
const onb = require('./onboarding');
const { Store } = require('./store');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const P = __dirname;
const ROOT = path.resolve(P, '..', 'onb-test11');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const TOPIC_RE = /^claude-[a-hj-km-np-z2-9]{16}$/;
const cfgPath = (dir) => path.join(dir, 'ntfy.json');

let n = 0;
/** a fresh data folder + real settings store + onboarding controller with a scripted sender and a controllable clock */
function mk(opts = {}) {
  const dir = path.join(ROOT, `d${++n}`); fs.mkdirSync(dir, { recursive: true });
  const store = new Store(dir);
  const clock = { t: 1_800_000_000_000 };
  const sent = []; const logs = [];
  let reply = { ok: true, status: 200 };
  const send = async (cfg, body, o) => { sent.push({ cfg, body, o }); return typeof reply === 'function' ? reply(cfg, body) : reply; };
  const o = new onb.Onboarding({ dir, store, send, now: () => clock.t, log: (m) => logs.push(m), ...opts });
  return { dir, store, o, clock, sent, logs, setReply: (r) => { reply = r; }, reopen: () => { store.close(); const s2 = new Store(dir); return { store: s2, o: new onb.Onboarding({ dir, store: s2, send, now: () => clock.t, log: (m) => logs.push(m) }) }; } };
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });

  // =========================================================================================================
  console.log('== A) configuration lifecycle: created on this machine, never overwritten');
  let m = mk();
  check('before first launch there is no ntfy.json and the state is "new"', !fs.existsSync(cfgPath(m.dir)) && m.o.state() === 'new');
  const r1 = m.o.ensureConfig();
  check('ensureConfig creates ntfy.json with a random topic generated here', r1.status === 'created' && fs.existsSync(cfgPath(m.dir)));
  const c1 = JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8'));
  check('topic format claude-<16 look-alike-free chars>; server ntfy.sh over https; no token; session titles OFF', TOPIC_RE.test(c1.topic) && c1.server === 'https://ntfy.sh' && c1.token === null && c1.includeSessionTitle === false && c1.configVersion === 2);
  check('phone notifications are OFF after creation', m.store.settings.phoneEnabled !== true);
  const h1 = sha(cfgPath(m.dir));
  check('a second ensureConfig leaves the file byte-identical (never regenerated)', m.o.ensureConfig().status === 'ok' && sha(cfgPath(m.dir)) === h1);
  check('no temporary file is left next to ntfy.json (atomic write)', fs.readdirSync(m.dir).every((f) => !/\.tmp$/.test(f)));
  const topics = new Set(); for (let i = 0; i < 400; i++) { const d = path.join(ROOT, `u${i}`); ntfy.initConfig(d); topics.add(JSON.parse(fs.readFileSync(cfgPath(d), 'utf8')).topic); }
  check('400 fresh installations => 400 different, well-formed topics', topics.size === 400 && [...topics].every((t) => TOPIC_RE.test(t)));
  const chars = new Set([...topics].flatMap((t) => [...t.slice(7)])); check('the random part uses the whole 31-character alphabet (no stuck or biased generator)', chars.size >= 29, `${chars.size} distinct`);
  const shippedFiles = fs.readdirSync(P).filter((f) => /\.(js|ps1|vbs)$/.test(f) && !/^test-/.test(f));
  const embedded = shippedFiles.filter((f) => /claude-[a-hj-km-np-z2-9]{16}\b/.test(fs.readFileSync(path.join(P, f), 'utf8')));
  check('no topic-shaped string and no ntfy.json is embedded in any shipped source file', embedded.length === 0 && !fs.existsSync(path.join(P, 'ntfy.json')), embedded.join(','));
  m.store.close();

  // corrupt / invalid / unreadable
  for (const [label, content, expect] of [['truncated JSON', '{"server":"https://ntfy.sh","topic":"claude-abc', 'corrupt'], ['empty file', '', 'corrupt'], ['JSON array', '[1,2]', 'corrupt'], ['JSON string', '"x"', 'corrupt'], ['topic with illegal characters', JSON.stringify({ server: 'https://ntfy.sh', topic: 'bad topic!' }), 'invalid'], ['missing topic', JSON.stringify({ server: 'https://ntfy.sh' }), 'invalid'], ['insecure server', JSON.stringify({ server: 'http://example.com', topic: 'claude-abcdefghjkmnpqrs' }), 'invalid']]) {
    m = mk(); fs.writeFileSync(cfgPath(m.dir), content); const hb = sha(cfgPath(m.dir));
    const e = m.o.ensureConfig(); const st = await m.o.sendTest(); const rot = m.o.rotateTopic();
    check(`${label} => reported as "${expect}", file NOT touched, nothing sent, rotation refused`, e.status === 'problem' && e.problem === expect && sha(cfgPath(m.dir)) === hb && m.sent.length === 0 && st.ok === false && st.kind === 'config' && rot.ok === false);
    m.store.close();
  }
  m = mk(); fs.mkdirSync(cfgPath(m.dir));      // a folder where the file should be
  check('an unreadable ntfy.json (a folder in its place) => "unreadable", nothing replaced', m.o.ensureConfig().problem === 'unreadable' && fs.statSync(cfgPath(m.dir)).isDirectory());
  m.store.close();
  m = mk(); fs.writeFileSync(cfgPath(m.dir), '{broken'); m.store.setSetting('phoneEnabled', true);
  const orig = fs.readFileSync(cfgPath(m.dir));
  const rec = m.o.recoverConfig();
  check('"Start over" (explicit action) keeps the broken file as a backup with identical bytes', rec.ok && /^ntfy\.json\.corrupt-\d{14}$/.test(rec.backup) && Buffer.compare(fs.readFileSync(path.join(m.dir, rec.backup)), orig) === 0);
  check('...creates a valid new configuration and switches phone notifications OFF', ntfy.inspectConfig(m.dir).problem === null && TOPIC_RE.test(JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8')).topic) && m.store.settings.phoneEnabled === false && m.o.state() === 'in-progress');
  check('recoverConfig on a healthy configuration does nothing', m.o.recoverConfig().ok === false);
  m.store.close();

  // =========================================================================================================
  console.log('== B) topic rotation');
  m = mk(); m.o.ensureConfig();
  const custom = JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8')); custom.priorities = { TURN_FINISHED: 5 }; custom.includeSessionTitle = true; custom.extra = 'keep me'; fs.writeFileSync(cfgPath(m.dir), JSON.stringify(custom));
  const oldTopic = custom.topic; m.store.setSetting('phoneEnabled', true); m.o._set({ state: 'confirmed', confirmedAt: 1 });
  const rt = m.o.rotateTopic(); const after = JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8'));
  check('rotation creates a different, well-formed topic', rt.ok && after.topic !== oldTopic && TOPIC_RE.test(after.topic));
  check('...changes ONLY the topic: every other stored choice is kept', after.priorities.TURN_FINISHED === 5 && after.includeSessionTitle === true && after.extra === 'keep me' && after.server === custom.server);
  check('...turns phone notifications OFF and requires a new confirmation', m.store.settings.phoneEnabled === false && m.o.state() === 'in-progress' && !m.o.isConfirmed());
  check('...and explains that the old subscription stops working', /old topic will stop working/.test(rt.notice) && /OFF/.test(rt.notice) && !rt.notice.includes(after.topic) && !rt.notice.includes(oldTopic));
  check('the tray toggle cannot switch phone push back on until the new setup is confirmed', m.o.setPhoneEnabled(true).ok === false);
  check('rotation leaves no temporary file', fs.readdirSync(m.dir).every((f) => !/\.tmp$/.test(f)));
  m.store.close();

  // =========================================================================================================
  console.log('== C) the state machine: phone push only after an explicit confirmation');
  m = mk(); m.o.ensureConfig();
  check('a new installation: state "new", the setup window should open by itself', m.o.state() === 'new' && m.o.shouldAutoOpen() === true && m.o.trayLabel() === 'Set up phone notifications…');
  m.o.markAutoOpened();
  check('after it opened once: state "in-progress" and it will NOT open by itself again', m.o.state() === 'in-progress' && m.o.shouldAutoOpen() === false);
  let re = m.reopen();
  check('...that survives a restart (settings are persisted)', re.o.state() === 'in-progress' && re.o.shouldAutoOpen() === false); re.store.close();
  m = mk(); m.o.ensureConfig(); m.o.markAutoOpened(); m.o.dismiss();
  check('dismissed: stays off, does not interrupt again, tray still offers the setup', m.o.state() === 'dismissed' && m.o.shouldAutoOpen() === false && /Set up phone/.test(m.o.trayLabel()) && m.store.settings.phoneEnabled !== true);
  m.o.opened(); check('...and the tray item reopens it (dismissed -> in-progress)', m.o.state() === 'in-progress');
  check('"I got it" without any test => refused, push stays OFF', m.o.confirm().ok === false && m.o.confirm().reason === 'no-test' && m.store.settings.phoneEnabled !== true);
  check('turning phone push on from the tray before confirmation is refused', m.o.setPhoneEnabled(true).ok === false && m.o.setPhoneEnabled(true).reason === 'not-confirmed');
  const t1 = await m.o.sendTest();
  check('a test the server ACCEPTED (HTTP 200) => state "test-sent", but phone push is STILL OFF (200 is not delivery)', t1.ok && t1.kind === 'accepted' && m.o.state() === 'test-sent' && m.store.settings.phoneEnabled !== true && !m.o.isConfirmed());
  check('...and the wording does not claim delivery', !/delivered|received/i.test(t1.title) && /look at your phone/i.test(t1.text));
  check('the test message sent is the generic allowlisted one (no project, session or path)', m.sent.length === 1 && JSON.stringify(Object.keys(m.sent[0].body).sort()) === JSON.stringify(['message', 'priority', 'tags', 'title', 'topic']) && /not a Claude event/.test(m.sent[0].body.message) && m.sent[0].body.title === 'Claude Notifier: test');
  const c = m.o.confirm();
  check('"I got it" after an accepted test => confirmed, and ONLY now phone push turns on', c.ok && m.o.isConfirmed() && m.store.settings.phoneEnabled === true && m.o.record.confirmedAt > 0);
  re = m.reopen(); check('...persisted across a restart', re.o.isConfirmed() && re.store.settings.phoneEnabled === true && re.o.shouldAutoOpen() === false && re.o.trayLabel() === 'Phone setup…'); re.store.close();
  check('a confirmed setup can be turned off and on again from the tray', m.o.setPhoneEnabled(false).ok && m.store.settings.phoneEnabled === false && m.o.isConfirmed() && m.o.setPhoneEnabled(true).ok && m.store.settings.phoneEnabled === true);
  check('dismiss() on a confirmed setup changes nothing', (m.o.dismiss(), m.o.isConfirmed()));
  m.store.close();

  m = mk(); m.o.ensureConfig(); await m.o.sendTest(); m.clock.t += 31 * 60_000;
  check('a confirmation more than 30 minutes after the accepted test is refused (a new test is required)', m.o.confirm().ok === false && m.o.confirm().reason === 'test-too-old' && m.store.settings.phoneEnabled !== true);
  m.store.close();
  m = mk(); m.o.ensureConfig(); await m.o.sendTest(); m.o.reject();
  check('"I didn\'t get it" => state "test-failed", push stays OFF, the earlier acceptance no longer counts', m.o.state() === 'test-failed' && m.store.settings.phoneEnabled !== true && m.o.confirm().ok === false);
  m.clock.t += 11_000; await m.o.sendTest();
  check('...a new accepted test leads back to "test-sent" and can then be confirmed', m.o.state() === 'test-sent' && m.o.confirm().ok === true);
  m.store.close();
  m = mk(); m.o.ensureConfig(); m.store.setSetting('phoneSetup', { state: 'test-sent' });
  check('a hand-edited "test-sent" without a recorded accepted test cannot be confirmed', m.o.confirm().ok === false && m.store.settings.phoneEnabled !== true);
  m.store.setSetting('phoneSetup', { state: 'confirmed' });
  check('setPhoneEnabled needs a VALID configuration even when the state says confirmed', (fs.writeFileSync(cfgPath(m.dir), '{bad'), m.o.setPhoneEnabled(true).ok === false));
  m.store.close();
  m = mk(); m.o.ensureConfig(); await m.o.sendTest();
  fs.writeFileSync(cfgPath(m.dir), '{bad');
  check('confirm() refuses when the configuration became unusable after the test', m.o.confirm().ok === false && m.o.confirm().reason === 'config' && m.store.settings.phoneEnabled !== true);
  m.store.close();

  // =========================================================================================================
  console.log('== D) existing installations are never interrupted; CLI-created configurations are respected');
  m = mk(); ntfy.initConfig(m.dir); m.store.setSetting('phoneEnabled', true);
  let rc = m.o.reconcile();
  check('valid configuration + phone push already ENABLED (your own installation) => silently "confirmed", no window', rc.legacy && m.o.isConfirmed() && m.o.shouldAutoOpen() === false && m.store.settings.phoneEnabled === true && m.o.record.legacy === true);
  check('...nothing was changed in the configuration', m.o.ensureConfig().status === 'ok');
  m.store.close();
  m = mk(); fs.writeFileSync(cfgPath(m.dir), '{broken'); m.store.setSetting('phoneEnabled', true);
  rc = m.o.reconcile();
  check('enabled but the configuration is corrupt => NOT treated as confirmed, file untouched, setup will report the problem', !rc.legacy && !m.o.isConfirmed() && fs.readFileSync(cfgPath(m.dir), 'utf8') === '{broken');
  m.store.close();
  m = mk(); ntfy.initConfig(m.dir); const topicCli = JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8')).topic;
  rc = m.o.reconcile();
  check('a configuration made earlier with --ntfy-init but never enabled => the setup runs and KEEPS that topic', !rc.legacy && m.o.shouldAutoOpen() && m.o.ensureConfig().status === 'ok' && JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8')).topic === topicCli);
  m.store.close();
  m = mk(); rc = m.o.reconcile();
  check('a brand-new profile (no config, push off) => not legacy, setup opens', !rc.legacy && m.o.shouldAutoOpen());
  m.store.close();

  // =========================================================================================================
  console.log('== E) failures are explained in plain words; the test sender is rate limited');
  const cases = [[{ ok: false, error: 'timeout' }, 'network'], [{ ok: false, error: 'ENOTFOUND' }, 'network'], [{ ok: false, error: 'ECONNREFUSED' }, 'network'], [{ ok: false, error: 'fetch failed' }, 'network'], [{ ok: false, error: 'EAI_AGAIN' }, 'network'],
    [{ ok: false, error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, 'tls'], [{ ok: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' }, 'tls'], [{ ok: false, status: 429, error: 'HTTP 429' }, 'rate-limited'], [{ ok: false, status: 503, error: 'HTTP 503' }, 'server-down'],
    [{ ok: false, status: 403, error: 'HTTP 403' }, 'server-auth'], [{ ok: false, status: 401, error: 'HTTP 401' }, 'server-auth'], [{ ok: false, status: 400, error: 'HTTP 400' }, 'server-rejected'], [{ ok: false, error: 'something odd' }, 'unknown']];
  for (const [reply, kind] of cases) {
    m = mk(); m.o.ensureConfig(); m.setReply(reply); const r = await m.o.sendTest(); const topic = JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8')).topic;
    check(`send failure ${JSON.stringify(reply.status || reply.error)} => "${kind}" with a friendly message, push stays OFF`, r.ok === false && r.kind === kind && r.title && r.text && m.o.state() !== 'test-sent' && m.store.settings.phoneEnabled !== true && !JSON.stringify(r).includes(topic));
    m.store.close();
  }
  m = mk(); m.o.ensureConfig(); m.setReply({ ok: false, error: 'connect ECONNREFUSED https://ntfy.sh/claude-abcdefghjkmnpqrs Bearer tk_secret123' });
  const leak = await m.o.sendTest();
  check('error text from the network layer is never echoed to the user (no URL, topic or token in the message)', !/https?:|claude-abc|tk_secret|Bearer/.test(JSON.stringify(leak)));
  m.store.close();
  m = mk(); m.o.ensureConfig();
  const a1 = await m.o.sendTest(); const a2 = await m.o.sendTest();
  check('a second test within 10 s is refused locally (nothing sent), with the seconds to wait', a1.ok && a2.ok === false && a2.kind === 'too-soon' && a2.waitSec >= 1 && a2.waitSec <= 10 && m.sent.length === 1);
  m.clock.t += 10_001; const a3 = await m.o.sendTest();
  check('...and allowed again after 10 s', a3.ok && m.sent.length === 2);
  for (let i = 0; i < 8; i++) { m.clock.t += 11_000; await m.o.sendTest(); }
  m.clock.t += 11_000; const a4 = await m.o.sendTest();
  check('at most 10 tests per run (then "limit"), far below the ntfy.sh limits', m.sent.length === 10 && a4.kind === 'limit' && m.o.view().canSendTest === false);
  m.store.close();
  m = mk(); m.o.ensureConfig(); m.setReply(() => { throw new Error('boom'); });
  const thrown = await m.o.sendTest();
  check('a sender that THROWS is turned into a friendly failure (no exception reaches the window), push stays OFF', thrown.ok === false && !!thrown.title && m.o.state() !== 'test-sent' && m.store.settings.phoneEnabled !== true);
  m.store.close();

  // =========================================================================================================
  console.log('== F) privacy: the topic stays out of logs and of everything except the window\'s own view');
  m = mk(); m.o.ensureConfig(); m.o.reconcile(); m.o.markAutoOpened(); await m.o.sendTest(); m.o.reject(); m.clock.t += 11_000; await m.o.sendTest(); m.o.confirm(); m.o.rotateTopic();
  const tp = JSON.parse(fs.readFileSync(cfgPath(m.dir), 'utf8')).topic;
  check('a complete run (open, test, reject, test, confirm, rotate) writes log lines that never contain the topic, a deep link or a URL', m.logs.length >= 6 && !m.logs.join('\n').includes(tp) && !/ntfy:\/\/|https?:\/\//.test(m.logs.join('\n')), `${m.logs.length} log lines`);
  check('the log lines name states only', m.logs.every((l) => /^phone setup: /.test(l)));
  const vSafe = m.o.view(); const vSecret = m.o.view({ withSecret: true });
  check('the default view model holds neither the topic nor the deep link', !JSON.stringify(vSafe).includes(tp) && vSafe.topic === undefined && vSafe.deepLink === undefined);
  check('the window\'s view (withSecret) carries the topic and a deep link of the form ntfy://ntfy.sh/<topic>', vSecret.topic === tp && vSecret.deepLink === `ntfy://ntfy.sh/${tp}`);
  check('the settings file holds no topic and no token (only the setup state)', !fs.readFileSync(path.join(m.dir, 'settings.json'), 'utf8').includes(tp) && !/token/i.test(fs.readFileSync(path.join(m.dir, 'settings.json'), 'utf8')));
  check('deep link for a plain-http server carries ?secure=false and the port', onb.deepLink({ server: 'http://127.0.0.1:8080', topic: 'claude-abcdefghjkmnpqrs' }) === 'ntfy://127.0.0.1:8080/claude-abcdefghjkmnpqrs?secure=false');
  check('store links are the official Google Play and F-Droid pages of ntfy', onb.PLAY_URL === 'https://play.google.com/store/apps/details?id=io.heckel.ntfy' && onb.FDROID_URL === 'https://f-droid.org/packages/io.heckel.ntfy/');
  m.store.close();

  // =========================================================================================================
  console.log('== G) the checklist wording');
  const ok = onb.rowsFrom({ claudeRunning: true, sessionsDirExists: true, liveSessions: 2, usage: { state: 'fresh' } });
  check('everything fine: three green rows ("Claude Desktop is running", "Watching 2 Claude Code sessions", "Usage numbers are being read")', ok.length === 3 && ok.every((r) => r.level === 'ok') && /running/.test(ok[0].title) && /Watching 2 Claude Code sessions/.test(ok[1].title) && /being read/.test(ok[2].title));
  const bad = onb.rowsFrom({});
  check('nothing found: three warnings, each with a plain instruction, none blocking', bad.length === 3 && bad.every((r) => r.level === 'warn' && r.detail.length > 10));
  check('"Claude Desktop installed but not running", one session, stale usage, ambiguous usage', onb.rowsFrom({ claudeInstalled: true, sessionsDirExists: true, liveSessions: 1, usage: { state: 'stale' } }).map((r) => r.level).join() === 'ok,ok,warn' && /1 Claude Code session$/.test(onb.rowsFrom({ sessionsDirExists: true, liveSessions: 1 })[1].title) && /more than one/i.test(onb.rowsFrom({ usage: { state: 'ambiguous' } })[2].title));
  check('the rows contain no path, no profile folder name and no number from the usage file', !onb.rowsFrom({ claudeRunning: true, sessionsDirExists: true, liveSessions: 3, usage: { state: 'fresh', text: 'Usage: 5-hour 55%' } }).some((r) => /\\|55%|Claude-Data/.test(JSON.stringify(r))));

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
