'use strict';
/**
 * ntfy.js — metadata-only phone push via ntfy (https://ntfy.sh or a self-hosted server).
 *
 * PRIVACY MODEL (enforced in code, covered by tests):
 *   - The request body is built ONLY from an allowlist: topic, title, message, priority, tags.
 *   - `message` is assembled from: project folder name, (optionally) the session title, one short
 *     sanitized detail per event type, and a clock time. Nothing else ever reaches the payload.
 *   - Details are per-type whitelists: tool NAME for permission prompts (e.g. "Bash"), reset time for
 *     session limits, exit code for crashes, a short scrubbed error line for API errors.
 *     Prompts, code, file contents, transcripts, tokens and credentials are never read by this app.
 *   - Privacy default: the session TITLE (derived from the conversation) is NOT sent unless the config opts in with
 *     "configVersion": 2 + "includeSessionTitle": true. Configs written before this default existed (no configVersion)
 *     are treated as opted-out, because the old tool wrote `true` for everyone.
 *   - Topic/server/token live in the user's local config file (%USERPROFILE%\.claude-notifier\ntfy.json),
 *     never in source. The token (optional, for protected/self-hosted servers) is never logged.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_NAME = 'ntfy.json';
const DEFAULT_CONFIG = {
  server: 'https://ntfy.sh',
  topic: '',
  token: null,                 // optional bearer token for protected / self-hosted servers
  configVersion: 2,            // 2 = privacy default below is in force
  includeSessionTitle: false,  // opt-in: true adds the session title (conversation-derived) next to the project name
  allowInsecure: false,        // plain http only allowed for loopback unless this is true
  priorities: { TURN_FINISHED: 4, WAITING_FOR_USER: 4, WAITING_FOR_PERMISSION: 5, API_ERROR: 5, SESSION_LIMIT: 5, PROCESS_EXITED_ERROR: 5, USAGE_WARNING: 3, USAGE_CRITICAL: 4, WAITING_UNKNOWN: 4 },
  // seconds to wait before pushing; the push is cancelled if the session resumes in the meantime.
  // 0 = push immediately. (E.g. set WAITING_FOR_PERMISSION to 20 to only ping the phone if you are away.)
  holdSeconds: { TURN_FINISHED: 0, WAITING_FOR_USER: 0, WAITING_FOR_PERMISSION: 0, API_ERROR: 0, SESSION_LIMIT: 0, PROCESS_EXITED_ERROR: 0, USAGE_WARNING: 0, USAGE_CRITICAL: 0, WAITING_UNKNOWN: 0 },
  types: { TURN_FINISHED: true, WAITING_FOR_USER: true, WAITING_FOR_PERMISSION: true, API_ERROR: true, SESSION_LIMIT: true, PROCESS_EXITED_ERROR: true, USAGE_WARNING: true, USAGE_CRITICAL: true, WAITING_UNKNOWN: true },
};

const TYPE_INFO = {
  TURN_FINISHED: { title: 'Claude finished the task', tags: ['white_check_mark'] },
  WAITING_FOR_USER: { title: 'Claude needs your input', tags: ['question'] },
  WAITING_FOR_PERMISSION: { title: 'Claude needs permission', tags: ['lock'] },
  API_ERROR: { title: 'Claude needs attention: API error', tags: ['warning'] },
  SESSION_LIMIT: { title: 'Claude needs attention: session limit', tags: ['hourglass_flowing_sand', 'warning'] },
  PROCESS_EXITED_ERROR: { title: 'Claude needs attention: process exited', tags: ['rotating_light'] },
  USAGE_WARNING: { title: 'Claude usage warning', tags: ['warning'] },       // Step 5 (numbers only)
  USAGE_CRITICAL: { title: 'Claude usage critical', tags: ['rotating_light'] },
  WAITING_UNKNOWN: { title: 'Claude needs your attention', tags: ['question'] },
};
const RESOLVES = new Set(['WORKING', 'IDLE', 'TURN_FINISHED', 'SESSION_ENDED', 'USAGE_CLEARED']);
const WAITING = new Set(['WAITING_FOR_USER', 'WAITING_FOR_PERMISSION', 'WAITING_UNKNOWN']);

// ---------- config ----------
function merge(a, b) { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) ? merge(a[k], b[k]) : b[k]; return o; }

function loadConfig(dir) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8')); } catch { return null; }
  const cfg = merge(DEFAULT_CONFIG, parsed);
  // migration: files written before configVersion existed carry includeSessionTitle:true only because that was the
  // generated default, not a decision. Treat them as opted out (privacy by default); opting in needs configVersion 2.
  if (!(parsed.configVersion >= 2)) { cfg.titleMigrated = parsed.includeSessionTitle === true; cfg.includeSessionTitle = false; }
  cfg.configVersion = 2;
  return cfg;
}

function validateConfig(cfg) {
  if (!cfg) return 'not configured (run: node notifier.js --ntfy-init)';
  if (!cfg.topic || !/^[A-Za-z0-9_-]{1,64}$/.test(cfg.topic)) return 'topic missing or invalid (letters, digits, - and _ only)';
  let u; try { u = new URL(cfg.server); } catch { return 'server is not a valid URL'; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (loopback || cfg.allowInsecure))) return 'server must be https (http only for localhost, or set allowInsecure)';
  return null;
}

/** lowercase letters/digits without look-alikes (no i, l, o, 0, 1): easy to type and read on a phone; 16 chars ~ 79 bits */
function friendlyRandom(n) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = ''; while (out.length < n) { const b = crypto.randomBytes(1)[0]; if (b < 248) out += alphabet[b % alphabet.length]; }
  return out;
}

