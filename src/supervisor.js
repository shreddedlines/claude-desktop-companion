#!/usr/bin/env node
'use strict';
/**
 * supervisor.js — lightweight watchdog for notifier.js (this is what autostart launches).
 *
 *   - Starts notifier.js and waits for it.
 *   - EXIT CODE 0  (tray "Exit", Ctrl+C, "already running", SIGTERM)  => clean: the supervisor exits too. No restart.
 *   - any other exit / crash / kill => logged with code and signal, then restarted with exponential backoff.
 *   - Never an infinite loop: at most `maxRestarts` restarts inside `windowMs` (default 5 in 10 min). A notifier that
 *     ran healthily for longer than the window starts a fresh budget. When the budget is spent the supervisor logs it,
 *     shows one Windows notification (notify-once.ps1) and stops.
 *   - Every event goes to supervisor.log in the data folder.
 *
 * Usage: node supervisor.js        (development builds additionally pass their arguments on to the notifier; releases ignore them)
 */
const fs = require('fs');
const winpaths = require('./winpaths');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/**
 * @param {{ script:string, args?:string[], logFile?:string, maxRestarts?:number, windowMs?:number, backoffMs?:number, maxBackoffMs?:number,
 *           onGiveUp?:Function, spawnImpl?:Function, now?:Function, execPath?:string }} o
 * @returns {{ done: Promise<{ reason:string, restarts:number, exitCode:number }>, stop: Function }}
 */
function runSupervisor(o) {
  const { script, args = [], logFile, maxRestarts = 5, windowMs = 600_000, backoffMs = 2000, maxBackoffMs = 30_000, execPath = process.execPath } = o;
  const spawnImpl = o.spawnImpl || spawn; const now = o.now || Date.now;
  const log = (m) => { const line = `${new Date().toISOString()} [supervisor] ${m}\n`; if (logFile) { try { fs.appendFileSync(logFile, line); } catch { /* ignore */ } } };
  let child = null; let stopping = false; let restarts = []; let totalRestarts = 0; let timer = null; let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const finish = (reason, exitCode) => { if (timer) clearTimeout(timer); log(`stopping: ${reason}`); resolveDone({ reason, restarts: totalRestarts, exitCode }); };

  function start() {
    if (stopping) return;
    const t0 = now();
    child = spawnImpl(execPath, [script, ...args], { stdio: 'ignore', windowsHide: true });
    log(`started notifier pid=${child.pid} (restarts so far: ${totalRestarts})`);
    child.on('error', (e) => log(`could not start notifier: ${e.message}`));
    child.on('exit', (code, signal) => {
      child = null;
      const ranMs = now() - t0;
      if (stopping) return finish('stop requested', 0);
      if (code === 0) { log(`notifier exited cleanly (code 0) after ${Math.round(ranMs / 1000)}s: not restarting`); return finish('clean exit', 0); }
      log(`notifier ${signal ? `killed by ${signal}` : `exited with code ${code}`} after ${Math.round(ranMs / 1000)}s (unexpected)`);
      const t = now(); restarts = restarts.filter((x) => t - x < windowMs);
      if (restarts.length >= maxRestarts) {
        log(`giving up: ${restarts.length + 1} failures within ${Math.round(windowMs / 60000)} min (limit ${maxRestarts} restarts)`);
        try { (o.onGiveUp || defaultGiveUp)({ failures: restarts.length + 1, minutes: Math.round(windowMs / 60000), lastCode: code, signal }); } catch (e) { log(`give-up notice failed: ${e.message}`); }
        return finish('restart budget exhausted', 1);
      }
      const delay = Math.min(maxBackoffMs, backoffMs * 2 ** restarts.length);
      restarts.push(t); totalRestarts++;
      log(`restart ${restarts.length}/${maxRestarts} in ${delay} ms`);
      timer = setTimeout(start, delay);
    });
  }

  function stop() { stopping = true; if (timer) { clearTimeout(timer); timer = null; } if (child) { try { child.kill(); } catch { /* gone */ } } else finish('stop requested', 0); }
  start();
  return { done, stop };
}

function defaultGiveUp({ failures, minutes }) {
  const ps = path.join(__dirname, 'notify-once.ps1');
  spawn(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps,
    '-Title', 'Claude Notifier stopped', '-Body', `It crashed ${failures} times in ${minutes} minutes and was not restarted. See supervisor.log in the app data folder.`],
  { windowsHide: true, stdio: 'ignore', detached: true }).unref();
}

if (require.main === module) {
  // Development/test controls come from devhooks.js only; in the release build the supervisor ignores its command line entirely and
  // starts the notifier without arguments.
  const dev = require('./devhooks').options(process.argv.slice(2));
  const args = [...dev.passthrough];
  const dataDir = dev.dataDir || require('./paths').defaultDataDir();   // %USERPROFILE%\.claude-notifier (same for every launch context)
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'supervisor.log');
  const sup = runSupervisor({ script: path.join(__dirname, 'notifier.js'), args, logFile });
  const bye = () => sup.stop();
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  sup.done.then((r) => setTimeout(() => process.exit(r.exitCode), 200));
}

module.exports = { runSupervisor };
