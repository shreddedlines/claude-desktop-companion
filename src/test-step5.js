#!/usr/bin/env node
/**
 * test-step5.js — SYNTHETIC tests for the plan-usage monitor (Step 5). Uses temp files only:
 * it never reads or writes the real plan-usage-history.json and never touches the real network
 * (phone pushes go to a local mock ntfy server).
 *   A) tracker: threshold crossings, re-arming, duplicate suppression, stale/fresh, persistence, account switch
 *   B) file reader + read-only guarantees
 *   C) policy (Windows toasts) and phone payload integration
 *   D) end-to-end: synthetic history file -> notifier (--ui none) -> toast actions + mock ntfy pushes
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { UsageTracker, UsageMonitor, readLatestSample } = require('./usage-monitor');
const { Policy } = require('./policy');
const ntfy = require('./ntfy');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'step5-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const MIN = 60_000;

(async () => {
// ---------- A) tracker ----------
console.log('== A) tracker');
let clock = 1_800_000_000_000;
const mk = (o = {}) => new UsageTracker({ now: () => clock, ...o });
const S = (fh, sd, extra = {}) => ({ t: clock, fh, sd, org: 'org1', ...extra });
const types = (evs) => evs.map((e) => `${e.type}:${e.usage.window}${e.usage.threshold}`).join(',');

let t = mk();
check('first-ever sample above a threshold is seeded silently (no startup alert)', t.process(S(85, 10)).length === 0);
clock += 5 * MIN; check('...and stays silent while it keeps rising within the same band', t.process(S(86, 10)).length === 0);
clock += 5 * MIN; let ev = t.process(S(92, 10));
check('...but the NEXT threshold (90) still alerts once', ev.length === 1 && ev[0].type === 'USAGE_CRITICAL' && ev[0].usage.threshold === 90, types(ev));

t = mk(); clock += MIN; t.process(S(50, 10));
const seq = [];
for (const v of [79, 80, 81, 85, 89, 90, 91, 95, 100]) { clock += 5 * MIN; seq.push([v, t.process(S(v, 10))]); }
const fired = seq.filter(([, e]) => e.length).map(([v, e]) => `${v}=>${types(e)}`);
check('5-hour: 79 silent, 80 => ONE warning, 81-89 silent, 90 => ONE critical, 91-100 silent (no repeats)', fired.join(' | ') === '80=>USAGE_WARNING:fh80 | 90=>USAGE_CRITICAL:fh90', fired.join(' | '));
const w80 = seq.find(([v]) => v === 80)[1][0];
check('warning event carries window, threshold, value and a numbers-only title', w80.title === '5-hour usage reached 80%' && w80.usage.value === 80 && w80.sessionId === 'usage:fh:80' && !('org' in w80));

t = mk(); clock += MIN; t.process(S(70, 10)); clock += 5 * MIN; ev = t.process(S(95, 10));
check('jump 70 -> 95 gives exactly ONE alert (critical), not two', ev.length === 1 && ev[0].type === 'USAGE_CRITICAL', types(ev));
clock += 5 * MIN; ev = t.process(S(85, 10));
check('drop to 85: 90 re-arms (CLEARED for 90), no new warning because 80 was already consumed', types(ev) === 'USAGE_CLEARED:fh90', types(ev));
clock += 5 * MIN; ev = t.process(S(91, 10));
check('...climbing back to 91 alerts critical again (re-armed)', types(ev) === 'USAGE_CRITICAL:fh90', types(ev));
clock += 5 * MIN; ev = t.process(S(60, 10));
check('drop to 60 clears 90 and re-arms 80 silently', types(ev) === 'USAGE_CLEARED:fh90', types(ev));
clock += 5 * MIN; ev = t.process(S(81, 10));
check('...then 81 warns again', types(ev) === 'USAGE_WARNING:fh80', types(ev));

t = mk(); clock += MIN; t.process(S(50, 50)); clock += 5 * MIN; ev = t.process(S(60, 83));
check('weekly (sd) is tracked independently: 83% weekly warns, 60% 5-hour does not', types(ev) === 'USAGE_WARNING:sd80', types(ev));
clock += 5 * MIN; ev = t.process(S(81, 91));
check('both windows crossing in one sample => two events with distinct ids', ev.length === 2 && new Set(ev.map((e) => e.sessionId)).size === 2, types(ev));

t = mk(); clock += MIN; t.process(S(50, 10)); clock += 5 * MIN; const s80 = S(82, 10);
check('first 82 => 1 alert', t.process(s80).length === 1);
check('same sample processed again (duplicate) => nothing', t.process(s80).length === 0);
check('an OLDER sample than the last processed one is ignored', t.process({ ...s80, t: s80.t - 10 * MIN, fh: 40 }).length === 0);
clock += 5 * MIN; check('a re-read of the same value at a later time => nothing', t.process(S(82, 10)).length === 0);

t = mk(); clock += MIN; t.process(S(50, 10)); clock += 5 * MIN; t.process(S(80, 10));
clock += 5 * MIN; ev = t.process(S(79, 10)); check('80 -> 79 re-arms (CLEARED)', types(ev) === 'USAGE_CLEARED:fh80');
clock += 5 * MIN; ev = t.process(S(80, 10)); check('79 -> 80 warns again', types(ev) === 'USAGE_WARNING:fh80');
clock += 5 * MIN; check('80 -> 80 stays quiet', t.process(S(80, 10)).length === 0);

// stale / fresh
t = mk(); check('no data yet => status "none" with the refresh instruction', t.status().state === 'none' && /tray menu/.test(t.status().hint));
clock += MIN; t.process({ t: clock, fh: 53, sd: 34, org: 'org1' });
clock += 10 * MIN; let st = t.status();
check('fresh data (10 min old): shows both percentages and the age, no hint', st.state === 'fresh' && /5-hour 53%/.test(st.text) && /weekly 34%/.test(st.text) && /updated 10 min ago/.test(st.text) && st.hint === null, st.text);
clock += 30 * MIN; st = t.status();
check('stale data (40 min old): says STALE + age and tells you to open Claude Desktop\'s tray menu', st.state === 'stale' && /STALE/.test(st.text) && /40 min ago/.test(st.text) && /Open Claude Desktop's tray menu to refresh/.test(st.hint), st.text);
clock += 5 * 3600_000; check('very old data shows hours', /5 h \d+ min ago/.test(t.status().text), t.status().text);

t = mk(); clock += MIN; t.process({ t: clock - 4 * 3600_000, fh: 40, sd: 10, org: 'org1' });   // first (old) sample seeds the state
clock += 5 * MIN; ev = t.process({ t: clock - 3 * 3600_000, fh: 95, sd: 10, org: 'org1' });      // newer than the seed, but 3 h old
check('a STALE sample above a threshold never raises an alert (old news)', ev.length === 0);
clock += 5 * MIN; ev = t.process({ t: clock, fh: 96, sd: 10, org: 'org1' });
check('...and does not alert later either (that crossing was already consumed)', ev.length === 0);
clock += 5 * MIN; t.process({ t: clock, fh: 40, sd: 10, org: 'org1' }); clock += 5 * MIN; ev = t.process({ t: clock, fh: 82, sd: 10, org: 'org1' });
check('after dropping below, a fresh 82 alerts normally again', types(ev) === 'USAGE_WARNING:fh80', types(ev));

t = mk(); check('checkStale with no data => no notice', t.checkStale().length === 0);
clock += MIN; t.process({ t: clock, fh: 10, sd: 10, org: 'org1' });
clock += 10 * MIN; check('fresh => no stale notice', t.checkStale().length === 0);
clock += 30 * MIN; ev = t.checkStale();
check('stale (40 min) => ONE stale notice mentioning the age', ev.length === 1 && ev[0].type === 'USAGE_STALE' && /40 min ago/.test(ev[0].details), ev[0] && ev[0].details);
clock += 10 * MIN; check('...and no repeat while it stays stale', t.checkStale().length === 0);
clock += MIN; t.process({ t: clock, fh: 11, sd: 10, org: 'org1' }); clock += 40 * MIN;
check('stale again within 4 h of the last notice => suppressed (no nagging)', t.checkStale().length === 0);
clock += 4 * 3600_000; t.process({ t: clock, fh: 12, sd: 10, org: 'org1' }); clock += 40 * MIN;
check('a new stale episode after the 4 h gap => notified again', t.checkStale().length === 1);

// persistence across restarts
t = mk(); clock += MIN; t.process(S(50, 10)); clock += 5 * MIN; check('(setup) tracker 1 alerts at 82', t.process(S(82, 10)).length === 1);
const saved = JSON.parse(JSON.stringify(t.state)); const t2 = mk({ state: saved });
check('after a restart, the same sample is not alerted again', t2.process(S(82, 10)).length === 0 && t2.process({ ...S(82, 10), t: clock + 1 }).length === 0);
clock += 5 * MIN; check('...nor a slightly higher value in the same band', t2.process(S(86, 10)).length === 0);
clock += 5 * MIN; ev = t2.process(S(50, 10)); check('...but dropping below still re-arms across the restart (CLEARED)', types(ev) === 'USAGE_CLEARED:fh80', types(ev));
clock += 5 * MIN; check('...and the next crossing alerts', t2.process(S(83, 10)).length === 1);

t = mk(); clock += MIN; t.process(S(50, 10)); clock += 5 * MIN; ev = t.process({ t: clock, fh: 95, sd: 10, org: 'orgB' });
check('account switch (different org hash) reseeds silently, no alert for the other account', ev.length === 0);

// ---------- B) file reader + read-only ----------
console.log('== B) file reader / read-only');
const hist = path.join(root, 'plan-usage-history.json');
const writeHist = (samples) => fs.writeFileSync(hist, JSON.stringify({ version: 2, samples }));
writeHist([{ t: 100, org: 'RAW-ORG-ID-1', u: { fh: 5, sd: 6 } }, { t: 300, org: 'RAW-ORG-ID-2', u: { fh: 53, sd: 34, xu: 0 } }, { t: 200, org: 'RAW-ORG-ID-1', u: { fh: 9, sd: 9 } }]);
let r = readLatestSample(hist);
check('reader picks the newest sample by time (not file order)', r.sample && r.sample.t === 300 && r.sample.fh === 53 && r.sample.sd === 34);
check('org id is never exposed (only a short hash)', r.sample.org && r.sample.org !== 'RAW-ORG-ID-2' && r.sample.org.length === 8 && !JSON.stringify(r).includes('RAW-ORG'));
check('missing file => status "missing", no throw', readLatestSample(path.join(root, 'nope.json')).status === 'missing');
fs.writeFileSync(hist + '.bad', '{"version":2,"samples":['); check('half-written / corrupt JSON => "unreadable", no throw', readLatestSample(hist + '.bad').status === 'unreadable');
fs.writeFileSync(hist + '.empty', '{"version":2,"samples":[]}'); check('no samples => "empty"', readLatestSample(hist + '.empty').status === 'empty');
writeHist([{ t: 5, org: 'x', u: {} }]); r = readLatestSample(hist); check('sample without fh/sd => nulls, no crash', r.sample && r.sample.fh === null && r.sample.sd === null);

const nowReal = Date.now();
writeHist([{ t: nowReal - 60_000, org: 'o', u: { fh: 55, sd: 30 } }]);
const before = { h: sha(hist), m: fs.statSync(hist).mtimeMs };
fs.chmodSync(hist, 0o444);                                           // read-only attribute: the monitor must not need write access
const mdir = path.join(root, 'mon'); fs.mkdirSync(mdir); const emitted = [];
const mon = new UsageMonitor({ file: hist, stateFile: path.join(mdir, 'usage-state.json'), emit: (e) => emitted.push(e), pollMs: 100000 });
mon.tick(); mon.tick(); mon.tick();
const after = { h: sha(hist), m: fs.statSync(hist).mtimeMs };
check('monitor works on a READ-ONLY history file and never modifies it (hash + mtime unchanged)', before.h === after.h && before.m === after.m && mon.status().state === 'fresh');
check('monitor writes only its own state file next to the app data (nothing else created)', JSON.stringify(fs.readdirSync(mdir)) === JSON.stringify(['usage-state.json']));
check('repeated ticks on an unchanged file => no events, no re-processing', emitted.length === 0);
fs.chmodSync(hist, 0o666);

// mid-write corruption then recovery
const hist2 = path.join(root, 'h2.json'); const em2 = [];
const fixed = () => Date.now();
fs.writeFileSync(hist2, JSON.stringify({ samples: [{ t: fixed() - 1000, org: 'o', u: { fh: 50, sd: 10 } }] }));
const mon2 = new UsageMonitor({ file: hist2, emit: (e) => em2.push(e), pollMs: 100000 }); mon2.tick();
fs.writeFileSync(hist2, '{"samples":[{"t":'); mon2.tick();
check('mid-write corrupt file: no crash, no events, previous data still shown', em2.length === 0 && mon2.status().state === 'fresh');
fs.writeFileSync(hist2, JSON.stringify({ samples: [{ t: fixed(), org: 'o', u: { fh: 84, sd: 10 } }] })); mon2.tick();
check('...and the next valid write is processed (84% => one warning)', em2.length === 1 && em2[0].type === 'USAGE_WARNING');

// ---------- C) policy + phone ----------
console.log('== C) toasts and phone payloads');
let pclock = 2_000_000_000_000; const settings = { notificationsEnabled: true, soundsEnabled: true };
const mkPol = () => new Policy({ getSettings: () => settings, now: () => pclock });
const UE = (type, w, th, v, o = {}) => ({ type, session: 'Claude usage', project: '?', sessionId: `usage:${w}:${th}`, pid: null, epoch: pclock, source: 'usage-history',
  title: `${w === 'fh' ? '5-hour' : 'Weekly'} usage reached ${th}%`, details: 'x', usage: { window: w, label: w === 'fh' ? '5-hour' : 'Weekly', threshold: th, value: v, sampleAt: pclock - 60_000 }, ...o });
const toasts = (r) => r.actions.filter((a) => a.kind === 'toast');
let pol = mkPol(); let pr = pol.handle(UE('USAGE_WARNING', 'fh', 80, 82));
check('80% => normal (non-persistent) Windows toast with window, percent and data time', toasts(pr).length === 1 && !toasts(pr)[0].persistent && toasts(pr)[0].title === '5-hour usage reached 80%' && /Currently 82% used/.test(toasts(pr)[0].lines[0]) && toasts(pr)[0].sound === 'input');
pr = pol.handle(UE('USAGE_CRITICAL', 'fh', 90, 91)); const crit = toasts(pr)[0];
check('90% => PERSISTENT toast with the attention sound', crit && crit.persistent && crit.title === '5-hour usage reached 90%' && crit.sound === 'attention');
pr = pol.handle(UE('USAGE_CLEARED', 'fh', 90, 40));
check('USAGE_CLEARED retracts the persistent 90% toast and shows nothing', pr.actions.length === 1 && pr.actions[0].kind === 'retract' && pr.actions[0].tags.includes(crit.tag) && !pr.notified);
pol = mkPol(); pr = pol.handle(UE('USAGE_WARNING', 'fh', 80, 81)); const pr2 = pol.handle(UE('USAGE_WARNING', 'sd', 80, 82));
check('5-hour and weekly warnings at the same instant both show (not collapsed by the cooldown)', toasts(pr).length === 1 && toasts(pr2).length === 1);
pol = mkPol(); pr = pol.handle(UE('USAGE_WARNING', 'fh', 80, 81)); pclock += 1000; pr2.x = 0; const dup = pol.handle(UE('USAGE_WARNING', 'fh', 80, 81));
check('same window+threshold re-sent within seconds => cooldown (no duplicate toast)', toasts(dup).length === 0 && dup.reason === 'cooldown');
pol = mkPol(); pr = pol.handle({ type: 'USAGE_STALE', session: 'Claude usage', project: '?', sessionId: 'usage:stale', epoch: pclock, details: '40 min ago', usage: {} });
check('stale notice => toast telling you to open Claude Desktop\'s tray menu', toasts(pr).length === 1 && /stale/i.test(toasts(pr)[0].title) && toasts(pr)[0].lines.join(' ').includes("Open Claude Desktop's tray menu to refresh") && /40 min ago/.test(toasts(pr)[0].lines[0]) && !toasts(pr)[0].persistent);
pol = mkPol(); pr = pol.handle(UE('USAGE_WARNING', 'fh', 80, 81, { title: '<b>evil</b> \\n C:\\secret' }));
check('a title with unsafe characters is rejected (falls back to the fixed title)', toasts(pr)[0].title === 'Claude usage warning');
settings.notificationsEnabled = false; pol = mkPol(); pr = pol.handle(UE('USAGE_WARNING', 'fh', 80, 81)); settings.notificationsEnabled = true;
check('notifications disabled in the tray => no usage toast either', toasts(pr).length === 0);

const cfg = { ...ntfy.DEFAULT_CONFIG, topic: 'testtopic_123', server: 'http://127.0.0.1:1' };
let m = ntfy.buildMessage(UE('USAGE_WARNING', 'fh', 80, 82), cfg);
check('phone: warning => priority 3, title from numbers, body "5-hour usage: 82%"', m && m.priority === 3 && m.title === '5-hour usage reached 80%' && /Claude usage\n5-hour usage: 82%\n\d\d:\d\d:\d\d/.test(m.message), m && JSON.stringify(m.message));
m = ntfy.buildMessage(UE('USAGE_CRITICAL', 'sd', 90, 93), cfg);
check('phone: critical weekly => priority 4, "Weekly usage: 93%"', m.priority === 4 && /Weekly usage: 93%/.test(m.message) && m.title === 'Weekly usage reached 90%');
check('phone: stale and cleared events are NOT pushed', ntfy.buildMessage({ type: 'USAGE_STALE', details: 'x' }, cfg) === null && ntfy.buildMessage(UE('USAGE_CLEARED', 'fh', 80, 10), cfg) === null);
const body = JSON.stringify([ntfy.buildMessage(UE('USAGE_WARNING', 'fh', 80, 82, { details: 'secret org abc', org: 'RAW-ORG' }), { ...cfg, includeSessionTitle: false })]);
check('phone: only allowlisted keys; no org id, ids, or paths (even with session titles off)', !/RAW-ORG|usage:fh|abc|\\\\/.test(body) && JSON.stringify(Object.keys(JSON.parse(body)[0]).sort()) === JSON.stringify(['message', 'priority', 'tags', 'title', 'topic']));
const sent = []; let en = true; let dclock = 3_000_000_000_000; const cfg2 = { ...cfg, holdSeconds: { ...cfg.holdSeconds, USAGE_WARNING: 0.1 } };
const disp = new ntfy.PhoneDispatcher({ getConfig: () => cfg2, getEnabled: () => en, sender: async (c, b) => { sent.push(b); return { ok: true }; }, now: () => dclock });
disp.handle(UE('USAGE_WARNING', 'fh', 80, 82, { epoch: dclock })); disp.handle(UE('USAGE_CLEARED', 'fh', 80, 40, { epoch: dclock + 1 })); await sleep(250);
check('phone hold is cancelled when usage drops back (USAGE_CLEARED)', sent.length === 0);
disp.handle(UE('USAGE_CRITICAL', 'sd', 90, 91, { epoch: dclock })); await sleep(30); disp.handle(UE('USAGE_CRITICAL', 'sd', 90, 92, { epoch: dclock })); await sleep(30);
check('phone: same threshold twice quickly => ONE push', sent.length === 1 && sent[0].priority === 4);
en = false; disp.handle(UE('USAGE_CRITICAL', 'fh', 90, 91, { epoch: dclock })); await sleep(30);
check('phone disabled => no usage push', sent.length === 1);

// ---------- D) end-to-end ----------
console.log('== D) end-to-end (synthetic history file -> notifier --ui none -> toasts + mock ntfy)');
const received = []; const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { received.push(JSON.parse(b)); } catch { /* ignore */ } res.writeHead(200); res.end('{}'); }); });
await new Promise((rr) => server.listen(0, '127.0.0.1', rr)); const URLBASE = `http://127.0.0.1:${server.address().port}`;
const DATA = path.join(root, 'data'); const SES = path.join(root, 'sessions'); const LOG = path.join(root, 'logs'); fs.mkdirSync(DATA); fs.mkdirSync(SES); fs.mkdirSync(LOG); fs.writeFileSync(path.join(LOG, 'main.log'), '');
fs.writeFileSync(path.join(DATA, 'ntfy.json'), JSON.stringify({ server: URLBASE, topic: 'e2e_usage_topic' })); fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ phoneEnabled: true }));
const HF = path.join(root, 'e2e-history.json'); let lastWritten = '';
const samples = []; const addSample = (fh, sd) => { samples.push({ t: Date.now(), org: 'e2e-org', u: { fh, sd } }); lastWritten = JSON.stringify({ version: 2, samples }); fs.writeFileSync(HF, lastWritten); };
addSample(50, 30);
const acts = []; let err = '';
const child = spawn(process.execPath, [path.join(__dirname, 'notifier.js'), '--ui', 'none', '--no-lock', '--data-dir', DATA, '--sessions-dir', SES, '--log-dir', LOG, '--interval', '300',
  '--usage-file', HF, '--usage-poll-ms', '200', '--usage-fresh-ms', '5000', '--usage-stale-gap-ms', '600000'], { stdio: ['ignore', 'pipe', 'pipe'] });
