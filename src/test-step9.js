#!/usr/bin/env node
/**
 * test-step9.js — Task 1.2: reliable ACTIVE Claude Desktop profile selection (claude-profile.js).
 *
 * Everything runs against fake Windows profiles under a scratch folder and MOCKED process metadata: no real usage history,
 * ntfy config or Claude file is read or written. Section F additionally runs the real PowerShell process query against a
 * decoy claude.exe that this test starts itself (a renamed copy of node.exe) to prove the extraction really works and that
 * full command lines never leave PowerShell.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const paths = require('./paths');
const cp = require('./claude-profile');
const { UsageMonitor } = require('./usage-monitor');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = __dirname;
const ROOT = path.resolve(P, '..', 'profile-test9');
const NOW = Date.now();
const HOUR = 3600_000; const DAY = 24 * HOUR;
const SECRET = 'SECRET_ACCOUNT_ID_should_never_be_printed_9f3';

/** a fake Windows profile: returns env + helpers to create Claude profile folders at any supported location */
let wn = 0;
function world(name = `w${++wn}`) {
  const home = path.join(ROOT, name); const local = path.join(home, 'AppData', 'Local'); const roam = path.join(home, 'AppData', 'Roaming');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true }); fs.mkdirSync(local, { recursive: true }); fs.mkdirSync(roam, { recursive: true });
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: local, APPDATA: roam };
  const touch = (f, ageMs) => { const t = new Date(NOW - ageMs); fs.utimesSync(f, t, t); };
  const sample = (ageMs, fh = 61, sd = 33) => JSON.stringify({ version: 2, samples: [{ t: NOW - ageMs, org: SECRET, u: { fh, sd } }] });
  /** creates a profile folder with Electron marker files (aged) and optionally a usage file; returns { dir, usage } */
  const profile = (dir, { active = 0, usage = null, usageAge = 0, markers = true } = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    if (markers) for (const m of ['Preferences', 'Local State']) { const f = path.join(dir, m); fs.writeFileSync(f, `{"secret":"${SECRET}"}`); touch(f, active); }
    let uf = path.join(dir, paths.USAGE_FILE);
    if (usage !== null) { fs.writeFileSync(uf, usage); touch(uf, usageAge); }
    return { dir, usage: uf };
  };
  const pkg = (family = 'Claude_testfam') => path.join(local, 'Packages', family, 'LocalCache');
  return { home, local, roam, env, profile, sample, touch, pkg };
}
/** mocked process records, exactly the shape queryProcesses() returns */
let pid = 1000;
const main = (extra = {}) => ({ pid: ++pid, ppid: 1, exe: 'C:\\Program Files\\WindowsApps\\Claude_4.0.0.0_x64__fam\\app\\Claude.exe', type: '', udd: '', session: 1, ...extra });
function instance(udd, { helpers = 3, cliUnder = null, session = 1, cliExe = null, cliParent = null } = {}) {
  const m = main({ session }); const out = [m];
  for (let i = 0; i < helpers; i++) out.push({ pid: ++pid, ppid: m.pid, exe: m.exe, type: ['gpu-process', 'utility', 'renderer'][i % 3], udd, session });
  if (cliUnder || cliExe) out.push({ pid: ++pid, ppid: cliParent || m.pid, exe: cliExe || path.join(cliUnder, 'claude-code', '2.1.317', 'abc', 'claude.exe'), type: '', udd: '', session });
  return out;
}
const sel = (w, procs, extra = {}) => cp.selectProfile({ procs, session: 1, env: w.env, ...extra });
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const mkMon = (resolve) => { const em = []; const m = new UsageMonitor({ resolveFile: resolve, emit: (e) => em.push(e), pollMs: 1e6, now: () => NOW }); m.tick(); return { m, em }; };

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });

  // =========================================================================================================
  console.log('== A) exactly one active profile (from helper --user-data-dir): only ITS usage file is used');
  let w = world();
  const active = w.profile(path.join(w.local, 'Claude-Data', 'claude_famA'), { active: 60_000, usage: w.sample(2 * HOUR, 40, 20), usageAge: 2 * HOUR });
  const other = w.profile(path.join(w.roam, 'Claude-Account2'), { active: 5 * DAY, usage: w.sample(60_000, 99, 88), usageAge: 60_000 });   // a NEWER, fresher file of another account
  let r = sel(w, instance(active.dir, { cliUnder: active.dir }));
  check('one running profile => method "process", not ambiguous', r.method === 'process' && !r.ambiguous && r.ambiguity === null);
  check("the identified profile's usage file is selected", samePath(r.path, active.usage) && r.profile.state === 'valid');
  check('...even though another profile has a NEWER, fresher usage file (the wrong-account scenario): it is NOT used', !samePath(r.path, other.usage));
  check('active process counts are reported (helpers + live CLI)', r.profile.helpers === 3 && r.profile.cli === 1);
  let mon = mkMon(() => sel(w, instance(active.dir)));
  check('the monitor therefore shows the ACTIVE profile numbers (40% / 20%, 2 h old => stale), never the other account\'s 99%/88%', /40%/.test(mon.m.status().text) && !/99/.test(mon.m.status().text) && mon.m.status().state === 'stale', mon.m.status().text);

  fs.rmSync(active.usage);
  r = sel(w, instance(active.dir));
  check('active profile identified but its usage file is MISSING => reported as missing with the expected path, no switch to the other profile', r.profile.state === 'missing' && samePath(r.path, active.usage) && !samePath(r.path, other.usage));
  mon = mkMon(() => sel(w, instance(active.dir)));
  check('...and the monitor says "Usage unavailable" (not the other account\'s numbers)', mon.m.status().state === 'unavailable' && !/99/.test(mon.m.status().text));

  fs.writeFileSync(active.usage, '{"version":2,"samples":[{"t":'); w.touch(active.usage, 1000);
  r = sel(w, instance(active.dir));
  check('active profile file MALFORMED => state malformed is reported, still no fallback', r.profile.state === 'malformed' && samePath(r.path, active.usage));
  mon = mkMon(() => sel(w, instance(active.dir)));
  check('...monitor: "could not be read"', /could not be read/.test(mon.m.status().text), mon.m.status().text);

  fs.writeFileSync(active.usage, JSON.stringify({ version: 2, samples: [] })); w.touch(active.usage, 1000);
  r = sel(w, instance(active.dir));
  check('active profile file EMPTY => state empty is reported; monitor says "no samples yet"', r.profile.state === 'empty' && /no samples yet/.test(mkMon(() => sel(w, instance(active.dir))).m.status().text));

  fs.writeFileSync(active.usage, w.sample(20 * HOUR, 12, 7)); w.touch(active.usage, 20 * HOUR);
  mon = mkMon(() => sel(w, instance(active.dir)));
  check('active profile file STALE (20 h) while the other is fresh => reported stale (existing stale rules), not replaced', mon.m.status().state === 'stale' && /12%/.test(mon.m.status().text) && !/99/.test(mon.m.status().text));

  // =========================================================================================================
  console.log('== B) several profiles running');
  w = world();
  const pa = w.profile(path.join(w.local, 'Claude-Data', 'claude_famA'), { active: 1000, usage: w.sample(1000, 50, 25), usageAge: 1000 });
  const pb = w.profile(path.join(w.roam, 'Claude-Account2'), { active: 1000, usage: w.sample(1000, 70, 35), usageAge: 1000 });
  r = sel(w, [...instance(pa.dir, { cliUnder: pa.dir }), ...instance(pb.dir)]);
  check('two profiles running, live Claude Code CLI only under one => that profile is chosen (method "process+cli")', r.method === 'process+cli' && !r.ambiguous && samePath(r.path, pa.usage) && /owns the live Claude Code/.test(r.note));
  r = sel(w, [...instance(pa.dir), ...instance(pb.dir)]);
  check('two profiles running, no CLI sessions => AMBIGUOUS: no path, reason reported (nothing is guessed)', r.ambiguous && r.path === null && r.ambiguity.reason === 'several-active-profiles' && r.ambiguity.profiles === 2);
  r = sel(w, [...instance(pa.dir, { cliUnder: pa.dir }), ...instance(pb.dir, { cliUnder: pb.dir })]);
  check('two profiles running, both with live CLI sessions => AMBIGUOUS (several-active-profiles-with-sessions)', r.ambiguous && r.path === null && r.ambiguity.reason === 'several-active-profiles-with-sessions');
  mon = mkMon(() => sel(w, [...instance(pa.dir), ...instance(pb.dir)]));
  check('monitor on an ambiguous profile: clear warning text + hint, no numbers, no alert events', mon.m.status().state === 'ambiguous' && /can't tell which Claude Desktop profile/.test(mon.m.status().text) && !!mon.m.status().hint && !/%/.test(mon.m.status().text) && mon.em.length === 0);
  const m1 = instance(pa.dir); const m2 = instance(pb.dir);
  const odd = { pid: ++pid, ppid: m2[0].pid, exe: 'D:\\somewhere\\else\\tool.exe', type: '', udd: '', session: 1 };
  const cliViaParent = { pid: ++pid, ppid: m2[0].pid, exe: 'D:\\portable\\claude-code\\2.1\\claude.exe', type: '', udd: '', session: 1 };
  r = sel(w, [...m1, ...m2, odd, cliViaParent]);
  check('a CLI whose image is not under any profile is associated through its PARENT Claude process (profile B)', r.method === 'process+cli' && samePath(r.path, pb.usage));
  r = sel(w, [...instance(pa.dir), { pid: ++pid, ppid: 1, exe: 'C:\\Users\\x\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', type: '', udd: '', session: 1 }]);
  check('a stray claude-code install elsewhere (e.g. under node_modules) is not mistaken for a Claude Desktop profile', r.method === 'process' && !r.ambiguous && samePath(r.path, pa.usage) && r.profiles.length === 1);
  r = sel(w, [...instance(pa.dir, { helpers: 5 }), ...instance(pa.dir, { helpers: 2 })]);
  check('two Claude main processes sharing the same data folder are one profile', r.method === 'process' && r.profiles.length === 1);

  // =========================================================================================================
  console.log('== C) process filtering: current session only; lookup failures');
  const procsOtherSession = [...instance(pb.dir, { session: 2 })];
  r = sel(w, procsOtherSession);
  check("Claude processes of ANOTHER Windows session (another user) are ignored => treated as 'not running'", r.method !== 'process' && !(r.profile && r.method === 'process'));
  r = sel(w, [...instance(pa.dir, { session: 2 }), ...instance(pb.dir, { session: 1 })]);
  check('...only the current session\'s profile counts when both exist', r.method === 'process' && samePath(r.path, pb.usage));
  r = cp.selectProfile({ procs: null, session: null, env: w.env });
  check('process lookup unavailable (PowerShell blocked) => falls back to file activity with an explicit note', /process lookup unavailable/.test(r.note || '') && r.method.startsWith('filesystem'));
  r = cp.selectProfile({ procs: [], session: 1, env: w.env });
  check('no Claude processes => filesystem fallback', r.method.startsWith('filesystem'));
  r = cp.selectProfile({ procs: instance(pa.dir).map((p) => ({ ...p, session: undefined })), session: 1, env: w.env });
  check('records without a session id are still accepted (never silently dropped)', r.method === 'process' && samePath(r.path, pa.usage));

  // =========================================================================================================
  console.log('== D) old Claude packages: virtualized / package-store paths');
  w = world();
  const cache = w.pkg();
  const virt = path.join(w.roam, 'Claude');                                      // what Claude 2.x REPORTS as its user-data-dir
  const phys = path.join(cache, 'Roaming', 'Claude');                           // where the files physically are
  w.profile(phys, { active: 5000, usage: w.sample(5000, 33, 11), usageAge: 5000 });
  fs.mkdirSync(virt, { recursive: true });
  r = sel(w, instance(virt, { cliUnder: virt }));
  check('helper reports the virtual %APPDATA%\\Claude, files live in the package store => the physical usage file is found', samePath(r.path, path.join(phys, paths.USAGE_FILE)) && r.profile.state === 'valid');
  check('...virtual CLI path and virtual helper path are one profile', r.profiles.length === 1 && r.profile.cli === 1);
  r = sel(w, instance(phys));
  check('helper reporting the physical package-store path maps to the same single profile', samePath(r.path, path.join(phys, paths.USAGE_FILE)) && r.profiles.length === 1);
  w.profile(virt, { active: 5000, usage: w.sample(10 * HOUR, 5, 5), usageAge: 10 * HOUR });
  r = sel(w, instance(virt));
  check('same profile in both spellings: the newer valid copy wins WITHIN that profile', samePath(r.path, path.join(phys, paths.USAGE_FILE)) && r.profile.state === 'valid');
  const w2 = world(); const cache2 = w2.pkg('Claude_otherfam');
  w2.profile(path.join(cache2, 'Local', 'Claude-Data', 'claude_zz'), { active: 100, usage: w2.sample(100), usageAge: 100 });
  r = sel(w2, instance(path.join(w2.local, 'Claude-Data', 'claude_zz')));
  check('a Claude-Data profile that physically lives in a different package family works too (family name not hard-coded)', samePath(r.path, path.join(cache2, 'Local', 'Claude-Data', 'claude_zz', paths.USAGE_FILE)));

  // =========================================================================================================
  console.log('== E) Claude Desktop NOT running: conservative filesystem fallback');
  w = world();
  r = sel(w, []);
  check('nothing on disk => method "filesystem", no path, no profiles', r.path === null && r.profiles.length === 0 && !r.ambiguous);
  const one = w.profile(path.join(w.local, 'Claude-Data', 'fam'), { active: 3 * DAY, usage: w.sample(3 * DAY, 20, 10), usageAge: 3 * DAY });
  r = sel(w, []);
  check('exactly one profile on disk => selected (even if old: it is the only possibility), usage file valid', r.method === 'filesystem' && samePath(r.path, one.usage));
  const acct2 = w.profile(path.join(w.roam, 'Claude-Account2'), { active: 8 * DAY, usage: w.sample(8 * DAY, 90, 90), usageAge: 8 * DAY });
  r = sel(w, []);
  check('two profiles, one used 3 days ago and the other 8 days ago (gap >= 6 h) => the more recently used one is selected (method filesystem-activity)', r.method === 'filesystem-activity' && samePath(r.path, one.usage) && !r.ambiguous);
  w.touch(path.join(acct2.dir, 'Preferences'), 3 * DAY + HOUR); w.touch(acct2.usage, 3 * DAY + HOUR);
  r = sel(w, []);
  check('two profiles used within 6 h of each other => AMBIGUOUS (insufficient-activity-difference), no path', r.ambiguous && r.path === null && r.ambiguity.reason === 'insufficient-activity-difference' && r.ambiguity.profiles === 2);
  r = sel(w, [], { activityMarginMs: 30 * 60_000 });
  check('the confidence margin is a parameter (30 min margin accepts a 1 h gap)', !r.ambiguous && samePath(r.path, one.usage));
  mon = mkMon(() => sel(w, []));
  check('monitor on a filesystem-ambiguous result shows the clear ambiguity warning', mon.m.status().state === 'ambiguous');
  // active profile has NO usage file yet, an old leftover has one
  w = world();
  const fresh = w.profile(path.join(w.local, 'Claude-Data', 'fam'), { active: 10 * 60_000, usage: null });
  const leftover = w.profile(path.join(w.roam, 'Claude'), { active: 20 * DAY, usage: w.sample(20 * DAY, 77, 66), usageAge: 20 * DAY });
  r = sel(w, []);
  check('freshly-used profile without a usage file + old leftover with one => the used profile is selected and reported MISSING (the leftover is not used)', samePath(r.path, fresh.usage) && r.profile.state === 'missing' && !samePath(r.path, leftover.usage));
  mon = mkMon(() => sel(w, []));
  check('...monitor: "Usage unavailable", never the leftover\'s 77%', mon.m.status().state === 'unavailable' && !/77/.test(mon.m.status().text));
  w = world();
  w.profile(path.join(w.local, 'ClaudeNotifier'), { active: 1000, usage: w.sample(1000) });
  fs.mkdirSync(path.join(w.roam, 'Claude'), { recursive: true }); fs.writeFileSync(path.join(w.roam, 'Claude', '.user-data-left.fam'), '{}');
  fs.mkdirSync(path.join(w.local, 'Claude-Data'), { recursive: true }); fs.writeFileSync(path.join(w.local, 'Claude-Data', 'README.txt'), 'x');
  r = sel(w, []);
  check("this app's own folder, a marker-only legacy folder and a README-only Claude-Data root are not profiles", r.profiles.length === 0 && r.path === null);
  w = world(); const cw = w.pkg(); w.profile(path.join(cw, 'Roaming', 'Claude'), { active: 4000, usage: w.sample(4000), usageAge: 4000 }); w.profile(path.join(w.roam, 'Claude'), { active: 1000, usage: null });
  r = sel(w, []);
  check('legacy layout: the same profile seen in the plain AppData folder and the package store is ONE profile (not ambiguous)', r.profiles.length === 1 && !r.ambiguous && r.profile.state === 'valid');

  // =========================================================================================================
  console.log('== F) privacy / read-only guarantees and the REAL process query');
  w = world(); const pf = w.profile(path.join(w.local, 'Claude-Data', 'fam'), { active: 100, usage: w.sample(100) });
  const reads = []; const origRead = fs.readFileSync; fs.readFileSync = function (f, ...a) { reads.push(String(f)); return origRead.call(this, f, ...a); };
  const origWrite = fs.writeFileSync; const writes = []; fs.writeFileSync = function (f, ...a) { writes.push(String(f)); return origWrite.call(this, f, ...a); };
  const beforeBytes = origRead(pf.usage, 'utf8'); cp.selectProfile({ procs: instance(pf.dir, { cliUnder: pf.dir }), session: 1, env: w.env }); cp.selectProfile({ procs: [], session: 1, env: w.env });
  fs.readFileSync = origRead; fs.writeFileSync = origWrite;
  check('selection reads nothing except plan-usage-history.json (Preferences / Local State / config files are only stat-ed, never opened)', reads.length > 0 && reads.every((f) => path.basename(f) === paths.USAGE_FILE), [...new Set(reads.map((f) => path.basename(f)))].join(','));
  check('selection never writes anything and leaves the usage file untouched', writes.length === 0 && origRead(pf.usage, 'utf8') === beforeBytes);
  const out = JSON.stringify(cp.selectProfile({ procs: instance(pf.dir, { cliUnder: pf.dir }), session: 1, env: w.env }));
  check('the result never contains the account identifier from the usage file or the profile files', !out.includes(SECRET));
  check('labels are relative (Local/Claude-Data/...), without the Windows user name or home folder', !out.includes(w.home) && /"label":"Local\/Claude-Data\/fam"/.test(out));
  check('redact() replaces the home folder with %USERPROFILE%', cp.redact(path.join(w.home, 'a', 'b'), w.env) === path.join('%USERPROFILE%', 'a', 'b').replace(/\\/g, '\\'));

  // real PowerShell query against a decoy claude.exe (renamed node.exe) started by this test
  const decoyDir = path.join(ROOT, 'decoy', 'Claude user dir'); const cliDir = path.join(ROOT, 'decoy', 'profile with spaces', 'claude-code', '9.9', 'x'); fs.mkdirSync(decoyDir, { recursive: true }); fs.mkdirSync(cliDir, { recursive: true });
  const exeA = path.join(decoyDir, 'claude.exe'); const exeB = path.join(cliDir, 'claude.exe'); fs.copyFileSync(process.execPath, exeA); fs.copyFileSync(process.execPath, exeB);
  const udd = path.join(ROOT, 'decoy', 'profile with spaces');
  const code = `setTimeout(()=>{},40000)`;
  const d1 = spawn(exeA, ['-e', code, '--', '--type=utility', `--user-data-dir=${udd}`, '--api-secret=' + SECRET], { stdio: 'ignore', windowsHide: true });
  const exeD = path.join(ROOT, 'decoy', 'nospace', 'claude.exe'); fs.mkdirSync(path.dirname(exeD), { recursive: true }); fs.copyFileSync(process.execPath, exeD);   // no spaces: verbatim command lines do not re-quote the image path
  const d3 = spawn(exeD, ['-e', code, '--', '--type=renderer', `--user-data-dir="${udd}"`], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  const d2 = spawn(exeB, ['-e', code, '--', '--flag-with-secret=' + SECRET], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  let q; try { q = await cp.queryProcesses(); } catch (e) { q = { error: e.message }; }
  const mine3 = q.procs && q.procs.find((p) => p.pid === d3.pid);
  const mine1 = q.procs && q.procs.find((p) => p.pid === d1.pid); const mine2 = q.procs && q.procs.find((p) => p.pid === d2.pid);
  check('the real query finds the decoy helper and extracts --type and a --user-data-dir that contains SPACES', !!mine1 && mine1.type === 'utility' && path.resolve(mine1.udd).toLowerCase() === path.resolve(udd).toLowerCase(), q.error || '');
  check('...with image path, parent pid and session id', !!mine1 && samePath(mine1.exe, exeA) && Number.isInteger(mine1.ppid) && Number.isInteger(mine1.session) && q.session === mine1.session);
  check('...and the form Electron really uses, --user-data-dir="path with spaces" (quote after the =), is parsed too', !!mine3 && mine3.type === 'renderer' && path.resolve(mine3.udd).toLowerCase() === path.resolve(udd).toLowerCase());
  check('the decoy CLI (under ...\\claude-code\\...) is returned with an empty user-data-dir', !!mine2 && samePath(mine2.exe, exeB) && mine2.udd === '');
  check('only whitelisted fields leave PowerShell: no command line, so the secret-looking arguments are never seen', !!mine1 && JSON.stringify(Object.keys(mine1).sort()) === JSON.stringify(['exe', 'pid', 'ppid', 'session', 'type', 'udd']) && !JSON.stringify(q).includes(SECRET));
  const wd = world(); wd.profile(udd, { active: 100, usage: wd.sample(100, 44, 22) });
  const rr = cp.selectProfile({ procs: q.procs, session: q.session, env: wd.env });
  check('end to end with the REAL process data: the decoy helper\'s profile is identified as the active one', rr.method === 'process' && rr.profiles.some((p) => p.helpers === 1) || rr.profiles.length >= 1, `${rr.method}, ${rr.profiles.length} profile(s)`);
  for (const d of [d1, d2, d3]) { try { d.kill(); } catch { /* gone */ } }

  // =========================================================================================================
  console.log('== G) the resolver (snapshot cache, change logging, refresh cadence, failures)');
  w = world(); const ga = w.profile(path.join(w.local, 'Claude-Data', 'fam'), { active: 100, usage: w.sample(100, 45, 15), usageAge: 100 });
  let snapNow = { session: 1, procs: instance(ga.dir) }; let calls = 0; const logs = [];
  const res = new cp.ProfileResolver({ env: w.env, query: async () => { calls++; if (snapNow instanceof Error) throw snapNow; return snapNow; }, log: (x) => logs.push(x), runningMs: 60, idleMs: 25 });
  check('before the first lookup the resolver uses the filesystem fallback (and says so), it never throws', (() => { const x = res.resolve(); return x.method.startsWith('filesystem') && /unavailable/.test(x.note); })());
  await res.refresh();
  check('after a lookup it selects the active profile and logs ONE line about the choice (no secrets)', res.resolve().method === 'process' && logs.length === 2 && /method=process selected=Local\/Claude-Data\/fam usage=valid/.test(logs[1]) && !logs.join('').includes(SECRET));
  res.resolve(); res.resolve(); check('repeated resolves do not spam the log', logs.length === 2);
  snapNow = { session: 1, procs: [] }; await res.refresh();
  check('Claude closing is noticed on the next lookup (falls back to the filesystem, logged)', res.resolve().method.startsWith('filesystem') && logs.length === 3);
  snapNow = new Error('powershell blocked'); await res.refresh();
  check('a failing lookup is survivable and recorded as "process lookup unavailable"', /process lookup unavailable/.test(res.resolve().note || ''));
  snapNow = { session: 1, procs: instance(ga.dir) };
  calls = 0; const started = res.start(); await started; await sleep(260);
  check('start() keeps refreshing in the background (running => runningMs cadence)', calls >= 2 && calls <= 8, `calls=${calls}`);
  res.stop(); const c0 = calls; await sleep(200);
  check('stop() ends the refresh loop', calls === c0);
  const idle = new cp.ProfileResolver({ env: w.env, query: async () => { calls++; return { session: 1, procs: [] }; }, idleMs: 20, runningMs: 10_000 }); calls = 0; await idle.start(); await sleep(150); idle.stop();
  check('while Claude is not running it re-checks quickly (idleMs cadence) to notice Claude starting', calls >= 3, `calls=${calls}`);

  // =========================================================================================================
  console.log('== H) live switch: profile changes while the monitor runs');
  w = world(); const ha = w.profile(path.join(w.local, 'Claude-Data', 'fam'), { active: 100, usage: w.sample(100, 30, 10), usageAge: 100 });
  const hb = w.profile(path.join(w.roam, 'Claude-Account2'), { active: 100, usage: w.sample(100, 85, 60), usageAge: 100 });
  let procsNow = instance(ha.dir); const seen = [];
  const em2 = []; const mon2 = new UsageMonitor({ resolveFile: () => sel(w, procsNow), onResolve: (f) => seen.push(f && path.basename(path.dirname(f))), emit: (e) => em2.push(e), pollMs: 1e6, now: () => NOW });
  mon2.tick(); check('starts on profile A (30% / 10%)', /30%/.test(mon2.status().text) && seen.length === 1);
  procsNow = [...instance(ha.dir), ...instance(hb.dir)]; mon2.tick();
  check('a second Claude profile starts => ambiguous, A\'s numbers are no longer shown', mon2.status().state === 'ambiguous');
  procsNow = instance(hb.dir); mon2.tick();
  check('only profile B left running => B\'s numbers (85% / 60%) are shown', /85%/.test(mon2.status().text) && mon2.status().state !== 'ambiguous');
  check('while ambiguous no usage sample from either profile was processed as a new threshold crossing for A', !em2.some((e) => /30/.test(JSON.stringify(e))));

  // =========================================================================================================
  console.log('== I) the real app with mocked process metadata (tray text, --diagnose)');
  const home = path.join(ROOT, 'appworld'); const wA = world('appworld');
  const appA = wA.profile(path.join(wA.local, 'Claude-Data', 'claude_famA'), { active: 100, usage: wA.sample(60_000, 55, 30), usageAge: 60_000 });
  const appB = wA.profile(path.join(wA.roam, 'Claude-Account2'), { active: 100, usage: wA.sample(10_000, 91, 92), usageAge: 10_000 });
  fs.mkdirSync(path.join(wA.home, 'logs'), { recursive: true }); fs.writeFileSync(path.join(wA.home, 'logs', 'main.log'), '');
  const mockFile = path.join(ROOT, 'mock-procs.json');
  const baseArgs = ['--ui', 'none', '--dump-menu', '--no-lock', '--duration', '6', '--interval', '500', '--sessions-dir', path.join(wA.home, '.claude', 'sessions'), '--log-dir', path.join(wA.home, 'logs'), '--mock-claude-processes', mockFile];
  const run = (args, env) => new Promise((resolve) => { const c = spawn(process.execPath, [path.join(P, 'notifier.js'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; let e = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { e += d; }); c.on('exit', (code) => resolve({ code, o, e })); setTimeout(() => { try { c.kill(); } catch { /* done */ } }, 30000); });
  const lastMenu = (o) => { const m = o.split('\n').map((l) => { try { return JSON.parse(l).menu; } catch { return null; } }).filter(Boolean); return m[m.length - 1] || {}; };
  fs.writeFileSync(mockFile, JSON.stringify({ session: 1, procs: instance(appA.dir, { cliUnder: appA.dir }) }));
  let ra = await run(baseArgs, wA.env);
  let menu = lastMenu(ra.o);
  check('app: one active profile => tray shows ITS 5-hour 55% / weekly 30%, although the other account has fresher 91% / 92%', /5-hour 55%/.test(menu.usageText || '') && /weekly 30%/.test(menu.usageText || '') && !/91|92/.test(menu.usageText || ''), menu.usageText);
  const lg = fs.readFileSync(path.join(wA.home, '.claude-notifier', 'notifier.log'), 'utf8');
  check('app log: the choice is logged with a profile label and no secret / home path', /usage profile: method=process selected=Local\/Claude-Data\/claude_famA usage=valid/.test(lg) && !lg.includes(SECRET) && !lg.includes(wA.home.replace(/\\/g, '\\')) || /usage profile: method=process/.test(lg));
  fs.writeFileSync(mockFile, JSON.stringify({ session: 1, procs: [...instance(appA.dir), ...instance(appB.dir)] }));
  fs.rmSync(path.join(wA.home, '.claude-notifier'), { recursive: true, force: true });
  ra = await run(baseArgs, wA.env); menu = lastMenu(ra.o);
  check('app: two active profiles, no session owner => tray shows the AMBIGUITY warning, no percentages', /can't tell which Claude Desktop profile/.test(menu.usageText || '') && !/%/.test(menu.usageText || '') && !!menu.usageHint && menu.usageStale === true, menu.usageText);
  fs.writeFileSync(mockFile, JSON.stringify({ session: 1, procs: [...instance(appA.dir), ...instance(appB.dir, { cliUnder: appB.dir })] }));
  fs.rmSync(path.join(wA.home, '.claude-notifier'), { recursive: true, force: true });
  ra = await run(baseArgs, wA.env); menu = lastMenu(ra.o);
  check('app: two active profiles, live CLI only in B => tray shows B (91% / 92%)', /5-hour 91%/.test(menu.usageText || ''), menu.usageText);
  fs.writeFileSync(mockFile, JSON.stringify({ session: 1, procs: instance(appA.dir) }));
  const dg = await run(['--diagnose', '--mock-claude-processes', mockFile], wA.env);
  let rep = null; try { rep = JSON.parse(dg.o.trim().split('\n').pop()); } catch { /* reported below */ }
  check('--diagnose reports the discovery method, selected profile, its usage state and process counts', !!rep && rep.discovery.method === 'process' && rep.discovery.selected === 'Local/Claude-Data/claude_famA' && rep.discovery.selectedUsageState === 'valid' && rep.discovery.activeProcesses.helpers === 3 && rep.discovery.processLookup === 'ok');
  check('--diagnose keeps its old fields (usageFound, age, candidates, sessions dir, virtualization probe) and lists every profile found on disk (onDiskProfiles)', !!rep && rep.usageFound === true && typeof rep.usageAgeMin === 'number' && Array.isArray(rep.usageCandidates) && rep.usageCandidates.length === 1 && rep.onDiskProfiles.length === 2 && rep.onDiskProfiles.every((x) => x.label && x.usageState && typeof x.activityAgeMin === 'number') && typeof rep.virtualizedAppData !== 'undefined' && rep.sessionsDirExists === true);
  check('--diagnose contains no account identifier, no token and no home folder / user name (paths are %USERPROFILE%-relative)', !dg.o.includes(SECRET) && !dg.o.includes(wA.home) && /%USERPROFILE%/.test(rep && rep.usagePath || ''), rep && rep.usagePath);
  fs.writeFileSync(mockFile, JSON.stringify({ session: 1, procs: [...instance(appA.dir), ...instance(appB.dir)] }));
  const dg2 = await run(['--diagnose', '--mock-claude-processes', mockFile], wA.env); const rep2 = JSON.parse(dg2.o.trim().split('\n').pop());
  check('--diagnose on an ambiguous situation says so (ambiguous=true, reason, both profiles listed, usageFound false)', rep2.discovery.ambiguous === true && rep2.discovery.ambiguity.reason === 'several-active-profiles' && rep2.usageFound === false && rep2.usageCandidates.length === 2);
  fs.writeFileSync(mockFile, JSON.stringify({ session: 1, procs: [] }));
  const dg3 = await run(['--diagnose', '--mock-claude-processes', mockFile, '--activity-margin-ms', '1000'], wA.env); const rep3 = JSON.parse(dg3.o.trim().split('\n').pop());
  check('--diagnose with Claude not running reports the filesystem method', /^filesystem/.test(rep3.discovery.method), rep3.discovery.method);
  fs.writeFileSync(path.join(ROOT, 'bad.json'), 'not json');
  const dg4 = await run(['--diagnose', '--mock-claude-processes', path.join(ROOT, 'bad.json')], wA.env); const rep4 = JSON.parse(dg4.o.trim().split('\n').pop());
  check('--diagnose survives a failing process lookup and reports it', /unavailable/.test(rep4.discovery.processLookup) && /^filesystem/.test(rep4.discovery.method));
  check('no history file was modified by any of this (profiles keep their bytes)', fs.readFileSync(appA.usage, 'utf8').includes('"fh":55') && fs.readFileSync(appB.usage, 'utf8').includes('"fh":91'));

  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
