'use strict';
/**
 * onboarding.js — first-run phone setup: a small state machine plus the configuration lifecycle behind it.
 *
 * It is deliberately separate from the monitoring engine: it knows nothing about sessions, policy, health or the event stream.
 * Everything it touches is injected (the settings store, the sender, the clock), and it has no user interface; the Windows
 * setup window only renders the view model returned by view() and reports button clicks back.
 *
 * Rules enforced here (each one has a test):
 *   - the ntfy topic is generated on THIS machine at first launch (ntfy.initConfig); nothing is shipped;
 *   - phoneEnabled becomes true ONLY through confirm(): the user said "I got it" after a test the server ACCEPTED within the
 *     last 30 minutes. An HTTP 200 from the server is acceptance, never proof of delivery to the phone;
 *   - a corrupt or invalid ntfy.json is never overwritten silently; recoverConfig() is an explicit user action that keeps a backup;
 *   - rotating the topic turns phone notifications off and says that the old subscription stops working;
 *   - an existing installation whose phone push is already enabled with a valid configuration is treated as confirmed: no window;
 *   - the topic is never written to a log: log lines carry state names only.
 */
const fs = require('fs');
const path = require('path');
const ntfy = require('./ntfy');

const SETTING = 'phoneSetup';
const PLAY_URL = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';
const FDROID_URL = 'https://f-droid.org/packages/io.heckel.ntfy/';
const TEST_VALID_MS = 30 * 60_000;      // a "yes, I got it" only counts for a test accepted this recently
const MIN_TEST_GAP_MS = 10_000;         // ntfy.sh allows a burst of 60 then one request per 5 s: stay far below that
const MAX_TESTS_PER_RUN = 10;
const STATES = ['new', 'in-progress', 'test-sent', 'test-failed', 'dismissed', 'confirmed'];

/** ntfy://<host>/<topic> opens the topic in the Android app and subscribes (documented by ntfy); plain-http servers need ?secure=false */
function deepLink(cfg) {
  const u = new URL(cfg.server);
  return `ntfy://${u.host}/${cfg.topic}${u.protocol === 'http:' ? '?secure=false' : ''}`;
}

/** maps a send() result to wording a non-technical user can act on. Never contains the topic or a URL. */
function friendlyError(r) {
  const code = String((r && r.error) || '');
  const status = r && r.status;
  if (status === 429) return { kind: 'rate-limited', retryAfterSec: 30, title: 'ntfy.sh asked us to slow down', text: 'Wait about 30 seconds, then press Send again.' };
  if (status === 401 || status === 403) return { kind: 'server-auth', title: 'ntfy.sh did not accept the message', text: 'The server refused access to this topic. Use "Create a new topic" and set up again.' };
  if (status >= 500) return { kind: 'server-down', title: 'ntfy.sh is having trouble', text: 'This is on the ntfy.sh side. Try again in a few minutes.' };
  if (status >= 400) return { kind: 'server-rejected', title: 'ntfy.sh rejected the test', text: 'Use "Create a new topic" and set up again. If it keeps happening, tell the person who gave you this app.' };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/i.test(code)) return { kind: 'tls', title: 'The secure connection to ntfy.sh was blocked', text: 'A security program, proxy or network on this PC may be intercepting the connection. Try a different network.' };
  if (/timeout|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|fetch failed|UND_ERR/i.test(code)) return { kind: 'network', title: "Can't reach ntfy.sh", text: "Check this PC's internet connection (and that a firewall or proxy is not blocking it), then press Try again." };
  return { kind: 'unknown', title: 'The test could not be sent', text: 'Press Try again. If it keeps failing, restart Claude Notifier.' };
}

