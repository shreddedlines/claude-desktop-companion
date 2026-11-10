#!/usr/bin/env node
/**
 * notifier.js — MVP step 3: Windows tray app on top of the (unchanged) Step 2 merged event stream.
 *
 *   merge-events.js --json  ->  policy.js (what to show)  ->  ui-host.ps1 (tray + toasts + sounds)
 *                                      \->  store.js (SQLite history + settings)
 *
 * Local only: no network, no usage/OAuth, no transcripts, no push. Only event metadata is stored.
 *
 * Usage (production):  ClaudeNotifier.exe notifier.js            run the tray app (normally started by supervisor.js / Claude-Notifier.vbs)
 *   Diagnostics:         --diagnose [--out file]   --self-test-toasts   --verbose
 *   Lifecycle:           --autostart-enable | --autostart-disable | --autostart-status   (HKCU Run key -> Claude-Notifier.vbs)   --unregister
 *   Phone push (ntfy):   --ntfy-init [--ntfy-server URL] [--ntfy-topic T] [--force]   create ntfy.json (push stays off)
 *                        --ntfy-enable | --ntfy-disable | --ntfy-status | --ntfy-test
 * Development/test controls are not listed here: they live in devhooks.js and do not exist in the release build.
 */
'use strict';
const fs = require('fs');
const winpaths = require('./winpaths');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { Store } = require('./store');
const { Policy, SPEC, sessionKey } = require('./policy');
const { ensureSounds } = require('./sounds');
const { ProfileResolver, selectProfile, queryProcesses, redact, onDiskProfiles } = require('./claude-profile');
const { Onboarding } = require('./onboarding');
const { SetupController } = require('./setup-controller');
const theme = require('./theme');
const palette = require('./palette');
const devhooks = require('./devhooks');   // development/test hooks; the release package contains an inert stub (see devhooks.js)
const ntfy = require('./ntfy');
const { UsageMonitor } = require('./usage-monitor');
const { HealthCanary } = require('./health');
const lock = require('./lock');
const autostart = require('./autostart');
const paths = require('./paths');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
// Development/test controls (alternative folders, no-tray mode, disabled lock / usage monitor, timing overrides, ...) are read ONLY from
// devhooks.js. In the release build that module is an inert stub, so none of them exists there. Options kept in production: --diagnose,
// --out, --verbose, --ntfy-*, --autostart-enable|-disable|-status, --unregister, --self-test-toasts.
const D = devhooks.options(argv);
const AUMID = 'ClaudeNotifier.Companion';
// The data folder is %USERPROFILE%\.claude-notifier: outside AppData, so it is the same files whether the notifier was started by
// Explorer / Windows sign-in or as a child of Claude Desktop (which gets a virtualized AppData view). See paths.js.
const DATA_DIR = D.dataDir || paths.defaultDataDir();
const UI_MODE = D.ui || 'tray';
const DURATION = D.durationSec || 0;
const HOLD = String(D.holdMs ?? 1200); // shorter than Step 2's default: lower latency for "needs input/permission"
const pad = (n) => String(n).padStart(2, '0');
const hms = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_PATH = path.join(DATA_DIR, 'notifier.log');
const MIGRATION = D.dataDir ? [] : paths.migrateLegacyData({ dataDir: DATA_DIR, log: (m) => { try { fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } } });   // one-time copy of an older config; never overwrites
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
  if (UI_MODE === 'none' || flag('--verbose')) process.stderr.write(line);
}

// Crashes and exits must leave a trace: the app normally runs hidden, so the log is the only witness.
function logSync(msg) { try { fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } }
process.on('uncaughtException', (e) => { logSync(`CRASH uncaughtException: ${e && e.stack ? e.stack : e}`); process.exit(70); });   // non-zero => the supervisor restarts us
process.on('unhandledRejection', (e) => { logSync(`CRASH unhandledRejection: ${e && e.stack ? e.stack : e}`); process.exit(70); });
process.on('exit', (code) => { if (!argv.some((a) => /^--(ntfy|autostart)-/.test(a))) logSync(`process exit code=${code}`); });   // one-shot CLI commands stay quiet

// ---------- unregister helper ----------
if (flag('--unregister')) {
  try { execFileSync(winpaths.regExe(), ['delete', `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`, '/f'], { stdio: 'pipe' }); console.log('Removed the toast AppUserModelID registration.'); }
  catch (e) { console.log('AppUserModelID registration: nothing to remove.'); }
  const lnk = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Notifier.lnk');
  try { fs.unlinkSync(lnk); console.log('Removed Start Menu shortcut.'); } catch { console.log('Start Menu shortcut: nothing to remove.'); }
  console.log('Data folder left in place:', DATA_DIR);
  process.exit(0);
}


