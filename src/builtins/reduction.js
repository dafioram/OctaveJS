// reduction.js — Statistics/reduction builtins. Default reduction dimension
// follows MATLAB's rule: the first non-singleton dimension (i.e. down each
// column for an ordinary matrix, or along the vector itself for a vector).

import { Mat, MatlabError } from '../core/values.js';

function defaultDim(mat) {
  if (mat.rows === 1) return 2;
  return 1;
}
// MATLAB reduces a 0-by-0 input with no dimension given to a scalar:
// sum([]) is 0, prod([]) is 1, mean([]) is NaN.
const emptySquare = (m) => m.rows === 0 && m.cols === 0;

function columnsOf(mat) {
  const cols = [];
  for (let c = 0; c < mat.cols; c++) {
    const col = [];
    for (let r = 0; r < mat.rows; r++) {
      const k = c * mat.rows + r;
      col.push({ re: mat.re[k], im: mat.isComplex ? mat.im[k] : 0 });
    }
    cols.push(col);
  }
  return cols;
}
function rowsOf(mat) {
  const rows = [];
  for (let r = 0; r < mat.rows; r++) {
    const row = [];
    for (let c = 0; c < mat.cols; c++) {
      const k = c * mat.rows + r;
      row.push({ re: mat.re[k], im: mat.isComplex ? mat.im[k] : 0 });
    }
    rows.push(row);
  }
  return rows;
}

// Reduce along `dim` (1=down columns, 2=across rows), fn(values[]) -> {re,im}.
// A dim of 3 or more is a singleton dimension of a 2-D array, so each
// element is reduced on its own (sum(A,3) is A itself, as in MATLAB).
// An empty slice reduces to fn([]): sum(zeros(0,3)) is [0 0 0] and
// mean(zeros(0,3)) is [NaN NaN NaN], as in MATLAB.
function reduceAlong(mat, dim, fn) {
  if (dim >= 3) {
    const re = new Float64Array(mat.numel);
    let im = null;
    for (let k = 0; k < mat.numel; k++) {
      const r = fn([{ re: mat.re[k], im: mat.isComplex ? mat.im[k] : 0 }]);
      re[k] = r.re;
      if (r.im !== 0) { if (!im) im = new Float64Array(mat.numel); im[k] = r.im; }
    }
    return new Mat(mat.rows, mat.cols, re, im);
  }
  if (dim === 1) {
    const cols = columnsOf(mat);
    const results = cols.map(fn);
    const re = new Float64Array(results.length);
    const anyComplex = results.some(r => r.im !== 0);
    const im = anyComplex ? new Float64Array(results.length) : null;
    results.forEach((r, i) => { re[i] = r.re; if (im) im[i] = r.im; });
    return new Mat(1, results.length, re, im);
  } else {
    const rows = rowsOf(mat);
    const results = rows.map(fn);
    const re = new Float64Array(results.length);
    const anyComplex = results.some(r => r.im !== 0);
    const im = anyComplex ? new Float64Array(results.length) : null;
    results.forEach((r, i) => { re[i] = r.re; if (im) im[i] = r.im; });
    return new Mat(results.length, 1, re, im);
  }
}

function cumAlong(mat, dim, combine, init) {
  if (mat.isEmpty) return Mat.empty();
  if (dim >= 3) { const out = mat.clone(); out.isLogical = false; out.isChar = false; return out; }
  const re = new Float64Array(mat.numel);
  const im = mat.isComplex ? new Float64Array(mat.numel) : null;
  if (dim === 1) {
    for (let c = 0; c < mat.cols; c++) {
      let acc = init();
      for (let r = 0; r < mat.rows; r++) {
        const k = c * mat.rows + r;
        acc = combine(acc, { re: mat.re[k], im: mat.isComplex ? mat.im[k] : 0 });
        re[k] = acc.re; if (im) im[k] = acc.im;
      }
    }
  } else {
    for (let r = 0; r < mat.rows; r++) {
      let acc = init();
      for (let c = 0; c < mat.cols; c++) {
        const k = c * mat.rows + r;
        acc = combine(acc, { re: mat.re[k], im: mat.isComplex ? mat.im[k] : 0 });
        re[k] = acc.re; if (im) im[k] = acc.im;
      }
    }
  }
  return new Mat(mat.rows, mat.cols, re, im);
}

function getDimArg(args, pos = 1) {
  if (args.length > pos) {
    const d = Math.round(args[pos].toScalarNumber());
    if (!(d >= 1)) throw new MatlabError('Dimension argument must be a positive integer');
    return d;
  }
  return null;
}

