// stats.js — Data analysis: cov, corrcoef, prctile, quantile, histcounts,
// histc, discretize, accumarray, cummax, cummin, the moving-window
// statistics (movmean, movsum, movmedian, movmax, movmin, movprod,
// movstd, movvar), normalize, rescale, bounds and vecnorm.

import { Mat, MatlabError } from '../core/values.js';
import { histogramEdges, histogramCounts, normalizeCounts } from './plotting.js';

const isText = (v) => v instanceof Mat && v.isChar;
const text = (v) => v.toJSString().toLowerCase();
const firstDim = (m) => (m.rows !== 1 ? 1 : 2);

function realArg(v, fname, what = 'input') {
  if (!(v instanceof Mat) || v.isChar) throw new MatlabError(`${fname}: ${what} must be numeric`);
  if (v.isComplex && v.im.some(x => x !== 0)) throw new MatlabError(`${fname}: complex ${what} is not supported`);
  return v;
}
function dimArg(v, fname) {
  const d = v.toScalarNumber();
  if (!Number.isInteger(d) || d < 1) throw new MatlabError(`${fname}: dimension must be a positive integer`);
  return d;
}

// Applies fn(values) -> values (of length outLen) along dim of m.
function alongDim(m, dim, outLen, fn) {
  if (dim >= 3) {
    const out = Mat.zeros(m.rows, m.cols);
    for (let k = 0; k < m.numel; k++) out.re[k] = fn([m.re[k]])[0];
    return out;
  }
  const len = dim === 1 ? m.rows : m.cols, lines = dim === 1 ? m.cols : m.rows;
  const outRows = dim === 1 ? outLen : m.rows, outCols = dim === 1 ? m.cols : outLen;
  const out = Mat.zeros(outRows, outCols);
  for (let l = 0; l < lines; l++) {
    const vals = Array.from({ length: len }, (_, k) => m.re[dim === 1 ? l * m.rows + k : k * m.rows + l]);
    const res = fn(vals);
    for (let k = 0; k < outLen; k++) out.re[dim === 1 ? l * outRows + k : k * outRows + l] = res[k];
  }
  return out;
}

const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
function median(v) {
  if (v.length === 0) return NaN;
  const s = v.slice().sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function variance(v, population = false) {
  if (v.length === 0) return NaN;
  if (v.length === 1) return 0;
  const mu = mean(v);
  return v.reduce((s, x) => s + (x - mu) ** 2, 0) / (population ? v.length : v.length - 1);
}

// ---------------- cov / corrcoef ----------------

// The data as columns of observations: cov(A), cov(x, y) (two variables).
function variablesOf(args, fname) {
  const data = args.filter(v => !isText(v));
  let cols;
  if (data.length >= 2 && data[1].numel > 1) {
    const [x, y] = data.map(v => realArg(v, fname));
    if (x.numel !== y.numel) throw new MatlabError(`${fname}: X and Y must have the same number of elements`);
    cols = [Array.from(x.re), Array.from(y.re)];
  } else {
    const A = realArg(data[0], fname);
    if (A.rows === 1 || A.cols === 1) cols = [Array.from(A.re)];
    else cols = Array.from({ length: A.cols }, (_, c) => Array.from(A.re.subarray(c * A.rows, (c + 1) * A.rows)));
  }
  return { cols, rest: data.slice(cols.length === 2 && data.length >= 2 && data[1].numel > 1 ? 2 : 1) };
}
// Rows with a NaN in any variable are dropped ('omitrows' / 'complete').
function dropNaNRows(cols) {
  const n = cols[0].length;
  const keep = Array.from({ length: n }, (_, r) => cols.every(c => !Number.isNaN(c[r])));
  return cols.map(c => c.filter((_, r) => keep[r]));
}
function covMatrix(cols, population) {
  if (cols.length === 0) return Mat.scalar(NaN); // cov([]) is NaN, as in MATLAB
  const p = cols.length, n = cols[0].length;
  const mus = cols.map(c => (n ? mean(c) : NaN));
  const out = Mat.zeros(p, p);
  const denom = population || n === 1 ? n : n - 1;
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += (cols[i][k] - mus[i]) * (cols[j][k] - mus[j]);
      out.re[j * p + i] = out.re[i * p + j] = n ? s / denom : NaN;
    }
  }
  return out;
}