// ---------- phone push (ntfy) command line helpers; run and exit before the tray app starts ----------
const CLI_FLAGS = ['--ntfy-init', '--ntfy-enable', '--ntfy-disable', '--ntfy-status', '--ntfy-test', '--autostart-enable', '--autostart-disable', '--autostart-status', '--diagnose'];
async function runDiagnose() {
  // read-only report of what THIS launch context sees. No secrets, tokens or account identifiers: booleans, ages and redacted
  // (%USERPROFILE%) paths only. Used by the launch-context tests and for support.
  const cfg = ntfy.loadConfig(DATA_DIR);
  let settings = {}; try { settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8')); } catch { /* none */ }
  let snap; try { const mockSource = devhooks.mockProcessSource(argv); snap = mockSource ? await mockSource() : await queryProcesses(); } catch (e) { snap = { procs: null, session: null, error: e.code || e.message }; }
  const sel = selectProfile({ procs: snap.procs, session: snap.session, env: process.env, ...(D.activityMarginMs ? { activityMarginMs: D.activityMarginMs } : {}) });
  const probe = path.join(process.env.LOCALAPPDATA || '', `ClaudeNotifier-probe-${process.pid}`);
  let virtualized = null;                       // does a file I write under %LOCALAPPDATA% land in a Claude package store (i.e. am I virtualized)?
  try { fs.writeFileSync(probe, 'x'); virtualized = paths.claudePackageCaches(process.env).some((p) => fs.existsSync(path.join(p.cache, 'Local', path.basename(probe)))); } catch { /* unknown */ } finally { try { fs.unlinkSync(probe); } catch { /* gone */ } }
  const st = sel.path ? paths.mtimeOf(sel.path) : null;
  const report = {
    dataDir: DATA_DIR, dataDirExists: fs.existsSync(DATA_DIR), ntfyConfigured: !ntfy.validateConfig(cfg), phoneEnabled: !!settings.phoneEnabled,
    usageFound: !!st, usagePath: redact(sel.path, process.env), usageAgeMin: st ? Math.round((Date.now() - st.mtimeMs) / 60000) : null,
    discovery: {
      method: sel.method, ambiguous: sel.ambiguous, ambiguity: sel.ambiguity, selected: sel.profile ? sel.profile.label : null, selectedUsageState: sel.profile ? sel.profile.state : null,
      activeProcesses: sel.profile ? { helpers: sel.profile.helpers, cli: sel.profile.cli } : null, processLookup: snap.procs ? 'ok' : `unavailable (${snap.error || 'unknown'})`, note: sel.note,
    },
    onDiskProfiles: onDiskProfiles(process.env),
    usageCandidates: sel.profiles.map((c) => ({ label: c.label, exists: c.mtimeMs !== null && c.mtimeMs !== undefined, state: c.state })), packageStores: paths.claudePackageCaches(process.env).length,
    sessionsDirExists: fs.existsSync(path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'sessions')), virtualizedAppData: virtualized, pid: process.pid,
  };
  const txt = JSON.stringify(report); const oi = argv.indexOf('--out');
  if (oi >= 0 && argv[oi + 1]) fs.writeFileSync(argv[oi + 1], txt); else console.log(txt);
  process.exit(0);
}
if (CLI_FLAGS.some(flag)) {
  (async () => {
    if (flag('--diagnose')) return runDiagnose();
    const st = new Store(DATA_DIR);
    const akey = { key: D.autostartKey || autostart.RUN_KEY, value: D.autostartValue || autostart.VALUE };
    if (flag('--autostart-enable')) {
      const r = autostart.enable(akey); console.log(r.ok ? `Autostart ENABLED (${akey.key}\\${akey.value}). Claude Notifier will start hidden at your next sign-in.` : `Could not enable autostart: ${r.error}`);
      st.close(); process.exit(r.ok ? 0 : 1);
    } else if (flag('--autostart-disable')) {
      const r = autostart.disable(akey); console.log(r.ok ? 'Autostart DISABLED.' : `Could not disable autostart: ${r.error}`); st.close(); process.exit(r.ok ? 0 : 1);
    } else if (flag('--autostart-status')) {
      const s = autostart.status(akey); console.log(`autostart: ${s.enabled ? `ENABLED -> ${s.command}` : 'disabled'}`); st.close(); process.exit(0);
    }
    if (flag('--ntfy-init')) {
      const r = ntfy.initConfig(DATA_DIR, { server: opt('--ntfy-server', undefined), topic: opt('--ntfy-topic', undefined), force: flag('--force') });
      console.log(r.created ? 'Created' : 'Kept existing', path.join(DATA_DIR, ntfy.CONFIG_NAME));
      console.log(`Server: ${r.cfg.server}\nTopic : ${r.cfg.topic}\nPhone push is currently ${st.settings.phoneEnabled ? 'ENABLED' : 'DISABLED'}.`);
      console.log('Next: install the ntfy Android app, subscribe to that topic on that server, then run:\n  node notifier.js --ntfy-test      (sends one harmless test message)\n  node notifier.js --ntfy-enable    (turns phone push on)');
    } else if (flag('--ntfy-enable') || flag('--ntfy-disable')) {
      const on = flag('--ntfy-enable');
      if (on) { const bad = ntfy.validateConfig(ntfy.loadConfig(DATA_DIR)); if (bad) { console.log(`Cannot enable: ${bad}`); st.close(); process.exit(1); } }
      st.setSetting('phoneEnabled', on); console.log(`Phone push ${on ? 'ENABLED' : 'DISABLED'}.`);
    } else if (flag('--ntfy-status')) {
      const cfg = ntfy.loadConfig(DATA_DIR); const bad = ntfy.validateConfig(cfg);
      console.log(`config : ${bad ? `NOT READY (${bad})` : 'ok'}\nserver : ${cfg ? cfg.server : '-'}\ntopic  : ${cfg && cfg.topic ? `${cfg.topic.slice(0, 6)}… (hidden)` : '-'}\ntoken  : ${cfg && cfg.token ? 'set' : 'none'}\nenabled: ${st.settings.phoneEnabled}`);
    } else if (flag('--ntfy-test')) {
      const cfg = ntfy.loadConfig(DATA_DIR); const bad = ntfy.validateConfig(cfg);
      if (bad) { console.log(`Cannot send: ${bad}`); st.close(); process.exit(1); }
      const r = await ntfy.send(cfg, ntfy.buildTestMessage(cfg));
      st.addPush({ type: 'TEST', project: null, priority: 3, ok: r.ok, status: r.status, error: r.error });
      console.log(r.ok ? `Test message accepted by ${cfg.server} (HTTP ${r.status}). Check your phone.` : `Send FAILED: ${r.error}`);
      st.close(); process.exit(r.ok ? 0 : 1);
    }
    st.close(); process.exit(0);
  })();
  setInterval(() => {}, 1 << 30); // keep alive until the async block exits the process
}

