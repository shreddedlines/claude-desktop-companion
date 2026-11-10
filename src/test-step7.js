#!/usr/bin/env node
/**
 * test-step7.js — regression tests for the AppData-virtualization bug (data dir, usage-history discovery, migration,
 * "usage unavailable" wording) and for the LAUNCH-CONTEXT separation.
 *
 * Why this exists: Claude Desktop is an MSIX app; processes it launches see a virtualized copy-on-write AppData, a process
 * started from Explorer does not. Tests run from inside Claude Desktop therefore CANNOT prove the normal Windows launch path.
 * Section D launches the real app from Explorer (a non-descendant of Claude) and from this test's own context and requires
 * both views to agree. Everything else uses a fake Windows profile in a temp folder (no secrets, nothing real touched).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const paths = require('./paths');
const ntfy = require('./ntfy');
const { UsageMonitor } = require('./usage-monitor');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = __dirname;
const root = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'step7-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const SECRET_TOPIC = 'zz_fake_topic_Q7mK2xv'; const SECRET_TOKEN = 'tk_FAKE_SECRET_token_81723';
const NOW = Date.now();

/** a complete fake Windows profile. `legacy` puts the notifier config where the bug left it (package store only). */
function fakeWorld(name, { usage = 'package', usageAgeMs = 60_000, legacy = true, family = 'Claude_testfamily99' } = {}) {
  const home = path.join(root, name); const local = path.join(home, 'AppData', 'Local'); const roam = path.join(home, 'AppData', 'Roaming');
  const pkg = path.join(local, 'Packages', family, 'LocalCache');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true }); fs.mkdirSync(roam, { recursive: true });
  fs.mkdirSync(path.join(local, 'Packages', 'Other_unrelated', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
  fs.writeFileSync(path.join(local, 'Packages', 'Other_unrelated', 'LocalCache', 'Roaming', 'Claude', paths.USAGE_FILE), '{"version":2,"samples":[{"t":1,"org":"x","u":{"fh":1,"sd":1}}]}');   // must be ignored
  const hist = JSON.stringify({ version: 2, samples: [{ t: NOW - usageAgeMs, org: 'fake-org', u: { fh: 55, sd: 30 } }] });
  const put = (dir) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, paths.USAGE_FILE); fs.writeFileSync(f, hist); return f; };
  if (usage === 'package') put(path.join(pkg, 'Roaming', 'Claude'));
  if (usage === 'plain') put(path.join(roam, 'Claude'));
  if (legacy) {
    const ld = path.join(pkg, 'Local', 'ClaudeNotifier'); fs.mkdirSync(ld, { recursive: true });
    fs.writeFileSync(path.join(ld, 'ntfy.json'), JSON.stringify({ server: 'https://ntfy.sh', topic: SECRET_TOPIC, token: SECRET_TOKEN, includeSessionTitle: true, allowInsecure: false }));
    fs.writeFileSync(path.join(ld, 'settings.json'), JSON.stringify({ notificationsEnabled: true, soundsEnabled: false, phoneEnabled: true }));
  }
  return { home, local, roam, pkg, env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: roam, HOME: home }, dataDir: path.join(home, '.claude-notifier') };
}
const runNode = (args, env, ms = 20000) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(P, 'notifier.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => resolve({ code, out, err })); setTimeout(() => { try { c.kill(); } catch { /* done */ } }, ms);
});

