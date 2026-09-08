// arrayops.js — find/any/all, NaN/Inf predicates, fliplr/flipud/flip,
// sort, unique, repmat, and the cat/horzcat/vertcat function forms of
// matrix concatenation (which the interpreter already does for `[A B]`
// and `[A;B]` — these just expose that as callable functions).

import { Mat, MatlabError } from '../core/values.js';

function tagLogical(mat) { mat.isLogical = true; return mat; }

function nonzeroPositions(mat) {
  const positions = [];
  for (let k = 0; k < mat.numel; k++) {
    const re = mat.re[k], im = mat.isComplex ? mat.im[k] : 0;
    if (re !== 0 || im !== 0) positions.push(k);
  }
  return positions;
}

function anyAll(mat, mode) {
  const allMode = mode === 'all';
  if (mat.isEmpty) return Mat.logicalScalar(allMode); // MATLAB: all([])=true, any([])=false
  const testCol = (colStart, count, stride) => {
    let result = allMode;
    for (let i = 0; i < count; i++) {
      const k = colStart + i * stride;
      const nz = mat.re[k] !== 0 || (mat.isComplex && mat.im[k] !== 0);
      if (!allMode && nz) return true;
      if (allMode && !nz) return false;
    }
    return result;
  };
  if (mat.rows === 1 || mat.cols === 1) {
    return Mat.logicalScalar(testCol(0, mat.numel, 1));
  }
  const re = new Float64Array(mat.cols);
  for (let c = 0; c < mat.cols; c++) re[c] = testCol(c * mat.rows, mat.rows, 1) ? 1 : 0;
  return tagLogical(new Mat(1, mat.cols, re));
}

function flipDim(mat, dim) {
  const out = mat.clone();
  if (dim === 2) {
    for (let c = 0; c < mat.cols; c++) {
      const srcCol = mat.cols - 1 - c;
      for (let r = 0; r < mat.rows; r++) {
        out.setLin(c * mat.rows + r, mat.re[srcCol * mat.rows + r], mat.isComplex ? mat.im[srcCol * mat.rows + r] : 0);
      }
    }
  } else {
    for (let r = 0; r < mat.rows; r++) {
      const srcRow = mat.rows - 1 - r;
      for (let c = 0; c < mat.cols; c++) {
        out.setLin(c * mat.rows + r, mat.re[c * mat.rows + srcRow], mat.isComplex ? mat.im[c * mat.rows + srcRow] : 0);
      }
    }
  }
  return out;
}

function compareForSort(x, y, descending) {
  const xm = x.im !== 0 ? Math.hypot(x.re, x.im) : x.re;
  const ym = y.im !== 0 ? Math.hypot(y.re, y.im) : y.re;
  const xNaN = Number.isNaN(xm), yNaN = Number.isNaN(ym);
  if (xNaN && yNaN) return 0;
  if (xNaN) return 1; // NaN always sorts last, regardless of direction (matches MATLAB)
  if (yNaN) return -1;
  return descending ? (ym - xm) : (xm - ym);
}

