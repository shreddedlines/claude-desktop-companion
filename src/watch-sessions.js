#!/usr/bin/env node
/**
 * watch-sessions.js — MVP step 1: read-only watcher for Claude Code session state.
 *
 * Watches %USERPROFILE%\.claude\sessions\<pid>.json and prints every state transition.
 * It ONLY reads files matching /^\d+\.json$/ in that directory. It never touches settings,
 * hooks, credentials, transcripts, the *.key files or the peer pipes, and sends nothing.
 *
 * Stale handling: a session file counts as live only if a process with that PID exists AND
 * its creation time equals the file's `procStart` (a Windows FILETIME). This rejects both
 * dead PIDs and PIDs reused by another process after a crash.
 *
 * Usage: node watch-sessions.js        (started by merge-events.js; its development/test controls live in devhooks.js and are absent from releases)
 */
'use strict';
const fs = require('fs');
const winpaths = require('./winpaths');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// ---------- args ----------
// Development/test overrides come from devhooks.js only (an inert stub in the release build): production runs with fixed defaults.
const D = require('./devhooks').options(process.argv.slice(2));
const DIR = D.dir || path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'sessions');
const INTERVAL = D.intervalMs ?? 500;
const DURATION = D.durationSec ?? 0; // seconds, 0 = run until stopped
const ONCE = D.once;
const ONLY_DESKTOP = !D.allEntrypoints; // this tool is about Claude Desktop sessions
const NO_VERIFY = D.noVerify;           // skip creation-time check (tests only)
const PROC_TOLERANCE = 10_000_000n;             // 1 s in FILETIME units; observed diff is < 1 µs
// Process identity (PID + creation time) is verified with ONE PowerShell lookup when a session file is first seen
// and then re-verified every PROC_TABLE_MAX_AGE (default 5 min). PowerShell cold-start costs ~0.7 s of CPU, so the
// old 3 s cadence cost ~20 % of a core. Between re-verifications only the cheap PID-exists check runs.
const PROC_TABLE_MAX_AGE = D.verifyIntervalMs ?? 300000; // ms
const HEARTBEAT_MS = D.heartbeatMs ?? 30000;                       // health heartbeat line (0 = off)
const BLIND_PROBE_MS = D.blindProbeMs ?? 60000;                  // while NOTHING is live, refresh the process counts at most this often
const STATS = D.stats;
let lookups = 0;

// ---------- state model ----------
// Raw CLI status -> label. `waiting` is split by waitingFor (verified live: "input needed";
// "permission prompt" comes from the CLI source and has not been observed live yet).
function label(status, waitingFor) {
  switch (status) {
    case 'busy': return 'WORKING';
    case 'idle': return 'IDLE';
    case 'shell': return 'SHELL';
    case 'waiting':
      if (waitingFor === 'input needed') return 'WAITING_FOR_USER';
      if (waitingFor === 'permission prompt') return 'WAITING_FOR_PERMISSION';
      return 'WAITING_UNKNOWN';
    default: return `UNKNOWN(${status})`;
  }
}