const CLI_ONLY = CLI_FLAGS.some(flag);
if (!CLI_ONLY) logSync(`startup: pid=${process.pid} node=${process.version} ui=${UI_MODE} data=${DATA_DIR}`);
// ---------- single instance ----------
const LOCK = path.join(DATA_DIR, 'notifier.lock');
function acquireLock() {
  if (D.noLock) return true;
  const d = lock.checkLock({ file: LOCK });
  if (!d.acquire) { logSync(`startup refused: ${d.reason}`); console.log(`Claude Notifier not started: ${d.reason}`); return false; }
  if (!/^(no lock file|lock already ours)/.test(d.reason)) logSync(`lock: ${d.reason}`);   // a recovered stale lock is always logged
  lock.writeLock(LOCK);
  return true;
}
if (!CLI_ONLY && !acquireLock()) process.exit(0);   // exit 0: "already running" is not a failure the supervisor should retry

// ---------- UI backends ----------
class TrayUi extends EventEmitter {
  start() {
    const script = path.join(__dirname, 'ui-host.ps1');
    this.child = spawn(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script, '-Aumid', AUMID], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) this._line(l); } });
    this.child.stderr.on('data', (d) => log(`ui-host stderr: ${String(d).trim().slice(0, 300)}`));
    this.child.on('exit', (code) => this.emit('exit', code));
    this.child.stdin.on('error', () => { /* host gone */ });
  }
  _line(l) { try { const o = JSON.parse(l); this.emit(o.evt, o); } catch { log(`ui-host: unparsable line ${l.slice(0, 120)}`); } }
  send(obj) { if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n'); }
  stop() { this.send({ cmd: 'exit' }); setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } }, 800); }
}

class NullUi extends EventEmitter {
  start() {
    setImmediate(() => this.emit('ready', { evt: 'ready' }));
    if (D.controlStdin) {
      let b = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const id = b.slice(0, i).trim(); b = b.slice(i + 1); if (id) this._cmd(id); } });
    }
  }
  // test hooks (only reachable with the development stdin-control mode, which does not exist in releases): simulate what the real tray host would report
  _cmd(id) {
    if (id.startsWith('toastSetting:')) this.emit('toastSetting', { evt: 'toastSetting', setting: id.slice(13) });
    else if (id.startsWith('toastFail:')) this.emit('toastShown', { evt: 'toastShown', tag: 'x', ok: false, error: id.slice(10), setting: 'Enabled' });
    else if (id === 'toastOk') this.emit('toastShown', { evt: 'toastShown', tag: 'x', ok: true, setting: 'Enabled' });
    else if (id === '__crash__') setImmediate(() => { throw new Error('test crash'); });
    else this.emit('menu', { evt: 'menu', id });
  }
  send(obj) {
    if (obj.cmd === 'toast' || obj.cmd === 'retract') process.stdout.write(JSON.stringify({ t: Date.now(), ...obj }) + '\n');
    else if (obj.cmd === 'menu' && D.dumpMenu) process.stdout.write(JSON.stringify({ t: Date.now(), menu: obj }) + '\n');   // tests: what the tray would show
    else if (obj.cmd === 'theme' && D.dumpMenu) process.stdout.write(JSON.stringify({ t: Date.now(), theme: obj.theme }) + '\n');   // tests: the colours the tray would get
  }
  stop() { /* nothing */ }
}

