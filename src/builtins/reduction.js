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

// Reduce along `dim` (1=down columns, 2=across rows), fn(values[]) -> {re,im}
function reduceAlong(mat, dim, fn) {
  if (mat.isEmpty) return Mat.empty();
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

function getDimArg(args) {
  if (args.length >= 2) return Math.round(args[1].toScalarNumber());
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
  reg.set('var', { fn: (args) => [reduceAlong(args[0], getDimArg(args) || defaultDim(args[0]), (v) => variance(v, true))] });
  reg.set('std', {
    fn: (args) => {
      const m = reduceAlong(args[0], getDimArg(args) || defaultDim(args[0]), (v) => variance(v, true));
      return [Mat.mapElementwise(m, (r) => [Math.sqrt(r), 0])];
    },
  });

  function extremum(args, better) {
    const a = args[0];
    if (args.length >= 2 && args[1] instanceof Mat && args[1].numel > 0) {
      // elementwise min/max of two arrays
      return [Mat.broadcastBinary(a, args[1], (ar, ai, br, bi) => better(ar, br) ? [ar, ai] : [br, bi])];
    }
    const dim = defaultDim(a);
    if (a.isEmpty) return [Mat.empty(), Mat.empty()];
    const pick = (vals) => {
      let bestIdx = 0;
      for (let i = 1; i < vals.length; i++) if (better(vals[i].re, vals[bestIdx].re) && vals[i].re !== vals[bestIdx].re) bestIdx = i;
      return { val: vals[bestIdx], idx: bestIdx + 1 };
    };
    if (dim === 1) {
      const cols = columnsOf(a);
      const picks = cols.map(pick);
      const re = new Float64Array(picks.length), idxRe = new Float64Array(picks.length);
      picks.forEach((p, i) => { re[i] = p.val.re; idxRe[i] = p.idx; });
      return [new Mat(1, picks.length, re), new Mat(1, picks.length, idxRe)];
    } else {
      const rows = rowsOf(a);
      const picks = rows.map(pick);
      const re = new Float64Array(picks.length), idxRe = new Float64Array(picks.length);
      picks.forEach((p, i) => { re[i] = p.val.re; idxRe[i] = p.idx; });
      return [new Mat(picks.length, 1, re), new Mat(picks.length, 1, idxRe)];
    }
  }
  reg.set('max', { fn: (args) => extremum(args, (x, y) => x > y) });
  reg.set('min', { fn: (args) => extremum(args, (x, y) => x < y) });
  reg.set('range', {
    fn: (args) => {
      const [mx] = extremum(args, (x, y) => x > y);
      const [mn] = extremum(args, (x, y) => x < y);
      return [Mat.broadcastBinary(mx, mn, (ar, _ai, br, _bi) => [ar - br, 0])];
    },
  });
}
