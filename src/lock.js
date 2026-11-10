'use strict';
/**
 * lock.js — single-instance lock that survives crashes and PID reuse.
 *
 * The lock file records { pid, startMs }: the owner's PID AND its process start time. A lock is honoured only if
 * a process with that PID exists AND started when the lock says (±5 s). So:
 *   - dead owner                 -> stale, recovered
 *   - PID reused by another app  -> start time differs, recovered
 *   - lock older than the last boot -> stale, recovered (no process lookup needed)
 *   - legacy plain-number lock   -> compared against the lock file's modification time
 *   - start time cannot be read  -> falls back to the image name (not node.exe => recovered); otherwise the owner is
 *                                   assumed to be running and the reason is returned so it can be logged.
 * Every decision returns a human-readable `reason` that the caller logs; a refusal is never silent.
 */
const fs = require('fs');
const winpaths = require('./winpaths');
const os = require('os');
const { spawnSync } = require('child_process');

const TOL_MS = 5000;

function readLock(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
  if (!raw) return { pid: 0, startMs: null, legacy: true, mtimeMs: safeMtime(file) };
  try { const j = JSON.parse(raw); if (j && Number.isInteger(j.pid)) return { pid: j.pid, startMs: Number.isFinite(j.startMs) ? j.startMs : null, legacy: !Number.isFinite(j.startMs), mtimeMs: safeMtime(file) }; } catch { /* maybe legacy */ }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? { pid: n, startMs: null, legacy: true, mtimeMs: safeMtime(file) } : { pid: 0, startMs: null, legacy: true, mtimeMs: safeMtime(file) };
}
function safeMtime(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }

const selfStartMs = () => Math.round(Date.now() - process.uptime() * 1000);

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** process start time (epoch ms) of another PID, or null. Only used in the rare "lock exists and PID is alive" path. */
function processStartMs(pid) {
  try {
    const r = spawnSync(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command',
      `[DateTimeOffset]::new((Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const n = Number(String(r.stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function imageName(pid) {
  try {
    const r = spawnSync(winpaths.tasklistExe(), ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const m = /^"([^"]+)"/.exec(String(r.stdout || '').trim());
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

/**
 * Decide whether we may start. Everything environmental is injectable so the cases can be tested exactly.
 * @returns {{ acquire: boolean, reason: string }}
 */
function checkLock({ file, selfPid = process.pid, now = Date.now(), alive = isAlive, startOf = processStartMs, imageOf = imageName, bootMs = Date.now() - os.uptime() * 1000 }) {
  const lock = readLock(file);
  if (!lock) return { acquire: true, reason: 'no lock file' };
  if (!lock.pid) return { acquire: true, reason: 'lock file empty/corrupt: recovered' };
  if (lock.pid === selfPid) return { acquire: true, reason: 'lock already ours' };
  if (!alive(lock.pid)) return { acquire: true, reason: `stale lock: owner process ${lock.pid} is not running (recovered)` };
  const stamp = lock.startMs ?? lock.mtimeMs;
  if (stamp && stamp < bootMs - TOL_MS) return { acquire: true, reason: `stale lock: written before the last system boot (owner PID ${lock.pid} is a different, newer process) (recovered)` };
  const start = startOf(lock.pid);
  if (start !== null && start !== undefined) {
    if (lock.startMs !== null) {
      if (Math.abs(start - lock.startMs) <= TOL_MS) return { acquire: false, reason: `already running: PID ${lock.pid} started at ${new Date(start).toISOString()}, matching the lock` };
      return { acquire: true, reason: `PID reuse: lock owner started at ${new Date(lock.startMs).toISOString()}, but PID ${lock.pid} now belongs to a process that started at ${new Date(start).toISOString()} (recovered)` };
    }
    // legacy lock: it was written when its owner started, so a process that started AFTER the lock was written is not the owner
    if (start > lock.mtimeMs + TOL_MS) return { acquire: true, reason: `PID reuse (legacy lock): PID ${lock.pid} started at ${new Date(start).toISOString()}, after the lock was written (recovered)` };
    return { acquire: false, reason: `already running (legacy lock): PID ${lock.pid} started at ${new Date(start).toISOString()}` };
  }
  const img = imageOf(lock.pid);
  if (img && img !== 'node.exe') return { acquire: true, reason: `stale lock: PID ${lock.pid} is ${img}, not a Node process (recovered)` };
  return { acquire: false, reason: `lock owner PID ${lock.pid} is alive but its start time could not be verified${img ? ` (${img})` : ''}; assuming Claude Notifier is already running — delete the lock file if it is not` };
}

function writeLock(file, pid = process.pid) { fs.writeFileSync(file, JSON.stringify({ pid, startMs: pid === process.pid ? selfStartMs() : null, written: new Date().toISOString() })); }
function releaseLock(file, pid = process.pid) { try { const l = readLock(file); if (l && l.pid === pid) fs.unlinkSync(file); } catch { /* ignore */ } }

module.exports = { checkLock, writeLock, releaseLock, readLock, selfStartMs, processStartMs, imageName, TOL_MS };