// ---------- state ----------
const store = new Store(DATA_DIR);
const soundPaths = ensureSounds(path.join(DATA_DIR, 'sounds'));
const policy = new Policy({ getSettings: () => store.settings });
let phoneStatus = { failStreak: 0, lastOkAt: 0, lastError: null, failing: false };
const phone = new ntfy.PhoneDispatcher({
  getConfig: () => ntfy.loadConfig(DATA_DIR), getEnabled: () => store.settings.phoneEnabled, log,
  onStatus: (s, tr) => {
    phoneStatus = s;
    if (tr.becameFailing) {
      log(`phone push FAILING: ${s.failStreak} in a row (${s.lastError})`);
      onEvent({ type: 'PHONE_FAILING', session: 'Phone push', project: '?', sessionId: 'phone:failing', pid: null, source: 'phone', epoch: Date.now(), details: `${s.failStreak} failures`,
        noticeLines: [`Phone pushes failed ${s.failStreak} times in a row (${s.lastError}).`, 'Your phone may not be getting notifications. Check the network, the ntfy server and the topic.'] });
    } else if (tr.recovered) log('phone push recovered (server accepted a push again)');
    scheduleMenu();
  },
  onResult: (ev, body, r) => store.addPush({ type: ev.type, project: ev.project, priority: body.priority, ok: r.ok, status: r.status, error: r.error }),
});
const ui = UI_MODE === 'none' ? new NullUi() : new TrayUi();
// Which Claude Desktop profile is active (process metadata first, file activity if Claude is not running).
const profileResolver = new ProfileResolver({
  env: process.env, log,
  query: devhooks.mockProcessSource(argv) || queryProcesses,
  ...(D.profileRefreshMs ? { runningMs: D.profileRefreshMs, idleMs: D.profileRefreshMs } : {}),
  ...(D.activityMarginMs ? { activityMarginMs: D.activityMarginMs } : {}),
});
// Step 5: plan-usage monitor (read-only on Claude Desktop's plan-usage-history.json)
const usage = new UsageMonitor({
  // the ACTIVE profile's usage file, re-resolved on every tick (see claude-profile.js). A development override can pin a fixed path (tests only).
  resolveFile: D.usageFile ? () => D.usageFile : () => profileResolver.resolve(),
  onResolve: (file, cands) => log(file ? `usage history: using ${redact(file, process.env)}` : `usage history: none selected (${cands ? cands.length : '?'} profile(s) considered: ${cands ? cands.map((c) => c.label).join(', ') : '-'})`),
  stateFile: path.join(DATA_DIR, 'usage-state.json'),
  emit: (ev) => onEvent(ev),
  pollMs: D.usagePollMs ?? 15000,
  ...(D.usageFreshMs ? { freshMs: D.usageFreshMs, maxAlertAgeMs: D.usageFreshMs } : {}),
  ...(D.usageStaleGapMs ? { staleNoticeGapMs: D.usageStaleGapMs } : {}),
});
const health = new HealthCanary({
  ...(D.healthGraceMs ? { graceMs: D.healthGraceMs } : {}),
  ...(D.healthBlindMs ? { blindMs: D.healthBlindMs } : {}),
  ...(D.healthStallMs ? { stallMs: D.healthStallMs } : {}),
  ...(D.healthLimit ? { limit: D.healthLimit } : {}),
});
const toastState = { setting: null, failStreak: 0, lastError: null, shortcutError: null };   // Windows notification mechanism health
const sessions = new Map();      // key -> { name, project, state, since, pid }

