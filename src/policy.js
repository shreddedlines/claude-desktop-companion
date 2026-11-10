'use strict';
/**
 * policy.js — pure notification policy: normalized event in -> { notified, reason, actions[] } out.
 * No I/O, so it is unit-testable. Step 2 already merges/dedupes at the event level; this layer adds
 * anti-spam on top of that:
 *   - an identical event (same session+type, and the same request id when there is one) within COOLDOWN_MS is
 *     suppressed. A DISTINCT prompt is never suppressed: a resolution (WORKING/IDLE/...) clears the cooldown
 *     of that session's prompt types, and a different request id always notifies
 *   - burst limiter: at most 4 normal toasts (task finished) and 8 persistent toasts (needs input /
 *     permission / attention) per window; the rest become ONE summary toast. Important events are never
 *     throttled by chatty ones: the two buckets are independent.
 *   - a persistent toast is retracted as soon as the session resumes (WORKING) or finishes
 *   - a WAITING event that was resolved before it was delivered (merge hold delay) is dropped
 *   - events older than STALE_MS (replay / delayed) never notify
 *   - the same tag per (session,type) means Windows replaces rather than stacks repeated toasts
 */
const crypto = require('crypto');

const SPEC = {
  TURN_FINISHED: { title: 'Claude finished the task', persistent: false, sound: 'finished' },
  WAITING_FOR_USER: { title: 'Claude needs your input', persistent: true, sound: 'input' },
  WAITING_FOR_PERMISSION: { title: 'Claude needs permission', persistent: true, sound: 'permission' },
  API_ERROR: { title: 'Claude needs attention', what: 'API error', persistent: true, sound: 'attention' },
  SESSION_LIMIT: { title: 'Claude needs attention', what: 'Session limit reached', persistent: true, sound: 'attention' },
  PROCESS_EXITED_ERROR: { title: 'Claude needs attention', what: 'Claude Code process exited unexpectedly', persistent: true, sound: 'attention' },
  // Step 5: plan-usage monitor (events come from usage-monitor.js; titles are built from numbers only)
  USAGE_WARNING: { title: 'Claude usage warning', persistent: false, sound: 'input' },
  USAGE_CRITICAL: { title: 'Claude usage critical', persistent: true, sound: 'attention' },
  USAGE_STALE: { title: 'Claude usage data is stale', persistent: false, sound: 'input' },
  // reliability pass: a `waiting` status with a reason we do not know still needs a human
  WAITING_UNKNOWN: { title: 'Claude needs your attention', persistent: true, sound: 'input' },
  // app-health notices (Windows only; text comes from health.js / phone status, never from Claude content)
  HEALTH_WARNING: { title: 'Claude Notifier health warning', persistent: false, sound: 'attention' },
  PHONE_FAILING: { title: 'Phone push is failing', persistent: false, sound: 'input' },
};
const RESOLVES = new Set(['WORKING', 'IDLE', 'TURN_FINISHED', 'SESSION_ENDED', 'USAGE_CLEARED', 'HEALTH_CLEARED']);
const WAITING = new Set(['WAITING_FOR_USER', 'WAITING_FOR_PERMISSION', 'WAITING_UNKNOWN']);

const short = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const sessionKey = (ev) => ev.sessionId || (ev.pid ? `pid:${ev.pid}` : ev.session || 'unknown');

function label(ev) {
  const unknown = !ev.session || /^local_/.test(ev.session);
  const name = unknown ? 'Claude session' : ev.session;
  const proj = ev.project && ev.project !== '?' ? ev.project : null;
  if (proj && !unknown && proj !== name) return `${proj} — ${name}`;
  return proj || name;
}

const hms = (ms) => { const d = new Date(ms); const z = (n) => String(n).padStart(2, '0'); return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
const SAFE_TITLE = /^[A-Za-z0-9 %.\-]{1,60}$/;

const cleanText = (s, n) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function bodyLines(ev, spec) {
  if (ev.type === 'HEALTH_WARNING' || ev.type === 'PHONE_FAILING') {
    return (Array.isArray(ev.noticeLines) ? ev.noticeLines : []).slice(0, 4).map((l) => cleanText(l, 160)).filter(Boolean);
  }
  if (ev.type === 'WAITING_UNKNOWN') {
    const w = /waitingFor="([^"]*)"/.exec(ev.details || '');
    const reason = w && /^[A-Za-z][A-Za-z0-9 _:.\-]{0,39}$/.test(w[1]) ? w[1] : null;   // fixed CLI strings only
    return reason ? [label(ev), `Reason: ${reason}`] : [label(ev)];
  }
  if (ev.type === 'USAGE_WARNING' || ev.type === 'USAGE_CRITICAL') {
    const u = ev.usage || {};
    return [`Currently ${Number(u.value)}% used`, `Based on Claude Desktop data from ${hms(u.sampleAt || ev.epoch)}`];
  }
  if (ev.type === 'USAGE_STALE') {
    return [`Last usage update ${String(ev.details || '').slice(0, 40)}`, "Open Claude Desktop's tray menu to refresh"];
  }
  const lines = [label(ev)];
  if (spec.what) lines.push(spec.what);
  const d = (ev.details || '').replace(/\s+/g, ' ');
  if (WAITING.has(ev.type)) {
    const tool = /tool=([^\s;]+)/.exec(d);
    if (tool && tool[1] !== 'AskUserQuestion') lines.push(`Tool: ${tool[1]}`);
  } else if (ev.type === 'SESSION_LIMIT' || ev.type === 'API_ERROR' || ev.type === 'PROCESS_EXITED_ERROR') {
    lines.push(d.length > 140 ? `${d.slice(0, 137)}...` : d);
  }
  return lines;
}

