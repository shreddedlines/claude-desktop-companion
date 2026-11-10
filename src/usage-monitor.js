'use strict';
/**
 * usage-monitor.js — Step 5: plan-usage warnings from Claude Desktop's own local history file.
 *
 * Source: %APPDATA%\Claude\plan-usage-history.json  (written by Claude Desktop itself).
 *   samples: [{ t: epoch ms, org, u: { fh: 5-hour %, sd: weekly %, xu: extra-usage % } }]
 * Desktop only appends samples while its tray menu has been opened within the last 24 h
 * (every 5 min for 30 min after an interaction, then every 15 min), so data can go STALE.
 *
 * Read-only: the history file is only ever read (readFileSync). No OAuth tokens, no network, no
 * transcripts. The org id in the file is never used for display or sent anywhere; only a short hash of
 * it is kept locally to notice an account switch. This module writes ONE file of its own
 * (usage-state.json in the app's data folder) so alerts are not repeated after a restart.
 *
 * Events produced (consumed by the existing policy / tray / phone paths):
 *   USAGE_WARNING   a window crossed 80 %   (default)
 *   USAGE_CRITICAL  a window crossed 90 %
 *   USAGE_CLEARED   a window dropped back below an alerted threshold (re-arms it; retracts the toast)
 *   USAGE_STALE     no fresh sample for a while -> "open Claude Desktop's tray menu to refresh"
 */
const fs = require('fs');
const crypto = require('crypto');

const WINDOWS = { fh: '5-hour', sd: 'Weekly' };
const DEFAULTS = {
  thresholds: [80, 90],
  freshMs: 20 * 60_000,            // sample older than this => data is stale (poll cadence is 5-15 min)
  staleNoticeGapMs: 4 * 3600_000,  // never nag about staleness more often than this
  maxAlertAgeMs: 20 * 60_000,      // a sample older than this never raises a threshold alert
};

const short = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

/** newest sample in the history file, or { status } when unusable. Never throws. */
function readLatestSample(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { status: e.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { status: 'unreadable' }; }   // mid-write: keep previous state
  const s = j && Array.isArray(j.samples) ? j.samples : null;
  if (!s || !s.length) return { status: 'empty' };
  let best = null;
  for (const x of s) if (x && Number.isFinite(x.t) && (!best || x.t > best.t)) best = x;
  if (!best) return { status: 'empty' };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { sample: { t: best.t, fh: num(best.u && best.u.fh), sd: num(best.u && best.u.sd), org: best.org ? short(best.org) : null } };
}

function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}

class UsageTracker {
  /** @param {{state?:object, onState?:Function, now?:Function} & Partial<typeof DEFAULTS>} o */
  constructor(o = {}) {
    this.opt = { ...DEFAULTS, ...o };
    this.now = o.now || Date.now;
    this.onState = o.onState || (() => {});
    this.state = o.state && o.state.v === 1 ? o.state : { v: 1, org: null, lastT: 0, windows: {}, lastStaleNoticeAt: 0, staleNoticed: false };
    this.latest = null; // newest sample seen (for status display)
  }

  _win(w) {
    if (!this.state.windows[w]) this.state.windows[w] = { armed: {}, alerted: {} };
    for (const th of this.opt.thresholds) { if (this.state.windows[w].armed[th] === undefined) this.state.windows[w].armed[th] = true; }
    return this.state.windows[w];
  }

  _event(type, w, th, v, sample) {
    const label = WINDOWS[w];
    return {
      type, session: 'Claude usage', project: '?', sessionId: `usage:${w}:${th}`, pid: null, source: 'usage-history', epoch: this.now(),
      title: type === 'USAGE_CLEARED' ? undefined : `${label} usage reached ${th}%`,
      details: `${label} ${v}% (threshold ${th}%)`,
      usage: { window: w, label, threshold: th, value: v, sampleAt: sample.t },
    };
  }

  /** feed the newest sample; returns the events to emit (possibly none) */
  process(sample) {
    this.latest = sample;
    const st = this.state; const out = [];
    const sameOrg = st.org === sample.org;
    if (sample.t <= st.lastT && sameOrg) return out;                       // already processed (duplicate / older)
    const firstOrSwitched = !st.lastT || !sameOrg;
    const fresh = this.now() - sample.t <= this.opt.maxAlertAgeMs;

    for (const w of Object.keys(WINDOWS)) {
      const v = sample[w]; if (v === null || v === undefined) continue;
      const ws = this._win(w);
      if (firstOrSwitched) {                                                // seed silently: no alert for a state we never watched
        for (const th of this.opt.thresholds) { ws.armed[th] = v < th; ws.alerted[th] = false; }
        continue;
      }
      for (const th of this.opt.thresholds) {                               // re-arm after dropping below
        if (v < th && !ws.armed[th]) {
          ws.armed[th] = true;
          if (ws.alerted[th]) { ws.alerted[th] = false; out.push(this._event('USAGE_CLEARED', w, th, v, sample)); }
        }
      }
      const crossed = this.opt.thresholds.filter((th) => v >= th && ws.armed[th]);
      if (crossed.length) {
        const top = Math.max(...crossed);                                   // a jump past both thresholds => ONE alert (the highest)
        for (const th of crossed) ws.armed[th] = false;
        if (fresh) { ws.alerted[top] = true; out.push(this._event(top >= 90 ? 'USAGE_CRITICAL' : 'USAGE_WARNING', w, top, v, sample)); }
      }
    }
    st.org = sample.org; st.lastT = sample.t;
    if (fresh) st.staleNoticed = false;
    this.onState(st);
    return out;
  }

