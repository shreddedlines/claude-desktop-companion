#!/usr/bin/env node
/**
 * merge-events.js — MVP step 2: one normalized, de-duplicated event stream from
 *   (a) the UNCHANGED session-file watcher (watch-sessions.js, run as a child process), and
 *   (b) a read-only tail of Desktop's main.log (+ main1.log on rotation).
 *
 * Output (one line per event):  timestamp | session | project | event_type | details | source
 *
 * Read-only. It does not read settings, credentials/tokens, transcripts or the usage
 * endpoint, and it sends/notifies nothing.
 *
 * Usage: node merge-events.js [--json] [--hold ms] [--verbose]
 *   (--json and --hold are the options the notifier uses; development/test controls live in devhooks.js and are absent from releases)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { LogTailer } = require('./log-tailer');

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
// Development/test overrides come from devhooks.js only (an inert stub in the release build). Internal flags used by the notifier: --json, --hold.
const D = require('./devhooks').options(argv);
const SESSIONS_DIR = D.sessionsDir || path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'sessions');
const LOG_DIR = D.logDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude', 'logs');
const INTERVAL = D.intervalMs ?? 500;
const HOLD_MS = Number(opt('--hold', 2500));          // how long to wait for the second source of the same event
const DURATION = D.durationSec ?? 0;
const HB_MS = D.hbMs ?? 30000;                        // heartbeat period (JSON mode)
const REPLAY_DAYS = D.replayDays ?? 0;                // >0: also parse existing log history (marked "(replay)")
const JSON_OUT = flag('--json');
const VERBOSE = flag('--verbose');
const WATCHER = path.join(__dirname, 'watch-sessions.js');

const diag = (m) => process.stderr.write(`[merge] ${m}\n`);
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmt(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const clean = (s) => String(s).replace(/\s*\|\s*/g, ' / ').replace(/[\r\n]+/g, ' ').trim();

// ---------- session directory: pid <-> Desktop session id (local_...) <-> name/project ----------
// Reads <pid>.json only (same files the watcher reads). Entries are retained after a session ends
// so late log lines can still be attributed.
class SessionDirectory {
  constructor(dir) { this.dir = dir; this.byPid = new Map(); this.byHost = new Map(); }
  refresh() {
    let names; try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const n of names) {
      const m = /^(\d+)\.json$/.exec(n); if (!m) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
        const info = { pid: +m[1], host: j.hostSessionId, name: j.name, project: path.basename(j.cwd || '') || '?' };
        this.byPid.set(info.pid, info);
        if (info.host) this.byHost.set(info.host, info);
      } catch { /* partial write or vanished: next refresh */ }
    }
  }
  forPid(pid) { if (!this.byPid.has(pid)) this.refresh(); return this.byPid.get(pid); }
  forHost(host) { if (!this.byHost.has(host)) this.refresh(); return this.byHost.get(host); }
}

// ---------- event bus: correlation + de-duplication ----------
// Same logical event seen by two sources (status file + main.log) is held briefly and merged into ONE
// event. Repeats from one source (retries, duplicate log lines) are dropped by key within a window.
const CORRELATED = new Set(['WAITING_FOR_PERMISSION', 'WAITING_FOR_USER', 'TURN_FINISHED']);