/** Creates ntfy.json (push stays DISABLED until the user turns it on). Returns the config. */
function initConfig(dir, { server, topic, force } = {}) {
  const p = path.join(dir, CONFIG_NAME);
  if (fs.existsSync(p) && !force) return { created: false, cfg: loadConfig(dir) };
  const cfg = merge(DEFAULT_CONFIG, { server: server || DEFAULT_CONFIG.server, topic: topic || `claude-${friendlyRandom(16)}` });
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(p, JSON.stringify(cfg, null, 2));
  return { created: true, cfg };
}

/** write-then-rename in the same folder: a crash or power loss can never leave a half-written ntfy.json */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Looks at ntfy.json WITHOUT interpreting a problem as "no config": { exists, cfg, problem }.
 * problem is null | 'unreadable' | 'corrupt' (not valid JSON / not an object) | 'invalid' (valid JSON, unusable topic or server).
 * Callers must never overwrite a file whose problem is not null without an explicit user decision.
 */
function inspectConfig(dir) {
  const p = path.join(dir, CONFIG_NAME);
  if (!fs.existsSync(p)) return { exists: false, cfg: null, problem: null };
  let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch { return { exists: true, cfg: null, problem: 'unreadable' }; }
  let parsed; try { parsed = JSON.parse(raw); } catch { return { exists: true, cfg: null, problem: 'corrupt' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { exists: true, cfg: null, problem: 'corrupt' };
  const cfg = loadConfig(dir);
  return { exists: true, cfg, problem: validateConfig(cfg) ? 'invalid' : null };
}

/** replaces ONLY the topic of an existing, valid ntfy.json (every other stored choice is kept) and returns the new config */
function rotateTopic(dir, { topic } = {}) {
  const p = path.join(dir, CONFIG_NAME);
  const insp = inspectConfig(dir);
  if (insp.problem || !insp.exists) { const e = new Error(`cannot rotate: configuration is ${insp.problem || 'missing'}`); e.code = 'ECONFIG'; throw e; }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  raw.topic = topic || `claude-${friendlyRandom(16)}`;
  writeAtomic(p, JSON.stringify(raw, null, 2));
  return loadConfig(dir);
}

// ---------- payload (allowlist) ----------
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** removes anything that could be a secret/long identifier from a short error line */
function scrub(s) {
  return clip(String(s)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9+/_-]{28,}={0,2}\b/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim(), 100);
}

function detailFor(ev) {
  const d = String(ev.details || '');
  switch (ev.type) {
    case 'WAITING_FOR_PERMISSION': { const m = /tool=([A-Za-z0-9_:.-]{1,60})/.exec(d); return m ? `Tool: ${m[1]}` : null; }
    case 'WAITING_FOR_USER': return null;
    case 'TURN_FINISHED': return null;
    case 'SESSION_LIMIT': { const m = /resets\s+([^\n]{1,60})/i.exec(d); return m ? `Resets ${scrub(m[1])}` : 'Limit reached'; }
    case 'PROCESS_EXITED_ERROR': { const m = /exit code (\d+)/.exec(d); return m ? `Exit code ${m[1]}` : null; }
    case 'API_ERROR': return d ? scrub(d) : null;
    case 'WAITING_UNKNOWN': { const w = /waitingFor="([^"]*)"/.exec(d); return w && /^[A-Za-z][A-Za-z0-9 _:.-]{0,39}$/.test(w[1]) ? `Reason: ${w[1]}` : null; }
    case 'USAGE_WARNING': case 'USAGE_CRITICAL': { const u = ev.usage || {}; return ['5-hour', 'Weekly'].includes(u.label) && Number.isFinite(u.value) ? `${u.label} usage: ${Math.round(u.value)}%` : null; }
    default: return null;
  }
}

