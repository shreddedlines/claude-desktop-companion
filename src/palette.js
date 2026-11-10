'use strict';
/**
 * palette.js -- the colour tokens of the Light and Dark appearance (Task 4, stage 2). Data and pure functions only: no UI code, no I/O.
 *
 * The values follow the Windows 11 look (neutral greys, a blue accent, Segoe UI) and are checked by test-step16.js: every text token
 * against every background it can appear on reaches WCAG AA (>= 4.5:1, DISABLED TEXT INCLUDED, which WCAG itself would exempt), and
 * borders / focus rings / the accent reach 3:1 for non-text contrast.
 *
 * High Contrast is NOT a palette: paletteFor('contrast') is null, which tells the UI to keep the plain Windows system colours.
 * QR codes are NOT themed: QR is a fixed black-on-white pair in every mode (scanners need that contrast).
 */

/**
 * token meaning
 *   bg            window / page background            surface        cards, text boxes, menu background
 *   text          primary text                         textSecondary  hints, status lines, captions
 *   textDisabled  text of disabled controls (on disabledBg or on bg/surface)
 *   border        decorative dividers, separators      borderStrong   boundaries of controls (>= 3:1)
 *   accent        primary button, selected state       accentText     text on accent*       accentHover / accentPressed
 *   link          hyperlinks                           focus          keyboard focus ring (>= 3:1)
 *   hover/pressed neutral hover / pressed backgrounds (menu items, secondary buttons)
 *   buttonBg      secondary button face (+ buttonHover / buttonPressed)       disabledBg  face of disabled controls
 *   success / warning / error  status text colours (on bg and surface)
 *   noticeBg / noticeText      the amber banner at the top of the window
 */
const TOKENS = Object.freeze([
  'bg', 'surface', 'text', 'textSecondary', 'textDisabled', 'border', 'borderStrong',
  'accent', 'accentText', 'accentHover', 'accentPressed', 'link', 'focus',
  'hover', 'pressed', 'buttonBg', 'buttonHover', 'buttonPressed', 'disabledBg',
  'success', 'warning', 'error', 'noticeBg', 'noticeText',
]);

const LIGHT = Object.freeze({
  bg: '#F3F3F3', surface: '#FFFFFF',
  text: '#1A1A1A', textSecondary: '#5A5A5A', textDisabled: '#666666',
  border: '#D6D6D6', borderStrong: '#8A8A8A',
  accent: '#0067C0', accentText: '#FFFFFF', accentHover: '#005AA6', accentPressed: '#004C8C',
  link: '#0063B1', focus: '#005A9E',
  hover: '#E8E8E8', pressed: '#DCDCDC',
  buttonBg: '#FDFDFD', buttonHover: '#F0F0F0', buttonPressed: '#E4E4E4', disabledBg: '#EDEDED',
  success: '#0F6B0F', warning: '#9A4A00', error: '#B3261E',
  noticeBg: '#FEF3C7', noticeText: '#6B3410',
});

const DARK = Object.freeze({
  bg: '#202020', surface: '#2B2B2B',
  text: '#FFFFFF', textSecondary: '#C8C8C8', textDisabled: '#A0A0A0',
  border: '#3F3F3F', borderStrong: '#8C8C8C',
  accent: '#60CDFF', accentText: '#001A2B', accentHover: '#78D6FF', accentPressed: '#48B8EC',
  link: '#7CCBFF', focus: '#8AD8FF',
  hover: '#383838', pressed: '#303030',
  buttonBg: '#323232', buttonHover: '#3C3C3C', buttonPressed: '#2A2A2A', disabledBg: '#2E2E2E',
  success: '#6CCB5F', warning: '#F5B544', error: '#FF99A4',
  noticeBg: '#4A3A14', noticeText: '#FFF1C9',
});

/** the QR code is the same in every theme: black modules on a white quiet zone */
const QR = Object.freeze({ background: '#FFFFFF', module: '#000000' });

const PALETTES = Object.freeze({ light: LIGHT, dark: DARK });

/** the palette of a resolved mode ('light' | 'dark'); null for 'contrast' (use system colours) and for anything unknown */
function paletteFor(mode) { return Object.prototype.hasOwnProperty.call(PALETTES, mode) ? PALETTES[mode] : null; }

// ---------- WCAG 2.x contrast ----------
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const isHexColor = (s) => typeof s === 'string' && HEX.test(s);
function hexToRgb(hex) {
  const m = HEX.exec(String(hex)); if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** contrast ratio 1..21 of two #RRGGBB colours */
function contrast(a, b) { const la = luminance(a); const lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }

module.exports = { TOKENS, LIGHT, DARK, QR, PALETTES, paletteFor, isHexColor, hexToRgb, luminance, contrast };