// ---------- first-run phone setup: a separate module + window process, not part of the monitoring engine (onboarding.js, setup-controller.js) ----------
const ONBOARDING = UI_MODE === 'tray' || D.firstRunSetup;      // production runs in tray mode; development tests opt in
const onboarding = new Onboarding({ dir: DATA_DIR, store, log });
const setupFacts = () => {   // what the setup window's checklist shows (no paths, no numbers)
  let sel = null; try { sel = profileResolver.resolve(); } catch { /* not ready yet */ }
  const sessDir = D.sessionsDir || path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'sessions');
  return {
    claudeRunning: !!(sel && String(sel.method).startsWith('process')), claudeInstalled: paths.claudePackageCaches(process.env).length > 0 || onDiskProfiles(process.env).length > 0,
    sessionsDirExists: fs.existsSync(sessDir), liveSessions: sessions.size, usage: { state: D.noUsage ? 'none' : usage.status().state },
  };
};
// ---------- appearance: the stored preference (System | Light | Dark) + what Windows is set to => the theme of the tray menu and the setup window ----------
const themeState = { system: (D.systemTheme && theme.systemFromName(D.systemTheme)) || theme.detectSystem(), resolved: null };
const resolveThemeNow = () => theme.resolveTheme(theme.getAppearance(store), themeState.system);
themeState.resolved = resolveThemeNow();
const themeMessage = (t) => ({ cmd: 'theme', theme: { appearance: t.appearance, mode: t.mode, highContrast: t.highContrast, colors: t.mode === 'contrast' ? null : palette.paletteFor(t.mode) } });
/** re-evaluate; when the effective theme changed, tell the tray menu and the open setup window at once (no restart) */
function refreshTheme(force = false) {
  const t = resolveThemeNow();
  if (!force && theme.sameTheme(t, themeState.resolved)) return false;
  themeState.resolved = t;
  ui.send(themeMessage(t)); setupWindow.applyTheme(); scheduleMenu();
  log(`appearance: ${t.appearance} => ${t.mode}${t.highContrast ? ' (High Contrast)' : ''}`);
  return true;
}
const setupWindow = new SetupController({ onboarding, getFacts: setupFacts, log, getTheme: () => themeState.resolved });
let firstRunStarted = false;
function startFirstRun() {   // once, after the tray is up: recognise an existing setup, create the topic if needed, offer the window ONCE
  if (!ONBOARDING || firstRunStarted) return; firstRunStarted = true;
  try {
    onboarding.reconcile();
    onboarding.ensureConfig();
    if (onboarding.shouldAutoOpen()) setTimeout(() => { if (!shuttingDown) { onboarding.markAutoOpened(); setupWindow.open(); } }, 3000);
  } catch (e) { log(`phone setup: could not start (${(e && e.code) || 'error'})`); }
}
const attention = new Map();     // key -> time
let shuttingDown = false;
let menuTimer = null;

const STATE_BY_TYPE = { WORKING: 'WORKING', IDLE: 'IDLE', TURN_FINISHED: 'IDLE', WAITING_FOR_USER: 'WAITING_FOR_USER', WAITING_FOR_PERMISSION: 'WAITING_FOR_PERMISSION', WAITING_UNKNOWN: 'WAITING_UNKNOWN' };
const FRIENDLY = { TURN_FINISHED: 'Finished', WAITING_FOR_USER: 'Needs input', WAITING_FOR_PERMISSION: 'Needs permission', API_ERROR: 'API error',
  SESSION_LIMIT: 'Session limit', PROCESS_EXITED_ERROR: 'Process exited', SESSION_STARTED: 'Session started', SESSION_ENDED: 'Session ended',
  USAGE_WARNING: 'Usage warning', USAGE_CRITICAL: 'Usage critical', USAGE_STALE: 'Usage data stale',
  WAITING_UNKNOWN: 'Needs attention', HEALTH_WARNING: 'Health warning', PHONE_FAILING: 'Phone push failing' };
const STATE_TEXT = { WORKING: 'working', IDLE: 'idle', WAITING_FOR_USER: 'needs input', WAITING_FOR_PERMISSION: 'needs permission', WAITING_UNKNOWN: 'needs attention', SHELL: 'shell' };

function updateSessions(ev) {
  const key = sessionKey(ev);
  if (ev.type === 'SESSION_ENDED') {
    for (const [k, s] of [...sessions]) if (k === key || (ev.pid && s.pid === ev.pid)) sessions.delete(k);
    attention.delete(key); return;
  }
  let state = STATE_BY_TYPE[ev.type];
  if (ev.type === 'INITIAL_STATE' || ev.type === 'SESSION_STARTED') { const m = /state=(\w+)/.exec(ev.details || ''); state = m ? m[1] : 'IDLE'; }
  if (['WORKING', 'TURN_FINISHED', 'IDLE'].includes(ev.type)) attention.delete(key);
  if (['API_ERROR', 'SESSION_LIMIT', 'PROCESS_EXITED_ERROR'].includes(ev.type)) attention.set(key, Date.now());
  if (!state) return;
  // log-only events (no pid) must never create or resurrect a session entry (e.g. ended sessions)
  if (!sessions.has(key) && !(ev.pid && /session-file/.test(ev.source || ''))) return;
  const prev = sessions.get(key);
  sessions.set(key, { name: ev.session, project: ev.project, pid: ev.pid, state, since: prev && prev.state === state ? prev.since : (ev.epoch || Date.now()) });
}