function hhmmss(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

function projectLabel(ev, cfg) {
  if (/^USAGE_/.test(ev.type)) return 'Claude usage';
  const proj = ev.project && ev.project !== '?' ? ev.project : null;
  const unknown = !ev.session || /^local_/.test(ev.session);
  const title = cfg.includeSessionTitle && !unknown && ev.session !== proj ? ev.session : null;
  return [proj, title].filter(Boolean).join(' — ') || 'Claude session';
}

function buildMessage(ev, cfg) {
  const info = TYPE_INFO[ev.type]; if (!info) return null;
  const title = /^USAGE_/.test(ev.type) && typeof ev.title === 'string' && /^[A-Za-z0-9 %.\-]{1,60}$/.test(ev.title) ? ev.title : info.title;
  const lines = [clip(projectLabel(ev, cfg), 120)];
  const det = detailFor(ev); if (det) lines.push(det);
  lines.push(hhmmss(ev.epoch || Date.now()));
  return { topic: cfg.topic, title, message: lines.join('\n'), priority: cfg.priorities[ev.type] || 3, tags: info.tags };
}

// ---------- transport ----------
async function send(cfg, body, { timeoutMs = 8000, retries = 2, fetchImpl = fetch } = {}) {
  const err = validateConfig(cfg); if (err) return { ok: false, error: err };
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  let last = { ok: false, error: 'unknown' };
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchImpl(cfg.server.replace(/\/+$/, '') + '/', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true, status: res.status };
      last = { ok: false, status: res.status, error: `HTTP ${res.status}` };
      if (res.status < 500 && res.status !== 429) return last; // client error: retrying will not help
    } catch (e) { last = { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : (e.cause && e.cause.code) || e.message }; }
    if (i < retries) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return last;
}

// ---------- dispatcher: when to push ----------
class PhoneDispatcher {
  constructor({ getConfig, getEnabled, sender = send, now = Date.now, log = () => {}, onResult = () => {}, onStatus = () => {}, cooldownMs = 10_000, maxPerMinute = 10, staleMs = 60_000, failThreshold = 3 }) {
    Object.assign(this, { getConfig, getEnabled, sender, now, log, onResult, onStatus, cooldownMs, maxPerMinute, staleMs, failThreshold });
    this.pending = new Map();   // `${session}|${type}|${request id}` -> timer
    this.inflight = new Set();  // send in progress (prevents a duplicate while the first is still on the wire)
    this.status = { failStreak: 0, lastOkAt: 0, lastError: null, failing: false };   // "ok" = accepted by the server, NOT received by the phone
    this.lastSent = new Map();  // `${session}|${type}` -> { t, req }  (only SUCCESSFUL sends consume the cooldown)
    this.resolvedAt = new Map();
    this.sentTimes = [];
    this.dropped = 0;
  }