  /** display state for the tray (does not change anything) */
  status() {
    const s = this.latest; const now = this.now();
    if (!s) return { state: 'none', text: 'Usage: no data yet', hint: "Open Claude Desktop's tray menu to refresh" };
    const age = now - s.t;
    const parts = [s.fh !== null ? `5-hour ${s.fh}%` : null, s.sd !== null ? `weekly ${s.sd}%` : null].filter(Boolean).join(' · ');
    if (age > this.opt.freshMs) {
      return { state: 'stale', ageMs: age, fh: s.fh, sd: s.sd, text: `Usage STALE — last update ${ago(age)} (${parts})`, hint: "Open Claude Desktop's tray menu to refresh", tip: 'usage STALE' };
    }
    return { state: 'fresh', ageMs: age, fh: s.fh, sd: s.sd, text: `Usage: ${parts} (updated ${ago(age)})`, hint: null, tip: `5h ${s.fh ?? '?'}% wk ${s.sd ?? '?'}%` };
  }

  /** call periodically: ONE stale notice per stale episode (and not more often than staleNoticeGapMs) */
  checkStale() {
    const s = this.latest; if (!s) return [];
    const now = this.now(); const age = now - s.t; const st = this.state;
    if (age <= this.opt.freshMs) { if (st.staleNoticed) { st.staleNoticed = false; this.onState(st); } return []; }
    if (st.staleNoticed || now - st.lastStaleNoticeAt < this.opt.staleNoticeGapMs) return [];
    st.staleNoticed = true; st.lastStaleNoticeAt = now; this.onState(st);
    return [{ type: 'USAGE_STALE', session: 'Claude usage', project: '?', sessionId: 'usage:stale', pid: null, source: 'usage-history', epoch: now,
      details: ago(age), usage: { sampleAt: s.t } }];
  }
}

class UsageMonitor {
  /**
   * @param {{file?:string, resolveFile?:Function, onResolve?:Function, stateFile?:string, emit:Function, pollMs?:number, now?:Function} & Partial<typeof DEFAULTS>} o
   * `resolveFile()` returns the history path (or { path, candidates, ambiguous?, ambiguity? }, or null) and is called on EVERY tick, so the monitor follows
   * the file if Claude Desktop's package moves it or it appears later. `file` is the fixed-path form (tests).
   */
  constructor(o) {
    this.resolveFile = o.resolveFile || (() => o.file); this.onResolve = o.onResolve || (() => {}); this.file = undefined;
    this.stateFile = o.stateFile; this.emit = o.emit; this.pollMs = o.pollMs || 15_000;
    let state = null;
    if (this.stateFile) { try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { /* first run */ } }
    this.tracker = new UsageTracker({ ...o, state, onState: (s) => this._save(s) });
    this.lastKey = null; this.timer = null; this.fileStatus = 'unknown'; this.ambiguity = null;
  }

  _save(s) { if (!this.stateFile) return; try { fs.writeFileSync(this.stateFile, JSON.stringify(s)); } catch { /* non-fatal */ } }

  tick() {
    const resolved = this.resolveFile();
    const file = resolved && typeof resolved === 'object' ? resolved.path : resolved;
    this.ambiguity = resolved && typeof resolved === 'object' && resolved.ambiguous ? (resolved.ambiguity || {}) : null;   // active Claude profile unclear: say so, read nothing
    if (file !== this.file) { this.file = file; this.lastKey = null; try { this.onResolve(file || null, resolved && resolved.candidates); } catch { /* logging only */ } }
    let key = null;
    if (!file) key = 'none';
    else { try { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch { key = 'missing'; } }
    if (key !== this.lastKey) {                                           // only re-read when the file changed
      if (!file) { this.fileStatus = 'missing'; this.lastKey = key; }
      else {
        const r = readLatestSample(file);
        this.fileStatus = r.status || 'ok';
        if (r.sample) { this.lastKey = key; for (const ev of this.tracker.process(r.sample)) this.emit(ev); }
        else if (r.status === 'missing') this.lastKey = key;               // unreadable (mid-write): retry next tick
      }
    }
    for (const ev of this.tracker.checkStale()) this.emit(ev);
  }

  start() { this.tick(); this.timer = setInterval(() => this.tick(), this.pollMs); if (this.timer.unref) this.timer.unref(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** tray model. When no sample has ever been read, say WHY instead of a vague "no data yet". */
  status() {
    if (this.ambiguity) return { state: 'ambiguous', text: "Usage: can't tell which Claude Desktop profile is active", hint: 'Close the Claude windows you are not using (or open the tray menu of the one you want)', tip: 'usage: profile ambiguous' };
    const s = this.tracker.status();
    if (s.state !== 'none') return s;
    if (this.fileStatus === 'missing') return { state: 'unavailable', text: "Usage unavailable \u2014 Claude Desktop's usage file was not found", hint: "Open Claude Desktop's tray menu once. If this persists the notifier cannot see Desktop's files (see notifier.log)", tip: 'usage UNAVAILABLE' };
    if (this.fileStatus === 'unreadable') return { state: 'unavailable', text: 'Usage unavailable \u2014 the usage file could not be read', hint: "Open Claude Desktop's tray menu to refresh it", tip: 'usage UNAVAILABLE' };
    if (this.fileStatus === 'empty') return { state: 'none', text: 'Usage: the usage file has no samples yet', hint: "Open Claude Desktop's tray menu to refresh", tip: 'usage: no samples' };
    return s;
  }
}

module.exports = { UsageTracker, UsageMonitor, readLatestSample, WINDOWS, DEFAULTS, ago };
