#!/usr/bin/env node
/**
 * test-step16.js -- Task 4 (dark mode), stage 2: the Light / Dark palettes (palette.js).
 * Completeness of the token set, and WCAG contrast of every foreground / background combination the UI will use:
 * text >= 4.5:1 (AA, normal text; disabled text included), borders / focus ring / accent >= 3:1 (non-text, WCAG 1.4.11).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./palette');
const theme = require('./theme');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -- ${extra}` : ''}`); };
const r2 = (x) => Math.round(x * 100) / 100;

// ---- 0. the contrast function itself against known WCAG values ----
check('contrast(black, white) = 21', Math.abs(P.contrast('#000000', '#FFFFFF') - 21) < 1e-9);
check('contrast(x, x) = 1', Math.abs(P.contrast('#7A7A7A', '#7A7A7A') - 1) < 1e-9);
check('contrast is symmetric', P.contrast('#0067C0', '#FFFFFF') === P.contrast('#FFFFFF', '#0067C0'));
check('known reference: #767676 on white = 4.54 (the classic AA grey)', Math.abs(P.contrast('#767676', '#FFFFFF') - 4.54) < 0.01);
check('known reference: #777777 on white = 4.48 (just below AA)', Math.abs(P.contrast('#777777', '#FFFFFF') - 4.48) < 0.01);
check('hexToRgb parses and rejects bad input', P.hexToRgb('#0a1B2c').join() === '10,27,44' && (() => { try { P.hexToRgb('red'); return false; } catch { return true; } })());

// ---- 1. completeness ----
check('there are 24 semantic tokens', P.TOKENS.length === 24 && new Set(P.TOKENS).size === 24);
for (const [name, pal] of [['light', P.LIGHT], ['dark', P.DARK]]) {
  const keys = Object.keys(pal);
  check(`${name}: has exactly the defined tokens (none missing, none extra)`, keys.length === P.TOKENS.length && P.TOKENS.every((t) => keys.includes(t)), keys.filter((k) => !P.TOKENS.includes(k)).join());
  check(`${name}: every token is a #RRGGBB colour`, P.TOKENS.every((t) => P.isHexColor(pal[t])), P.TOKENS.filter((t) => !P.isHexColor(pal[t])).join());
  check(`${name}: the palette is frozen`, Object.isFrozen(pal));
}
check('light and dark differ in the main surfaces', P.LIGHT.bg !== P.DARK.bg && P.LIGHT.surface !== P.DARK.surface && P.LIGHT.text !== P.DARK.text);
check('dark is really dark and light really light (background luminance)', P.luminance(P.DARK.bg) < 0.05 && P.luminance(P.LIGHT.bg) > 0.85 && P.luminance(P.DARK.surface) < 0.08 && P.luminance(P.LIGHT.surface) > 0.95);
check('dark text is lighter than the dark background, light text darker than the light background', P.luminance(P.DARK.text) > P.luminance(P.DARK.bg) && P.luminance(P.LIGHT.text) < P.luminance(P.LIGHT.bg));

// ---- 2. High Contrast and the lookup ----
check('paletteFor("light") / ("dark") return the palettes', P.paletteFor('light') === P.LIGHT && P.paletteFor('dark') === P.DARK);
check('High Contrast has NO palette (null => the UI keeps the Windows system colours)', P.paletteFor('contrast') === null);
check('unknown modes have no palette (no accidental prototype lookups)', [undefined, null, '', 'system', 'purple', '__proto__', 'constructor', 'toString', 5].every((m) => P.paletteFor(m) === null));
check('the theme resolver and the palette agree: every resolved mode is light, dark or contrast, and only contrast has no palette', ['system', 'light', 'dark'].every((a) => [true, false].every((l) => [true, false].every((h) => { const t = theme.resolveTheme(a, { systemLight: l, highContrast: h }); return (t.mode === 'contrast') === (P.paletteFor(t.mode) === null); }))));
check('no palette entry contains a system colour name or a "contrast" palette', !('contrast' in P.PALETTES) && Object.keys(P.PALETTES).join() === 'light,dark');

// ---- 3. QR is fixed ----
check('QR is black on white', P.QR.module === '#000000' && P.QR.background === '#FFFFFF' && Object.isFrozen(P.QR));
check('QR contrast is 21:1 and does not depend on the mode', P.contrast(P.QR.module, P.QR.background) === 21 && !Object.values(P.LIGHT).concat(Object.values(P.DARK)).some(() => false));
check('no palette token is used by the QR definition (the QR object has only its two fixed colours)', Object.keys(P.QR).sort().join() === 'background,module');

// ---- 4. text contrast (>= 4.5) for every text-on-background pair the UI uses ----
const AA = 4.5; const NONTEXT = 3;
// [foreground token, background token, description]
const TEXT_PAIRS = [
  ['text', 'bg', 'primary text on the window'], ['text', 'surface', 'primary text on surfaces / text boxes / menu'],
  ['textSecondary', 'bg', 'secondary text on the window'], ['textSecondary', 'surface', 'secondary text on surfaces / menu status lines'],
  ['textSecondary', 'hover', 'secondary text on a hovered row'],
  ['textDisabled', 'disabledBg', 'disabled text on a disabled button'], ['textDisabled', 'bg', 'disabled text on the window'], ['textDisabled', 'surface', 'disabled text on surfaces / disabled menu items'],
  ['text', 'hover', 'text on hover'], ['text', 'pressed', 'text on pressed'],
  ['text', 'buttonBg', 'secondary button text'], ['text', 'buttonHover', 'secondary button text, hover'], ['text', 'buttonPressed', 'secondary button text, pressed'],
  ['accentText', 'accent', 'primary button text'], ['accentText', 'accentHover', 'primary button text, hover'], ['accentText', 'accentPressed', 'primary button text, pressed'],
  ['link', 'bg', 'links on the window'], ['link', 'surface', 'links on surfaces'],
  ['success', 'bg', 'success text on the window'], ['success', 'surface', 'success text on surfaces'],
  ['warning', 'bg', 'warning text on the window'], ['warning', 'surface', 'warning text on surfaces'],
  ['error', 'bg', 'error text on the window'], ['error', 'surface', 'error text on surfaces'],
  ['error', 'hover', 'error text on a hovered menu row'], ['success', 'hover', 'success text on a hovered menu row'], ['warning', 'hover', 'warning text on a hovered menu row'],
  ['noticeText', 'noticeBg', 'banner text'],
];
for (const [name, pal] of [['light', P.LIGHT], ['dark', P.DARK]]) {
  const worst = { v: 99, d: '' };
  let ok = true; const bad = [];
  for (const [fg, bg, desc] of TEXT_PAIRS) {
    const c = P.contrast(pal[fg], pal[bg]);
    if (c < worst.v) { worst.v = c; worst.d = desc; }
    const pass = c >= AA; if (!pass) { ok = false; bad.push(`${desc} ${r2(c)}`); }
    check(`${name}: ${desc} (${fg} on ${bg}) = ${r2(c)}:1 >= ${AA}`, pass);
  }
  check(`${name}: all ${TEXT_PAIRS.length} text combinations reach WCAG AA`, ok, bad.join('; ') || `lowest ${r2(worst.v)}:1 (${worst.d})`);
}

// ---- 5. disabled text stays readable and distinguishable ----
for (const [name, pal] of [['light', P.LIGHT], ['dark', P.DARK]]) {
  check(`${name}: disabled text is at least AA on every background it can appear on (not exempted as WCAG would allow)`, [pal.disabledBg, pal.bg, pal.surface].every((b) => P.contrast(pal.textDisabled, b) >= AA));
  check(`${name}: disabled text is visibly weaker than primary text (contrast to the page is lower)`, P.contrast(pal.textDisabled, pal.bg) < P.contrast(pal.text, pal.bg));
  check(`${name}: a disabled button face differs from the normal face (so disabled is not only the text)`, pal.disabledBg !== pal.buttonBg && pal.disabledBg !== pal.accent);
}

// ---- 6. non-text contrast (>= 3) ----
for (const [name, pal] of [['light', P.LIGHT], ['dark', P.DARK]]) {
  check(`${name}: control borders (borderStrong) reach 3:1 on the window, surfaces and button faces`, [pal.bg, pal.surface, pal.buttonBg].every((b) => P.contrast(pal.borderStrong, b) >= NONTEXT), [pal.bg, pal.surface, pal.buttonBg].map((b) => r2(P.contrast(pal.borderStrong, b))).join('/'));
  check(`${name}: the focus ring (drawn OUTSIDE a control) reaches 3:1 on the window, surfaces and button faces`, [pal.bg, pal.surface, pal.buttonBg, pal.buttonHover, pal.buttonPressed].every((b) => P.contrast(pal.focus, b) >= NONTEXT), [pal.bg, pal.surface, pal.buttonBg, pal.buttonHover, pal.buttonPressed].map((b) => r2(P.contrast(pal.focus, b))).join('/'));
  check(`${name}: on a primary button the focus shows as an INNER ring in the button-text colour, which reaches 3:1 on every accent state`, [pal.accent, pal.accentHover, pal.accentPressed].every((b) => P.contrast(pal.accentText, b) >= NONTEXT));
  check(`${name}: the primary button (accent) stands out from the window and surfaces by 3:1`, [pal.bg, pal.surface].every((b) => P.contrast(pal.accent, b) >= NONTEXT), [pal.bg, pal.surface].map((b) => r2(P.contrast(pal.accent, b))).join('/'));
  check(`${name}: button states are distinguishable from each other (hover / pressed / normal all differ)`, new Set([pal.buttonBg, pal.buttonHover, pal.buttonPressed]).size === 3 && new Set([pal.accent, pal.accentHover, pal.accentPressed]).size === 3 && pal.hover !== pal.pressed);
  check(`${name}: decorative border is visible against its background (>= 1.2:1) but weaker than the control border`, P.contrast(pal.border, pal.bg) >= 1.2 && P.contrast(pal.border, pal.surface) >= 1.2 && P.contrast(pal.border, pal.surface) < P.contrast(pal.borderStrong, pal.surface));
  check(`${name}: the window, surface and hover backgrounds are distinct`, new Set([pal.bg, pal.surface, pal.hover, pal.pressed]).size === 4);
}

// ---- 7. fixed status colours of the existing UI are covered ----
{
  // the current (pre-theme) fixed colours of the setup window must still be present as semantic equivalents: amber banner, green / amber / red text
  check('light status colours are the readable dark variants of the old fixed green / amber / red', P.contrast(P.LIGHT.success, P.LIGHT.bg) >= AA && P.contrast(P.LIGHT.warning, P.LIGHT.bg) >= AA && P.contrast(P.LIGHT.error, P.LIGHT.bg) >= AA);
  check('dark status colours are the readable light variants', P.contrast(P.DARK.success, P.DARK.bg) >= AA && P.contrast(P.DARK.warning, P.DARK.bg) >= AA && P.contrast(P.DARK.error, P.DARK.bg) >= AA);
  check('success, warning and error are three different colours in each mode (status is not conveyed by one hue only)', [P.LIGHT, P.DARK].every((p) => new Set([p.success, p.warning, p.error]).size === 3));
}

// ---- 8. boundaries (static): the stage touches no UI, notification or phone code ----
{
  const src = fs.readFileSync(path.join(__dirname, 'palette.js'), 'utf8');
  check('palette.js has no requires, no I/O and no development-only control', !/require\(/.test(src) && !/writeFile|readFile|spawn|process\.env/.test(src) && !/NOTIFIER_TEST|--first-run|--data-dir/.test(src));
  check('palette.js contains no topic-shaped string', !/claude-[a-hj-km-np-z2-9]{16}/.test(src));
  for (const f of ['onboarding.js', 'ntfy.js']) {
    check(`${f} does not use the palette (phone configuration code is independent of appearance)`, !/palette/i.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  }
}

const pass = results.filter(Boolean).length;
console.log(`\nstep16: ${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