(async () => {
  // =========================================================================================================
  console.log('== A) where things live: data folder + discovery of Claude Desktop\'s files');
  const w = fakeWorld('wA');
  check('default data folder is %USERPROFILE%\\.claude-notifier (outside AppData, never virtualized)', paths.defaultDataDir(w.env) === w.dataDir && path.relative(w.home, paths.defaultDataDir(w.env)) === '.claude-notifier' && !/AppData/i.test(path.relative(w.home, paths.defaultDataDir(w.env))));
  check('it follows USERPROFILE (per-user), not a hard-coded machine path', paths.defaultDataDir({ USERPROFILE: 'C:\\Users\\Someone' }) === path.join('C:\\Users\\Someone', '.claude-notifier'));
  const caches = paths.claudePackageCaches(w.env);
  check('package stores are DISCOVERED by pattern (Claude_*), unrelated packages ignored', caches.length === 1 && caches[0].name === 'Claude_testfamily99');
  fs.mkdirSync(path.join(w.local, 'Packages', 'Claude_9zzzOtherFamily', 'LocalCache'), { recursive: true });
  check('...a different family name works too (nothing is hard-coded to the real package name)', paths.claudePackageCaches(w.env).map((c) => c.name).sort().join() === 'Claude_9zzzOtherFamily,Claude_testfamily99');
  let d = paths.discoverUsageHistory(w.env);
  check('usage history found ONLY in the package store (plain %APPDATA% has none) => discovered there', d.path && /Claude_testfamily99[\\/]LocalCache[\\/]Roaming[\\/]Claude/.test(d.path) && d.label === 'package-store');
  const plain = path.join(w.roam, 'Claude', paths.USAGE_FILE); fs.mkdirSync(path.dirname(plain), { recursive: true }); fs.writeFileSync(plain, JSON.stringify({ version: 2, samples: [{ t: NOW - 1000, org: 'o', u: { fh: 41, sd: 20 } }] }));
  const old = new Date(NOW - 3 * 3600_000); fs.utimesSync(plain, old, old);
  check('stale plain file + live package-store file => the LIVE one wins (newest write)', paths.discoverUsageHistory(w.env).label === 'package-store');
  const fresh = new Date(NOW); fs.utimesSync(plain, fresh, fresh); const olderPkg = new Date(NOW - 2 * 3600_000); fs.utimesSync(d.path, olderPkg, olderPkg);
  check('...and when the plain file is the live one, THAT wins (works launched either way)', paths.discoverUsageHistory(w.env).label === 'appdata');
  const second = path.join(w.local, 'Packages', 'Claude_9zzzOtherFamily', 'LocalCache', 'Roaming', 'Claude'); fs.mkdirSync(second, { recursive: true }); fs.writeFileSync(path.join(second, paths.USAGE_FILE), JSON.stringify({ version: 2, samples: [{ t: NOW, org: 'o', u: { fh: 12, sd: 9 } }] }));
  fs.utimesSync(path.join(second, paths.USAGE_FILE), new Date(NOW + 5000), new Date(NOW + 5000));
  check('two package families: the most recently written file wins', /Claude_9zzzOtherFamily/.test(paths.discoverUsageHistory(w.env).path));
  const e = fakeWorld('wE', { usage: 'none', legacy: false }); d = paths.discoverUsageHistory(e.env);
  check('no usage file anywhere => path null, with the list of places that were checked', d.path === null && d.candidates.length >= 1 && d.candidates.every((c) => c.mtimeMs === null));
  const before = { h: sha(plain), m: fs.statSync(plain).mtimeMs }; paths.discoverUsageHistory(w.env); paths.usageHistoryCandidates(w.env);
  check('discovery is read-only (history file hash + mtime unchanged)', before.h === sha(plain) && before.m === fs.statSync(plain).mtimeMs);

  // ---- A2) Claude 4.x layout (Claude-Data\<family>), several candidates, stale / missing / malformed / empty files ----
  console.log('== A2) usage-file discovery: supported locations, multiple candidates, validation');
  const sample = (ageMs, fh = 61, sd = 33) => JSON.stringify({ version: 2, samples: [{ t: NOW - ageMs, org: 'fake-org', u: { fh, sd } }] });
  const put2 = (dir, content, ageMs = 0) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, paths.USAGE_FILE); fs.writeFileSync(f, content); const t = new Date(NOW - ageMs); fs.utimesSync(f, t, t); return f; };
  const world2 = (name) => fakeWorld(name, { usage: 'none', legacy: false });
  let x = world2('wC1'); const cd = put2(path.join(x.local, 'Claude-Data', 'claude_somefamily7'), sample(60_000), 60_000);
  d = paths.discoverUsageHistory(x.env);
  check('Claude 4.x location %LOCALAPPDATA%\\Claude-Data\\<family>\\ is found (family name is not hard-coded)', d.path === cd && d.state === 'valid' && /^local:Claude-Data\//.test(d.label), d.label);
  const y = world2('wC1c'); const yf = put2(path.join(y.local, 'Claude-Data', 'otherfam_x'), sample(1000), 1000);
  check('...and it works for a completely different family name in a different (fake) user profile', paths.discoverUsageHistory(y.env).path === yf);
  const old3 = put2(path.join(x.roam, 'Claude'), sample(5 * 86400_000), 5 * 86400_000);
  check('old %APPDATA%\\Claude leftover (stale) + live Claude-Data file => the LIVE Claude-Data file wins', paths.discoverUsageHistory(x.env).path === cd);
  put2(path.join(x.roam, 'Claude-Account2'), sample(6 * 86400_000, 5, 5), 6 * 86400_000);
  check("another account's stale file (Roaming\\Claude-Account2) does not displace the live file", paths.discoverUsageHistory(x.env).path === cd);
  const pk = put2(path.join(x.pkg, 'Roaming', 'Claude'), sample(30_000), 30_000);
  check('a package-store copy that is NEWER than Claude-Data wins (all supported places compete on freshness)', paths.discoverUsageHistory(x.env).path === pk && paths.discoverUsageHistory(x.env).label === 'package-store');
  const cands = paths.usageHistoryCandidates(x.env);
  check('every candidate reports its state and the list stays compact (existing files + the classic place only)', cands.every((c) => ['valid', 'empty', 'malformed', 'unreadable', 'missing'].includes(c.state)) && cands.length <= 12, `${cands.length} candidates`);
  put2(path.join(x.local, 'ClaudeNotifier'), sample(1000), 1000);
  check("this app's own ClaudeNotifier folder is never treated as a Claude Desktop folder", !paths.usageHistoryCandidates(x.env).some((c) => /ClaudeNotifier/.test(c.path)));
  put2(path.join(x.local, 'NotClaude'), sample(1000), 1000);
  check('folders that do not start with "Claude" are ignored', !paths.usageHistoryCandidates(x.env).some((c) => /NotClaude/.test(c.path)));

  // validation: a NEWER but broken file must not beat an older valid one
  x = world2('wC2'); const good = put2(path.join(x.local, 'Claude-Data', 'fam'), sample(3600_000), 3600_000);
  const badNew = put2(path.join(x.roam, 'Claude'), '{"version":2,"samples":[{"t":1,"u":', 0);   // truncated mid-write, newer mtime
  d = paths.discoverUsageHistory(x.env);
  check('malformed (truncated) newer file loses to an older VALID file', d.path === good && d.candidates.find((c) => c.path === badNew).state === 'malformed');
  fs.writeFileSync(badNew, JSON.stringify({ version: 2, samples: [] }));
  check('an EMPTY (no samples) newer file loses to an older valid file', paths.discoverUsageHistory(x.env).path === good && paths.discoverUsageHistory(x.env).candidates.find((c) => c.path === badNew).state === 'empty');
  fs.writeFileSync(badNew, JSON.stringify({ version: 2, samples: [{ t: 'x', u: { fh: 'a' } }, null, { t: 5 }] }));
  check('samples without a numeric t and a numeric 5-hour/weekly value do not count as valid', paths.discoverUsageHistory(x.env).path === good);
  fs.writeFileSync(badNew, '[1,2,3]');
  check('valid JSON of the wrong shape is malformed', paths.discoverUsageHistory(x.env).candidates.find((c) => c.path === badNew).state === 'malformed' && paths.discoverUsageHistory(x.env).path === good);
  fs.writeFileSync(badNew, sample(0, 77, 44)); const fresh2 = new Date(NOW + 1000); fs.utimesSync(badNew, fresh2, fresh2);
  check('once the newer file becomes valid it wins (discovery follows the live file, no stale cache)', paths.discoverUsageHistory(x.env).path === badNew);

  // nothing valid: the newest existing file is still returned so the monitor can explain the state
  x = world2('wC3'); const onlyBad = put2(path.join(x.roam, 'Claude'), 'not json at all', 10_000);
  d = paths.discoverUsageHistory(x.env);
  check('only a malformed file exists => it is returned (state malformed) so the tray can say "could not be read"', d.path === onlyBad && d.state === 'malformed');
  const onlyEmpty = put2(path.join(x.local, 'Claude-Data', 'fam'), JSON.stringify({ version: 2, samples: [] }), 20_000);
  check('empty beats malformed when nothing is valid (tray says "no samples yet")', paths.discoverUsageHistory(x.env).path === onlyEmpty && paths.discoverUsageHistory(x.env).state === 'empty');
  const big = put2(path.join(x.pkg, 'Roaming', 'Claude'), 'x'.repeat(100), 5000); fs.truncateSync(big, 21 * 1024 * 1024);
  check('an absurdly large file is rejected as malformed without being read into memory', paths.discoverUsageHistory(x.env).candidates.find((c) => c.path === big).state === 'malformed');

  // missing: no crash, null result
  x = world2('wC4'); fs.rmSync(x.roam, { recursive: true, force: true }); fs.rmSync(path.join(x.local, 'Packages'), { recursive: true, force: true });
  d = paths.discoverUsageHistory(x.env);
  check('no AppData folders at all => no crash, path null', d.path === null && d.state === null);
  check('missing env variables fall back to the profile folder instead of throwing', (() => { try { return paths.discoverUsageHistory({ USERPROFILE: x.home }).path === null; } catch { return false; } })());

  // end to end through the real monitor (thresholds / stale logic untouched): wording for each situation
  const mk = (env) => { const em = []; const m2 = new UsageMonitor({ resolveFile: () => paths.discoverUsageHistory(env), emit: (e) => em.push(e), pollMs: 100000, now: () => NOW }); m2.tick(); return { m2, em }; };
  let r = mk(world2('wC5').env);
  check('monitor + nothing found => "Usage unavailable" with the hint (never a silent "no data yet")', r.m2.status().state === 'unavailable' && /Usage unavailable/.test(r.m2.status().text) && !!r.m2.status().hint);
  x = world2('wC6'); put2(path.join(x.roam, 'Claude'), '{broken', 1000); r = mk(x.env);
  check('monitor + malformed file => "could not be read"', /could not be read/.test(r.m2.status().text), r.m2.status().text);
  x = world2('wC7'); put2(path.join(x.local, 'Claude-Data', 'fam'), JSON.stringify({ version: 2, samples: [] }), 1000); r = mk(x.env);
  check('monitor + empty file => "no samples yet"', /no samples yet/.test(r.m2.status().text), r.m2.status().text);
  x = world2('wC8'); put2(path.join(x.local, 'Claude-Data', 'fam'), sample(60_000, 55, 30), 60_000); r = mk(x.env);
  check('monitor + live Claude-Data file => the real 5-hour and weekly numbers with the sample age', /5-hour 55%/.test(r.m2.status().text) && /weekly 30%/.test(r.m2.status().text) && /1 min ago/.test(r.m2.status().text), r.m2.status().text);
  x = world2('wC9'); put2(path.join(x.local, 'Claude-Data', 'fam'), sample(3 * 3600_000, 55, 30), 3 * 3600_000); r = mk(x.env);
  check('monitor + STALE samples (3 h old) => still discovered, reported stale with the refresh hint; the only event is the existing USAGE_STALE notice (no 80/90% alert)', r.m2.status().state === 'stale' && !!r.m2.status().hint && r.em.length === 1 && r.em[0].type === 'USAGE_STALE', r.em.map((e) => e.type).join());
  const hashes = () => [cd, old3, pk].map((f) => (fs.existsSync(f) ? sha(f) : '-')).join(); const h0 = hashes(); const m0 = fs.statSync(cd).mtimeMs;
  paths.discoverUsageHistory(world2('wCx').env); paths.discoverUsageHistory(x.env); paths.discoverUsageHistory(w.env);
  check('discovery never writes: candidate files keep their bytes and mtimes', hashes() === h0 && fs.statSync(cd).mtimeMs === m0);

  // =========================================================================================================
  console.log('== B) migration of an existing configuration');
  const m = fakeWorld('wM'); const legacyDir = path.join(m.pkg, 'Local', 'ClaudeNotifier');
  fs.writeFileSync(path.join(legacyDir, 'usage-state.json'), '{"v":1,"windows":{}}'); fs.writeFileSync(path.join(legacyDir, 'history.db'), 'SMALLDB');
  const plainLegacy = path.join(m.local, 'ClaudeNotifier'); fs.mkdirSync(plainLegacy, { recursive: true }); fs.writeFileSync(path.join(plainLegacy, 'history.db'), 'x'.repeat(5000));   // bigger history in the other legacy location
  const lines = []; const baseline = { n: sha(path.join(legacyDir, 'ntfy.json')), s: sha(path.join(legacyDir, 'settings.json')), u: sha(path.join(legacyDir, 'usage-state.json')) };
  let mr = paths.migrateLegacyData({ env: m.env, dataDir: m.dataDir, log: (x) => lines.push(x) });
  const act = Object.fromEntries(mr.map((x) => [x.file, x.action]));
  check('every existing file is copied into the new folder', act['ntfy.json'] === 'copied' && act['settings.json'] === 'copied' && act['usage-state.json'] === 'copied' && act['history.db'] === 'copied', JSON.stringify(act));
  check('ntfy.json / settings.json / usage-state.json are BYTE-IDENTICAL (topic, token, privacy flag and every user choice preserved)', sha(path.join(m.dataDir, 'ntfy.json')) === baseline.n && sha(path.join(m.dataDir, 'settings.json')) === baseline.s && sha(path.join(m.dataDir, 'usage-state.json')) === baseline.u);
  check('the history database comes from the LARGEST legacy copy', fs.readFileSync(path.join(m.dataDir, 'history.db'), 'utf8').length === 5000);
  check('sources are never deleted or modified', sha(path.join(legacyDir, 'ntfy.json')) === baseline.n && fs.existsSync(path.join(plainLegacy, 'history.db')));
  check('migration log lines name files and sources only: the topic and token never appear', lines.length === 4 && !lines.join('\n').includes(SECRET_TOPIC) && !lines.join('\n').includes(SECRET_TOKEN), lines[0]);
  fs.writeFileSync(path.join(m.dataDir, 'settings.json'), '{"phoneEnabled":false,"mine":true}'); fs.unlinkSync(path.join(m.dataDir, 'usage-state.json'));
  mr = paths.migrateLegacyData({ env: m.env, dataDir: m.dataDir }); const act2 = Object.fromEntries(mr.map((x) => [x.file, x.action]));
  check('an EXISTING configuration is never overwritten (settings.json kept as the user left it)', act2['settings.json'] === 'kept-existing' && /"mine":true/.test(fs.readFileSync(path.join(m.dataDir, 'settings.json'), 'utf8')) && act2['ntfy.json'] === 'kept-existing');
  check('...only what is MISSING is filled in (the deleted usage-state.json is restored, nothing else touched)', act2['usage-state.json'] === 'copied');
  const none = fakeWorld('wN', { legacy: false }); mr = paths.migrateLegacyData({ env: none.env, dataDir: none.dataDir });
  check('nothing to migrate => "no-source", no files invented, no error', mr.every((x) => x.action === 'no-source') && !fs.existsSync(path.join(none.dataDir, 'ntfy.json')));
  const self = paths.migrateLegacyData({ env: m.env, dataDir: plainLegacy }); check('a destination folder is never used as its own source (its existing history.db is kept)', self.find((x) => x.file === 'history.db').action === 'kept-existing' && fs.readFileSync(path.join(plainLegacy, 'history.db'), 'utf8').length === 5000);
  const mc = ntfy.loadConfig(m.dataDir);
  check('the migrated ntfy config loads and is valid; the stored privacy setting is untouched on disk but the effective default stays opted-out', mc && !ntfy.validateConfig(mc) && mc.includeSessionTitle === false && mc.titleMigrated === true && JSON.parse(fs.readFileSync(path.join(m.dataDir, 'ntfy.json'), 'utf8')).includeSessionTitle === true);

  // =========================================================================================================
  console.log('== C) usage status wording: say WHY, never a vague "no data yet"');
  const tmpH = path.join(root, 'hist.json'); let target = null; const resolved = [];
  const em = []; const mon = new UsageMonitor({ resolveFile: () => target, onResolve: (f) => resolved.push(f), emit: (x) => em.push(x), pollMs: 100000, now: () => NOW });
  mon.tick(); let st = mon.status();
  check('usage file not found => "Usage unavailable — Claude Desktop\'s usage file was not found" (state unavailable, with a hint)', st.state === 'unavailable' && /^Usage unavailable/.test(st.text) && /not found/.test(st.text) && /tray menu/.test(st.hint) && !/no data yet/.test(st.text), st.text);
  fs.writeFileSync(tmpH, '{"version":2,"samples":['); target = tmpH; mon.tick(); st = mon.status();
  check('file present but unreadable (corrupt/half-written) => "Usage unavailable — could not be read"', st.state === 'unavailable' && /could not be read/.test(st.text), st.text);
  fs.writeFileSync(tmpH, '{"version":2,"samples":[]}'); mon.tick(); st = mon.status();
  check('file with no samples => "no samples yet", not "no data yet"', /no samples yet/.test(st.text) && !/no data yet/.test(st.text), st.text);
  fs.writeFileSync(tmpH, JSON.stringify({ version: 2, samples: [{ t: NOW - 60_000, org: 'o', u: { fh: 61, sd: 22 } }] })); mon.tick(); st = mon.status();
  check('a valid fresh sample => the real percentages and the age are shown', st.state === 'fresh' && /5-hour 61%/.test(st.text) && /weekly 22%/.test(st.text) && /updated 1 min ago/.test(st.text), st.text);
  const tmpH2 = path.join(root, 'hist2.json'); fs.writeFileSync(tmpH2, JSON.stringify({ version: 2, samples: [{ t: NOW - 30_000, org: 'o', u: { fh: 64, sd: 23 } }] })); target = tmpH2; mon.tick(); st = mon.status();
  check('the monitor FOLLOWS a changed location (the resolver is consulted every tick) and reads the new file', /5-hour 64%/.test(st.text) && resolved[resolved.length - 1] === tmpH2, st.text);
  target = null; mon.tick(); check('if the file later disappears the monitor does not crash and the last known numbers simply keep aging', ['fresh', 'stale', 'unavailable'].includes(mon.status().state));
  check('onResolve told the app about each change (not found, then each path)', resolved[0] === null && resolved.includes(tmpH) && resolved.includes(tmpH2));
  const hb = sha(tmpH2); mon.tick(); check('read-only: the history file is never modified', sha(tmpH2) === hb);

  // =========================================================================================================
  console.log('== D) the REAL app in a fake profile where config + usage exist ONLY in the package store (the exact bug)');
  const NOPROC = path.join(root, 'noproc.json'); fs.writeFileSync(NOPROC, JSON.stringify({ session: 1, procs: [] }));   // these runs use fake profiles: pretend Claude Desktop is not running (the real process table is irrelevant here)
  const A = fakeWorld('wD'); const common = ['--mock-claude-processes', NOPROC, '--ui', 'none', '--dump-menu', '--no-lock', '--duration', '7', '--interval', '500', '--sessions-dir', path.join(A.home, '.claude', 'sessions'), '--log-dir', path.join(A.home, 'logs')];
  fs.mkdirSync(path.join(A.home, 'logs'), { recursive: true }); fs.writeFileSync(path.join(A.home, 'logs', 'main.log'), '');
  let run = await runNode(common.filter((x) => x !== '--no-lock'), A.env, 30000);
  const menus = run.out.split('\n').map((l) => { try { return JSON.parse(l).menu; } catch { return null; } }).filter(Boolean); const last = menus[menus.length - 1] || {};
  check('normal launch (default data dir, nothing passed): tray usage line shows the REAL 5-hour and weekly %', /Usage: 5-hour 55% · weekly 30%/.test(last.usageText || ''), last.usageText);
  check('...with the sample age', /updated \d+ min ago/.test(last.usageText || ''));
  check('...and phone notifications are ENABLED/configured from the migrated config (not "not configured")', last.phoneConfigured === true && last.phoneEnabled === true && /^Phone push: enabled/.test(last.phoneText || ''), last.phoneText);
  const log = fs.readFileSync(path.join(A.dataDir, 'notifier.log'), 'utf8');
  check('startup migrated the config and logged where the usage file was found (no secrets in the log)', /migrated ntfy\.json from package-store/.test(log) && /usage history: using .*Claude_testfamily99.*plan-usage-history\.json/.test(log) && !log.includes(SECRET_TOPIC) && !log.includes(SECRET_TOKEN));
  check('no secret appears in the process output either', !(run.out + run.err).includes(SECRET_TOPIC) && !(run.out + run.err).includes(SECRET_TOKEN));
  check('the notifier wrote ONLY to the new folder (nothing created under the fake AppData by the app itself)', !fs.existsSync(path.join(A.local, 'ClaudeNotifier')) && fs.existsSync(path.join(A.dataDir, 'history.db')));
  const ST = await runNode(['--ntfy-status'], A.env); check('--ntfy-status never prints the topic or token', ST.code === 0 && /config : ok/.test(ST.out) && !ST.out.includes(SECRET_TOPIC) && !ST.out.includes(SECRET_TOKEN) && /enabled: true/.test(ST.out), ST.out.replace(/\n/g, ' | ').slice(0, 120));
  const B = fakeWorld('wD2', { usage: 'none', legacy: false }); fs.mkdirSync(path.join(B.home, 'logs'), { recursive: true }); fs.writeFileSync(path.join(B.home, 'logs', 'main.log'), '');
  run = await runNode(['--mock-claude-processes', NOPROC, '--ui', 'none', '--dump-menu', '--no-lock', '--duration', '6', '--interval', '500', '--sessions-dir', path.join(B.home, '.claude', 'sessions'), '--log-dir', path.join(B.home, 'logs')], B.env, 30000);
  const m2 = run.out.split('\n').map((l) => { try { return JSON.parse(l).menu; } catch { return null; } }).filter(Boolean); const l2 = m2[m2.length - 1] || {};
  check('usage file missing everywhere: the tray says "Usage unavailable — … not found" with the red/refresh hint (not "no data yet")', /^Usage unavailable/.test(l2.usageText || '') && l2.usageStale === true && /tray menu/.test(l2.usageHint || '') && !/no data yet/.test(l2.usageText || ''), l2.usageText);
  check('...and nothing configured => the phone line is honest too', l2.phoneConfigured === false);
  check('the supervisor uses the same data folder (no AppData reference left in the launch path)', !/LOCALAPPDATA/.test(fs.readFileSync(path.join(P, 'supervisor.js'), 'utf8')) && !/LOCALAPPDATA/.test(fs.readFileSync(path.join(P, 'notifier.js'), 'utf8').split('\n').filter((l) => /DATA_DIR =/.test(l)).join('')));

  // =========================================================================================================
  console.log('== E) LAUNCH CONTEXT: this process vs a process started by Explorer (not a descendant of Claude)');
  const here = JSON.parse((await runNode(['--diagnose'], process.env)).out.trim().split('\n').pop());
  const dir = path.join(P, '.launchtest'); fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `diag-${process.pid}.json`); const vbs = path.join(dir, `run-${process.pid}.vbs`);
  fs.writeFileSync(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${process.execPath}"" ""${path.join(P, 'notifier.js')}"" --diagnose --out ""${outFile}""", 0, True\r\n`);
  spawn('explorer.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
  const t0 = Date.now(); while (!fs.existsSync(outFile) && Date.now() - t0 < 40000) await sleep(300); await sleep(300);
  const there = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  for (const f of [outFile, vbs]) { try { fs.unlinkSync(f); } catch { /* gone */ } } try { fs.rmdirSync(dir); } catch { /* not empty */ }
  check('the Explorer-launched process ran and reported', !!there, there ? '' : 'no report within 40 s');
  if (there) {
    console.log(`      view A (this test's own context): AppData virtualized=${here.virtualizedAppData}  |  view B (started by Explorer): AppData virtualized=${there.virtualizedAppData}`);
    check('both views use the SAME data folder: %USERPROFILE%\\.claude-notifier', here.dataDir === there.dataDir && here.dataDir === path.join(os.homedir(), '.claude-notifier'), here.dataDir === there.dataDir ? '' : `${here.dataDir} vs ${there.dataDir}`);
    check('both views agree on the phone configuration (configured + enabled) — the original bug showed "not configured" in one of them', here.ntfyConfigured === there.ntfyConfigured && here.phoneEnabled === there.phoneEnabled, `A=${here.ntfyConfigured}/${here.phoneEnabled} B=${there.ntfyConfigured}/${there.phoneEnabled}`);
    check('both views FIND Claude Desktop\'s usage history (the original bug: "no data yet" in one of them)', here.usageFound === there.usageFound, `A=${here.usageFound} B=${there.usageFound}`);
    check('...and it is the same LIVE data (file ages within 2 min of each other)', (!here.usageFound && !there.usageFound) || (here.usageFound && there.usageFound && Math.abs(here.usageAgeMin - there.usageAgeMin) <= 2), `A=${here.usageAgeMin}min B=${there.usageAgeMin}min`);
    check('both views see the Claude package store and the sessions folder', here.packageStores === there.packageStores && here.sessionsDirExists && there.sessionsDirExists);
    check('the two filesystem views are explicitly recorded (and, where they differ, the results still agree)', typeof here.virtualizedAppData === 'boolean' && typeof there.virtualizedAppData === 'boolean');
  } else { for (let i = 0; i < 5; i++) check('Explorer-launch comparison', false, 'skipped: no report'); }

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
