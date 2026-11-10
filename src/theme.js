'use strict';
/**
 * theme.js -- the appearance preference and the Windows theme detection (Task 4, stage 1). No UI code in here.
 *
 *   preference  : settings.json key `appearance` = 'system' (default) | 'light' | 'dark'. Anything else (missing, misspelt, wrong type,
 *                 a corrupt file) means 'system'; an unusable stored value is never "repaired" by writing it back.
 *   detection   : HKCU\...\Themes\Personalize\AppsUseLightTheme (0 = dark, 1 = light; the apps setting, not the taskbar one) and
 *                 HKCU\Control Panel\Accessibility\HighContrast\Flags (bit 0 = High Contrast on), read with the full path of reg.exe
 *                 (winpaths.js). Every failure falls back to LIGHT / not high contrast (the Windows defaults), never throws.
 *   resolution  : High Contrast always wins ('contrast': the UI uses plain system colours), then an explicit Light / Dark, then the
 *                 detected system theme.
 *
 * The only thing this module ever writes is the single `appearance` key, through the Store (the notifier is the single writer).
 * It does not read or write ntfy.json, phoneEnabled, phoneSetup or any other setting.
 */
const { spawnSync, execFile } = require('child_process');
const winpaths = require('./winpaths');

const APPEARANCES = Object.freeze(['system', 'light', 'dark']);
const DEFAULT_APPEARANCE = 'system';
const SETTING = 'appearance';

const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const HIGH_CONTRAST_KEY = 'HKCU\\Control Panel\\Accessibility\\HighContrast';

/** a stored/typed value -> a valid preference; case and surrounding blanks are tolerated, anything else is 'system' */
function normalizeAppearance(v) {
  if (typeof v !== 'string') return DEFAULT_APPEARANCE;
  const s = v.trim().toLowerCase();
  return APPEARANCES.includes(s) ? s : DEFAULT_APPEARANCE;
}
const isValidAppearance = (v) => typeof v === 'string' && APPEARANCES.includes(v);

/** the effective preference of a Store (never throws, never writes) */
function getAppearance(store) {
  try { return normalizeAppearance(store && store.settings && store.settings[SETTING]); } catch { return DEFAULT_APPEARANCE; }
}

/**
 * Choose a preference. Only the exact values 'system' | 'light' | 'dark' are accepted; anything else is refused and nothing is
 * written. An unchanged value does not touch the file. Returns { ok, changed, appearance }.
 */
function setAppearance(store, value) {
  if (!isValidAppearance(value)) return { ok: false, changed: false, appearance: getAppearance(store) };
  if (store.settings[SETTING] === value) return { ok: true, changed: false, appearance: value };
  store.setSetting(SETTING, value);
  return { ok: true, changed: true, appearance: value };
}

// ---------- reading Windows ----------
/** same as queryRegistry, without blocking the event loop: resolves with the text, or null */
function queryRegistryAsync(key, name, { env = process.env, timeoutMs = 3000, run = execFile } = {}) {
  return new Promise((resolve) => {
    try { run(winpaths.regExe(env), ['query', key, '/v', name], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || ''))); }
    catch { resolve(null); }
  });
}

/** `reg query <key> /v <name>` -> the raw text, or null (key / value missing, timeout, no reg.exe) */
function queryRegistry(key, name, { env = process.env, timeoutMs = 3000, run = spawnSync } = {}) {
  try {
    const r = run(winpaths.regExe(env), ['query', key, '/v', name], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (!r || r.error || r.status !== 0) return null;
    return String(r.stdout || '');
  } catch { return null; }
}

/** REG_DWORD AppsUseLightTheme text -> true (light) | false (dark) | null (not readable) */
function parseAppsUseLightTheme(text) {
  const m = /AppsUseLightTheme\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n !== 0 : null;
}
/** REG_SZ Flags text (a decimal string) -> true | false | null. Bit 0 (HCF_HIGHCONTRASTON) is set while High Contrast is on. */
function parseHighContrastFlags(text) {
  const m = /\bFlags\s+REG_SZ\s+(\d+)/i.exec(String(text || ''));
  if (!m) return null;
  return (Number(m[1]) & 1) === 1;
}

/**
 * What Windows is set to right now. `read(key, name)` is injectable for tests.
 * @returns {{ systemLight: boolean, highContrast: boolean, source: 'registry'|'default' }}
 */
function detectSystem({ read = (k, n) => queryRegistry(k, n) } = {}) {
  let light = null; let hc = null;
  try { light = parseAppsUseLightTheme(read(PERSONALIZE_KEY, 'AppsUseLightTheme')); } catch { light = null; }
  try { hc = parseHighContrastFlags(read(HIGH_CONTRAST_KEY, 'Flags')); } catch { hc = null; }
  return { systemLight: light === null ? true : light, highContrast: hc === true, source: light === null ? 'default' : 'registry' };
}

/** the same as detectSystem(), asynchronous (used by the running notifier to follow Windows without blocking) */
async function detectSystemAsync({ read = (k, n) => queryRegistryAsync(k, n) } = {}) {
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => read(PERSONALIZE_KEY, 'AppsUseLightTheme')).catch(() => null),
    Promise.resolve().then(() => read(HIGH_CONTRAST_KEY, 'Flags')).catch(() => null),
  ]);
  let light = null; let hc = null;
  try { light = parseAppsUseLightTheme(a); } catch { light = null; }
  try { hc = parseHighContrastFlags(b); } catch { hc = null; }
  return { systemLight: light === null ? true : light, highContrast: hc === true, source: light === null ? 'default' : 'registry' };
}
/** a named system state ('light' | 'dark' | 'contrast') for tests; null for anything else */
function systemFromName(n) {
  if (n === 'light') return { systemLight: true, highContrast: false, source: 'override' };
  if (n === 'dark') return { systemLight: false, highContrast: false, source: 'override' };
  if (n === 'contrast') return { systemLight: true, highContrast: true, source: 'override' };
  return null;
}

/**
 * The theme the UI must show.
 * @param {string} appearance the stored preference (validated here)
 * @param {{systemLight:boolean, highContrast:boolean}} system from detectSystem()
 * @returns {{ appearance: string, mode: 'light'|'dark'|'contrast', highContrast: boolean }}
 */
function resolveTheme(appearance, system) {
  const pref = normalizeAppearance(appearance);
  const sys = system || { systemLight: true, highContrast: false };
  const highContrast = !!sys.highContrast;
  let mode;
  if (highContrast) mode = 'contrast';                 // accessibility wins over any preference
  else if (pref === 'light') mode = 'light';
  else if (pref === 'dark') mode = 'dark';
  else mode = sys.systemLight === false ? 'dark' : 'light';
  return { appearance: pref, mode, highContrast };
}

/** convenience: the resolved theme for a store and (optionally injected) detection */
function currentTheme(store, detect = detectSystem) {
  let sys; try { sys = detect(); } catch { sys = null; }
  return resolveTheme(getAppearance(store), sys);
}

/** the same theme twice? (used to avoid re-theming the UI when nothing changed) */
const sameTheme = (a, b) => !!a && !!b && a.mode === b.mode && a.appearance === b.appearance && a.highContrast === b.highContrast;

module.exports = {
  APPEARANCES, DEFAULT_APPEARANCE, SETTING, PERSONALIZE_KEY, HIGH_CONTRAST_KEY,
  normalizeAppearance, isValidAppearance, getAppearance, setAppearance,
  queryRegistry, queryRegistryAsync, parseAppsUseLightTheme, parseHighContrastFlags, detectSystem, detectSystemAsync, systemFromName, resolveTheme, currentTheme, sameTheme,
};
