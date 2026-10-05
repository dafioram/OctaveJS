// interp.js — Interpolation and piecewise polynomials: interp1 (linear,
// nearest, next, previous, pchip/cubic, spline), interp2 (linear,
// nearest, cubic, spline), spline (not-a-knot, or clamped with end
// slopes), pchip (shape-preserving, MATLAB's slope formula), the pp-form
// functions mkpp / unmkpp / ppval, and polyder / polyint.

import { Mat, StructArray, MatlabError } from '../core/values.js';

const isText = (v) => v instanceof Mat && v.isChar;

function realValues(v, what, fname) {
  if (!(v instanceof Mat) || v.isChar) throw new MatlabError(`${fname}: ${what} must be numeric`);
  if (v.isComplex && v.im.some(x => x !== 0)) throw new MatlabError(`${fname}: complex ${what} is not supported`);
  return Array.from(v.re);
}

// Index i of the piece [x[i], x[i+1]] containing q (clamped to the ends,
// so values outside extend the first or last piece).
function pieceIndex(x, q) {
  let lo = 0, hi = x.length - 2;
  if (q <= x[0]) return 0;
  if (q >= x[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (x[mid] <= q) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---- piecewise polynomials ----
// A pp is { breaks, coefs: [piece][dim] -> [c_k ... c_0] (powers of
// x - breaks[piece], highest first), order, dim }.

function hermitePP(x, ys, slopes) {
  // ys and slopes: arrays (per dimension) of arrays over the points.
  const L = x.length - 1;
  const coefs = [];
  for (let i = 0; i < L; i++) {
    const h = x[i + 1] - x[i];
    coefs.push(ys.map((y, d) => {
      const s = slopes[d], del = (y[i + 1] - y[i]) / h;
      return [(s[i] + s[i + 1] - 2 * del) / (h * h), (3 * del - 2 * s[i] - s[i + 1]) / h, s[i], y[i]];
    }));
  }
  return { breaks: x.slice(), coefs, order: 4, dim: ys.length };
}

function ppEval(pp, q) {
  if (Number.isNaN(q)) return Array.from({ length: pp.dim }, () => NaN);
  const i = pieceIndex(pp.breaks, q);
  const dx = q - pp.breaks[i];
  return pp.coefs[i].map(c => c.reduce((acc, ck) => acc * dx + ck, 0));
}

// Not-a-knot spline slopes (or clamped with end slopes e = [e1, en]).
function splineSlopes(x, y, ends) {
  const n = x.length;
  const dx = [], del = [];
  for (let i = 0; i < n - 1; i++) { dx.push(x[i + 1] - x[i]); del.push((y[i + 1] - y[i]) / dx[i]); }
  // Tridiagonal system: sub[i] s[i-1] + main[i] s[i] + sup[i] s[i+1] = rhs[i].
  const sub = new Array(n).fill(0), main = new Array(n).fill(0), sup = new Array(n).fill(0), rhs = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    sub[i] = dx[i]; main[i] = 2 * (dx[i - 1] + dx[i]); sup[i] = dx[i - 1];
    rhs[i] = 3 * (dx[i] * del[i - 1] + dx[i - 1] * del[i]);
  }
  if (ends) {
    main[0] = 1; rhs[0] = ends[0];
    main[n - 1] = 1; rhs[n - 1] = ends[1];
  } else {
    const x31 = x[2] - x[0], xn = x[n - 1] - x[n - 3];
    main[0] = dx[1]; sup[0] = x31;
    rhs[0] = ((dx[0] + 2 * x31) * dx[1] * del[0] + dx[0] * dx[0] * del[1]) / x31;
    sub[n - 1] = xn; main[n - 1] = dx[n - 3];
    rhs[n - 1] = (dx[n - 2] * dx[n - 2] * del[n - 3] + (2 * xn + dx[n - 2]) * dx[n - 3] * del[n - 2]) / xn;
  }
  // Thomas algorithm.
  const c = new Array(n), d = new Array(n);
  c[0] = sup[0] / main[0]; d[0] = rhs[0] / main[0];
  for (let i = 1; i < n; i++) {
    const m = main[i] - sub[i] * c[i - 1];
    c[i] = sup[i] / m; d[i] = (rhs[i] - sub[i] * d[i - 1]) / m;
  }
  const s = new Array(n);
  s[n - 1] = d[n - 1];
  for (let i = n - 2; i >= 0; i--) s[i] = d[i] - c[i] * s[i + 1];
  return s;
}

// The spline pp of y (an array per dimension) over x; ends: per-dimension
// [e1, en] end slopes, or null for not-a-knot.
function splinePP(x, ys, ends) {
  const n = x.length;
  if (n === 2 && !ends) {
    // Two points: the straight line.
    return { breaks: x.slice(), coefs: [ys.map(y => [(y[1] - y[0]) / (x[1] - x[0]), y[0]])], order: 2, dim: ys.length };
  }
  if (n === 3 && !ends) {
    // Three points: the interpolating parabola, as one piece.
    return {
      breaks: [x[0], x[2]], order: 3, dim: ys.length,
      coefs: [ys.map(y => {
        const d1 = (y[1] - y[0]) / (x[1] - x[0]), d2 = (y[2] - y[1]) / (x[2] - x[1]);
        const c2 = (d2 - d1) / (x[2] - x[0]);
        return [c2, d1 - c2 * (x[1] - x[0]), y[0]];
      })],
    };
  }
  return hermitePP(x, ys, ys.map((y, d) => splineSlopes(x, y, ends ? ends[d] : null)));
}

// pchip slopes (MATLAB's pchipslopes): harmonic-mean interior slopes,
// zero at local extrema, shape-preserving one-sided ends.
function pchipSlopes(x, y) {
  const n = x.length;
  const h = [], del = [];
  for (let i = 0; i < n - 1; i++) { h.push(x[i + 1] - x[i]); del.push((y[i + 1] - y[i]) / h[i]); }
  const d = new Array(n).fill(0);
  if (n === 2) { d[0] = d[1] = del[0]; return d; }
  for (let k = 1; k < n - 1; k++) {
    if (Math.sign(del[k - 1]) * Math.sign(del[k]) > 0) {
      const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
      d[k] = (w1 + w2) / (w1 / del[k - 1] + w2 / del[k]);
    }
  }
  const end = (h1, h2, del1, del2) => {
    let dd = ((2 * h1 + h2) * del1 - h1 * del2) / (h1 + h2);
    if (Math.sign(dd) !== Math.sign(del1)) dd = 0;
    else if (Math.sign(del1) !== Math.sign(del2) && Math.abs(dd) > Math.abs(3 * del1)) dd = 3 * del1;
    return dd;
  };
  d[0] = end(h[0], h[1], del[0], del[1]);
  d[n - 1] = end(h[n - 2], h[n - 3], del[n - 2], del[n - 3]);
  return d;
}

// Sorted, distinct x with the matching y columns.
function prepareGrid(x, ys, fname) {
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const xs = order.map(i => x[i]);
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] === xs[i - 1]) throw new MatlabError(`${fname}: the sample points must be unique`);
  }
  if (xs.some(v => !Number.isFinite(v))) throw new MatlabError(`${fname}: the sample points must be finite`);
  return { x: xs, ys: ys.map(y => order.map(i => y[i])) };
}

