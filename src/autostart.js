'use strict';
/**
 * autostart.js — per-user autostart through the HKCU Run key (no admin, no scheduled task, removable).
 * The Run value launches Claude-Notifier.vbs (hidden window), which starts supervisor.js (watchdog) -> notifier.js.
 * The key path / value name are parameters so tests can use a throwaway key instead of the real one.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const winpaths = require('./winpaths');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE = 'ClaudeNotifier';

function reg(args) { const r = spawnSync(winpaths.regExe(), args, { encoding: 'utf8', windowsHide: true }); return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }; }

function command(vbs = path.join(__dirname, 'Claude-Notifier.vbs')) { return `wscript.exe "${vbs}"`; }

function status({ key = RUN_KEY, value = VALUE } = {}) {
  const r = reg(['query', key, '/v', value]);
  if (r.code !== 0) return { enabled: false, command: null };
  const m = new RegExp(`${value}\\s+REG_SZ\\s+(.*)`, 'i').exec(r.out);
  return { enabled: true, command: m ? m[1].trim() : null };
}
function enable({ key = RUN_KEY, value = VALUE, vbs } = {}) {
  const r = reg(['add', key, '/v', value, '/t', 'REG_SZ', '/d', command(vbs), '/f']);
  return { ok: r.code === 0, error: r.code === 0 ? null : (r.err || r.out).trim() };
}
function disable({ key = RUN_KEY, value = VALUE } = {}) {
  const r = reg(['delete', key, '/v', value, '/f']);
  return { ok: r.code === 0 || /unable to find/i.test(r.err + r.out), error: null };
}

module.exports = { status, enable, disable, command, RUN_KEY, VALUE };
