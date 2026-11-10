'use strict';
/**
 * claude-profile.js — which Claude Desktop profile (user-data folder) is ACTIVE, so the usage monitor reads that profile's
 * plan-usage-history.json and never another account's.
 *
 * Evidence, strongest first (all read-only; no token, credential, account id or conversation file is ever opened):
 *   1. RUNNING PROCESSES of the current Windows session: every Electron helper of Claude Desktop carries --user-data-dir=<profile>.
 *      Only that switch, --type, pids, the image path and the session id are extracted (inside PowerShell: full command lines
 *      never reach this program). Embedded Claude Code CLI processes live under <profile>\claude-code\...
 *   2. several profiles running  -> the one that owns live Claude Code CLI processes; otherwise AMBIGUOUS (we say so, we do not guess)
 *   3. nothing running           -> filesystem activity (modification times of a few Electron profile files); a profile is chosen
 *                                   only when it is the only one or clearly the most recently used, otherwise AMBIGUOUS.
 * Once a profile is identified the monitor is pointed ONLY at its usage file. If that file is missing, malformed or stale the
 * state is reported; there is deliberately no fall-back to a different profile.
 * Old (virtualized) Claude packages report %APPDATA%\Claude while the files physically live in Packages\Claude_*\LocalCache: both
 * spellings are treated as the same profile.
 */
const fs = require('fs');
const winpaths = require('./winpaths');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');

const MARKERS = ['Preferences', 'Local State', 'window-state.json', 'claude_desktop_config.json', 'Network'];   // presence/mtime only
const ACTIVITY_MARGIN_MS = 6 * 3600_000;
const CLI_DIR = /[\\/]claude-code[\\/]/i;

const norm = (p) => path.resolve(p).toLowerCase();
const isUnder = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const statAny = (p) => { try { return fs.statSync(p); } catch { return null; } };
const redact = (p, env = process.env) => { const h = paths.userHome(env); return p ? String(p).split(h).join('%USERPROFILE%') : p; };

/** package-store mirrors of a profile folder (old Claude packages): same relative path under LocalCache\Roaming / \Local */
function variantDirs(dir, env) {
  const out = [path.resolve(dir)];
  for (const [root, sub] of [[paths.roamingAppData(env), 'Roaming'], [paths.localAppData(env), 'Local']]) {
    if (!isUnder(dir, root)) continue;
    const rel = path.relative(path.resolve(root), path.resolve(dir));
    for (const p of paths.claudePackageCaches(env)) out.push(path.join(p.cache, sub, rel));
  }
  return [...new Map(out.map((d) => [norm(d), d])).values()];
}
/** one spelling per profile: a package-store physical path maps back to its virtual %APPDATA% / %LOCALAPPDATA% form */
function canonicalDir(dir, env) {
  for (const p of paths.claudePackageCaches(env)) {
    for (const [sub, root] of [['Roaming', paths.roamingAppData(env)], ['Local', paths.localAppData(env)]]) {
      const base = path.join(p.cache, sub);
      if (isUnder(dir, base)) return path.join(root, path.relative(base, path.resolve(dir)));
    }
  }
  return path.resolve(dir);
}
function labelOf(dir, env) {
  for (const [root, name] of [[paths.roamingAppData(env), 'Roaming'], [paths.localAppData(env), 'Local']]) if (isUnder(dir, root)) return `${name}/${path.relative(root, dir).replace(/\\/g, '/')}`;
  return redact(dir, env);
}

/** the usage file of ONE profile (all its spellings): newest valid, else newest existing, else the expected-but-missing path */
function usageFor(dir, env) {
  const infos = variantDirs(dir, env).map((d) => {
    const f = path.join(d, paths.USAGE_FILE); const st = paths.mtimeOf(f);
    return st ? { path: f, ...st, state: paths.classifyUsageFile(f, st) } : { path: f, mtimeMs: null, size: null, state: 'missing' };
  });
  const byNewest = (a, b) => b.mtimeMs - a.mtimeMs; const ex = infos.filter((i) => i.mtimeMs !== null);
  return ex.filter((i) => i.state === 'valid').sort(byNewest)[0] || ex.filter((i) => i.state === 'empty').sort(byNewest)[0] || ex.sort(byNewest)[0] || infos[0];
}
/** last activity of a profile folder from file metadata only (modification times of Electron profile files + the usage file) */
function activityOf(dir, env) {
  let best = null;
  for (const d of variantDirs(dir, env)) for (const m of [...MARKERS, paths.USAGE_FILE]) { const st = statAny(path.join(d, m)); if (st && (best === null || st.mtimeMs > best)) best = st.mtimeMs; }
  return best;
}
const looksLikeProfile = (dir, env) => activityOf(dir, env) !== null;