function ppStruct(pp) {
  const L = pp.coefs.length;
  const coefs = new Mat(L * pp.dim, pp.order, new Float64Array(L * pp.dim * pp.order));
  pp.coefs.forEach((piece, i) => piece.forEach((c, d) => c.forEach((v, k) => { coefs.re[k * L * pp.dim + i * pp.dim + d] = v; })));
  return StructArray.scalar({
    form: Mat.fromString('pp'), breaks: new Mat(1, L + 1, Float64Array.from(pp.breaks)), coefs,
    pieces: Mat.scalar(L), order: Mat.scalar(pp.order), dim: Mat.scalar(pp.dim),
  });
}

function ppFromStruct(s, fname) {
  if (!(s instanceof StructArray) || !s.hasField('breaks') || !s.hasField('coefs')) throw new MatlabError(`${fname}: expected a piecewise polynomial structure (from spline, pchip or mkpp)`);
  const el = s.data[0];
  const breaks = Array.from(el.get('breaks').re);
  const C = el.get('coefs');
  const dim = el.has('dim') ? el.get('dim').re[0] : 1;
  const L = breaks.length - 1;
  if (C.rows !== L * dim) throw new MatlabError(`${fname}: coefs must have pieces*dim rows`);
  const coefs = Array.from({ length: L }, (_, i) => Array.from({ length: dim }, (_, d) => Array.from({ length: C.cols }, (_, k) => C.re[k * C.rows + i * dim + d])));
  return { breaks, coefs, order: C.cols, dim };
}