export function registerArrayOps(reg) {
  reg.set('find', {
    fn: (args, nargout) => {
      const a = args[0];
      let positions = nonzeroPositions(a);
      let n = null, dir = 'first';
      for (let i = 1; i < args.length; i++) {
        if (args[i].isChar) dir = args[i].toJSString().toLowerCase();
        else n = Math.round(args[i].toScalarNumber());
      }
      if (n !== null) positions = dir === 'last' ? positions.slice(-n) : positions.slice(0, n);
      const isRow = a.rows === 1;
      if (nargout >= 2) {
        const rows = new Float64Array(positions.length), cols = new Float64Array(positions.length);
        positions.forEach((p, i) => { rows[i] = (p % a.rows) + 1; cols[i] = Math.floor(p / a.rows) + 1; });
        const mk = (data) => isRow ? new Mat(1, positions.length, data) : new Mat(positions.length, 1, data);
        if (nargout >= 3) {
          const vals = new Float64Array(positions.length);
          let vim = null;
          positions.forEach((p, i) => { vals[i] = a.re[p]; if (a.isComplex && a.im[p] !== 0) { if (!vim) vim = new Float64Array(positions.length); vim[i] = a.im[p]; } });
          return [mk(rows), mk(cols), isRow ? new Mat(1, positions.length, vals, vim) : new Mat(positions.length, 1, vals, vim)];
        }
        return [mk(rows), mk(cols)];
      }
      const re = new Float64Array(positions.length);
      positions.forEach((p, i) => { re[i] = p + 1; });
      return [isRow ? new Mat(1, positions.length, re) : new Mat(positions.length, 1, re)];
    },
  });

  reg.set('any', { fn: (args) => [anyAll(args[0], 'any')] });
  reg.set('all', { fn: (args) => [anyAll(args[0], 'all')] });

  reg.set('isnan', { fn: (args) => [tagLogical(Mat.mapElementwise(args[0], (r, i) => [(Number.isNaN(r) || Number.isNaN(i)) ? 1 : 0, 0]))] });
  reg.set('isinf', { fn: (args) => [tagLogical(Mat.mapElementwise(args[0], (r, i) => [((!isFinite(r) && !Number.isNaN(r)) || (!isFinite(i) && !Number.isNaN(i))) ? 1 : 0, 0]))] });
  reg.set('isfinite', { fn: (args) => [tagLogical(Mat.mapElementwise(args[0], (r, i) => [(isFinite(r) && isFinite(i)) ? 1 : 0, 0]))] });

  reg.set('fliplr', { fn: (args) => [flipDim(args[0], 2)] });
  reg.set('flipud', { fn: (args) => [flipDim(args[0], 1)] });
  reg.set('flip', {
    fn: (args) => {
      const a = args[0];
      const dim = args.length >= 2 ? Math.round(args[1].toScalarNumber()) : (a.rows === 1 ? 2 : 1);
      return [flipDim(a, dim)];
    },
  });

  reg.set('sort', {
    fn: (args, nargout) => {
      const a = args[0];
      let dim = a.rows === 1 ? 2 : 1;
      let descending = false;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.isChar) descending = arg.toJSString().toLowerCase() === 'descend';
        else dim = Math.round(arg.toScalarNumber());
      }
      const sorted = Mat.zeros(a.rows, a.cols);
      if (a.isComplex) sorted.im = new Float64Array(a.numel);
      const idxMat = Mat.zeros(a.rows, a.cols);
      const sortSlice = (getter, setter, count) => {
        const entries = [];
        for (let i = 0; i < count; i++) entries.push({ ...getter(i), idx: i });
        entries.sort((x, y) => compareForSort(x, y, descending));
        entries.forEach((entry, i) => setter(i, entry));
      };
      if (dim === 1) {
        for (let c = 0; c < a.cols; c++) {
          sortSlice(
            (r) => ({ re: a.re[c * a.rows + r], im: a.isComplex ? a.im[c * a.rows + r] : 0 }),
            (r, entry) => { sorted.re[c * a.rows + r] = entry.re; if (sorted.im) sorted.im[c * a.rows + r] = entry.im; idxMat.re[c * a.rows + r] = entry.idx + 1; },
            a.rows,
          );
        }
      } else {
        for (let r = 0; r < a.rows; r++) {
          sortSlice(
            (c) => ({ re: a.re[c * a.rows + r], im: a.isComplex ? a.im[c * a.rows + r] : 0 }),
            (c, entry) => { sorted.re[c * a.rows + r] = entry.re; if (sorted.im) sorted.im[c * a.rows + r] = entry.im; idxMat.re[c * a.rows + r] = entry.idx + 1; },
            a.cols,
          );
        }
      }
      sorted.isChar = a.isChar;
      return nargout >= 2 ? [sorted, idxMat] : [sorted];
    },
  });

  reg.set('unique', {
    fn: (args) => {
      const a = args[0];
      const seen = new Map();
      for (let k = 0; k < a.numel; k++) {
        const key = a.re[k] + (a.isComplex ? ('_' + a.im[k]) : '');
        if (!seen.has(key)) seen.set(key, { re: a.re[k], im: a.isComplex ? a.im[k] : 0 });
      }
      const vals = [...seen.values()].sort((x, y) => x.re - y.re);
      const re = new Float64Array(vals.length);
      let im = null;
      vals.forEach((v, i) => { re[i] = v.re; if (v.im !== 0) { if (!im) im = new Float64Array(vals.length); im[i] = v.im; } });
      return [new Mat(vals.length, 1, re, im)];
    },
  });

  reg.set('repmat', {
    fn: (args) => {
      const a = args[0];
      let m, n;
      if (args.length === 2 && args[1].numel === 2) { m = Math.round(args[1].re[0]); n = Math.round(args[1].re[1]); }
      else if (args.length === 2) { m = n = Math.round(args[1].toScalarNumber()); }
      else { m = Math.round(args[1].toScalarNumber()); n = Math.round(args[2].toScalarNumber()); }
      const rows = a.rows * m, cols = a.cols * n;
      const re = new Float64Array(rows * cols);
      const im = a.isComplex ? new Float64Array(rows * cols) : null;
      for (let bi = 0; bi < m; bi++) {
        for (let bj = 0; bj < n; bj++) {
          for (let r = 0; r < a.rows; r++) {
            for (let c = 0; c < a.cols; c++) {
              const dr = bi * a.rows + r, dc = bj * a.cols + c;
              re[dc * rows + dr] = a.re[c * a.rows + r];
              if (im) im[dc * rows + dr] = a.im[c * a.rows + r];
            }
          }
        }
      }
      return [new Mat(rows, cols, re, im, { isChar: a.isChar, isLogical: a.isLogical })];
    },
  });

  reg.set('horzcat', { fn: (args, _n, ctx) => [ctx.interp.hconcat(args)] });
  reg.set('vertcat', { fn: (args, _n, ctx) => [ctx.interp.vconcat(args)] });
  reg.set('cat', {
    fn: (args, _n, ctx) => {
      const dim = Math.round(args[0].toScalarNumber());
      const rest = args.slice(1);
      return [dim === 1 ? ctx.interp.vconcat(rest) : ctx.interp.hconcat(rest)];
    },
  });
}