class EventBus {
  constructor(sink, holdMs) {
    this.sink = sink; this.holdMs = holdMs;
    this.pending = new Map();   // `${session}|${type}` -> {ev, timer}
    this.recent = new Map();    // same key -> {ev, at}   (already emitted; catches a late second source)
    this.windows = new Map();   // dedupe key -> last emit time
    this.seenIds = new Set();   // permission request ids
    this.suppressed = 0;
  }
  submit(ev) {
    const sess = ev.sessionKey;
    if (CORRELATED.has(ev.type)) {
      const k = `${sess}|${ev.type}`;
      const p = this.pending.get(k);
      if (p && !p.ev.sources.includes(ev.sources[0])) { this._merge(p.ev, ev); return; }  // counterpart arrived in time
      const r = this.recent.get(k);
      if (r && Date.now() - r.at < this.holdMs + 1500 && !r.ev.sources.includes(ev.sources[0])) {
        this.suppressed++; if (VERBOSE) diag(`late duplicate merged away: ${k} (${ev.sources[0]})`); return;
      }
      if (p) this._flush(k); // same source twice => two distinct events
      const timer = setTimeout(() => this._flush(k), this.holdMs);
      this.pending.set(k, { ev, timer });
      return;
    }
    if (ev.dedupe) {
      // window on the event's own timestamp (== wall clock live; keeps replayed history from collapsing)
      const last = this.windows.get(ev.dedupe.key);
      if (last !== undefined && Math.abs(ev.ts - last) < ev.dedupe.windowMs) {
        this.suppressed++; if (VERBOSE) diag(`duplicate dropped: ${ev.dedupe.key}`); return;
      }
      this.windows.set(ev.dedupe.key, ev.ts);
    }
    this.sink(ev);
  }
  _merge(base, add) {
    base.sources = [...new Set([...base.sources, ...add.sources])];
    // the status file stamps to the millisecond, log lines only to the second: prefer the precise one
    if (add.precise && !base.precise) { base.ts = add.ts; base.precise = true; } else if (!add.precise === !base.precise) base.ts = Math.min(base.ts, add.ts);
    if (add.details && !base.details.includes(add.details)) base.details += `; ${add.details}`;
    if (base.session.startsWith('local_') && !add.session.startsWith('local_')) { base.session = add.session; base.project = add.project; }
  }
  _flush(k) {
    const p = this.pending.get(k); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(k);
    this.recent.set(k, { ev: p.ev, at: Date.now() });
    this.sink(p.ev);
  }
  flushAll() { for (const k of [...this.pending.keys()]) this._flush(k); }
}

// ---------- output ----------
function emit(ev) {
  const src = ev.sources.join('+');
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ts: fmt(ev.ts), epoch: ev.ts, session: ev.session, project: ev.project,
      sessionId: ev.sessionId || null, pid: ev.pid || null, type: ev.type, details: ev.details, source: src }) + '\n');
  } else {
    process.stdout.write(`${fmt(ev.ts)} | ${clean(ev.session)} | ${clean(ev.project)} | ${ev.type} | ${clean(ev.details)} | ${src}\n`);
  }
}

// ---------- shared helpers ----------
const dir = new SessionDirectory(SESSIONS_DIR);
const bus = new EventBus(emit, HOLD_MS);

function sessionFromHost(host) {
  const i = dir.forHost(host);
  if (i) return { session: i.name || host, project: i.project, sessionKey: host, sessionId: host, pid: i.pid };
  return { session: host.slice(0, 14), project: '?', sessionKey: host, sessionId: host, pid: null };
}

// ---------- source 1: lines printed by the unchanged watch-sessions.js ----------
// "HH:MM:SS.mmm  PID n  [name | project]  <rest>"
const W_LINE = /^(\d\d:\d\d:\d\d\.\d{3})\s+PID (\d+)\s+\[(.*?)\]\s{2}(.*)$/;
const W_HEARTBEAT = /^\d\d:\d\d:\d\d\.\d{3}\s+-- heartbeat: files=(\d+) live=(\d+) stale=(\d+) cli=(\S+) desktop=(\S+) lookupAgeSec=(\S+) --/;
let watcherHb = null; // last heartbeat line from the session-file watcher (health canary input)

function todayAt(hms, nowMs) {
  const [h, m, sm] = hms.split(':'); const [s, ms] = sm.split('.');
  const d = new Date(nowMs); d.setHours(+h, +m, +s, +ms);
  let t = d.getTime(); if (t > nowMs + 60_000) t -= 86_400_000; // line stamped just before midnight
  return t;
}