// ------------------------------------------------------------------------------------------------------------------------------
/** Profiles evidenced by running processes of the current session. procs: [{pid,ppid,exe,type,udd,session}] */
function profilesFromProcesses(procs, mySession, env) {
  const mine = procs.filter((p) => p && (mySession == null || p.session == null || p.session === mySession));
  const isCli = (p) => CLI_DIR.test(p.exe || '');
  const profiles = new Map(); const mainToProfile = new Map();
  const get = (dir) => { const c = canonicalDir(dir, env); const k = norm(c); if (!profiles.has(k)) profiles.set(k, { dir: c, helpers: 0, cli: 0 }); return profiles.get(k); };
  for (const p of mine) {
    if (isCli(p) || !p.udd) continue;
    const pr = get(p.udd); pr.helpers++;
    mainToProfile.set(p.type ? p.ppid : p.pid, pr);
  }
  for (const p of mine) {
    if (!isCli(p)) continue;
    const dir = p.exe.slice(0, p.exe.search(CLI_DIR));
    const known = profiles.get(norm(canonicalDir(dir, env)));
    let pr = known || mainToProfile.get(p.ppid) || null;
    if (!pr && looksLikeProfile(dir, env)) pr = get(dir);            // a CLI under a real profile folder; a stray claude-code install elsewhere is ignored
    if (pr) pr.cli++;
  }
  return [...profiles.values()];
}

/** Profiles that exist on disk (no process needed), with their last activity. */
function profilesFromDisk(env) {
  const roots = [paths.roamingAppData(env), paths.localAppData(env)];
  for (const p of paths.claudePackageCaches(env)) roots.push(path.join(p.cache, 'Roaming'), path.join(p.cache, 'Local'));
  const found = new Map();
  for (const root of roots) {
    for (const name of paths.subdirs(root)) {
      if (!/^Claude/i.test(name) || /^ClaudeNotifier/i.test(name)) continue;
      const base = path.join(root, name);
      for (const dir of [base, ...paths.subdirs(base).map((s) => path.join(base, s))]) {
        const act = activityOf(dir, env); if (act === null) continue;
        const c = canonicalDir(dir, env); const k = norm(c); const prev = found.get(k);
        found.set(k, { dir: c, activity: prev ? Math.max(prev.activity, act) : act });
      }
    }
  }
  return [...found.values()];
}

/** every profile folder found on disk with its usage state and last-activity age (diagnostics only; labels are redacted) */
function onDiskProfiles(env = process.env) {
  return profilesFromDisk(env).sort((a, b) => b.activity - a.activity).map((p) => ({ label: labelOf(p.dir, env), usageState: usageFor(p.dir, env).state, activityAgeMin: Math.round((Date.now() - p.activity) / 60000) }));
}

const describe = (pr, env) => ({ label: labelOf(pr.dir, env), ...(({ state, mtimeMs }) => ({ state, mtimeMs }))(usageFor(pr.dir, env)) });

/**
 * The decision. Pure given (procs snapshot, filesystem).
 * @returns {{method:string, ambiguous:boolean, ambiguity:object|null, path:string|null, profile:object|null, profiles:object[], candidates:object[], note:string|null}}
 */
function selectProfile({ procs, session = null, env = process.env, activityMarginMs = ACTIVITY_MARGIN_MS } = {}) {
  const result = (o) => ({ method: o.method, ambiguous: !!o.ambiguity, ambiguity: o.ambiguity || null, path: o.path || null, profile: o.profile || null, profiles: o.profiles || [], candidates: o.profiles || [], note: o.note || null });
  const chosen = (pr, method, profiles, note) => { const u = usageFor(pr.dir, env); return result({ method, path: u.path, profile: { label: labelOf(pr.dir, env), state: u.state, helpers: pr.helpers || 0, cli: pr.cli || 0 }, profiles, note }); };

  const running = Array.isArray(procs) ? profilesFromProcesses(procs, session, env) : [];
  if (running.length) {
    const profiles = running.map((p) => ({ ...describe(p, env), helpers: p.helpers, cli: p.cli }));
    if (running.length === 1) return chosen(running[0], 'process', profiles);
    const withCli = running.filter((p) => p.cli > 0);
    if (withCli.length === 1) return chosen(withCli[0], 'process+cli', profiles, `${running.length} Claude profiles are running; chose the one that owns the live Claude Code sessions`);
    return result({ method: 'process', profiles, ambiguity: { reason: withCli.length ? 'several-active-profiles-with-sessions' : 'several-active-profiles', profiles: running.length } });
  }

  const note = Array.isArray(procs) ? null : 'process lookup unavailable; used file activity';
  const disk = profilesFromDisk(env).sort((a, b) => b.activity - a.activity);
  const profiles = disk.map((p) => ({ ...describe(p, env), activityMs: p.activity }));
  if (!disk.length) return result({ method: 'filesystem', profiles, note });
  if (disk.length === 1) return chosen(disk[0], 'filesystem', profiles, note);
  if (disk[0].activity - disk[1].activity >= activityMarginMs) return chosen(disk[0], 'filesystem-activity', profiles, note);
  return result({ method: 'filesystem', profiles, note, ambiguity: { reason: 'insufficient-activity-difference', profiles: disk.length } });
}

