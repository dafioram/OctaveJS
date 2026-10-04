// reduction.js — Statistics/reduction builtins. Default reduction dimension
// follows MATLAB's rule: the first non-singleton dimension (i.e. down each
// column for an ordinary matrix, or along the vector itself for a vector).

import { Mat, MatlabError } from '../core/values.js';

function defaultDim(mat) {
  if (mat.rows === 1) return 2;
  return 1;
}

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
function reduceAlong(mat, dim, fn) {
  if (mat.isEmpty) return Mat.empty();
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

function sumVals(vals) { return vals.reduce((a, v) => ({ re: a.re + v.re, im: a.im + v.im }), { re: 0, im: 0 }); }
function prodVals(vals) { return vals.reduce((a, v) => ({ re: a.re * v.re - a.im * v.im, im: a.re * v.im + a.im * v.re }), { re: 1, im: 0 }); }
function meanVals(vals) { const s = sumVals(vals); return { re: s.re / vals.length, im: s.im / vals.length }; }

export function registerReduction(reg) {
  reg.set('sum', { fn: (args) => [reduceAlong(args[0], getDimArg(args) || defaultDim(args[0]), sumVals)] });
  reg.set('prod', { fn: (args) => [reduceAlong(args[0], getDimArg(args) || defaultDim(args[0]), prodVals)] });
  reg.set('mean', { fn: (args) => [reduceAlong(args[0], getDimArg(args) || defaultDim(args[0]), meanVals)] });
  reg.set('cumsum', { fn: (args) => [cumAlong(args[0], getDimArg(args) || defaultDim(args[0]), (a, v) => ({ re: a.re + v.re, im: a.im + v.im }), () => ({ re: 0, im: 0 }))] });
  reg.set('cumprod', { fn: (args) => [cumAlong(args[0], getDimArg(args) || defaultDim(args[0]), (a, v) => ({ re: a.re * v.re - a.im * v.im, im: a.re * v.im + a.im * v.re }), () => ({ re: 1, im: 0 }))] });

  reg.set('median', {
    fn: (args) => [reduceAlong(args[0], getDimArg(args) || defaultDim(args[0]), (vals) => {
      const xs = vals.map(v => v.re).sort((a, b) => a - b);
      const n = xs.length;
      const m = n % 2 === 1 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
      return { re: m, im: 0 };
    })],
  });

  function variance(vals, sampleCorrection) {
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
  function varianceArgs(args) {
    let population = false;
    if (args.length >= 2 && !args[1].isEmpty) {
      const w = args[1].toScalarNumber();
      if (w !== 0 && w !== 1) throw new MatlabError('Weight argument must be 0 or 1');
      population = w === 1;
    }
    const dim = getDimArg(args, 2) || defaultDim(args[0]);
    return reduceAlong(args[0], dim, (v) => variance(v, !population));
  }
  reg.set('var', { fn: (args) => [varianceArgs(args)] });
  reg.set('std', { fn: (args) => [Mat.mapElementwise(varianceArgs(args), (r) => [Math.sqrt(r), 0])] });

  // max/min: max(X), [m,i] = max(X), max(X,[],dim), max(A,B).
  // NaNs are ignored unless every candidate is NaN; complex arrays compare
  // by magnitude (MATLAB's rule).
  function extremum(args, isMax) {
    const a = args[0];
    const better = (x, y) => isMax ? x > y : x < y;
    if (args.length >= 2 && !args[1].isEmpty) {
      const b = args[1];
      const cx = a.isComplex || b.isComplex;
      const key = (r, i) => cx ? Math.hypot(r, i) : r;
      return [Mat.broadcastBinary(a, b, (ar, ai, br, bi) => {
        const ka = key(ar, ai), kb = key(br, bi);
        if (Number.isNaN(ka)) return [br, bi];
        if (Number.isNaN(kb)) return [ar, ai];
        return better(kb, ka) ? [br, bi] : [ar, ai];
      })];
    }
    if (a.isEmpty) return [Mat.empty(), Mat.empty()];
    const dim = getDimArg(args, 2) || defaultDim(a);
    const key = (v) => a.isComplex ? Math.hypot(v.re, v.im) : v.re;
    const pick = (vals) => {
      let best = -1;
      for (let i = 0; i < vals.length; i++) {
        const k = key(vals[i]);
        if (Number.isNaN(k)) continue;
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