function menuModel() {
  const now = Date.now();
  for (const [k, t] of attention) if (now - t > 10 * 60_000) attention.delete(k);
  const list = [...sessions.values()];
  const waiting = list.filter((s) => s.state.startsWith('WAITING')).length;
  const working = list.filter((s) => s.state === 'WORKING').length;
  const state = attention.size ? 'attention' : waiting ? 'waiting' : working ? 'working' : 'idle';
  const recent = store.recent(12).map((r) => `${hms(r.ts)}  ${FRIENDLY[r.type] || r.type} — ${r.project && r.project !== '?' ? r.project : (r.session || '?')}${!r.notified && SPEC[r.type] ? '  (no toast)' : ''}`);
  const us = D.noUsage ? { state: 'off', text: null, hint: null, tip: '' } : usage.status();
  const hs = health.status();
  let toastText = null; let toastBad = false;
  if (toastState.setting && toastState.setting !== 'Enabled') { toastText = `Windows notifications are OFF for Claude Notifier (${toastState.setting}) \u2014 enable them in Settings > System > Notifications`; toastBad = true; }
  else if (toastState.failStreak >= 2) { toastText = `Windows toasts are failing (${toastState.failStreak} in a row: ${toastState.lastError || 'unknown error'})`; toastBad = true; }
  else if (toastState.shortcutError) { toastText = `Start Menu shortcut could not be created \u2014 banners may not pop up (${toastState.shortcutError})`; toastBad = true; }
  let phoneText = null; let phoneBad = false;
  if (store.settings.phoneEnabled) {
    if (phoneStatus.failing) { phoneText = `Phone push FAILING (${phoneStatus.failStreak} failed in a row: ${phoneStatus.lastError}) \u2014 check network / ntfy topic`; phoneBad = true; }
    else if (phoneStatus.lastOkAt) phoneText = `Phone push: last accepted by server ${hms(phoneStatus.lastOkAt)} (phone delivery not confirmed)`;
    else phoneText = 'Phone push: enabled \u2014 nothing sent yet';
  }
  return {
    healthText: hs.text, healthHint: hs.hint, toastText, toastBad, phoneText, phoneBad,
    usageText: us.text, usageHint: us.hint, usageStale: us.state === 'stale' || us.state === 'none' || us.state === 'unavailable' || us.state === 'ambiguous',
    cmd: 'menu', state, notificationsEnabled: store.settings.notificationsEnabled, soundsEnabled: store.settings.soundsEnabled,
    appearance: theme.getAppearance(store),
    phoneEnabled: store.settings.phoneEnabled, phoneConfigured: !ntfy.validateConfig(ntfy.loadConfig(DATA_DIR)) && (!ONBOARDING || onboarding.isConfirmed()), phoneSetupText: onboarding.trayLabel(),
    tooltip: `Claude: ${working} working, ${waiting} waiting${attention.size ? ', ATTENTION' : ''}${store.settings.notificationsEnabled ? '' : ' (muted)'}${us.tip ? ` | ${us.tip}` : ''}`,
    sessions: list.sort((a, b) => a.name.localeCompare(b.name)).map((s) => `${s.project && s.project !== '?' ? s.project : s.name} — ${STATE_TEXT[s.state] || s.state} (${Math.max(0, Math.round((now - s.since) / 60000))}m)`),
    recent,
  };
}
function scheduleMenu() { if (menuTimer || shuttingDown) return; menuTimer = setTimeout(() => { menuTimer = null; if (!shuttingDown) ui.send(menuModel()); }, 150); }   // never after shutdown began: the history database is closed by then

function perform(actions) {
  for (const a of actions) {
    if (a.kind === 'toast') ui.send({ cmd: 'toast', ...a, sound: a.sound ? soundPaths[a.sound] || a.sound : null, soundName: a.sound });
    else if (a.kind === 'retract') ui.send({ cmd: 'retract', group: a.group, tags: a.tags });
  }
}

function onEvent(ev) {
  if (ev.type === 'HEARTBEAT') { health.onHeartbeat(ev); return; }   // liveness signal only: never stored, never notified
  health.onEvent(ev);
  store.reloadSettings();
  updateSessions(ev);
  const res = policy.handle(ev);
  store.addEvent(ev, res);
  if (ev.type !== 'WORKING' && ev.type !== 'INITIAL_STATE') log(`event ${ev.type} project=${ev.project} notified=${res.notified} reason=${res.reason}`);
  perform(res.actions);
  const ph = phone.handle(ev);
  if (ph.reason !== 'no-push-for-type' && ph.reason !== 'phone-disabled') log(`phone ${ev.type}: ${ph.reason}`);
  scheduleMenu();
}