/** plain-language checklist rows from raw facts (the notifier collects the facts; this only words them) */
function rowsFrom(facts = {}) {
  const rows = [];
  if (facts.claudeRunning) rows.push({ id: 'claude', level: 'ok', title: 'Claude Desktop is running', detail: '' });
  else if (facts.claudeInstalled) rows.push({ id: 'claude', level: 'ok', title: 'Claude Desktop is installed', detail: 'Open it to see your sessions here.' });
  else rows.push({ id: 'claude', level: 'warn', title: 'Claude Desktop was not found', detail: 'Install it from claude.ai/download and open it. You can set up your phone now anyway.' });

  if (facts.sessionsDirExists && facts.liveSessions > 0) rows.push({ id: 'sessions', level: 'ok', title: `Watching ${facts.liveSessions} Claude Code session${facts.liveSessions === 1 ? '' : 's'}`, detail: '' });
  else if (facts.sessionsDirExists) rows.push({ id: 'sessions', level: 'ok', title: 'Ready to watch your Claude Code sessions', detail: 'Start a session in Claude Desktop and it will appear.' });
  else rows.push({ id: 'sessions', level: 'warn', title: 'Waiting for your first Claude Code session', detail: 'Open Claude Desktop and start a Claude Code session.' });

  const u = facts.usage || {};
  if (u.state === 'fresh') rows.push({ id: 'usage', level: 'ok', title: 'Usage numbers are being read', detail: '' });
  else if (u.state === 'stale') rows.push({ id: 'usage', level: 'warn', title: 'Usage numbers are out of date', detail: "Open Claude Desktop's tray menu once to refresh them." });
  else if (u.state === 'ambiguous') rows.push({ id: 'usage', level: 'warn', title: 'More than one Claude profile is open', detail: 'Close the Claude windows you are not using.' });
  else rows.push({ id: 'usage', level: 'warn', title: 'Usage numbers are not available yet', detail: "Open Claude Desktop's tray menu once." });
  return rows;
}

class Onboarding {
  /**
   * @param {{dir:string, store:{settings:object,setSetting:Function}, send?:Function, now?:Function, log?:Function}} o
   *   dir = the notifier data folder (where ntfy.json lives). store = the notifier's settings store (the single writer).
   */
  constructor({ dir, store, send = ntfy.send, now = Date.now, log = () => {} }) {
    Object.assign(this, { dir, store, send, now, log, lastTestAt: 0, testsThisRun: 0, lastError: null });
  }

  // ---- state --------------------------------------------------------------------------------------------------------------
  get record() { return this.store.settings[SETTING] || null; }
  state() { const r = this.record; return r && STATES.includes(r.state) ? r.state : 'new'; }
  _set(patch, why) {
    const next = { ...(this.record || {}), ...patch, v: 1, updatedAt: this.now() };
    this.store.setSetting(SETTING, next);
    if (why) this.log(`phone setup: ${why} (state=${next.state})`);
    return next;
  }
  isConfirmed() { return this.state() === 'confirmed'; }

  /**
   * Called once at startup. An installation that already has push enabled with a valid configuration is simply marked confirmed:
   * that user must never be interrupted. Returns { legacy: boolean }.
   */
  reconcile() {
    const insp = ntfy.inspectConfig(this.dir);
    if (this.store.settings.phoneEnabled === true && insp.exists && !insp.problem) {
      if (this.state() !== 'confirmed') this._set({ state: 'confirmed', confirmedAt: this.now(), legacy: true }, 'existing enabled configuration recognised');
      return { legacy: true };
    }
    return { legacy: false };
  }
  /** open the window by itself ONCE (about 3 s after the tray appears); a dismissed or finished setup never interrupts again */
  shouldAutoOpen() { return !this.isConfirmed() && this.state() !== 'dismissed' && !(this.record && this.record.autoOpenedAt); }
  markAutoOpened() { this._set({ state: this.state() === 'new' ? 'in-progress' : this.state(), autoOpenedAt: this.now() }, 'opened automatically'); }
  /** the user opened the window (tray menu or auto) */
  opened() { if (this.state() === 'new' || this.state() === 'dismissed') this._set({ state: 'in-progress' }, 'window opened'); }
  /** "not now": also counts as having been offered, so it never opens by itself again */
  dismiss() { if (!this.isConfirmed()) this._set({ state: 'dismissed', dismissedAt: this.now(), autoOpenedAt: (this.record && this.record.autoOpenedAt) || this.now() }, 'dismissed by the user'); }

