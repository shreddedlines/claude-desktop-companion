#!/usr/bin/env node
/**
 * test-step15.js -- Task 4 (dark mode), stage 1: the appearance setting and the Windows theme detection (theme.js).
 * Proves: default / persistence / fallback of the preference, that choosing a theme changes ONLY the `appearance` key (ntfy.json and
 * every other setting stay byte-identical), that existing installations keep their settings, the registry parsing, the resolution
 * matrix (High Contrast always wins) and that detection never throws and never depends on PATH.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Store } = require('./store');
const theme = require('./theme');
const winpaths = require('./winpaths');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`); };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'theme15-'));
let n = 0;
const newDir = () => { const d = path.join(ROOT, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const read = (f) => fs.readFileSync(f, 'utf8');
const quiet = (d) => { const s = new Store(d); return s; };
const settingsOf = (d) => JSON.parse(read(path.join(d, 'settings.json')));

// ---- 1. normalisation ----
check('the default preference is "system"', theme.DEFAULT_APPEARANCE === 'system' && theme.APPEARANCES.join() === 'system,light,dark');
for (const [v, want] of [['system', 'system'], ['light', 'light'], ['dark', 'dark'], ['Dark', 'dark'], [' LIGHT ', 'light'], ['purple', 'system'], ['', 'system'], [null, 'system'], [undefined, 'system'], [1, 'system'], [{}, 'system'], [['dark'], 'system'], [true, 'system']]) {
  check(`normalizeAppearance(${JSON.stringify(v)}) = ${want}`, theme.normalizeAppearance(v) === want);
}
check('only the exact values are valid for choosing ("Dark" and " dark" are not)', theme.isValidAppearance('dark') && !theme.isValidAppearance('Dark') && !theme.isValidAppearance(' dark') && !theme.isValidAppearance(null));

// ---- 2. new installation ----
{
  const d = newDir(); const s = quiet(d);
  check('NEW installation: the store default is appearance "system"', s.settings.appearance === 'system' && theme.getAppearance(s) === 'system');
  check('...reading the preference does not create or write settings.json', !fs.existsSync(path.join(d, 'settings.json')));
  s.close();
}

// ---- 3. existing installation (settings.json written by an older version, no `appearance` key) ----
{
  const d = newDir();
  const old = { notificationsEnabled: false, soundsEnabled: true, phoneEnabled: true, phoneSetup: { state: 'confirmed', confirmedAt: 1700000000000 }, someFutureKey: { a: [1, 2] } };
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(old, null, 2));
  const ntfyText = '{\n  "server": "https://ntfy.sh",\n  "topic": "claude-demo",\n  "priorityTurn": 4\n}\n';
  fs.writeFileSync(path.join(d, 'ntfy.json'), ntfyText);
  const before = read(path.join(d, 'settings.json'));
  const s = quiet(d);
  check('EXISTING installation: appearance defaults to "system" and every old value is kept', theme.getAppearance(s) === 'system' && s.settings.phoneEnabled === true && s.settings.notificationsEnabled === false && s.settings.phoneSetup.state === 'confirmed');
  check('...loading it did not rewrite settings.json', read(path.join(d, 'settings.json')) === before);
  const r = theme.setAppearance(s, 'dark');
  const after = settingsOf(d);
  check('choosing Dark succeeds and reports a change', r.ok && r.changed && r.appearance === 'dark');
  const { appearance, ...rest } = after;
  check('...the file now has appearance "dark" and ALL other keys exactly as before (including unknown future keys)', appearance === 'dark' && JSON.stringify(rest) === JSON.stringify(old));
  check('...ntfy.json is byte-identical', read(path.join(d, 'ntfy.json')) === ntfyText);
  s.close();
  const s2 = quiet(d);
  check('...a restart (new Store) still has "dark"', theme.getAppearance(s2) === 'dark' && s2.settings.phoneEnabled === true);
  s2.close();
}

// ---- 4. all three modes: only `appearance` changes; ntfy.json and phone state untouched ----
{
  const d = newDir();
  const base = { notificationsEnabled: true, soundsEnabled: false, phoneEnabled: true, phoneSetup: { state: 'confirmed' }, usageNote: 'x' };
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(base, null, 2));
  const ntfyText = JSON.stringify({ server: 'https://ntfy.sh', topic: 'claude-demo', token: null, priorityAttention: 5 }, null, 2);
  const ntfyPath = path.join(d, 'ntfy.json'); fs.writeFileSync(ntfyPath, ntfyText);
  const mtime0 = fs.statSync(ntfyPath).mtimeMs;
  const s = quiet(d);
  let ok = true; const seq = ['dark', 'light', 'system', 'dark', 'system', 'light'];
  for (const v of seq) {
    const r = theme.setAppearance(s, v);
    const cur = settingsOf(d); const { appearance, ...rest } = cur;
    const same = JSON.stringify(rest) === JSON.stringify(base) && appearance === v && read(ntfyPath) === ntfyText && fs.statSync(ntfyPath).mtimeMs === mtime0 && r.ok && theme.getAppearance(s) === v;
    if (!same) { ok = false; console.log('   mismatch at', v, JSON.stringify(cur)); }
  }
  check('switching System -> Dark -> Light -> ... (6 changes): phoneEnabled, phoneSetup, notification / sound settings and unknown keys unchanged', ok);
  check('...ntfy.json content AND modification time never change', read(ntfyPath) === ntfyText && fs.statSync(ntfyPath).mtimeMs === mtime0);
  const before = read(path.join(d, 'settings.json'));
  const same = theme.setAppearance(s, theme.getAppearance(s));
  check('choosing the value already in use is a no-op (reported unchanged, file untouched)', same.ok && !same.changed && read(path.join(d, 'settings.json')) === before);
  for (const bad of ['Dark', 'purple', '', null, undefined, 3, {}, 'system ']) {
    const r = theme.setAppearance(s, bad);
    if (r.ok || read(path.join(d, 'settings.json')) !== before) ok = false;
  }
  check('invalid choices (wrong case, unknown word, empty, null, number, object) are refused and nothing is written', ok && read(path.join(d, 'settings.json')) === before);
  s.close();
}

// ---- 5. fallback: bad stored values / corrupt file ----
for (const bad of ['purple', 5, null, ['dark'], { a: 1 }, '']) {
  const d = newDir(); const text = JSON.stringify({ phoneEnabled: true, appearance: bad }, null, 2);
  fs.writeFileSync(path.join(d, 'settings.json'), text);
  const s = quiet(d);
  check(`stored appearance ${JSON.stringify(bad)} behaves as "system", the file is not "repaired" by reading, phone state kept`, theme.getAppearance(s) === 'system' && read(path.join(d, 'settings.json')) === text && s.settings.phoneEnabled === true);
  s.close();
}
{
  const d = newDir(); const junk = '{ this is not json';
  fs.writeFileSync(path.join(d, 'settings.json'), junk);
  const s = quiet(d);
  check('CORRUPT settings.json: the preference is "system" and reading does not overwrite the file', theme.getAppearance(s) === 'system' && read(path.join(d, 'settings.json')) === junk);
  s.close();
}
check('getAppearance tolerates a missing store / settings', theme.getAppearance(null) === 'system' && theme.getAppearance({}) === 'system' && theme.getAppearance({ settings: null }) === 'system');

// ---- 6. registry parsing (samples are the exact reg.exe output format) ----
const dword = (name, v) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    ${name}    REG_DWORD    ${v}\r\n\r\n`;
check('AppsUseLightTheme 0x0 => dark', theme.parseAppsUseLightTheme(dword('AppsUseLightTheme', '0x0')) === false);
check('AppsUseLightTheme 0x1 => light', theme.parseAppsUseLightTheme(dword('AppsUseLightTheme', '0x1')) === true);
check('AppsUseLightTheme is not confused with SystemUsesLightTheme', theme.parseAppsUseLightTheme(dword('SystemUsesLightTheme', '0x0')) === null);
for (const t of ['', null, undefined, 'ERROR: The system was unable to find the specified registry key or value.', '    AppsUseLightTheme    REG_SZ    0', '    AppsUseLightTheme    REG_DWORD    banana']) {
  check(`unreadable AppsUseLightTheme text (${JSON.stringify(t)}) => null`, theme.parseAppsUseLightTheme(t) === null);
}
const flags = (v) => `\r\nHKEY_CURRENT_USER\\Control Panel\\Accessibility\\HighContrast\r\n    Flags    REG_SZ    ${v}\r\n\r\n`;
check('HighContrast Flags "4194" (off, typical default) => false', theme.parseHighContrastFlags(flags('4194')) === false);
check('HighContrast Flags "4195" / "1" / "127" (bit 0 set) => true', theme.parseHighContrastFlags(flags('4195')) === true && theme.parseHighContrastFlags(flags('1')) === true && theme.parseHighContrastFlags(flags('127')) === true);
check('HighContrast Flags unreadable => null', theme.parseHighContrastFlags('') === null && theme.parseHighContrastFlags('ERROR: x') === null && theme.parseHighContrastFlags(null) === null);

// ---- 7. detectSystem with injected readers ----
const rd = (light, fl) => (key, name) => (name === 'AppsUseLightTheme' ? light : fl);
let d1 = theme.detectSystem({ read: rd(dword('AppsUseLightTheme', '0x0'), flags('4194')) });
check('detect: dark apps theme, no high contrast', d1.systemLight === false && d1.highContrast === false && d1.source === 'registry');
d1 = theme.detectSystem({ read: rd(dword('AppsUseLightTheme', '0x1'), flags('4194')) });
check('detect: light apps theme', d1.systemLight === true && d1.source === 'registry');
d1 = theme.detectSystem({ read: rd(dword('AppsUseLightTheme', '0x0'), flags('4195')) });
check('detect: high contrast reported', d1.highContrast === true && d1.systemLight === false);
d1 = theme.detectSystem({ read: () => null });
check('detect: nothing readable => light, no high contrast, source "default"', d1.systemLight === true && d1.highContrast === false && d1.source === 'default');
d1 = theme.detectSystem({ read: () => { throw new Error('boom'); } });
check('detect: a throwing reader never throws out (falls back to light)', d1.systemLight === true && d1.highContrast === false && d1.source === 'default');
d1 = theme.detectSystem({ read: rd(null, flags('4195')) });
check('detect: high contrast is still honoured when the theme value is missing', d1.highContrast === true && d1.systemLight === true);

// ---- 8. resolution matrix ----
let m = true; const rows = [];
for (const pref of ['system', 'light', 'dark']) for (const light of [true, false]) for (const hc of [false, true]) {
  const r = theme.resolveTheme(pref, { systemLight: light, highContrast: hc });
  const want = hc ? 'contrast' : pref === 'light' ? 'light' : pref === 'dark' ? 'dark' : (light ? 'light' : 'dark');
  if (r.mode !== want || r.appearance !== pref || r.highContrast !== hc) { m = false; rows.push(`${pref}/${light}/${hc}->${r.mode}`); }
}
check('all 12 combinations of preference x system theme x high contrast resolve correctly (High Contrast always wins)', m, rows.join(' '));
check('an invalid preference resolves like "system"', theme.resolveTheme('???', { systemLight: false, highContrast: false }).mode === 'dark' && theme.resolveTheme('???', { systemLight: false, highContrast: false }).appearance === 'system');
check('missing detection result resolves to light', theme.resolveTheme('system', null).mode === 'light' && theme.resolveTheme('dark', undefined).mode === 'dark');
{
  const d = newDir(); const s = quiet(d);
  const dark = () => ({ systemLight: false, highContrast: false, source: 'registry' });
  check('currentTheme(): default preference follows the system', theme.currentTheme(s, dark).mode === 'dark' && theme.currentTheme(s, () => ({ systemLight: true, highContrast: false })).mode === 'light');
  theme.setAppearance(s, 'light');
  check('currentTheme(): Light stays light on a dark system', theme.currentTheme(s, dark).mode === 'light');
  check('currentTheme(): a throwing detector falls back instead of crashing', theme.currentTheme(s, () => { throw new Error('x'); }).mode === 'light');
  check('sameTheme distinguishes mode / preference / contrast', theme.sameTheme(theme.resolveTheme('dark', null), theme.resolveTheme('dark', null)) && !theme.sameTheme(theme.resolveTheme('dark', null), theme.resolveTheme('light', null)) && !theme.sameTheme(theme.resolveTheme('system', { systemLight: false }), theme.resolveTheme('dark', null)) && !theme.sameTheme(null, null));
  s.close();
}

// ---- 9. the real Windows registry (this machine) ----
{
  const direct = spawnSync(winpaths.regExe(), ['query', theme.PERSONALIZE_KEY, '/v', 'AppsUseLightTheme'], { encoding: 'utf8' });
  const want = /AppsUseLightTheme\s+REG_DWORD\s+0x0+\b(?!\w)/i.test(direct.stdout || '') ? false : (/REG_DWORD\s+0x[0-9a-f]*[1-9a-f]/i.test(direct.stdout || '') ? true : null);
  const real = theme.detectSystem();
  check(`REAL registry: detection agrees with a direct reg.exe query (apps theme is ${want === null ? 'unreadable' : want ? 'light' : 'dark'} on this PC)`, want === null ? real.source === 'default' : real.systemLight === want && real.source === 'registry', JSON.stringify(real));
  const calls = [];
  theme.queryRegistry(theme.PERSONALIZE_KEY, 'AppsUseLightTheme', { env: { SystemRoot: 'C:\\Windows', PATH: '' }, run: (exe, args, opt) => { calls.push({ exe, args, opt }); return { status: 0, stdout: dword('AppsUseLightTheme', '0x1') }; } });
  check('reg.exe is started by its full System32 path (not found through PATH), with a timeout and no window', calls.length === 1 && path.isAbsolute(calls[0].exe) && /System32[\\/]reg\.exe$/i.test(calls[0].exe) && calls[0].opt.timeout > 0 && calls[0].opt.windowsHide === true);
  check('...a failing / timing-out / throwing reg.exe gives null instead of an error', theme.queryRegistry('K', 'v', { run: () => ({ status: 1, stdout: '' }) }) === null && theme.queryRegistry('K', 'v', { run: () => ({ error: new Error('ETIMEDOUT') }) }) === null && theme.queryRegistry('K', 'v', { run: () => { throw new Error('x'); } }) === null);
  const real2 = theme.detectSystem({ read: (k, nme) => theme.queryRegistry(k, nme, { env: { SystemRoot: 'Z:\\nope', PATH: '' } }) });
  check('...with a bogus SystemRoot and an empty PATH the real query still works (falls back to C:\\Windows)', real2.systemLight === real.systemLight && real2.source === real.source);
}

// ---- 10. the module's boundaries (static) ----
{
  const src = read(path.join(__dirname, 'theme.js'));
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((x) => x[1]);
  check('theme.js depends only on child_process and winpaths (no ntfy, onboarding, devhooks or UI code)', requires.sort().join() === 'child_process,winpaths'.split(',').sort().join() || requires.sort().join() === ['./winpaths', 'child_process'].sort().join(), requires.join());
  check('theme.js writes through the store only, and only the single `appearance` key', !/writeFile|appendFile|renameSync|unlinkSync/.test(src) && (src.match(/setSetting\(/g) || []).length === 1 && /store\.setSetting\(SETTING,/.test(src));
  check('theme.js contains no development-only control and no topic-shaped string', !/--[a-z]+-[a-z-]+|NOTIFIER_TEST|claude-[a-hj-km-np-z2-9]{16}/.test(src.replace(/--[a-z]+ /g, '')));
}

fs.rmSync(ROOT, { recursive: true, force: true });
const pass = results.filter(Boolean).length;
console.log(`\nstep15: ${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