class Policy {
  constructor({ getSettings, now = Date.now, cooldownMs = 4000, burstMax = 4, burstMaxPersistent = 8, burstWindowMs = 10000, staleMs = 60000 }) {
    Object.assign(this, { getSettings, now, cooldownMs, burstMax, burstMaxPersistent, burstWindowMs, staleMs });
    this.lastShown = new Map();      // `${session}|${type}` -> time
    this.open = new Map();           // session -> Set(tag) of persistent toasts currently shown
    this.resolvedAt = new Map();     // session -> epoch of last WORKING/IDLE/TURN_FINISHED
    this.burst = { normal: [], persistent: [] };   // timestamps of recent toasts per bucket
    this.burstSuppressed = 0;
    this.burstSince = 0;
  }

  handle(ev) {
    const actions = []; const key = sessionKey(ev); const t = this.now();
    const epoch = ev.epoch || t;

    if (RESOLVES.has(ev.type)) {
      if (ev.type !== 'SESSION_ENDED') this.resolvedAt.set(key, Math.max(this.resolvedAt.get(key) || 0, epoch));
      for (const w of WAITING) this.lastShown.delete(`${key}|${w}`);   // the prompt was answered: the NEXT prompt must notify
      const tags = this.open.get(key);
      if (tags && tags.size) { actions.push({ kind: 'retract', group: short(key), tags: [...tags] }); this.open.delete(key); }
    }

    const spec = SPEC[ev.type];
    if (!spec) return { notified: false, reason: 'no-notification-for-type', actions };
    const s = this.getSettings();
    if (!s.notificationsEnabled) return { notified: false, reason: 'notifications-disabled', actions };
    if (t - epoch > this.staleMs) return { notified: false, reason: 'stale', actions };
    if (WAITING.has(ev.type) && epoch <= (this.resolvedAt.get(key) || 0)) return { notified: false, reason: 'resolved-before-delivery', actions };

    const ck = `${key}|${ev.type}`;
    const reqId = ((/request=([A-Za-z0-9]+)/.exec(ev.details || '')) || [])[1] || null;
    const last = this.lastShown.get(ck);
    if (last && t - last.t < this.cooldownMs && !(reqId && last.req && reqId !== last.req)) return { notified: false, reason: 'cooldown', actions };

    const bucket = spec.persistent ? 'persistent' : 'normal';
    this.burst[bucket] = this.burst[bucket].filter((x) => t - x < this.burstWindowMs);
    if (this.burst[bucket].length >= (spec.persistent ? this.burstMaxPersistent : this.burstMax)) {
      if (!this.burstSuppressed) this.burstSince = t;
      this.burstSuppressed++;
      return { notified: false, reason: 'burst-limited', actions };
    }
    this.burst[bucket].push(t); this.lastShown.set(ck, { t, req: reqId });

    const tag = `${ev.type}-${short(key)}${reqId ? `-${reqId.slice(0, 8)}` : ''}`;
    actions.push({ kind: 'toast', tag, group: short(key), persistent: spec.persistent,
      title: /^USAGE_/.test(ev.type) && typeof ev.title === 'string' && SAFE_TITLE.test(ev.title) ? ev.title : spec.title,
      lines: bodyLines(ev, spec), sound: s.soundsEnabled ? spec.sound : null, expireMinutes: spec.persistent ? 240 : 30 });
    if (spec.persistent) { if (!this.open.has(key)) this.open.set(key, new Set()); this.open.get(key).add(tag); }
    return { notified: true, reason: 'shown', actions };
  }

  /** call periodically: turns burst-suppressed toasts into ONE summary toast once the window has passed */
  tick() {
    const t = this.now();
    if (this.burstSuppressed && t - this.burstSince >= this.burstWindowMs) {
      const n = this.burstSuppressed; this.burstSuppressed = 0; this.burst = { normal: [], persistent: [] };
      const s = this.getSettings();
      return [{ kind: 'toast', tag: 'summary', group: 'summary', persistent: false, title: 'Claude Notifier',
        lines: [`${n} more Claude event${n > 1 ? 's' : ''} while notifications were rate-limited`, 'See the tray menu for recent events'],
        sound: s.soundsEnabled ? 'finished' : null, expireMinutes: 30 }];
    }
    return [];
  }
}

module.exports = { Policy, SPEC, sessionKey, label, short };