// ------------------------------------------------------------------------------------------------------------------------------
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$me = (Get-Process -Id $PID).SessionId
$o = @()
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='claude.exe'")) {
  $c = [string]$p.CommandLine
  $t = ''; if ($c -match '--type=([A-Za-z0-9-]+)') { $t = $Matches[1] }
  $u = ''
  if ($c -match '"--user-data-dir=([^"]+)"') { $u = $Matches[1] }
  elseif ($c -match '--user-data-dir="([^"]+)"') { $u = $Matches[1] }
  elseif ($c -match '--user-data-dir=(\\S+)') { $u = $Matches[1] }
  $o += [pscustomobject]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; exe = [string]$p.ExecutablePath; type = $t; udd = $u; session = $p.SessionId }
}
@{ session = $me; procs = @($o) } | ConvertTo-Json -Compress -Depth 4
`;

/** one PowerShell run; only claude.exe image/pid/type/user-data-dir/session come back (never a full command line) */
function queryProcesses({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const c = spawn(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; let done = false;
    const fin = (fn, v) => { if (!done) { done = true; clearTimeout(t); fn(v); } };
    const t = setTimeout(() => { try { c.kill(); } catch { /* gone */ } fin(reject, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); }, timeoutMs);
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', (e) => fin(reject, e));
    c.on('exit', (code) => {
      if (code !== 0) return fin(reject, Object.assign(new Error(`powershell exit ${code}`), { code: 'EPS' }));
      try { const j = JSON.parse(out.trim()); fin(resolve, { session: j.session, procs: Array.isArray(j.procs) ? j.procs : j.procs ? [j.procs] : [] }); } catch { fin(reject, Object.assign(new Error('bad output'), { code: 'EPARSE' })); }
    });
  });
}

/** keeps the latest process snapshot; resolve() is synchronous and cheap (called by the usage monitor on every tick) */
class ProfileResolver {
  constructor({ env = process.env, query = queryProcesses, log = () => {}, runningMs = 300_000, idleMs = 60_000, activityMarginMs } = {}) {
    Object.assign(this, { env, query, log, runningMs, idleMs, activityMarginMs, snap: null, timer: null, lastKey: null, stopped: false });
  }
  async refresh() {
    try { const r = await this.query(); this.snap = { procs: r.procs, session: r.session, ok: true }; }
    catch (e) { this.snap = { procs: null, session: null, ok: false, error: e.code || e.message }; }
    return this.snap;
  }
  resolve() {
    const sel = selectProfile({ procs: this.snap ? this.snap.procs : null, session: this.snap ? this.snap.session : null, env: this.env, ...(this.activityMarginMs ? { activityMarginMs: this.activityMarginMs } : {}) });
    const k = `${sel.method}|${sel.profile ? sel.profile.label : ''}|${sel.ambiguity ? sel.ambiguity.reason : ''}`;
    if (k !== this.lastKey) {
      this.lastKey = k;
      this.log(`usage profile: method=${sel.method} ${sel.ambiguity ? `AMBIGUOUS (${sel.ambiguity.reason}, ${sel.ambiguity.profiles} profiles)` : sel.profile ? `selected=${sel.profile.label} usage=${sel.profile.state}` : 'no Claude Desktop profile found'}${sel.note ? ` [${sel.note}]` : ''}`);
    }
    return sel;
  }
  start() {
    const loop = async () => {
      if (this.stopped) return;
      await this.refresh();
      const running = this.snap && this.snap.procs && this.snap.procs.length > 0;
      this.timer = setTimeout(loop, running ? this.runningMs : this.idleMs); if (this.timer.unref) this.timer.unref();
    };
    return loop();
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

module.exports = { onDiskProfiles, selectProfile, profilesFromProcesses, profilesFromDisk, ProfileResolver, queryProcesses, usageFor, activityOf, canonicalDir, variantDirs, redact, ACTIVITY_MARGIN_MS, PS_SCRIPT };
