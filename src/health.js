'use strict';
/**
 * health.js — health canary for the notification pipeline (pure logic, no I/O).
 *
 * Question it answers: "Claude is running, so why does the notifier see nothing?" — WITHOUT crying wolf when Claude
 * is merely idle or closed. It therefore never looks at "no events lately". Instead it compares independent views:
 *
 *   SESSIONS_BLIND  Claude Code CLI processes are running (found by install folder, so a renamed binary is still seen)
 *                   but the session-file watcher accepts ZERO live sessions, continuously for `blindMs`.
 *                   An idle session still has a file, so idleness cannot trigger this.
 *   LOG_BLIND       the last `limit` turn/prompt events came from the session files only: the Desktop log lines that
 *                   normally accompany every one of them (Stop hook, permission request) were not seen.
 *   FILES_BLIND     the last `limit` such events came from the log only: the session files did not change.
 *   STREAM_STALLED  the event-stream process stopped sending its heartbeat (or its watcher did).
 *
 * Episodes: ONE warning notice per episode, a cleared notice when everything is healthy again, and never more than
 * one warning per `renotifyMs`. After a sleep/resume (a long gap between evaluations) all timers restart.
 */

const PROBLEMS = {
  SESSIONS_BLIND: {
    summary: 'Claude is running, but no sessions are visible',
    action: 'Restart Claude Notifier. If this keeps happening, Claude Desktop probably changed its session files and the notifier needs an update.',
  },
  LOG_BLIND: {
    summary: "Claude Desktop's log lines are not being matched",
    action: "Notifications still work from the session files but may be less accurate. Desktop's log format or location may have changed; the notifier may need an update.",
  },
  FILES_BLIND: {
    summary: 'Session status files are not changing',
    action: 'Desktop log activity is seen but the session status files are silent. Restart Claude Notifier; if it persists, the notifier needs an update.',
  },
  STREAM_STALLED: {
    summary: 'The event stream stopped responding',
    action: 'Claude Notifier is restarting its event stream. If this repeats, restart the notifier.',
  },
};
const CORRELATED = new Set(['TURN_FINISHED', 'WAITING_FOR_USER', 'WAITING_FOR_PERMISSION']);

class HealthCanary {
  /** @param {{now?:Function, startedAt?:number, graceMs?:number, blindMs?:number, limit?:number, stallMs?:number, resumeGapMs?:number, renotifyMs?:number}} o */
  constructor(o = {}) {
    this.now = o.now || Date.now;
    this.o = { graceMs: 180_000, blindMs: 180_000, limit: 4, stallMs: 90_000, resumeGapMs: 60_000, renotifyMs: 30 * 60_000, ...o };
    const t = this.now();
    this.startedAt = o.startedAt || t;
    this.lastEvalAt = t;
    this.hb = null;               // last merge-events heartbeat { at, files, live, stale, cli, desktop, watcherAgeMs }
    this.firstHbWaitFrom = t;     // for "no heartbeat ever" detection
    this.blindSince = null;       // when "cli>0 && live==0" started
    this.uncorroborated = 0;      // consecutive session-file-only events
    this.logOnly = 0;             // consecutive log-only events
    this.active = new Map();      // problem id -> since
    this.lastWarnAt = 0;
    this.episodeNotified = false;
  }

  onHeartbeat(ev) {
    const h = ev.health || {};
    this.hb = { at: this.now(), files: h.files, live: h.live, stale: h.stale, cli: h.cli, desktop: h.desktop, watcherAgeMs: h.watcherAgeMs };
  }

  /** feed every normalized event (after the stream's own dedupe) */
  onEvent(ev) {
    if (!CORRELATED.has(ev.type) || typeof ev.source !== 'string') return;
    const file = ev.source.includes('session-file'); const log = /main1?\.log/.test(ev.source);
    if (file && log) { this.uncorroborated = 0; this.logOnly = 0; }
    else if (file) { this.uncorroborated++; this.logOnly = 0; }
    else if (log) { this.logOnly++; this.uncorroborated = 0; }
  }

  _setProblem(id, on, now) { if (on) { if (!this.active.has(id)) this.active.set(id, now); } else this.active.delete(id); }

  /** call every few seconds. Returns { problems, events } — events are HEALTH_WARNING / HEALTH_CLEARED notices */
  evaluate() {
    const now = this.now(); const o = this.o; const events = [];
    if (now - this.lastEvalAt > o.resumeGapMs) {            // sleep/resume (or a long freeze): never alarm on stale timers
      this.startedAt = now; this.blindSince = null; this.firstHbWaitFrom = now; if (this.hb) this.hb.at = now;
      this.uncorroborated = 0; this.logOnly = 0;
    }
    this.lastEvalAt = now;
    const grace = now - this.startedAt < o.graceMs;

    // SESSIONS_BLIND: processes say "sessions exist", the watcher says "none"
    const hb = this.hb;
    const cond = !!(hb && hb.cli > 0 && hb.live === 0);
    if (cond) { if (this.blindSince === null) this.blindSince = now; } else this.blindSince = null;
    this._setProblem('SESSIONS_BLIND', !grace && cond && now - this.blindSince >= o.blindMs, now);

    this._setProblem('LOG_BLIND', this.uncorroborated >= o.limit, now);
    this._setProblem('FILES_BLIND', this.logOnly >= o.limit, now);

    const lastHbAt = hb ? hb.at : this.firstHbWaitFrom;
    const watcherStalled = !!(hb && Number.isFinite(hb.watcherAgeMs) && hb.watcherAgeMs > o.stallMs);
    this._setProblem('STREAM_STALLED', (now - lastHbAt > o.stallMs && now - this.startedAt > o.stallMs) || watcherStalled, now);

    const ids = [...this.active.keys()];
    if (ids.length && !this.episodeNotified && now - this.lastWarnAt >= o.renotifyMs) {
      this.episodeNotified = true; this.lastWarnAt = now;
      const first = PROBLEMS[ids[0]];
      events.push({ type: 'HEALTH_WARNING', session: 'Claude Notifier', project: '?', sessionId: 'health:warning', pid: null, source: 'health', epoch: now,
        details: ids.join(','), noticeLines: [first.summary, first.action], problems: ids });
    } else if (ids.length && !this.episodeNotified) {
      this.episodeNotified = true;   // suppressed by the renotify gap: still shown in the tray, no second toast
    }
    if (!ids.length && this.episodeNotified) {
      this.episodeNotified = false;
      events.push({ type: 'HEALTH_CLEARED', session: 'Claude Notifier', project: '?', sessionId: 'health:warning', pid: null, source: 'health', epoch: now, details: 'recovered' });
    }
    return { problems: ids, events, stalled: this.active.has('STREAM_STALLED') };
  }

  /** tray model */
  status() {
    const ids = [...this.active.keys()];
    if (!ids.length) return { ok: true, text: null, hint: null };
    const first = PROBLEMS[ids[0]];
    return { ok: false, text: `Notifier health: ${first.summary}${ids.length > 1 ? ` (+${ids.length - 1} more)` : ''}`, hint: first.action, ids };
  }
}

module.exports = { HealthCanary, PROBLEMS };