// Trailing text options accepted by the reductions: 'all' reduces over
// every element; 'omitnan'/'includenan' choose whether NaNs are skipped.
const FLAG_NAMES = new Set(['all', 'omitnan', 'includenan', 'omitmissing', 'includemissing', 'double', 'native', 'default']);
function splitFlags(args) {
  const out = { args: args.slice(), all: false, omitnan: null };
  while (out.args.length > 1) {
    const last = out.args[out.args.length - 1];
    if (!(last instanceof Mat && last.isChar)) break;
    const f = last.toJSString().toLowerCase();
    if (!FLAG_NAMES.has(f)) throw new MatlabError(`Unrecognized option '${f}'`);
    if (f === 'all') out.all = true;
    else if (f === 'omitnan' || f === 'omitmissing') out.omitnan = true;
    else if (f === 'includenan' || f === 'includemissing') out.omitnan = false;
    out.args.pop();
  }
  return out;
}
const isNaNVal = (v) => Number.isNaN(v.re) || Number.isNaN(v.im);
function asColumn(m) {
  return new Mat(m.numel, 1, Float64Array.from(m.re), m.im ? Float64Array.from(m.im) : null, { isLogical: m.isLogical, isChar: m.isChar });
}

// sum/prod/mean/median style reduction with dim, 'all' and NaN options.
function reduction(fn, nanDefault = false) {
  return (args) => {
    const { args: a, all, omitnan } = splitFlags(args);
    const dimArg = getDimArg(a);
    const whole = all || (dimArg === null && emptySquare(a[0]));
    const x = whole ? asColumn(a[0]) : a[0];
    const dim = whole ? 1 : (dimArg || defaultDim(x));
    const skip = omitnan === null ? nanDefault : omitnan;
    return [reduceAlong(x, dim, skip ? (vals) => fn(vals.filter(v => !isNaNVal(v))) : fn)];
  };
}

function sumVals(vals) { return vals.reduce((a, v) => ({ re: a.re + v.re, im: a.im + v.im }), { re: 0, im: 0 }); }
function prodVals(vals) { return vals.reduce((a, v) => ({ re: a.re * v.re - a.im * v.im, im: a.re * v.im + a.im * v.re }), { re: 1, im: 0 }); }
function meanVals(vals) { const s = sumVals(vals); return { re: s.re / vals.length, im: vals.length ? s.im / vals.length : 0 }; }