// Values of pp at the points of xq: same shape as xq for dim 1,
// dim-by-numel(xq) otherwise.
function ppValues(pp, xq) {
  const qs = Array.from(xq.re);
  if (pp.dim === 1) return new Mat(xq.rows, xq.cols, Float64Array.from(qs, q => ppEval(pp, q)[0]));
  const out = new Mat(pp.dim, qs.length, new Float64Array(pp.dim * qs.length));
  qs.forEach((q, j) => ppEval(pp, q).forEach((v, d) => { out.re[j * pp.dim + d] = v; }));
  return out;
}

// (x, y) data for spline/pchip: y a vector, or a matrix whose rows are
// the components (MATLAB's convention for these two functions).
function curveData(xArg, yArg, fname, allowEnds) {
  const x = realValues(xArg, 'x', fname);
  const n = x.length;
  let ys, ends = null;
  const yv = realValues(yArg, 'y', fname);
  if (yArg.isVector || yArg.isEmpty) {
    if (allowEnds && yv.length === n + 2) { ends = [[yv[0], yv[n + 1]]]; ys = [yv.slice(1, n + 1)]; }
    else ys = [yv];
  } else {
    const rows = yArg.rows, cols = yArg.cols;
    ys = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => yArg.re[c * rows + r]));
    if (allowEnds && cols === n + 2) { ends = ys.map(y => [y[0], y[n + 1]]); ys = ys.map(y => y.slice(1, n + 1)); }
  }
  if (ys[0].length !== n) throw new MatlabError(`${fname}: x and y must have the same number of points`);
  if (n < 2) throw new MatlabError(`${fname}: at least two data points are needed`);
  const g = prepareGrid(x, ys, fname);
  return { x: g.x, ys: g.ys, ends };
}

// ---- interp1 ----

const METHODS1 = ['linear', 'nearest', 'next', 'previous', 'pchip', 'cubic', 'spline', 'v5cubic'];

function interp1(args) {
  // interp1(x, v, xq), interp1(v, xq), each with optional method and
  // extrapolation ('extrap' or a value).
  const rest = args.slice();
  let method = 'linear', extrap = null;
  // interp1(..., method, extrapval)
  if (rest.length >= 4 && !isText(rest[rest.length - 1]) && isText(rest[rest.length - 2])) extrap = rest.pop().toScalarNumber();
  while (rest.length && isText(rest[rest.length - 1])) {
    const s = rest.pop().toJSString().toLowerCase();
    if (s === 'extrap') extrap = 'extrap';
    else if (METHODS1.includes(s)) method = s;
    else if (s === 'makima') throw new MatlabError("interp1: method 'makima' is not supported; use 'pchip' or 'spline'");
    else throw new MatlabError(`interp1: unknown method '${s}'`);
  }
  if (method === 'cubic' || method === 'v5cubic') method = 'pchip';
  let xArg, vArg, xq;
  if (rest.length === 2) [vArg, xq] = rest;
  else if (rest.length === 3) [xArg, vArg, xq] = rest;
  else throw new MatlabError('interp1: expected interp1(x, v, xq) or interp1(v, xq)');
  // v: a vector, or a matrix with one column per series.
  const vIsVector = vArg.isVector;
  const n = vIsVector ? vArg.numel : vArg.rows;
  const series = vIsVector ? [realValues(vArg, 'v', 'interp1')]
    : Array.from({ length: vArg.cols }, (_, c) => Array.from(vArg.re.subarray(c * vArg.rows, (c + 1) * vArg.rows)));
  if (vArg.isComplex && vArg.im.some(v => v !== 0)) throw new MatlabError('interp1: complex values are not supported');
  const x = xArg ? realValues(xArg, 'x', 'interp1') : Array.from({ length: n }, (_, i) => i + 1);
  if (x.length !== n) throw new MatlabError('interp1: the sample points x must have the same length as v (or as its columns)');
  if (n < 2) throw new MatlabError('interp1: at least two sample points are needed');
  const g = prepareGrid(x, series, 'interp1');
  const xs = g.x;
  const lo = xs[0], hi = xs[n - 1];
  const doExtrap = extrap === 'extrap' || (extrap === null && (method === 'pchip' || method === 'spline'));
  const fill = typeof extrap === 'number' ? extrap : NaN;
  let pp = null;
  if (method === 'spline') pp = splinePP(xs, g.ys, null);
  if (method === 'pchip') pp = hermitePP(xs, g.ys, g.ys.map(y => pchipSlopes(xs, y)));
  const at = (q) => {
    if (Number.isNaN(q)) return g.ys.map(() => NaN);
    if ((q < lo || q > hi) && !doExtrap) return g.ys.map(() => fill);
    if (pp) return ppEval(pp, q);
    const i = pieceIndex(xs, q);
    switch (method) {
      case 'nearest': {
        const k = q - xs[i] < xs[i + 1] - q ? i : i + 1;
        return g.ys.map(y => y[q < lo ? 0 : q > hi ? n - 1 : k]);
      }
      case 'next': {
        if (q > hi) return g.ys.map(() => (doExtrap ? NaN : fill));
        const k = q <= xs[i] ? i : i + 1;
        return g.ys.map(y => y[k]);
      }
      case 'previous': {
        if (q < lo) return g.ys.map(() => (doExtrap ? NaN : fill));
        const k = q >= xs[i + 1] ? i + 1 : i;
        return g.ys.map(y => y[k]);
      }
      default: {
        const t = (q - xs[i]) / (xs[i + 1] - xs[i]);
        return g.ys.map(y => (t === 1 ? y[i + 1] : y[i] + t * (y[i + 1] - y[i])));
      }
    }
  };
  const qs = Array.from(xq.re);
  if (series.length === 1) return [new Mat(xq.rows, xq.cols, Float64Array.from(qs, q => at(q)[0]))];
  const out = new Mat(qs.length, series.length, new Float64Array(qs.length * series.length));
  qs.forEach((q, r) => at(q).forEach((v, c) => { out.re[c * qs.length + r] = v; }));
  return [out];
}