// ---------- merged event stream (Step 2, unchanged) ----------
let mergeRestarts = []; let mergeChild = null;
function startMerger() {
  const args = [path.join(__dirname, 'merge-events.js'), '--json', '--hold', HOLD];
  args.push(...devhooks.forwardToMerge(D));   // development overrides only; nothing in production
  mergeChild = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  mergeChild.stdout.setEncoding('utf8');
  mergeChild.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { onEvent(JSON.parse(l)); } catch (e) { log(`bad event line: ${e.message}`); } } });
  mergeChild.stderr.on('data', (d) => log(`merge: ${String(d).trim().slice(0, 300)}`));
  mergeChild.on('exit', (code) => {
    if (shuttingDown) return;
    const now = Date.now(); mergeRestarts = mergeRestarts.filter((t) => now - t < 60_000); mergeRestarts.push(now);
    log(`event stream exited (code ${code}); ${mergeRestarts.length > 5 ? 'giving up' : 'restarting in 2s'}`);
    if (mergeRestarts.length > 5) { perform([{ kind: 'toast', tag: 'stream-down', group: 'app', persistent: true, title: 'Claude Notifier stopped watching', lines: ['The event stream failed repeatedly; restart the app.'], sound: 'attention', expireMinutes: 60 }]); return; }
    setTimeout(startMerger, 2000);
  });
}

// ---------- menu actions ----------
function toastNote(title, lines) {
  perform([{ kind: 'toast', tag: 'note', group: 'app', persistent: false, title, lines, sound: null, expireMinutes: 10 }]);
}