export function registerReduction(reg) {
  reg.set('sum', { fn: reduction(sumVals) });
  reg.set('prod', { fn: reduction(prodVals) });
  reg.set('mean', { fn: reduction(meanVals) });
  // cumsum/cumprod(X, dim, 'omitnan'): with 'omitnan', NaNs leave the
  // running total unchanged.
  const cumulative = (combine, init) => (args) => {
    const { args: a, omitnan } = splitFlags(args);
    const step = omitnan ? (acc, v) => (isNaNVal(v) ? acc : combine(acc, v)) : combine;
    return [cumAlong(a[0], getDimArg(a) || defaultDim(a[0]), step, init)];
  };
  reg.set('cumsum', { fn: cumulative((a, v) => ({ re: a.re + v.re, im: a.im + v.im }), () => ({ re: 0, im: 0 })) });
  reg.set('cumprod', { fn: cumulative((a, v) => ({ re: a.re * v.re - a.im * v.im, im: a.re * v.im + a.im * v.re }), () => ({ re: 1, im: 0 })) });

  reg.set('median', {
    fn: reduction((vals) => {
      if (vals.length === 0 || vals.some(isNaNVal)) return { re: NaN, im: 0 }; // includenan (default): any NaN gives NaN
      const xs = vals.map(v => v.re).sort((a, b) => a - b);
      const n = xs.length;
      const m = n % 2 === 1 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
      return { re: m, im: 0 };
    }),
  });

  function variance(vals, sampleCorrection) {
    if (vals.length === 0) return { re: NaN, im: 0 };
    const mu = meanVals(vals);
    let s = 0;
    for (const v of vals) {
      const dr = v.re - mu.re, di = v.im - mu.im;
      s += dr * dr + di * di;
    }
    const denom = sampleCorrection ? Math.max(vals.length - 1, 1) : vals.length;
    return { re: s / denom, im: 0 };
  }
  // var(X), var(X, w), var(X, w, dim): w = 0 (or []) normalizes by N-1,
  // w = 1 by N — the second argument is a weight, not a dimension.
  function varianceArgs(allArgs) {
    const { args, all, omitnan } = splitFlags(allArgs);
    const whole = all || (getDimArg(args, 2) === null && emptySquare(args[0]));
    if (whole) args[0] = asColumn(args[0]);
    let population = false;
    if (args.length >= 2 && !args[1].isEmpty) {
      const w = args[1].toScalarNumber();
      if (w !== 0 && w !== 1) throw new MatlabError('Weight argument must be 0 or 1');
      population = w === 1;
    }
    const dim = whole ? 1 : (getDimArg(args, 2) || defaultDim(args[0]));
    return reduceAlong(args[0], dim, (v) => variance(omitnan ? v.filter(x => !isNaNVal(x)) : v, !population));
  }
  reg.set('var', { fn: (args) => [varianceArgs(args)] });
  reg.set('std', { fn: (args) => [Mat.mapElementwise(varianceArgs(args), (r) => [Math.sqrt(r), 0])] });

  // max/min: max(X), [m,i] = max(X), max(X,[],dim), max(A,B).
  // NaNs are ignored unless every candidate is NaN; complex arrays compare
  // by magnitude (MATLAB's rule).
  // max(X, [], dim|'all', 'omitnan'|'includenan'): NaNs are skipped by
  // default; with 'includenan' any NaN wins.
  function extremum(allArgs, isMax) {
    const { args, all, omitnan } = splitFlags(allArgs);
    const includeNan = omitnan === false;
    const a = all ? asColumn(args[0]) : args[0];
    const better = (x, y) => isMax ? x > y : x < y;
    if (args.length >= 2 && !args[1].isEmpty) {
      const b = args[1];
      const cx = a.isComplex || b.isComplex;
      const key = (r, i) => cx ? Math.hypot(r, i) : r;
      return [Mat.broadcastBinary(a, b, (ar, ai, br, bi) => {
        const ka = key(ar, ai), kb = key(br, bi);
        if (includeNan && (Number.isNaN(ka) || Number.isNaN(kb))) return [NaN, 0];
        if (Number.isNaN(ka)) return [br, bi];
        if (Number.isNaN(kb)) return [ar, ai];
        return better(kb, ka) ? [br, bi] : [ar, ai];
      })];
    }
    if (a.isEmpty) return [Mat.empty(), Mat.empty()];
    const dim = all ? 1 : (getDimArg(args, 2) || defaultDim(a));
    const key = (v) => a.isComplex ? Math.hypot(v.re, v.im) : v.re;
    const pick = (vals) => {
      let best = -1;
      for (let i = 0; i < vals.length; i++) {
        const k = key(vals[i]);
        if (Number.isNaN(k)) {
          if (includeNan) return { val: vals[i], idx: i + 1 };
          continue;
        }
        if (best < 0 || better(k, key(vals[best]))) best = i;
      }
      if (best < 0) best = 0; // all NaN
      return { val: vals[best], idx: best + 1 };
    };
    let picks, rows, cols;
    if (dim === 1) { picks = columnsOf(a).map(pick); rows = 1; cols = picks.length; }
    else if (dim === 2) { picks = rowsOf(a).map(pick); rows = picks.length; cols = 1; }
    else {
      picks = Array.from({ length: a.numel }, (_, k) => ({ val: { re: a.re[k], im: a.isComplex ? a.im[k] : 0 }, idx: 1 }));
      rows = a.rows; cols = a.cols;
    }
    const re = new Float64Array(picks.length), idxRe = new Float64Array(picks.length);
    let im = null;
    picks.forEach((p, i) => {
      re[i] = p.val.re; idxRe[i] = p.idx;
      if (p.val.im !== 0) { if (!im) im = new Float64Array(picks.length); im[i] = p.val.im; }
    });
    return [new Mat(rows, cols, re, im), new Mat(rows, cols, idxRe)];
  }
  reg.set('max', { fn: (args) => extremum(args, true) });
  reg.set('min', { fn: (args) => extremum(args, false) });
  reg.set('range', {
    fn: (args) => {
      // range(X, dim): dim is the 2nd argument here, unlike max(X, [], dim).
      const extArgs = args.length >= 2 ? [args[0], Mat.empty(), args[1]] : [args[0]];
      const [mx] = extremum(extArgs, true);
      const [mn] = extremum(extArgs, false);
      return [Mat.broadcastBinary(mx, mn, (ar, _ai, br, _bi) => [ar - br, 0])];
    },
  });
}