// ---- interp2 ----

// Keys cubic convolution kernel (a = -0.5), MATLAB's 'cubic' on uniform grids.
function keys(s) {
  const a = Math.abs(s);
  if (a <= 1) return 1.5 * a ** 3 - 2.5 * a ** 2 + 1;
  if (a < 2) return -0.5 * a ** 3 + 2.5 * a ** 2 - 4 * a + 2;
  return 0;
}

function interp2(args) {
  let rest = args.slice();
  let method = 'linear', extrapval = NaN;
  if (rest.length >= 2 && !isText(rest[rest.length - 1]) && isText(rest[rest.length - 2])) {
    extrapval = rest.pop().toScalarNumber();
  }
  if (rest.length && isText(rest[rest.length - 1])) method = rest.pop().toJSString().toLowerCase();
  if (!['linear', 'nearest', 'cubic', 'spline'].includes(method)) {
    throw new MatlabError(`interp2: unsupported method '${method}' (use linear, nearest, cubic or spline)`);
  }
  let X = null, Y = null, Z, Xq, Yq;
  if (rest.length === 3) [Z, Xq, Yq] = rest;
  else if (rest.length === 5) [X, Y, Z, Xq, Yq] = rest;
  else throw new MatlabError('interp2: expected interp2(X, Y, Z, Xq, Yq) or interp2(Z, Xq, Yq)');
  const m = Z.rows, n = Z.cols;
  if (m < 2 || n < 2) throw new MatlabError('interp2: Z must be at least 2-by-2');
  const grid = (v, count, isX) => {
    if (!v) return Array.from({ length: count }, (_, k) => k + 1);
    const vals = realValues(v, isX ? 'X' : 'Y', 'interp2');
    if (v.isVector) { if (vals.length !== count) throw new MatlabError(`interp2: the length of ${isX ? 'X' : 'Y'} must match the ${isX ? 'columns' : 'rows'} of Z`); return vals; }
    if (v.rows !== m || v.cols !== n) throw new MatlabError('interp2: X, Y and Z must be the same size');
    return isX ? Array.from({ length: n }, (_, j) => vals[j * m]) : Array.from({ length: m }, (_, i) => vals[i]);
  };
  const xs = grid(X, n, true), ys = grid(Y, m, false);
  const zrows = Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, j) => Z.re[j * m + i]));
  if (Z.isComplex && Z.im.some(v => v !== 0)) throw new MatlabError('interp2: complex values are not supported');
  for (const g of [xs, ys]) for (let k = 1; k < g.length; k++) if (!(g[k] > g[k - 1])) throw new MatlabError('interp2: grid vectors must be strictly increasing');
  // Query points: same-size arrays, or a row xq and a column yq (a grid).
  let qx, qy, outRows, outCols;
  const xqv = realValues(Xq, 'Xq', 'interp2'), yqv = realValues(Yq, 'Yq', 'interp2');
  if (Xq.rows === Yq.rows && Xq.cols === Yq.cols) { qx = xqv; qy = yqv; outRows = Xq.rows; outCols = Xq.cols; }
  else if (Xq.isVector && Yq.isVector) {
    outRows = yqv.length; outCols = xqv.length;
    qx = []; qy = [];
    for (let j = 0; j < outCols; j++) for (let i = 0; i < outRows; i++) { qx.push(xqv[j]); qy.push(yqv[i]); }
  } else throw new MatlabError('interp2: Xq and Yq must be the same size, or vectors defining a grid');

  const uniform = (g) => g.every((v, k) => k === 0 || Math.abs((v - g[k - 1]) - (g[1] - g[0])) <= 1e-12 * Math.abs(g[g.length - 1] - g[0]));
  let rowSplines = null;
  if (method === 'spline' || (method === 'cubic' && !(uniform(xs) && uniform(ys)))) {
    // Tensor-product not-a-knot spline: a spline along each row, then one down the column of results.
    rowSplines = zrows.map(r => splinePP(xs, [r], null));
  }
  const value = (x, y) => {
    if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
    if (x < xs[0] || x > xs[n - 1] || y < ys[0] || y > ys[m - 1]) return extrapval;
    if (rowSplines) {
      const col = rowSplines.map(pp => ppEval(pp, x)[0]);
      return ppEval(splinePP(ys, [col], null), y)[0];
    }
    const j = pieceIndex(xs, x), i = pieceIndex(ys, y);
    const tx = (x - xs[j]) / (xs[j + 1] - xs[j]), ty = (y - ys[i]) / (ys[i + 1] - ys[i]);
    if (method === 'nearest') {
      const jj = tx < 0.5 ? j : j + 1, ii = ty < 0.5 ? i : i + 1;
      return zrows[ii][jj];
    }
    if (method === 'linear') {
      return (1 - ty) * ((1 - tx) * zrows[i][j] + tx * zrows[i][j + 1]) + ty * ((1 - tx) * zrows[i + 1][j] + tx * zrows[i + 1][j + 1]);
    }
    // cubic convolution, with MATLAB's linear extrapolation of the border.
    const zAt = (r, c) => {
      if (r < 0) return 3 * zAt(0, c) - 3 * zAt(1, c) + zAt(2, c);
      if (r > m - 1) return 3 * zAt(m - 1, c) - 3 * zAt(m - 2, c) + zAt(m - 3, c);
      if (c < 0) return 3 * zrows[r][0] - 3 * zrows[r][1] + zrows[r][2];
      if (c > n - 1) return 3 * zrows[r][n - 1] - 3 * zrows[r][n - 2] + zrows[r][n - 3];
      return zrows[r][c];
    };
    if (m < 3 || n < 3) throw new MatlabError("interp2: 'cubic' needs at least 3 points in each direction");
    let sum = 0;
    for (let di = -1; di <= 2; di++) {
      const wy = keys(ty - di);
      if (wy === 0) continue;
      for (let dj = -1; dj <= 2; dj++) {
        const wx = keys(tx - dj);
        if (wx !== 0) sum += wy * wx * zAt(i + di, j + dj);
      }
    }
    return sum;
  };
  return [new Mat(outRows, outCols, Float64Array.from(qx, (x, k) => value(x, qy[k])))];
}