  // ---- configuration lifecycle -----------------------------------------------------------------------------------------------
  /** creates ntfy.json with a fresh random topic if (and only if) none exists. A broken file is reported, never replaced. */
  ensureConfig() {
    const insp = ntfy.inspectConfig(this.dir);
    if (insp.problem) { this.log(`phone setup: configuration problem (${insp.problem}); not touched`); return { status: 'problem', problem: insp.problem }; }
    if (!insp.exists) {
      ntfy.initConfig(this.dir); this.log('phone setup: new configuration created');
      if (this.store.settings.phoneEnabled) { this.store.setSetting('phoneEnabled', false); this.log('phone setup: phone notifications switched off (the old setting pointed at a configuration that no longer exists)'); }
      return { status: 'created' };
    }
    return { status: 'ok' };
  }
  /** EXPLICIT user action ("Start over"): the broken file is kept as a backup next to it, then a new configuration is created */
  recoverConfig() {
    const insp = ntfy.inspectConfig(this.dir);
    if (!insp.problem) return { ok: false, reason: 'nothing-to-recover' };
    const stamp = new Date(this.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backup = `${ntfy.CONFIG_NAME}.${insp.problem}-${stamp}`;
    fs.renameSync(path.join(this.dir, ntfy.CONFIG_NAME), path.join(this.dir, backup));
    ntfy.initConfig(this.dir);
    if (this.store.settings.phoneEnabled) this.store.setSetting('phoneEnabled', false);
    this._set({ state: 'in-progress', testAcceptedAt: null, lastTestAt: null }, 'configuration replaced after a problem; backup kept');
    return { ok: true, backup };
  }
  /** a new topic: phone notifications are switched OFF and the old subscription stops working (the caller shows the explanation) */
  rotateTopic() {
    const insp = ntfy.inspectConfig(this.dir);
    if (insp.problem || !insp.exists) return { ok: false, reason: insp.problem || 'missing' };
    ntfy.rotateTopic(this.dir);
    if (this.store.settings.phoneEnabled) this.store.setSetting('phoneEnabled', false);
    this._set({ state: 'in-progress', testAcceptedAt: null, rotatedAt: this.now(), confirmedAt: null }, 'topic rotated; phone notifications turned off');
    this.lastTestAt = 0;
    return { ok: true, notice: ROTATE_NOTICE };
  }

  // ---- the test + the confirmation ---------------------------------------------------------------------------------------------
  /** sends ONE generic test message. Success = the SERVER accepted it. It says nothing about the phone. */
  async sendTest() {
    const insp = ntfy.inspectConfig(this.dir);
    if (insp.problem || !insp.exists) return { ok: false, kind: 'config', title: 'Setup needs attention', text: 'The saved phone settings could not be used. Use "Start over".' };
    const t = this.now();
    if (this.testsThisRun >= MAX_TESTS_PER_RUN) return { ok: false, kind: 'limit', title: 'Too many tests', text: 'Close this window and open Phone setup again later.' };
    const wait = MIN_TEST_GAP_MS - (t - this.lastTestAt);
    if (this.lastTestAt && wait > 0) return { ok: false, kind: 'too-soon', waitSec: Math.ceil(wait / 1000), title: 'Please wait a moment', text: `You can send another test in ${Math.ceil(wait / 1000)} seconds.` };
    this.lastTestAt = t; this.testsThisRun++;
    let r; try { r = await this.send(insp.cfg, ntfy.buildTestMessage(insp.cfg), { retries: 1, timeoutMs: 8000 }); } catch (e) { r = { ok: false, error: String((e && (e.code || e.name)) || 'error') }; }   // a failing sender must never break the window
    if (!r.ok) {
      const f = friendlyError(r); this.lastError = f.kind;
      this._set({ state: this.state() === 'confirmed' ? 'confirmed' : 'in-progress', testAcceptedAt: null }, `test not sent (${f.kind})`);
      return { ok: false, ...f };
    }
    this.lastError = null;
    if (!this.isConfirmed()) this._set({ state: 'test-sent', testAcceptedAt: this.now() }, 'test accepted by the server; waiting for the user to confirm');
    else this._set({ testAcceptedAt: this.now() });
    return { ok: true, kind: 'accepted', title: 'Sent to the ntfy server', text: 'Now look at your phone. Did the notification arrive?' };
  }
  /** "I got it": the ONLY way phoneEnabled becomes true */
  confirm() {
    const rec = this.record || {};
    if (this.state() !== 'test-sent' || !rec.testAcceptedAt) return { ok: false, reason: 'no-test' };
    if (this.now() - rec.testAcceptedAt > TEST_VALID_MS) return { ok: false, reason: 'test-too-old' };
    if (ntfy.inspectConfig(this.dir).problem) return { ok: false, reason: 'config' };
    this._set({ state: 'confirmed', confirmedAt: this.now() }, 'confirmed by the user');
    this.store.setSetting('phoneEnabled', true);
    return { ok: true };
  }
  /** "I didn't get it": push stays OFF and the accepted test no longer counts */
  reject() { if (!this.isConfirmed()) this._set({ state: 'test-failed', testAcceptedAt: null }, 'user did not receive the test'); return { ok: true }; }

  /** the tray's phone toggle goes through here: turning ON is only possible after confirmation */
  setPhoneEnabled(on) {
    if (!on) { this.store.setSetting('phoneEnabled', false); return { ok: true }; }
    if (!this.isConfirmed()) return { ok: false, reason: 'not-confirmed' };
    if (ntfy.inspectConfig(this.dir).problem) return { ok: false, reason: 'config' };
    this.store.setSetting('phoneEnabled', true);
    return { ok: true };
  }
  trayLabel() { return this.isConfirmed() ? 'Phone setup…' : 'Set up phone notifications…'; }

  // ---- what the window renders --------------------------------------------------------------------------------------------------
  /**
   * The view model. The topic and the deep link are included ONLY when `withSecret` is true (the window needs them for the QR and the
   * "can't scan" text); everything else is safe to log.
   */
  view({ withSecret = false, facts = {} } = {}) {
    const insp = ntfy.inspectConfig(this.dir);
    const v = {
      state: this.state(), confirmed: this.isConfirmed(), phoneEnabled: this.store.settings.phoneEnabled === true,
      configProblem: insp.problem || (insp.exists ? null : 'missing'), rows: rowsFrom(facts),
      playUrl: PLAY_URL, fdroidUrl: FDROID_URL, lastError: this.lastError,
      canSendTest: !insp.problem && insp.exists && this.testsThisRun < MAX_TESTS_PER_RUN,
      testAccepted: this.state() === 'test-sent', serverHost: insp.cfg ? new URL(insp.cfg.server).host : null,
    };
    if (withSecret && insp.cfg && !insp.problem) { v.topic = insp.cfg.topic; v.deepLink = deepLink(insp.cfg); }
    return v;
  }
}

const ROTATE_NOTICE = 'A new topic was created and phone notifications are now OFF. The ntfy subscription on your phone for the old topic will stop working: scan the new QR code (or delete the old subscription in the ntfy app) and confirm with a new test.';

module.exports = { Onboarding, deepLink, friendlyError, rowsFrom, ROTATE_NOTICE, STATES, SETTING, PLAY_URL, FDROID_URL, TEST_VALID_MS, MIN_TEST_GAP_MS, MAX_TESTS_PER_RUN };