let ob = ''; child.stdout.on('data', (x) => { ob += x; let i; while ((i = ob.indexOf('\n')) >= 0) { try { acts.push(JSON.parse(ob.slice(0, i))); } catch { /* ignore */ } ob = ob.slice(i + 1); } });
child.stderr.on('data', (x) => { err += x; });
const U = (re) => acts.filter((a) => a.cmd === 'toast' && re.test(a.tag)); const pushes = (re) => received.filter((p) => re.test(p.title));
await sleep(3000);
check('startup with fresh 50%/30% => no toast, no push (seeded)', acts.length === 0 && received.length === 0);
addSample(82, 30); await sleep(1500);
check('5-hour 82% => ONE normal toast "5-hour usage reached 80%" + ONE phone push (priority 3)', U(/^USAGE_WARNING/).length === 1 && !U(/^USAGE_WARNING/)[0].persistent && U(/^USAGE_WARNING/)[0].title === '5-hour usage reached 80%' && pushes(/5-hour usage reached 80%/).length === 1 && pushes(/5-hour usage reached 80%/)[0].priority === 3, `toasts=${U(/^USAGE_WARNING/).length} pushes=${received.length}`);
const n1 = acts.length, p1 = received.length; addSample(83, 30); addSample(85, 30); addSample(86, 31); await sleep(1500);
check('further samples in the same band (83, 85, 86) => no new toasts or pushes', acts.length === n1 && received.length === p1);
addSample(91, 31); await sleep(1500);
check('91% => ONE persistent toast + ONE push (priority 4)', U(/^USAGE_CRITICAL/).length === 1 && U(/^USAGE_CRITICAL/)[0].persistent && pushes(/5-hour usage reached 90%/).length === 1 && pushes(/5-hour usage reached 90%/)[0].priority === 4);
const n2 = acts.length, p2 = received.length; addSample(93, 31); addSample(95, 31); await sleep(1500);
check('92-95% => nothing more (no repeated alerts for the same threshold)', acts.length === n2 && received.length === p2);
addSample(95, 82); await sleep(1500);
check('weekly 82% => its own toast + push', U(/^USAGE_WARNING/).length === 2 && pushes(/Weekly usage reached 80%/).length === 1);
addSample(40, 82); await sleep(1500);
check('5-hour drops to 40% => the persistent 90% toast is retracted (no new toast, no push)', acts.some((a) => a.cmd === 'retract' && a.tags.some((tg) => /^USAGE_CRITICAL/.test(tg))) && U(/^USAGE_CRITICAL/).length === 1 && received.length === 3, `pushes=${received.length}`);
await sleep(10_500);                                                    // outlast the 10 s phone/desktop cooldown for the same threshold
addSample(86, 82); await sleep(1500);
check('re-armed: back up to 86% => a NEW 80% warning (toast + push)', U(/^USAGE_WARNING/).length === 3 && pushes(/5-hour usage reached 80%/).length === 2, `toasts=${U(/^USAGE_WARNING/).length}`);
check('the app never modified the history file (content identical to what the test wrote)', fs.readFileSync(HF, 'utf8') === lastWritten);
await sleep(5500);                                                      // > fresh window (5 s) with no new sample
const stale1 = U(/^USAGE_STALE/);
check('no new sample for >5 s => exactly ONE stale toast telling you to open the tray menu; no phone push for it', stale1.length === 1 && stale1[0].lines.join(' ').includes("Open Claude Desktop's tray menu to refresh") && !received.some((p) => /stale/i.test(p.title)));
await sleep(3000); check('...and it does not repeat while data stays stale', U(/^USAGE_STALE/).length === 1);
addSample(87, 82); await sleep(1500); const nAfterFresh = acts.length;
check('fresh data again => no further alert (87% is in the already-alerted band)', U(/^USAGE_WARNING/).length === 3);
await sleep(6000);
check('stale again inside the 10 min notice gap => suppressed (no nagging)', U(/^USAGE_STALE/).length === 1 && acts.length >= nAfterFresh);
child.kill(); await sleep(1200); server.close();
const ust = JSON.parse(fs.readFileSync(path.join(DATA, 'usage-state.json'), 'utf8'));
check('usage-state.json persisted (armed/alerted flags, no raw org id)', ust.v === 1 && ust.windows.fh && !JSON.stringify(ust).includes('e2e-org'));
const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(DATA, 'history.db')); const rows = db.prepare("SELECT type, notified FROM events WHERE type LIKE 'USAGE_%'").all(); db.close();
check('usage events recorded in the history database', rows.some((x) => x.type === 'USAGE_WARNING' && x.notified === 1) && rows.some((x) => x.type === 'USAGE_CRITICAL') && rows.some((x) => x.type === 'USAGE_CLEARED') && rows.some((x) => x.type === 'USAGE_STALE'), JSON.stringify(rows.reduce((a, x) => { a[x.type] = (a[x.type] || 0) + 1; return a; }, {})));

const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
if (fails) console.log('--- notifier stderr ---\n' + err.slice(-1500));
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