  handle(ev) {
    const key = ev.sessionId || (ev.pid ? `pid:${ev.pid}` : ev.session || 'unknown');
    const epoch = ev.epoch || this.now();
    if (RESOLVES.has(ev.type)) {
      if (ev.type !== 'SESSION_ENDED') this.resolvedAt.set(key, Math.max(this.resolvedAt.get(key) || 0, epoch));
      for (const [k, t] of [...this.pending]) if (k.startsWith(`${key}|`) && (ev.type !== 'TURN_FINISHED' || !k.includes('|TURN_FINISHED|'))) { clearTimeout(t); this.pending.delete(k); this.log(`phone: cancelled ${k} (session resumed)`); }
      for (const w of WAITING) this.lastSent.delete(`${key}|${w}`);   // prompt answered: the next prompt must be pushed
    }
    if (!TYPE_INFO[ev.type]) return { sent: false, reason: 'no-push-for-type' };
    const cfg = this.getConfig();
    if (!this.getEnabled()) return { sent: false, reason: 'phone-disabled' };
    const bad = validateConfig(cfg); if (bad) return { sent: false, reason: `config: ${bad}` };
    if (cfg.types[ev.type] === false) return { sent: false, reason: 'type-disabled' };
    if (this.now() - epoch > this.staleMs) return { sent: false, reason: 'stale' };
    if (WAITING.has(ev.type) && epoch <= (this.resolvedAt.get(key) || 0)) return { sent: false, reason: 'resolved-before-delivery' };
    const ck = `${key}|${ev.type}`;
    const reqId = ((/request=([A-Za-z0-9]+)/.exec(ev.details || '')) || [])[1] || null;
    const pk = `${ck}|${reqId || ''}`;
    const last = this.lastSent.get(ck);
    const distinct = (l) => reqId && l && l.req && reqId !== l.req;           // a different request id is a different prompt
    if ((last && this.now() - last.t < this.cooldownMs && !distinct(last)) || this.pending.has(pk) || this.inflight.has(pk)) return { sent: false, reason: 'cooldown' };
    const hold = Number((cfg.holdSeconds || {})[ev.type] || 0) * 1000;
    if (hold > 0) {
      this.pending.set(pk, setTimeout(() => { this.pending.delete(pk); this._deliver(ev, ck, pk, reqId); }, hold));
      return { sent: false, reason: `held-${hold / 1000}s` };
    }
    this._deliver(ev, ck, pk, reqId);
    return { sent: true, reason: 'sending' };
  }

  async _deliver(ev, ck, pk, reqId) {
    const cfg = this.getConfig(); const t = this.now();
    this.sentTimes = this.sentTimes.filter((x) => t - x < 60_000);
    if (this.sentTimes.length >= this.maxPerMinute) { this.dropped++; this.log(`phone: rate-limited (${this.dropped} dropped)`); return; }
    this.sentTimes.push(t);
    const body = buildMessage(ev, cfg); if (!body) return;
    this.inflight.add(pk);
    let r;
    try { r = await this.sender(cfg, body); } catch (e) { r = { ok: false, error: e.message }; } finally { this.inflight.delete(pk); }
    // only a send the server ACCEPTED consumes the cooldown, so a failed push can be retried by the next identical event
    if (r.ok) this.lastSent.set(ck, { t: this.now(), req: reqId });
    this._record(r);
    this.log(`phone: ${ev.type} -> ${r.ok ? 'accepted by server (phone delivery not confirmed)' : `FAILED (${r.error})`}`);
    this.onResult(ev, body, r);
  }

  /** failure tracking for the tray / Windows notice; HTTP acceptance is NOT proof the phone received anything */
  _record(r) {
    const s = this.status; const was = s.failing;
    if (r.ok) { s.failStreak = 0; s.lastOkAt = this.now(); s.lastError = null; s.failing = false; }
    else { s.failStreak++; s.lastError = String(r.error || 'unknown').slice(0, 80); s.failing = s.failStreak >= this.failThreshold; }
    this.onStatus({ ...s }, { becameFailing: s.failing && !was, recovered: !s.failing && was });
  }

  /** a manual test (tray / CLI) uses the same bookkeeping */
  recordManual(r) { this._record(r); }

  stop() { for (const t of this.pending.values()) clearTimeout(t); this.pending.clear(); }
}

/** manual test message: contains no Claude data at all */
function buildTestMessage(cfg) {
  return { topic: cfg.topic, title: 'Claude Notifier: test', message: `Phone notifications are working.\nThis is a test, not a Claude event.\n${hhmmss(Date.now())}`, priority: 3, tags: ['white_check_mark'] };
}

module.exports = { inspectConfig, rotateTopic, writeAtomic, friendlyRandom, loadConfig, validateConfig, initConfig, buildMessage, buildTestMessage, send, PhoneDispatcher, scrub, CONFIG_NAME, DEFAULT_CONFIG, TYPE_INFO };