function onMenu(id) {
  if (id === 'toggleNotifications') store.setSetting('notificationsEnabled', !store.settings.notificationsEnabled);
  else if (id === 'toggleSounds') store.setSetting('soundsEnabled', !store.settings.soundsEnabled);
  else if (id === 'test') perform([{ kind: 'toast', tag: 'test', group: 'test', persistent: false, title: 'Claude Notifier test', lines: ['Notifications are working', 'This is a test, not a Claude event'], sound: store.settings.soundsEnabled ? 'finished' : null, expireMinutes: 10 }]);
  else if (id.startsWith('appearance:')) {   // System | Light | Dark: stored through the Store (one key), applied immediately
    const r = theme.setAppearance(store, id.slice('appearance:'.length));
    log(`appearance choice: ${r.ok ? (r.changed ? `now ${r.appearance}` : 'unchanged') : 'invalid value ignored'}`);
    if (r.ok) refreshTheme();
  }
  else if (id === 'phoneSetup') setupWindow.open();
  else if (id === 'togglePhone') {
    if (ONBOARDING) { if (!onboarding.setPhoneEnabled(!store.settings.phoneEnabled).ok) setupWindow.open(); }   // turning ON needs a confirmed setup: otherwise finish the setup first
    else {
      const bad = ntfy.validateConfig(ntfy.loadConfig(DATA_DIR));
      if (!store.settings.phoneEnabled && bad) toastNote('Phone notifications not configured', [bad, 'Open "Set up phone notifications" in this menu.']);
      else store.setSetting('phoneEnabled', !store.settings.phoneEnabled);
    }
  } else if (id === 'testPhone') {
    const cfg = ntfy.loadConfig(DATA_DIR); const bad = ntfy.validateConfig(cfg);
    if (bad) toastNote('Phone test not sent', [bad]);
    else ntfy.send(cfg, ntfy.buildTestMessage(cfg)).then((r) => {
      store.addPush({ type: 'TEST', project: null, priority: 3, ok: r.ok, status: r.status, error: r.error });
      phone.recordManual(r);
      toastNote(r.ok ? 'Phone test sent' : 'Phone test FAILED', [r.ok ? `Accepted by ${new URL(cfg.server).host}. Check your phone.` : `Error: ${r.error}`]);
    });
  }
  else if (id === 'openFolder') spawn(winpaths.explorerExe(), [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
  else if (id === 'exit') return shutdown(0, 'user chose Exit in the tray menu');
  log(`menu ${id} -> notifications=${store.settings.notificationsEnabled} sounds=${store.settings.soundsEnabled}`);
  scheduleMenu();
}

function shutdown(code, reason = 'requested') {
  if (shuttingDown) return; shuttingDown = true;
  log(`shutting down: ${reason} (exit code ${code})`);
  try { mergeChild && mergeChild.kill(); } catch { /* gone */ }
  usage.stop(); profileResolver.stop(); phone.stop(); setupWindow.kill(); ui.stop(); store.close();
  if (!D.noLock) lock.releaseLock(LOCK);
  setTimeout(() => process.exit(code), 1000);
}

// ---------- optional: render every notification type once (visual/audio check; NOT real Claude events) ----------
async function selfTestToasts() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = (type, details) => ({ type, session: 'Self test', project: 'notifier-selftest', sessionId: `selftest-${type}`, pid: null, details, epoch: Date.now(), source: 'selftest' });
  const gap = D.gapMs ?? 7000;
  for (const e of [ev('TURN_FINISHED', ''), ev('WAITING_FOR_USER', 'tool=AskUserQuestion'), ev('WAITING_FOR_PERMISSION', 'tool=Bash'),
    ev('SESSION_LIMIT', "You've hit your session limit · resets 7pm (Asia/Kolkata)"), ev('API_ERROR', 'API Error: Unable to connect to API'), ev('PROCESS_EXITED_ERROR', 'exit code 3221225786 (0xC000013A)')]) {
    const res = policy.handle(e); log(`selftest ${e.type} notified=${res.notified}`); perform(res.actions); await sleep(gap);
  }
}

// ---------- main ----------
if (!CLI_ONLY) {
ui.on('menu', (m) => onMenu(m.id));
const noteSetting = (s) => { if (s && s !== toastState.setting) { log(`windows notification setting: ${s}${s === 'Enabled' ? '' : ' (banners will NOT be shown)'}`); toastState.setting = s; scheduleMenu(); } };
ui.on('toastShown', (m) => {
  log(`toast ${m.tag} ok=${m.ok}${m.error ? ` error=${m.error}` : ''}`);
  noteSetting(m.setting);
  if (m.ok) { if (toastState.failStreak) { toastState.failStreak = 0; scheduleMenu(); } } else { toastState.failStreak++; toastState.lastError = String(m.error || 'unknown').slice(0, 80); scheduleMenu(); }
});
ui.on('toastSetting', (m) => noteSetting(m.setting));
ui.on('error', (m) => log(`ui error: ${m.message}`));
ui.on('exit', (code) => { if (!shuttingDown) { log(`tray host exited unexpectedly (code ${code}); exiting non-zero so the supervisor restarts the app`); shutdown(1, 'tray host died'); } });
ui.on('ready', (m) => {
  log(`ui ready shortcut=${m.shortcut || 'none'}${m.shortcutError ? ` shortcutError=${m.shortcutError}` : ''}`);
  toastState.shortcutError = m.shortcutError ? String(m.shortcutError).slice(0, 80) : null; noteSetting(m.toastSetting);
  ui.send(themeMessage(themeState.resolved)); scheduleMenu();      // the tray gets its colours before the menu is ever drawn
  startFirstRun();
});
ui.start();
log(`started pid=${process.pid} ui=${UI_MODE} data=${DATA_DIR} history=${store.backend} rows=${store.count()}`);
if (flag('--self-test-toasts')) selfTestToasts().then(() => setTimeout(() => shutdown(0, 'self-test finished'), 3000));
else { startMerger(); if (!D.noUsage && !D.usageFile) profileResolver.start().finally(() => { if (!shuttingDown) usage.start(); }); else if (!D.noUsage) usage.start(); }
setInterval(() => { perform(policy.tick()); scheduleMenu(); }, 5000).unref?.();
// follow Windows (System preference, High Contrast) and settings.json changes made elsewhere, within a few seconds
setInterval(async () => {
  if (shuttingDown) return;
  try { store.reloadSettings(); if (!D.systemTheme) themeState.system = await theme.detectSystemAsync(); refreshTheme(); } catch { /* keep the current theme */ }
}, 3000).unref?.();
process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
if (DURATION) setTimeout(() => shutdown(0, 'duration elapsed'), DURATION * 1000);
// health canary tick (every 5 s): warnings/clears flow through the normal policy -> ONE Windows toast, never the phone
let lastStreamKill = 0;
setInterval(() => {
  const r = health.evaluate();
  for (const e of r.events) onEvent(e);
  const n = Date.now();
  if (r.stalled && mergeChild && n - lastStreamKill > 120000) { lastStreamKill = n; log('health: event stream stalled; restarting it'); try { mergeChild.kill(); } catch { /* gone */ } }
  if (r.events.length) scheduleMenu();
}, 5000).unref?.();
{ const c = ntfy.loadConfig(DATA_DIR); if (c && c.titleMigrated) log('ntfy config: session titles are NOT sent (privacy default). To opt in set "configVersion": 2 and "includeSessionTitle": true in ntfy.json'); }
devhooks.installCrashInjector({ env: process.env, uiMode: UI_MODE, dataDir: DATA_DIR });   // no-op in the release build
}
