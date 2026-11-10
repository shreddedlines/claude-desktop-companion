'use strict';
/**
 * winpaths.js — full paths of the Windows system programs this application starts, so none of them is found through PATH
 * (a PATH without the PowerShell folder must not break the app, and a PATH entry must not be able to substitute a program).
 * Only the standard %SystemRoot% / %windir% variables are consulted, and they are validated: an absolute path to a folder that
 * contains System32. Anything else falls back to C:\Windows.
 */
const fs = require('fs');
const path = require('path');

function systemRoot(env = process.env) {
  for (const v of [env.SystemRoot, env.windir, env.WINDIR]) if (v && path.isAbsolute(v) && fs.existsSync(path.join(v, 'System32'))) return path.resolve(v);
  return 'C:\\Windows';
}
const system32 = (name, env) => path.join(systemRoot(env), 'System32', name);

module.exports = {
  systemRoot,
  powershellExe: (env) => path.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  regExe: (env) => system32('reg.exe', env),
  tasklistExe: (env) => system32('tasklist.exe', env),
  explorerExe: (env) => path.join(systemRoot(env), 'explorer.exe'),
};