function handleWatcherLine(line) {
  line = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (!line) return;
  const hb = W_HEARTBEAT.exec(line);
  if (hb) {
    const n = (v) => (/^\d+$/.test(v) ? Number(v) : null);
    watcherHb = { at: Date.now(), files: +hb[1], live: +hb[2], stale: +hb[3], cli: n(hb[4]), desktop: n(hb[5]) };
    return;
  }
  const m = W_LINE.exec(line);
  if (!m) { if (VERBOSE || /\[warn\]/.test(line)) diag(`watcher: ${line}`); return; }
  const now = Date.now();
  const pid = +m[2];
  const rest = m[4];
  const nm = m[3]; const cut = nm.lastIndexOf(' | ');
  const name = cut >= 0 ? nm.slice(0, cut) : nm; const project = cut >= 0 ? nm.slice(cut + 3) : '?';
  const info = dir.forPid(pid);
  const host = info && info.host;
  const base = { session: name, project, sessionKey: host || `pid:${pid}`, sessionId: host, pid, sources: ['session-file'], ts: now };
  const statusAt = /statusAt=(\d\d:\d\d:\d\d\.\d{3})/.exec(rest);
  if (statusAt) { base.ts = todayAt(statusAt[1], now); base.precise = true; }
  const wf = /waitingFor=("[^"]*"|null)/.exec(rest);
  const waitingFor = wf ? wf[1] : 'null';

  let x;
  if ((x = /^(INITIAL|NEW SESSION): (\S+)/.exec(rest))) {
    bus.submit({ ...base, type: x[1] === 'INITIAL' ? 'INITIAL_STATE' : 'SESSION_STARTED', details: `state=${x[2]}` });
  } else if ((x = /^SESSION ENDED\s+\((.*)\)\s*$/.exec(rest))) {
    bus.submit({ ...base, ts: now, type: 'SESSION_ENDED', details: x[1] });
  } else if ((x = /^(\S+) -> (\S+)\s+\((\w+) -> (\w+)\)/.exec(rest))) {
    const [, from, to] = x;
    if (to === 'WORKING') {
      bus.submit({ ...base, type: 'WORKING', details: from.startsWith('WAITING') ? `resumed after ${from}` : `from ${from}` });
    } else if (to === 'IDLE') {
      bus.submit({ ...base, type: from === 'WORKING' ? 'TURN_FINISHED' : 'IDLE', details: from === 'WORKING' ? 'status busy->idle' : `from ${from}` });
    } else if (to === 'WAITING_FOR_USER' || to === 'WAITING_FOR_PERMISSION') {
      bus.submit({ ...base, type: to, details: `waitingFor=${waitingFor}` });
    } else {
      bus.submit({ ...base, type: to, details: `from ${from}; waitingFor=${waitingFor}` });
    }
  } else if (/^stale file ignored/.test(rest)) {
    if (VERBOSE) diag(`stale: PID ${pid} ${rest}`);
  } else if (VERBOSE) diag(`unparsed watcher line: ${line}`);
}

// ---------- source 2: main.log entries ----------
const LIMIT_RE = /hit your .{0,40}limit|usage limit|limit reached|rate.?limit/i;
const seenIgnored = { unhealthy: 0 };