// ---- polyder / polyint ----

function stripLeading(p) {
  let k = 0;
  while (k < p.length - 1 && p[k] === 0) k++;
  return p.slice(k);
}
const derivative = (p) => (p.length <= 1 ? [0] : p.slice(0, -1).map((c, i) => c * (p.length - 1 - i)));
function conv(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => { out[i + j] += x * y; }));
  return out;
}
const rowOf = (vals) => new Mat(1, vals.length, Float64Array.from(vals));
function subtract(a, b) {
  const n = Math.max(a.length, b.length);
  const pa = [...new Array(n - a.length).fill(0), ...a], pb = [...new Array(n - b.length).fill(0), ...b];
  return pa.map((v, i) => v - pb[i]);
}

export function registerInterp(reg) {
  reg.set('interp1', { fn: interp1 });
  reg.set('interp2', { fn: interp2 });

  // spline(x, y) -> pp | spline(x, y, xq) -> values
  reg.set('spline', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('spline: expected spline(x, y) or spline(x, y, xq)');
      const { x, ys, ends } = curveData(args[0], args[1], 'spline', true);
      const pp = splinePP(x, ys, ends);
      return [args.length >= 3 ? ppValues(pp, args[2]) : ppStruct(pp)];
    },
  });
  reg.set('pchip', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('pchip: expected pchip(x, y) or pchip(x, y, xq)');
      const { x, ys } = curveData(args[0], args[1], 'pchip', false);
      const pp = hermitePP(x, ys, ys.map(y => pchipSlopes(x, y)));
      return [args.length >= 3 ? ppValues(pp, args[2]) : ppStruct(pp)];
    },
  });
  reg.set('ppval', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('ppval: expected ppval(pp, xq)');
      const [a, b] = args[0] instanceof StructArray ? args : [args[1], args[0]];
      return [ppValues(ppFromStruct(a, 'ppval'), b)];
    },
  });
  // mkpp(breaks, coefs) | mkpp(breaks, coefs, d)
  reg.set('mkpp', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('mkpp: expected mkpp(breaks, coefs)');
      const breaks = realValues(args[0], 'breaks', 'mkpp');
      const L = breaks.length - 1;
      const dim = args.length >= 3 ? Math.round(args[2].toScalarNumber()) : 1;
      if (L < 1) throw new MatlabError('mkpp: at least two breaks are needed');
      const C = args[1];
      const total = C.numel;
      if (total % (L * dim) !== 0) throw new MatlabError('mkpp: the number of coefficients must be a multiple of pieces*dim');
      const order = total / (L * dim);
      // A coefficient vector is read row-wise, like MATLAB's reshape of coefs to (pieces*dim)-by-order.
      // As in MATLAB, coefs is reshaped (column-major) to (pieces*dim)-by-order.
      const coefs = new Mat(L * dim, order, Float64Array.from(C.re));
      return [StructArray.scalar({
        form: Mat.fromString('pp'), breaks: rowOf(breaks), coefs,
        pieces: Mat.scalar(L), order: Mat.scalar(order), dim: Mat.scalar(dim),
      })];
    },
  });
  // [breaks, coefs, pieces, order, dim] = unmkpp(pp)
  reg.set('unmkpp', {
    fn: (args) => {
      const el = args[0] instanceof StructArray ? args[0].data[0] : null;
      if (!el || !el.has('breaks')) throw new MatlabError('unmkpp: expected a piecewise polynomial structure');
      return ['breaks', 'coefs', 'pieces', 'order', 'dim'].map(f => el.get(f));
    },
  });

  // polyder(p) | polyder(a, b) (derivative of the product) | [q, d] = polyder(b, a) (of the quotient b/a)
  reg.set('polyder', {
    fn: (args, nargout) => {
      const vals = args.map((v, i) => realValues(v, i ? 'b' : 'p', 'polyder'));
      if (vals.length === 1) return [rowOf(stripLeading(derivative(vals[0].length ? vals[0] : [0])))];
      const [u, v] = vals;
      if (nargout >= 2) {
        const q = subtract(conv(derivative(u), v), conv(u, derivative(v)));
        return [rowOf(stripLeading(q)), rowOf(stripLeading(conv(v, v)))];
      }
      return [rowOf(stripLeading(derivative(conv(u, v))))];
    },
  });
  // polyint(p) | polyint(p, k)
  reg.set('polyint', {
    fn: (args) => {
      const p = realValues(args[0], 'p', 'polyint');
      const k = args.length >= 2 ? args[1].toScalarNumber() : 0;
      return [rowOf([...p.map((c, i) => c / (p.length - i)), k])];
    },
  });
}
