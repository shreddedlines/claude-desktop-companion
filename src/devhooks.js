'use strict';
/**
 * devhooks.js — DEVELOPMENT AND TEST ONLY.
 *
 * Everything the test suites need to steer the application lives here and nowhere else:
 *   - options(argv): typed overrides read from development-only command-line controls (data / sessions / log folders, simulated
 *     tray input, disabled locking or usage monitoring, timing overrides, ...). The entry scripts read ONLY this object, so the
 *     names of these controls do not occur anywhere else in the code base.
 *   - mockProcessSource(argv): a stand-in for the PowerShell process query.
 *   - installCrashInjector(): makes the notifier crash once, to prove the supervisor restarts it.
 *
 * They must NOT exist in a distributed build: tools/stage.js ships tools/release/devhooks.js (an inert stub with the same
 * exports: it reads no argument and no environment variable) in place of this file, and its release gates fail the build if
 * this file, or any shipped file that names one of these controls, ends up in the package.
 */
const fs = require('fs');
const path = require('path');

const argValue = (argv, name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };
const argNumber = (argv, name) => { const v = argValue(argv, name); return v === undefined ? undefined : Number(v); };

/** every development-only control; tools/stage.js keeps a copy of this list and test-step10 proves the two lists are identical */
const DEV_CONTROLS = [
  '--data-dir', '--sessions-dir', '--log-dir', '--dir', '--ui', '--control-stdin', '--dump-menu', '--no-lock', '--no-usage', '--usage-file',
  '--usage-poll-ms', '--usage-fresh-ms', '--usage-stale-gap-ms', '--health-grace-ms', '--health-blind-ms', '--health-stall-ms', '--health-limit',
  '--profile-refresh-ms', '--activity-margin-ms', '--duration', '--interval', '--hb-ms', '--gap', '--autostart-key', '--autostart-value',
  '--replay-days', '--once', '--stats', '--all-entrypoints', '--no-verify', '--verify-interval', '--blind-probe-ms', '--heartbeat-ms',
  '--mock-claude-processes', 'NOTIFIER_TEST_CRASH_MS', '--first-run-setup', '--system-theme',
];

/** typed overrides; an absent control is `undefined` / `false`. `passthrough` is what the supervisor hands on to the notifier. */
function options(argv = process.argv.slice(2)) {
  const has = (n) => argv.includes(n);
  return Object.freeze({
    dev: true,
    passthrough: argv,
    dataDir: argValue(argv, '--data-dir'), sessionsDir: argValue(argv, '--sessions-dir'), logDir: argValue(argv, '--log-dir'), dir: argValue(argv, '--dir'),
    ui: argValue(argv, '--ui'), controlStdin: has('--control-stdin'), dumpMenu: has('--dump-menu'), noLock: has('--no-lock'), noUsage: has('--no-usage'),
    usageFile: argValue(argv, '--usage-file'), usagePollMs: argNumber(argv, '--usage-poll-ms'), usageFreshMs: argNumber(argv, '--usage-fresh-ms'), usageStaleGapMs: argNumber(argv, '--usage-stale-gap-ms'),
    healthGraceMs: argNumber(argv, '--health-grace-ms'), healthBlindMs: argNumber(argv, '--health-blind-ms'), healthStallMs: argNumber(argv, '--health-stall-ms'), healthLimit: argNumber(argv, '--health-limit'),
    profileRefreshMs: argNumber(argv, '--profile-refresh-ms'), activityMarginMs: argNumber(argv, '--activity-margin-ms'),
    holdMs: argNumber(argv, '--hold'), durationSec: argNumber(argv, '--duration'), intervalMs: argNumber(argv, '--interval'), hbMs: argNumber(argv, '--hb-ms'), gapMs: argNumber(argv, '--gap'),
    autostartKey: argValue(argv, '--autostart-key'), autostartValue: argValue(argv, '--autostart-value'), replayDays: argNumber(argv, '--replay-days'),
    systemTheme: argValue(argv, '--system-theme'),   // pretend Windows is 'light' | 'dark' | 'contrast' (tests; production always reads the real setting)
    firstRunSetup: has('--first-run-setup'),   // run the first-run phone setup also without the tray (headless tests)
    once: has('--once'), stats: has('--stats'), allEntrypoints: has('--all-entrypoints'), noVerify: has('--no-verify'),
    verifyIntervalMs: argNumber(argv, '--verify-interval'), blindProbeMs: argNumber(argv, '--blind-probe-ms'), heartbeatMs: argNumber(argv, '--heartbeat-ms'),
  });
}

/** what the notifier hands to the event-stream child (only controls that were actually given) */
function forwardToMerge(o) {
  const a = [];
  if (o.sessionsDir) a.push('--sessions-dir', o.sessionsDir);
  if (o.logDir) a.push('--log-dir', o.logDir);
  if (o.intervalMs !== undefined) a.push('--interval', String(o.intervalMs));
  if (o.hbMs !== undefined) a.push('--hb-ms', String(o.hbMs));
  return a;
}
/** what the event-stream child hands to the session watcher (production: nothing, the watcher's built-in defaults are identical) */
function forwardToWatcher(o) {
  const a = [];
  if (o.sessionsDir) a.push('--dir', o.sessionsDir);
  if (o.intervalMs !== undefined) a.push('--interval', String(o.intervalMs));
  if (o.hbMs !== undefined) a.push('--heartbeat-ms', String(o.hbMs));
  return a;
}

/** `--mock-claude-processes <json-file>`: a stand-in for the PowerShell process query. Returns an async function, or null if not requested. */
function mockProcessSource(argv = process.argv.slice(2)) {
  const file = argValue(argv, '--mock-claude-processes');
  return file ? async () => JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** env NOTIFIER_TEST_CRASH_MS (needs the no-tray test mode): throws once per data dir after that many ms, so the supervisor's restart can be tested. */
function installCrashInjector({ env = process.env, uiMode, dataDir }) {
  const ms = env.NOTIFIER_TEST_CRASH_MS;
  if (ms && uiMode === 'none' && !fs.existsSync(path.join(dataDir, 'test-crashed'))) {
    setTimeout(() => { fs.writeFileSync(path.join(dataDir, 'test-crashed'), '1'); throw new Error('test crash'); }, Number(ms));
  }
}

module.exports = { DEV_HOOKS: true, DEV_CONTROLS, options, forwardToMerge, forwardToWatcher, mockProcessSource, installCrashInjector };