function handleLogEntry(e) {
  const t = e.text;
  const src = e.replay ? `${e.file}(replay)` : e.file;
  let x;

  if ((x = /^Emitted tool permission request (\S+) for (\S+) in session (local_\S+)$/.exec(t))) {
    const [, reqId, tool, host] = x;
    if (bus.seenIds.has(reqId)) { bus.suppressed++; return; }
    bus.seenIds.add(reqId);
    const type = tool === 'AskUserQuestion' ? 'WAITING_FOR_USER' : 'WAITING_FOR_PERMISSION';
    bus.submit({ ...sessionFromHost(host), ts: e.ts, sources: [src], type, details: `tool=${tool} request=${reqId.slice(0, 8)}` });
  } else if ((x = /^\[Stop hook\] Query completed for session (local_\S+)$/.exec(t))) {
    bus.submit({ ...sessionFromHost(x[1]), ts: e.ts, sources: [src], type: 'TURN_FINISHED', details: 'stop hook: query completed' });
  } else if ((x = /^\[CCD CycleHealth\] (local_\S+) api_error \(([^)]*)\): (.*)$/.exec(t))) {
    const msg = x[3].trim();
    const type = LIMIT_RE.test(msg) ? 'SESSION_LIMIT' : 'API_ERROR';
    bus.submit({ ...sessionFromHost(x[1]), ts: e.ts, sources: [src], type, details: msg.slice(0, 220),
      dedupe: { key: `${x[1]}|${type}|${msg}`, windowMs: 120_000 } });
  } else if (/^\[CCD CycleHealth\] unhealthy cycle for /.test(t)) {
    seenIgnored.unhealthy++; // always accompanies an api_error line that is already reported
  } else if ((x = /^Session (local_\S+) query error: Claude Code process exited with code (\d+)\. stderr: (.*)$/.exec(t))) {
    const code = +x[2];
    const tag = /\[claude-code:[a-z_]+\]/.exec(x[3]);
    bus.submit({ ...sessionFromHost(x[1]), ts: e.ts, sources: [src], type: 'PROCESS_EXITED_ERROR',
      details: `exit code ${code} (0x${code.toString(16).toUpperCase()})${tag ? ` ${tag[0]}` : ''}`,
      dedupe: { key: `${x[1]}|exit|${code}`, windowMs: 30_000 } });
  }
}

// ---------- main ----------
function main() {
  diag(`sessions-dir=${SESSIONS_DIR} log-dir=${LOG_DIR} hold=${HOLD_MS}ms${REPLAY_DAYS ? ` replay-days=${REPLAY_DAYS}` : ''}`);
  if (!JSON_OUT) process.stdout.write('timestamp | session | project | event_type | details | source\n');
  dir.refresh();

  // session-file watcher: the existing script, unmodified, as a child process
  const child = spawn(process.execPath, [WATCHER, ...require('./devhooks').forwardToWatcher(D)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { handleWatcherLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr.on('data', (d) => diag(`watcher stderr: ${d.toString().trim()}`));
  child.on('exit', (code) => { if (!stopping) { diag(`watcher exited unexpectedly (code ${code})`); shutdown(1); } });

  // log tailer
  const cutoff = REPLAY_DAYS ? Date.now() - REPLAY_DAYS * 86_400_000 : 0;
  const tail = new LogTailer({ dir: LOG_DIR, intervalMs: INTERVAL, fromStart: REPLAY_DAYS > 0 });
  tail.on('entry', (e) => { if (e.replay && e.ts < cutoff) return; handleLogEntry(e); });
  tail.on('rotation', (r) => diag(`log rotation detected: ${r.kind}${r.drainedBytes !== undefined ? ` (drained ${r.drainedBytes} bytes from main1.log)` : ''}`));
  tail.on('warn', (m) => diag(m));
  tail.start();

  const refresher = setInterval(() => dir.refresh(), 2000);
  // heartbeat for the notifier's health canary (JSON mode only): proves this process and the watcher are alive
  const hbTimer = JSON_OUT ? setInterval(() => {
    process.stdout.write(JSON.stringify({ type: 'HEARTBEAT', epoch: Date.now(), session: '-', project: '-', details: 'heartbeat', source: 'merge-events',
      health: { watcherAgeMs: watcherHb ? Date.now() - watcherHb.at : null, files: watcherHb && watcherHb.files, live: watcherHb && watcherHb.live,
        stale: watcherHb && watcherHb.stale, cli: watcherHb && watcherHb.cli, desktop: watcherHb && watcherHb.desktop } }) + '\n');
  }, HB_MS) : null;
  let stopping = false;
  function shutdown(code = 0) {
    if (stopping) return; stopping = true;
    clearInterval(refresher); if (hbTimer) clearInterval(hbTimer); tail.stop();
    bus.flushAll();
    try { child.kill(); } catch { /* already gone */ }
    diag(`stopped (suppressed duplicates: ${bus.suppressed}, ignored unhealthy-cycle lines: ${seenIgnored.unhealthy})`);
    setTimeout(() => process.exit(code), 100);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (DURATION) setTimeout(() => shutdown(0), DURATION * 1000);
}

if (require.main === module) main();