// Two-sided p-value for a correlation coefficient r from n observations.
function corrPValue(r, n, betainc) {
  if (n < 3 || Number.isNaN(r)) return NaN;
  if (Math.abs(r) >= 1) return 0;
  const df = n - 2;
  const t2 = (r * r * df) / (1 - r * r);
  return betainc(df / (df + t2), df / 2, 0.5);
}

// ---------------- percentiles ----------------

// MATLAB's prctile/quantile: the sorted data (NaN removed) taken as the
// (i - 0.5)/n quantiles, linearly interpolated, clamped at the ends.
function quantileOf(sorted, q) {
  const n = sorted.length;
  if (n === 0 || Number.isNaN(q)) return NaN;
  const pos = n * q + 0.5;
  if (pos <= 1) return sorted[0];
  if (pos >= n) return sorted[n - 1];
  const i = Math.floor(pos), f = pos - i;
  return sorted[i - 1] + f * (sorted[i] - sorted[i - 1]);
}
function percentiles(args, fname, scale) {
  if (args.length < 2) throw new MatlabError(`${fname}: expected ${fname}(X, p)`);
  const X = realArg(args[0], fname);
  const pArg = realArg(args[1], fname, 'p');
  let qs = Array.from(pArg.re, v => v / scale);
  // quantile(X, N) with an integer N > 1: N evenly spaced cumulative probabilities.
  if (fname === 'quantile' && pArg.numel === 1 && Number.isInteger(pArg.re[0]) && pArg.re[0] > 1) {
    const N = pArg.re[0];
    qs = Array.from({ length: N }, (_, k) => (k + 1) / (N + 1));
  }
  for (const q of qs) if (!(q >= 0 && q <= 1)) throw new MatlabError(`${fname}: ${fname === 'prctile' ? 'percentages must be between 0 and 100' : 'probabilities must be between 0 and 1'}`);
  let dim = null;
  for (const v of args.slice(2)) {
    if (isText(v)) { if (text(v) === 'all') dim = 'all'; else throw new MatlabError(`${fname}: unsupported option '${v.toJSString()}'`); } else dim = dimArg(v, fname);
  }
  const ofValues = (vals) => {
    const sorted = vals.filter(v => !Number.isNaN(v)).sort((a, b) => a - b);
    return qs.map(q => quantileOf(sorted, q));
  };
  if (dim === 'all' || (dim === null && (X.rows === 1 || X.cols === 1))) {
    const res = ofValues(Array.from(X.re));
    const likeP = pArg.numel === qs.length ? pArg : new Mat(1, qs.length, new Float64Array(qs.length));
    return [new Mat(likeP.rows, likeP.cols, Float64Array.from(res))];
  }
  return [alongDim(X, dim ?? firstDim(X), qs.length, ofValues)];
}

// ---------------- moving-window statistics ----------------