// ---------- output ----------
const tty = process.stdout.isTTY;
const color = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const LABEL_COLOR = { WORKING: 33, IDLE: 32, WAITING_FOR_USER: 35, WAITING_FOR_PERMISSION: 31, WAITING_UNKNOWN: 31 };
const pad = (n, w = 2) => String(n).padStart(w, '0');
function hms(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const paint = (l) => color(LABEL_COLOR[l] || 0, l);
const who = (s) => `${s.name || '(unnamed)'} | ${path.basename(s.cwd || '?') || s.cwd}`;
function out(line) { process.stdout.write(line + '\n'); }

// ---------- process table (PID -> creation FILETIME) ----------
let procTable = new Map();
let procTableAt = 0;
let refreshing = null;
let verifyBroken = false;
let procStats = { cli: null, desktop: null };
const confirmed = new Map(); // `${pid}:${procStart}` -> true (identity verified) | false (not that process: reused PID)
const keyOf = (f) => `${f.pid}:${f.procStart}`;

function refreshProcTable() {
  if (refreshing) return refreshing;
  refreshing = new Promise((resolve) => {
    // also matches the CLI by install folder, so a renamed binary does not make every session look "reused"
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR ExecutablePath LIKE '%claude-code%'\" | " +
      "ForEach-Object { \"$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc()) $($_.ExecutablePath)\" }";
    lookups++;
    execFile(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        if (err) {
          if (!verifyBroken) out(color(31, `[warn] process lookup failed (${err.message.split('\n')[0]}); falling back to PID-exists only`));
          verifyBroken = true;
        } else {
          verifyBroken = false;
          const t = new Map(); let cli = 0; let desktop = 0;
          for (const line of stdout.split(/\r?\n/)) {
            const m = /^(\d+) (\d+)(?: (.*))?$/.exec(line.trim());
            if (m) { t.set(Number(m[1]), BigInt(m[2])); if (/claude-code/i.test(m[3] || '')) cli++; else desktop++; }
          }
          procTable = t; procStats = { cli, desktop };
          procTableAt = Date.now();
        }
        refreshing = null;
        resolve();
      });
  });
  return refreshing;
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** returns { live: bool, reason: string } */
function liveness(s) {
  if (!pidExists(s.pid)) return { live: false, reason: 'pid not running' };
  if (NO_VERIFY || verifyBroken) return { live: true, reason: 'pid exists (creation time not verified)' };
  const c = confirmed.get(keyOf(s));
  if (c === true) return { live: true, reason: 'verified' };
  const ft = procTable.get(s.pid);
  if (ft === undefined) return { live: false, reason: 'pid is not a claude.exe process (pid reused)' };
  let want;
  try { want = BigInt(s.procStart); } catch { return { live: false, reason: 'file has no valid procStart' }; }
  const diff = ft > want ? ft - want : want - ft;
  if (diff > PROC_TOLERANCE) return { live: false, reason: 'pid reused: creation time != procStart' };
  return { live: true, reason: 'verified' };
}

// ---------- session file reading ----------
const FILE_RE = /^(\d+)\.json$/; // deliberately excludes <pid>.<hash>.key
function readSessions() {
  let names;
  try { names = fs.readdirSync(DIR); } catch (e) { return { error: e, files: [] }; }
  const files = [];
  for (const n of names) {
    const m = FILE_RE.exec(n);
    if (!m) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(DIR, n), 'utf8'); } catch { continue; } // vanished mid-read
    let j;
    try { j = JSON.parse(raw); } catch { files.push({ file: n, pid: Number(m[1]), partial: true }); continue; } // mid-write
    if (!j || typeof j !== 'object') continue;
    files.push({
      file: n, pid: Number(m[1]), filePid: j.pid, name: j.name, cwd: j.cwd, status: j.status,
      waitingFor: j.waitingFor ?? null, statusUpdatedAt: j.statusUpdatedAt, procStart: j.procStart,
      entrypoint: j.entrypoint, kind: j.kind, sessionId: j.sessionId,
    });
  }
  return { files };
}

// ---------- main loop ----------
const active = new Map();   // pid -> last known {label,status,waitingFor,name,cwd,...}
const staleSeen = new Map(); // pid -> reason last reported (avoid repeating)
let firstScan = true;
let stopping = false;

