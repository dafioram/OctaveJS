// style.js — MATLAB graphics styling rules shared by the plotting builtins
// and the Plotly converter: the default color order, color specifications
// ('r', 'red', [1 0 0], '#FF0000'), line specs ('r--o') and the marker and
// line-style vocabularies. Plain data only; no DOM, no Plotly.

// MATLAB's default axes color order (R2014b and later).
export const COLOR_ORDER = [
  [0, 0.447, 0.741], [0.85, 0.325, 0.098], [0.929, 0.694, 0.125], [0.494, 0.184, 0.556],
  [0.466, 0.674, 0.188], [0.301, 0.745, 0.933], [0.635, 0.078, 0.184],
];

const LETTER_COLORS = {
  r: [1, 0, 0], g: [0, 1, 0], b: [0, 0, 1], c: [0, 1, 1], m: [1, 0, 1], y: [1, 1, 0], k: [0, 0, 0], w: [1, 1, 1],
};
const NAMED_COLORS = {
  red: 'r', green: 'g', blue: 'b', cyan: 'c', magenta: 'm', yellow: 'y', black: 'k', white: 'w',
};

export const LINE_STYLES = ['-', '--', ':', '-.', 'none'];
export const MARKERS = ['o', '+', '*', '.', 'x', 's', 'd', '^', 'v', '>', '<', 'p', 'h', 'none'];
const MARKER_NAMES = {
  circle: 'o', plus: '+', asterisk: '*', point: '.', cross: 'x', square: 's', diamond: 'd',
  pentagram: 'p', hexagram: 'h',
};

// A color from a text spec, or null if `s` isn't one.
export function colorFromText(s) {
  const t = s.trim().toLowerCase();
  if (LETTER_COLORS[t]) return LETTER_COLORS[t];
  if (NAMED_COLORS[t]) return LETTER_COLORS[NAMED_COLORS[t]];
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/.exec(t);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  return null;
}

export function markerFromText(s) {
  const t = s.trim().toLowerCase();
  if (MARKERS.includes(t)) return t;
  if (MARKER_NAMES[t]) return MARKER_NAMES[t];
  return null;
}

// Parses a MATLAB line spec such as 'r--o', 'k:', 'x' (tokens in any
// order). Returns { lineStyle, marker, color } with only the parts present,
// or null if the text isn't a valid line spec.
export function parseLinespec(spec) {
  let s = spec;
  const out = {};
  for (const ls of ['--', '-.', '-', ':']) {
    const i = s.indexOf(ls);
    if (i >= 0) { out.lineStyle = ls; s = s.slice(0, i) + s.slice(i + ls.length); break; }
  }
  for (const ch of s) {
    if (LETTER_COLORS[ch] && out.color === undefined) out.color = LETTER_COLORS[ch];
    else if (MARKERS.includes(ch) && ch !== 'none' && out.marker === undefined) out.marker = ch;
    else return null;
  }
  return out;
}

export function rgbCss(c, alpha = 1) {
  const [r, g, b] = c.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255));
  return alpha === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

// MATLAB's parula colormap, sampled (used for per-point colors until
// colormap support arrives).
export const PARULA = [
  [0.2422, 0.1504, 0.6603], [0.2810, 0.3228, 0.9579], [0.1786, 0.5289, 0.9682],
  [0.0689, 0.6948, 0.8394], [0.2161, 0.7843, 0.5923], [0.6720, 0.7793, 0.2227],
  [0.9970, 0.7659, 0.2199], [0.9769, 0.9839, 0.0805],
];