function movingWindow(fname, stat, args, hasWeight) {
  if (args.length < 2) throw new MatlabError(`${fname}: expected ${fname}(A, k)`);
  const A = realArg(args[0], fname);
  const kArg = realArg(args[1], fname, 'window');
  let kb, kf;
  if (kArg.numel === 1) {
    const k = kArg.re[0];
    if (!(k > 0)) throw new MatlabError(`${fname}: the window length must be positive`);
    if (Number.isInteger(k)) {
      if (k % 2) { kb = kf = (k - 1) / 2; } else { kb = k / 2; kf = k / 2 - 1; }
    } else { kb = kf = Math.floor(k / 2); }
  } else if (kArg.numel === 2) {
    [kb, kf] = kArg.re;
    if (!(kb >= 0 && kf >= 0)) throw new MatlabError(`${fname}: [kb kf] must be nonnegative`);
    kb = Math.floor(kb); kf = Math.floor(kf);
  } else throw new MatlabError(`${fname}: the window must be k or [kb kf]`);
  let i = 2, weight = 0, dim = null, endpoints = 'shrink', omitnan = false;
  if (hasWeight && i < args.length && !isText(args[i])) { weight = args[i].isEmpty ? 0 : args[i].toScalarNumber(); i++; }
  if (i < args.length && !isText(args[i])) { dim = dimArg(args[i], fname); i++; }
  while (i < args.length) {
    const opt = text(args[i]);
    if (opt === 'omitnan' || opt === 'omitmissing') { omitnan = true; i++; } else if (opt === 'includenan' || opt === 'includemissing') { i++; } else if (opt === 'endpoints') {
      const v = args[i + 1];
      if (!v) throw new MatlabError(`${fname}: Endpoints needs a value`);
      endpoints = isText(v) ? text(v) : v.toScalarNumber();
      if (typeof endpoints === 'string' && !['shrink', 'discard', 'fill'].includes(endpoints)) throw new MatlabError(`${fname}: Endpoints must be 'shrink', 'discard', 'fill' or a number`);
      i += 2;
    } else if (opt === 'samplepoints') throw new MatlabError(`${fname}: SamplePoints is not supported`);
    else throw new MatlabError(`${fname}: unsupported option '${args[i].toJSString()}'`);
  }
  const d = dim ?? firstDim(A);
  const len = d === 1 ? A.rows : d === 2 ? A.cols : 1;
  const discard = endpoints === 'discard';
  const outLen = discard ? Math.max(len - kb - kf, 0) : len;
  return alongDim(A, d, outLen, (vals) => {
    const out = [];
    for (let j = 0; j < vals.length; j++) {
      const lo = j - kb, hi = j + kf;
      const full = lo >= 0 && hi < vals.length;
      if (!full && discard) continue;
      if (!full && endpoints !== 'shrink') { out.push(endpoints === 'fill' ? NaN : endpoints); continue; }
      let win = vals.slice(Math.max(lo, 0), Math.min(hi, vals.length - 1) + 1);
      if (omitnan) win = win.filter(v => !Number.isNaN(v));
      out.push(stat(win, weight));
    }
    return out;
  });
}

// ---------------- builtins ----------------