async function tick() {
  const { files, error } = readSessions();
  if (error) {
    if (!tick.warnedDir) { out(color(31, `[warn] cannot read ${DIR}: ${error.code || error.message}`)); tick.warnedDir = true; }
    return;
  }
  tick.warnedDir = false;
  const now = Date.now();

  const candidates = files.filter((f) => !f.partial && f.pid === f.filePid && f.status);
  // Re-verify identities when the last lookup is old, or when a (pid, procStart) has never been verified.
  // A key that was checked and rejected (e.g. a reused PID) is remembered, so it does NOT trigger lookups every tick.
  // While no session is live the process counts (cli/desktop) are still needed by the health canary ("CLI processes exist
  // but no sessions are visible" must not depend on stale numbers, nor go blind when the files vanish). This probe stops
  // as soon as the counts say there are no CLI processes, so a closed Claude costs nothing.
  const blindProbe = !NO_VERIFY && active.size === 0 && (procStats.cli === null || procStats.cli > 0) && now - procTableAt > BLIND_PROBE_MS;
  if (!NO_VERIFY && ((candidates.length &&
      (now - procTableAt > PROC_TABLE_MAX_AGE || candidates.some((f) => pidExists(f.pid) && !confirmed.has(keyOf(f))))) || blindProbe)) {
    await refreshProcTable();
    if (!verifyBroken) {
      confirmed.clear();
      for (const f of candidates) {
        if (!pidExists(f.pid)) continue;
        let want; try { want = BigInt(f.procStart); } catch { confirmed.set(keyOf(f), false); continue; }
        const ft = procTable.get(f.pid);
        const diff = ft === undefined ? null : (ft > want ? ft - want : want - ft);
        confirmed.set(keyOf(f), diff !== null && diff <= PROC_TOLERANCE);
      }
    }
  }

  const seen = new Set(); let considered = 0;
  for (const f of candidates) {
    if (ONLY_DESKTOP && f.entrypoint !== 'claude-desktop') continue;
    considered++;
    const lv = liveness(f);
    if (!lv.live) {
      if (staleSeen.get(f.pid) !== lv.reason) {
        staleSeen.set(f.pid, lv.reason);
        if (active.has(f.pid)) {
          out(`${hms(now)}  PID ${f.pid}  [${who(active.get(f.pid))}]  ${color(90, 'SESSION ENDED')}  (process gone, file left behind: ${lv.reason})`);
          active.delete(f.pid);
        } else {
          out(`${hms(now)}  PID ${f.pid}  ${color(90, 'stale file ignored')}  (${f.file}: ${lv.reason}; last status "${f.status}")`);
        }
      }
      continue;
    }
    staleSeen.delete(f.pid);
    seen.add(f.pid);
    const cur = { ...f, label: label(f.status, f.waitingFor) };
    const prev = active.get(f.pid);
    active.set(f.pid, cur);
    const statusAt = f.statusUpdatedAt ? hms(f.statusUpdatedAt) : '?';
    const lag = f.statusUpdatedAt ? `${((now - f.statusUpdatedAt) / 1000).toFixed(2)}s` : '?';
    if (!prev) {
      const tag = firstScan ? 'INITIAL' : 'NEW SESSION';
      out(`${hms(now)}  PID ${f.pid}  [${who(cur)}]  ${tag}: ${paint(cur.label)}  (status=${f.status})  waitingFor=${JSON.stringify(f.waitingFor)}  statusAt=${statusAt}`);
    } else if (prev.label !== cur.label || prev.waitingFor !== cur.waitingFor) {
      const note = prev.label === 'WORKING' && cur.label === 'IDLE' ? '  (turn finished)' : '';
      out(`${hms(now)}  PID ${f.pid}  [${who(cur)}]  ${paint(prev.label)} -> ${paint(cur.label)}  (${prev.status} -> ${f.status})  waitingFor=${JSON.stringify(f.waitingFor)}  statusAt=${statusAt} lag=${lag}${note}`);
    }
  }

  // sessions whose file disappeared (clean exit) or that were skipped as non-live this scan
  const present = new Set(files.map((f) => f.pid));
  for (const [pid, s] of [...active]) {
    if (!present.has(pid)) {
      out(`${hms(now)}  PID ${pid}  [${who(s)}]  ${color(90, 'SESSION ENDED')}  (file removed, was ${s.label})`);
      active.delete(pid);
      staleSeen.delete(pid);
    }
  }
  for (const pid of [...staleSeen.keys()]) if (!present.has(pid)) staleSeen.delete(pid);

  if (firstScan) {
    firstScan = false;
    out(`${hms(now)}  -- initial scan done: ${active.size} live session(s), ${staleSeen.size} stale file(s) ignored --`);
  }

  // health heartbeat: lets the notifier tell "no sessions because Claude is idle/closed" from "pipeline is blind"
  if (HEARTBEAT_MS > 0 && now - (tick.lastHb || 0) >= HEARTBEAT_MS) {
    tick.lastHb = now;
    out(`${hms(now)}  -- heartbeat: files=${considered} live=${active.size} stale=${staleSeen.size} cli=${procStats.cli ?? '?'} desktop=${procStats.desktop ?? '?'} lookupAgeSec=${procTableAt ? Math.max(0, Math.round((now - procTableAt) / 1000)) : '?'} --`);
  }
}

async function main() {
  out(`watch-sessions: dir=${DIR} interval=${INTERVAL}ms${DURATION ? ` duration=${DURATION}s` : ''}${ONLY_DESKTOP ? ' (claude-desktop sessions only)' : ''}`);
  out('read-only: only <pid>.json files are read; nothing is written or sent. Ctrl+C to stop.');
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const deadline = DURATION ? Date.now() + DURATION * 1000 : Infinity;
  do {
    const t0 = Date.now();
    try { await tick(); } catch (e) { out(color(31, `[warn] tick failed: ${e.message}`)); }
    if (ONCE) break;
    const wait = Math.max(0, INTERVAL - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  } while (!stopping && Date.now() < deadline);
  out(`${hms(Date.now())}  -- stopped --`);
  if (STATS) { const cu = process.cpuUsage(); process.stderr.write(`[stats] lookups=${lookups} cpuMs=${Math.round((cu.user + cu.system) / 1000)}\n`); }
}
main();
