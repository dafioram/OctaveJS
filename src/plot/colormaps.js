// colormaps.js — MATLAB's named colormaps as functions of the number of
// colors, each returning an array of [r, g, b] rows in [0, 1]. Used by the
// colormap functions themselves (jet(10), parula, ...) and by the Plotly
// converter. Formulas follow MATLAB's definitions; parula and turbo are
// interpolated from sampled anchor colors.

import { COLOR_ORDER } from './style.js';

export const DEFAULT_COLORMAP_SIZE = 256;

const clamp = (v) => Math.min(Math.max(v, 0), 1);
const ramp = (n) => Array.from({ length: n }, (_, k) => (n === 1 ? 0 : k / (n - 1)));

function interpolate(anchors, n) {
  return ramp(n).map(t => {
    const pos = t * (anchors.length - 1);
    const i = Math.min(Math.floor(pos), anchors.length - 2);
    const f = pos - i;
    return anchors[i].map((v, c) => v + (anchors[i + 1][c] - v) * f);
  });
}

const PARULA_ANCHORS = [
  [0.2422, 0.1504, 0.6603], [0.2691, 0.2526, 0.8948], [0.2780, 0.3556, 0.9777], [0.2331, 0.4609, 0.9969],
  [0.1531, 0.5574, 0.9538], [0.1157, 0.6417, 0.8834], [0.0336, 0.7108, 0.8094], [0.1190, 0.7584, 0.7171],
  [0.2591, 0.7928, 0.5866], [0.4498, 0.8122, 0.4351], [0.6571, 0.7986, 0.2879], [0.8327, 0.7672, 0.2027],
  [0.9622, 0.7466, 0.2350], [0.9925, 0.8101, 0.1820], [0.9655, 0.9013, 0.1356], [0.9769, 0.9839, 0.0805],
];
const TURBO_ANCHORS = [
  [0.1900, 0.0718, 0.2322], [0.2737, 0.3644, 0.8422], [0.1554, 0.6512, 0.9867], [0.1281, 0.8873, 0.7458],
  [0.4626, 0.9947, 0.3613], [0.8044, 0.9177, 0.2133], [0.9871, 0.6852, 0.2088], [0.9282, 0.3519, 0.0753],
  [0.7097, 0.1199, 0.0122], [0.4796, 0.0158, 0.0106],
];

function hsvToRgb(h) {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  return [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][i];
}

function hot(n) {
  // MATLAB: red ramps over the first ~3/8, then green, then blue.
  const m1 = Math.floor(3 * n / 8), m2 = Math.floor(3 * n / 8);
  return Array.from({ length: n }, (_, k) => [
    clamp((k + 1) / m1), clamp((k + 1 - m1) / m2), clamp((k + 1 - m1 - m2) / (n - m1 - m2)),
  ]);
}

// MATLAB's jet.m: blue -> cyan -> yellow -> red built from a trapezoid
// ramp u shifted into the three channels.
function jet(m) {
  const n = Math.ceil(m / 4);
  const u = [];
  for (let k = 1; k <= n; k++) u.push(k / n);
  for (let k = 1; k < n; k++) u.push(1);
  for (let k = n; k >= 1; k--) u.push(k / n);
  const base = Math.ceil(n / 2) - (m % 4 === 1 ? 1 : 0);
  const g = u.map((_, k) => base + k + 1); // 1-based rows
  const r = g.map(v => v + n), b = g.map(v => v - n);
  const J = Array.from({ length: m }, () => [0, 0, 0]);
  const gk = g.filter(v => v <= m), rk = r.filter(v => v <= m), bk = b.filter(v => v >= 1);
  rk.forEach((row, k) => { J[row - 1][0] = u[k]; });
  gk.forEach((row, k) => { J[row - 1][1] = u[k]; });
  bk.forEach((row, k) => { J[row - 1][2] = u[u.length - bk.length + k]; });
  return J;
}

export const COLORMAPS = {
  parula: (n) => interpolate(PARULA_ANCHORS, n),
  turbo: (n) => interpolate(TURBO_ANCHORS, n),
  jet,
  hsv: (n) => Array.from({ length: n }, (_, k) => hsvToRgb(k / n)),
  hot,
  cool: (n) => ramp(n).map(t => [t, 1 - t, 1]),
  spring: (n) => ramp(n).map(t => [1, t, 1 - t]),
  summer: (n) => ramp(n).map(t => [t, 0.5 + t / 2, 0.4]),
  autumn: (n) => ramp(n).map(t => [1, t, 0]),
  winter: (n) => ramp(n).map(t => [0, t, 1 - t / 2]),
  gray: (n) => ramp(n).map(t => [t, t, t]),
  bone: (n) => {
    const h = hot(n).map(c => c.slice().reverse());
    return ramp(n).map((t, k) => [0, 1, 2].map(c => (7 * t + h[k][c]) / 8));
  },
  copper: (n) => ramp(n).map(t => [clamp(1.25 * t), 0.7812 * t, 0.4975 * t]),
  pink: (n) => {
    const h = hot(n);
    return ramp(n).map((t, k) => [0, 1, 2].map(c => Math.sqrt((2 * t + h[k][c]) / 3)));
  },
  white: (n) => Array.from({ length: n }, () => [1, 1, 1]),
  lines: (n) => Array.from({ length: n }, (_, k) => COLOR_ORDER[k % COLOR_ORDER.length].slice()),
};

export function colormapByName(name, n = DEFAULT_COLORMAP_SIZE) {
  const f = COLORMAPS[name];
  return f ? f(n) : null;
}

// A Plotly colorscale from a colormap (sampled down to at most 64 stops).
export function plotlyColorscale(map, rgbCss) {
  const n = map.length;
  if (n === 1) return [[0, rgbCss(map[0])], [1, rgbCss(map[0])]];
  const stops = Math.min(n, 64);
  return Array.from({ length: stops }, (_, k) => {
    const idx = Math.round(k * (n - 1) / (stops - 1));
    return [k / (stops - 1), rgbCss(map[idx])];
  });
}

// Range of the color data in an axes (surfaces, images, contours,
// per-point scatter colors): MATLAB's automatic color limits (CLim).
export function colorDataRange(ax) {
  let mn = Infinity, mx = -Infinity;
  for (const o of ax.objects) {
    const c = o.type === 'surface' || o.type === 'image' ? o.c : o.type === 'contour' ? o.z : o.colorValues;
    if (!c) continue;
    for (const v of c.flat()) if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  }
  if (mn === Infinity) return [0, 1];
  if (mn === mx) return [mn - 0.5, mx + 0.5];
  return [mn, mx];
}