export function registerStats(reg) {
  reg.set('cov', {
    fn: (args) => {
      if (args.length === 0) throw new MatlabError('cov: expected cov(A) or cov(x, y)');
      const { cols: raw, rest } = variablesOf(args, 'cov');
      let population = false;
      for (const v of rest) {
        const w = v.isEmpty ? 0 : v.toScalarNumber();
        if (w !== 0 && w !== 1) throw new MatlabError('cov: the normalization must be 0 or 1');
        population = w === 1;
      }
      const flag = args.filter(isText).map(text)[0];
      if (flag && !['includenan', 'omitrows', 'partialrows', 'includemissing', 'omitmissing'].includes(flag)) throw new MatlabError(`cov: unsupported option '${flag}'`);
      const cols = flag === 'omitrows' || flag === 'partialrows' || flag === 'omitmissing' ? dropNaNRows(raw) : raw;
      return [covMatrix(cols, population)];
    },
  });

  // [R, P] = corrcoef(A) | corrcoef(x, y) | corrcoef(..., 'Rows', 'complete')
  reg.set('corrcoef', {
    fn: (args, nargout, ctx) => {
      const data = [], opts = [];
      for (let i = 0; i < args.length; i++) {
        if (isText(args[i])) { opts.push(text(args[i]), args[i + 1] && isText(args[i + 1]) ? text(args[i + 1]) : null); i++; } else data.push(args[i]);
      }
      let rowsMode = 'all';
      for (let i = 0; i < opts.length; i += 2) {
        if (opts[i] === 'rows') rowsMode = opts[i + 1];
        else throw new MatlabError(`corrcoef: unsupported option '${opts[i]}'`);
      }
      if (!['all', 'complete', 'pairwise'].includes(rowsMode)) throw new MatlabError("corrcoef: Rows must be 'all', 'complete' or 'pairwise'");
      let { cols } = variablesOf(data, 'corrcoef');
      if (cols.length === 0) return nargout >= 2 ? [Mat.scalar(NaN), Mat.scalar(NaN)] : [Mat.scalar(NaN)];
      if (rowsMode !== 'all') cols = dropNaNRows(cols);
      const C = covMatrix(cols, false);
      const p = cols.length;
      const R = Mat.zeros(p, p), P = Mat.zeros(p, p);
      const betainc = (x, a, b) => ctx.interp.builtins.get('betainc').fn([Mat.scalar(x), Mat.scalar(a), Mat.scalar(b)])[0].re[0];
      for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++) {
          // A zero or NaN variance gives NaN, as MATLAB (corrcoef(5) is NaN).
          const r = i === j ? (C.re[i * p + i] > 0 ? 1 : NaN) : C.re[j * p + i] / Math.sqrt(C.re[i * p + i] * C.re[j * p + j]);
          R.re[j * p + i] = Math.max(-1, Math.min(1, r)) || (Number.isNaN(r) ? NaN : 0);
          P.re[j * p + i] = i === j ? 1 : corrPValue(R.re[j * p + i], cols[0].length, betainc);
        }
      }
      return nargout >= 2 ? [R, P] : [R];
    },
  });

  reg.set('prctile', { fn: (args) => percentiles(args, 'prctile', 100) });
  reg.set('quantile', { fn: (args) => percentiles(args, 'quantile', 1) });

  // [N, edges, bin] = histcounts(X) | histcounts(X, nbins) | histcounts(X, edges)
  // | histcounts(..., 'BinWidth', w, 'BinLimits', [lo hi], 'NumBins', n,
  // 'BinEdges', e, 'BinMethod', 'auto'|'integers', 'Normalization', ...)
  reg.set('histcounts', {
    fn: (args, nargout) => {
      if (args.length === 0) throw new MatlabError('histcounts: expected histcounts(X)');
      const X = realArg(args[0], 'histcounts');
      const opts = {};
      let rest = args.slice(1);
      if (rest.length && !isText(rest[0])) {
        const b = rest.shift();
        if (b.numel === 1) opts.numBins = b.re[0]; else opts.binEdges = Array.from(b.re);
      }
      let normalization = 'count', limits = null, method = 'auto';
      for (let i = 0; i < rest.length; i += 2) {
        const name = text(rest[i]), v = rest[i + 1];
        if (!v) throw new MatlabError(`histcounts: ${rest[i].toJSString()} needs a value`);
        if (name === 'binwidth') opts.binWidth = v.toScalarNumber();
        else if (name === 'numbins') opts.numBins = v.toScalarNumber();
        else if (name === 'binedges') opts.binEdges = Array.from(v.re);
        else if (name === 'binlimits') limits = Array.from(v.re);
        else if (name === 'normalization') normalization = text(v);
        else if (name === 'binmethod') method = text(v);
        else throw new MatlabError(`histcounts: unsupported option '${rest[i].toJSString()}'`);
      }
      if (opts.numBins !== undefined && !(Number.isInteger(opts.numBins) && opts.numBins > 0)) throw new MatlabError('histcounts: the number of bins must be a positive integer');
      if (!['count', 'probability', 'pdf', 'countdensity', 'cumcount', 'cdf'].includes(normalization)) throw new MatlabError(`histcounts: unsupported Normalization '${normalization}'`);
      const all = Array.from(X.re);
      let data = all.filter(v => !Number.isNaN(v));
      let edges;
      if (opts.binEdges) edges = opts.binEdges;
      else if (method === 'integers') {
        const fin = data.filter(Number.isFinite);
        const lo = limits ? limits[0] : Math.min(...fin), hi = limits ? limits[1] : Math.max(...fin);
        edges = [];
        for (let e = Math.floor(lo) - 0.5; e <= Math.ceil(hi) + 0.5; e++) edges.push(e);
      } else {
        // With BinLimits, only data inside them counts, and the edges span them exactly.
        if (limits) data = data.filter(v => v >= limits[0] && v <= limits[1]);
        const span = data.filter(Number.isFinite);
        edges = histogramEdges(limits ? [limits[0], ...span, limits[1]] : span, opts);
        if (limits) { edges[0] = limits[0]; edges[edges.length - 1] = limits[1]; }
      }
      const counts = histogramCounts(data, edges);
      const N = new Mat(1, counts.length, Float64Array.from(normalizeCounts(counts, edges, normalization)));
      const out = [N, new Mat(1, edges.length, Float64Array.from(edges))];
      if (nargout >= 3) {
        const binOf = (v) => {
          if (Number.isNaN(v) || v < edges[0] || v > edges[edges.length - 1]) return 0;
          for (let k = 0; k < edges.length - 1; k++) if (v < edges[k + 1]) return k + 1;
          return edges.length - 1;
        };
        out.push(new Mat(X.rows, X.cols, Float64Array.from(all, binOf)));
      }
      return out.slice(0, Math.max(nargout, 1));
    },
  });

  // [n, idx] = histc(x, edges): n(k) counts edges(k) <= x < edges(k+1);
  // the last count is of x == edges(end).
  reg.set('histc', {
    fn: (args, nargout) => {
      if (args.length < 2) throw new MatlabError('histc: expected histc(x, edges)');
      const x = realArg(args[0], 'histc'), edges = Array.from(realArg(args[1], 'histc', 'edges').re);
      const n = edges.length;
      const counts = new Float64Array(n), idx = new Float64Array(x.numel);
      x.re.forEach((v, k) => {
        let b = 0;
        if (v === edges[n - 1]) b = n;
        else for (let j = 0; j < n - 1; j++) if (v >= edges[j] && v < edges[j + 1]) { b = j + 1; break; }
        idx[k] = b;
        if (b) counts[b - 1]++;
      });
      const N = x.cols === 1 && x.rows > 1 ? new Mat(n, 1, counts) : new Mat(1, n, counts);
      return nargout >= 2 ? [N, new Mat(x.rows, x.cols, idx)] : [N];
    },
  });

  // discretize(X, edges) | discretize(X, edges, values) | discretize(X, N) |
  // discretize(..., 'IncludedEdge', 'left'|'right')
  reg.set('discretize', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('discretize: expected discretize(X, edges)');
      const X = realArg(args[0], 'discretize');
      let rest = args.slice(1);
      const e = rest.shift();
      let edges = Array.from(e.re);
      if (e.numel === 1) edges = histogramEdges(Array.from(X.re).filter(Number.isFinite), { numBins: e.re[0] });
      for (let k = 1; k < edges.length; k++) if (!(edges[k] > edges[k - 1])) throw new MatlabError('discretize: edges must be increasing');
      let values = null, right = false;
      if (rest.length && !isText(rest[0])) values = Array.from(rest.shift().re);
      for (let i = 0; i < rest.length; i += 2) {
        if (text(rest[i]) !== 'includededge' || !rest[i + 1]) throw new MatlabError(`discretize: unsupported option '${rest[i].toJSString()}'`);
        right = text(rest[i + 1]) === 'right';
      }
      const nb = edges.length - 1;
      if (values && values.length !== nb) throw new MatlabError('discretize: values must have one element per bin');
      const binOf = (v) => {
        if (Number.isNaN(v) || v < edges[0] || v > edges[nb]) return NaN;
        if (!right) { for (let k = 0; k < nb; k++) if (v < edges[k + 1]) return k + 1; return nb; }
        for (let k = 0; k < nb; k++) if (v <= edges[k + 1] && (k > 0 ? v > edges[k] : true)) return k + 1;
        return NaN;
      };
      return [new Mat(X.rows, X.cols, Float64Array.from(X.re, (v) => { const b = binOf(v); return values && !Number.isNaN(b) ? values[b - 1] : b; }))];
    },
  });

  // accumarray(subs, val) | accumarray(subs, val, sz) | accumarray(subs, val, sz, fun) |
  // accumarray(subs, val, sz, fun, fillval)
  reg.set('accumarray', {
    fn: (args, _n, ctx) => {
      if (args.length < 2) throw new MatlabError('accumarray: expected accumarray(subs, val)');
      const subs = realArg(args[0], 'accumarray', 'subs');
      const val = realArg(args[1], 'accumarray', 'val');
      const twoD = subs.cols === 2 && subs.rows !== 1;
      const count = twoD ? subs.rows : subs.numel;
      if (val.numel !== 1 && val.numel !== count) throw new MatlabError('accumarray: val must be a scalar or have one element per row of subs');
      const idx = Array.from({ length: count }, (_, k) => (twoD ? [subs.re[k], subs.re[count + k]] : [subs.re[k], 1]));
      for (const [r, c] of idx) if (!(Number.isInteger(r) && r >= 1 && Number.isInteger(c) && c >= 1)) throw new MatlabError('accumarray: subscripts must be positive integers');
      let rows = Math.max(0, ...idx.map(p => p[0])), cols = Math.max(twoD ? 0 : 1, ...idx.map(p => p[1]));
      if (args[2] && !args[2].isEmpty) {
        const sz = Array.from(args[2].re);
        if (sz[0] < rows || (sz[1] ?? 1) < cols) throw new MatlabError('accumarray: the size must be at least as large as the largest subscripts');
        [rows, cols] = [sz[0], sz[1] ?? 1];
      }
      const fun = args[3] && !(args[3] instanceof Mat && args[3].isEmpty) ? args[3] : null;
      const fill = args[4] && !args[4].isEmpty ? args[4].toScalarNumber() : 0;
      const groups = new Map();
      idx.forEach(([r, c], k) => {
        const key = (c - 1) * rows + (r - 1);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(val.numel === 1 ? val.re[0] : val.re[k]);
      });
      const out = new Mat(rows, cols, new Float64Array(rows * cols).fill(fill));
      for (const [key, vals] of groups) {
        if (!fun) { out.re[key] = vals.reduce((s, v) => s + v, 0); continue; }
        const res = ctx.interp.callFunctionValue(fun, [new Mat(vals.length, 1, Float64Array.from(vals))], 1, ctx.scope)[0];
        if (!(res instanceof Mat) || res.numel !== 1) throw new MatlabError('accumarray: the function must return a scalar (cell outputs are not supported)');
        out.re[key] = res.re[0];
      }
      return [out];
    },
  });

  // cummax / cummin(A) | (A, dim) | (..., 'reverse'): running extremes, ignoring NaN.
  const cumExtreme = (fname, better) => ({
    fn: (args) => {
      const A = realArg(args[0], fname);
      let dim = null, reverse = false;
      for (const v of args.slice(1)) {
        if (isText(v)) {
          const o = text(v);
          if (o === 'reverse') reverse = true;
          else if (!['forward', 'omitnan', 'includenan', 'omitmissing', 'includemissing'].includes(o)) throw new MatlabError(`${fname}: unsupported option '${v.toJSString()}'`);
        } else dim = dimArg(v, fname);
      }
      const d = dim ?? firstDim(A);
      const len = d === 1 ? A.rows : d === 2 ? A.cols : 1;
      return [alongDim(A, d, len, (vals) => {
        const order = reverse ? vals.map((_, k) => vals.length - 1 - k) : vals.map((_, k) => k);
        const out = new Array(vals.length);
        let cur = NaN;
        for (const k of order) {
          const v = vals[k];
          if (!Number.isNaN(v) && (Number.isNaN(cur) || better(v, cur))) cur = v;
          out[k] = cur;
        }
        return out;
      })];
    },
  });
  reg.set('cummax', cumExtreme('cummax', (a, b) => a > b));
  reg.set('cummin', cumExtreme('cummin', (a, b) => a < b));

  const nanToEmpty = (f) => (w, wt) => (w.length === 0 ? NaN : f(w, wt));
  reg.set('movmean', { fn: (args) => [movingWindow('movmean', nanToEmpty(mean), args, false)] });
  reg.set('movsum', { fn: (args) => [movingWindow('movsum', (w) => w.reduce((s, v) => s + v, 0), args, false)] });
  reg.set('movprod', { fn: (args) => [movingWindow('movprod', (w) => w.reduce((s, v) => s * v, 1), args, false)] });
  reg.set('movmedian', { fn: (args) => [movingWindow('movmedian', (w) => (w.some(Number.isNaN) ? NaN : median(w)), args, false)] });
  reg.set('movmax', { fn: (args) => [movingWindow('movmax', (w) => { const f = w.filter(v => !Number.isNaN(v)); return f.length ? Math.max(...f) : NaN; }, args, false)] });
  reg.set('movmin', { fn: (args) => [movingWindow('movmin', (w) => { const f = w.filter(v => !Number.isNaN(v)); return f.length ? Math.min(...f) : NaN; }, args, false)] });
  reg.set('movvar', { fn: (args) => [movingWindow('movvar', nanToEmpty((w, wt) => variance(w, wt === 1)), args, true)] });
  reg.set('movstd', { fn: (args) => [movingWindow('movstd', nanToEmpty((w, wt) => Math.sqrt(variance(w, wt === 1))), args, true)] });

  // [N, C, S] = normalize(A) | normalize(A, dim) | normalize(..., method, type):
  // N = (A - C) ./ S. Methods: 'zscore' ('std' | 'robust'), 'range' ([a b]),
  // 'center' ('mean' | 'median' | value), 'scale' ('std' | 'mad' | 'first' | value),
  // 'norm' (p). Statistics skip NaN.
  reg.set('normalize', {
    fn: (args, nargout) => {
      const A = realArg(args[0], 'normalize');
      let i = 1, dim = null;
      if (i < args.length && !isText(args[i])) dim = dimArg(args[i++], 'normalize');
      let method = 'zscore', type = null;
      if (i < args.length) {
        method = text(args[i++]);
        if (i < args.length) type = isText(args[i]) ? text(args[i]) : Array.from(args[i].re);
        i++;
      }
      if (!['zscore', 'range', 'center', 'scale', 'norm'].includes(method)) throw new MatlabError(`normalize: unsupported method '${method}'`);
      const d = dim ?? firstDim(A);
      const stats = (vals) => {
        const v = vals.filter(x => !Number.isNaN(x));
        const mad = () => { const m = median(v); return median(v.map(x => Math.abs(x - m))); };
        switch (method) {
          case 'zscore':
            if (type === 'robust') return [median(v), mad()];
            if (type && type !== 'std') throw new MatlabError(`normalize: unsupported zscore type '${type}'`);
            return [mean(v), Math.sqrt(variance(v))];
          case 'range': {
            const [a, b] = Array.isArray(type) ? type : [0, 1];
            const lo = Math.min(...v), hi = Math.max(...v);
            const s = (hi - lo) / (b - a);
            return [lo - a * s, s];
          }
          case 'center':
            if (Array.isArray(type)) return [type[0], 1];
            if (type === 'median') return [median(v), 1];
            return [mean(v), 1];
          case 'scale':
            if (Array.isArray(type)) return [0, type[0]];
            if (type === 'mad') return [0, mad()];
            if (type === 'first') return [0, v[0]];
            return [0, Math.sqrt(variance(v))];
          default: { // norm
            const p = Array.isArray(type) ? type[0] : 2;
            return [0, p === Infinity ? Math.max(...v.map(Math.abs)) : v.reduce((s, x) => s + Math.abs(x) ** p, 0) ** (1 / p)];
          }
        }
      };
      const len = d === 1 ? A.rows : d === 2 ? A.cols : 1;
      const Cs = [], Ss = [];
      const N = alongDim(A, d, len, (vals) => {
        const [c, s] = stats(vals);
        Cs.push(c); Ss.push(s);
        return vals.map(x => (x - c) / s);
      });
      const shape = (arr) => (d === 1 ? new Mat(1, arr.length, Float64Array.from(arr)) : new Mat(arr.length, 1, Float64Array.from(arr)));
      return nargout >= 2 ? [N, shape(Cs), shape(Ss)] : [N];
    },
  });

  // rescale(A) | rescale(A, l, u) | rescale(..., 'InputMin', m, 'InputMax', M)
  reg.set('rescale', {
    fn: (args) => {
      const A = realArg(args[0], 'rescale');
      let i = 1, l = 0, u = 1;
      if (args.length >= 3 && !isText(args[1])) { l = args[1].toScalarNumber(); u = args[2].toScalarNumber(); i = 3; }
      const finite = Array.from(A.re).filter(v => !Number.isNaN(v));
      let inMin = Math.min(...finite), inMax = Math.max(...finite);
      for (; i < args.length; i += 2) {
        const name = text(args[i]);
        if (name === 'inputmin') inMin = args[i + 1].toScalarNumber();
        else if (name === 'inputmax') inMax = args[i + 1].toScalarNumber();
        else throw new MatlabError(`rescale: unsupported option '${args[i].toJSString()}'`);
      }
      return [Mat.mapElementwise(A, (x) => {
        const c = Math.min(Math.max(x, inMin), inMax);
        return [inMax === inMin ? l : l + ((c - inMin) / (inMax - inMin)) * (u - l), 0];
      })];
    },
  });

  // [S, L] = bounds(A) | bounds(A, dim) | bounds(A, 'all'): smallest and largest.
  reg.set('bounds', {
    fn: (args, _n, ctx) => {
      const rest = args.length >= 2 ? [Mat.empty(), ...args.slice(1)] : [];
      const S = ctx.interp.builtins.get('min').fn([args[0], ...rest], 1, ctx)[0];
      const L = ctx.interp.builtins.get('max').fn([args[0], ...rest], 1, ctx)[0];
      return [S, L];
    },
  });

  // vecnorm(A) | vecnorm(A, p) | vecnorm(A, p, dim): p-norm of each column (or row).
  reg.set('vecnorm', {
    fn: (args) => {
      const A = args[0];
      if (!(A instanceof Mat) || A.isChar) throw new MatlabError('vecnorm: input must be numeric');
      const p = args[1] && !args[1].isEmpty ? args[1].toScalarNumber() : 2;
      if (!(p > 0)) throw new MatlabError('vecnorm: p must be positive');
      const d = args[2] ? dimArg(args[2], 'vecnorm') : firstDim(A);
      const mags = new Mat(A.rows, A.cols, Float64Array.from(A.re, (r, k) => Math.hypot(r, A.isComplex ? A.im[k] : 0)));
      return [alongDim(mags, d, 1, (v) => [p === Infinity ? Math.max(...v) : p === 2 ? Math.hypot(...v) : v.reduce((s, x) => s + x ** p, 0) ** (1 / p)])];
    },
  });
}

