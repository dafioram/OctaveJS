// missing.js — Missing data (NaN for numbers, '' in cell arrays of text,
// blank characters in char arrays): ismissing, anynan, allfinite,
// standardizeMissing, rmmissing and fillmissing.

import { Mat, Cell, MatlabError } from '../core/values.js';

const tagLogical = (m) => { m.isLogical = true; return m; };
const isText = (v) => v instanceof Mat && v.isChar;

// Element-by-element "is missing" flags for A (optionally against a list
// of indicator values instead of the standard missing value).
function missingFlags(a, indicators, fname) {
  if (a instanceof Cell) {
    if (!a.isCellstr()) throw new MatlabError(`${fname}: cell arrays must contain only character vectors`);
    const texts = indicators ? indicators.map(String) : [''];
    return a.data.map(v => texts.includes(v.toJSString()));
  }
  if (!(a instanceof Mat)) throw new MatlabError(`${fname}: input must be numeric, char, or a cell array of character vectors`);
  if (a.isChar && !indicators) return Array.from(a.re, c => c === 32);
  const flags = new Array(a.numel);
  for (let k = 0; k < a.numel; k++) {
    const re = a.re[k], im = a.isComplex ? a.im[k] : 0;
    const nan = Number.isNaN(re) || Number.isNaN(im);
    if (!indicators) { flags[k] = nan; continue; }
    flags[k] = indicators.some(ind => (typeof ind === 'number' ? (Number.isNaN(ind) ? nan : re === ind && im === 0) : false));
  }
  return flags;
}

// Indicator values from ismissing(A, indicator) / standardizeMissing(A, indicator).
function indicatorList(v, fname) {
  if (v instanceof Cell) return v.data.map(x => (isText(x) ? x.toJSString() : x.re[0]));
  if (isText(v)) return [v.toJSString()];
  if (v instanceof Mat) return Array.from(v.re);
  throw new MatlabError(`${fname}: invalid missing value indicator`);
}

function firstDim(a) { return a.rows !== 1 ? 1 : 2; }

function dimOf(v, fname) {
  const d = v.toScalarNumber();
  if (!Number.isInteger(d) || d < 1) throw new MatlabError(`${fname}: dimension must be a positive integer`);
  return d;
}

// The elements of A at linear positions keep, as an array shaped like
// MATLAB's rmmissing result.
function subset(a, rows, cols, positions) {
  if (a instanceof Cell) return new Cell(rows, cols, positions.map(k => a.data[k]));
  const out = new Mat(rows, cols, Float64Array.from(positions, k => a.re[k]), a.im ? Float64Array.from(positions, k => a.im[k]) : null, { isChar: a.isChar, isLogical: a.isLogical });
  return out;
}

export function registerMissing(reg) {
  // ismissing(A) | ismissing(A, indicator)
  reg.set('ismissing', {
    fn: (args) => {
      const a = args[0];
      const flags = missingFlags(a, args.length >= 2 ? indicatorList(args[1], 'ismissing') : null, 'ismissing');
      return [tagLogical(new Mat(a.rows, a.cols, Float64Array.from(flags, f => (f ? 1 : 0))))];
    },
  });
  reg.set('anynan', {
    fn: (args) => {
      const a = args[0];
      if (!(a instanceof Mat)) throw new MatlabError('anynan: input must be numeric');
      for (let k = 0; k < a.numel; k++) if (Number.isNaN(a.re[k]) || (a.isComplex && Number.isNaN(a.im[k]))) return [Mat.logicalScalar(true)];
      return [Mat.logicalScalar(false)];
    },
  });
  reg.set('allfinite', {
    fn: (args) => {
      const a = args[0];
      if (!(a instanceof Mat)) throw new MatlabError('allfinite: input must be numeric');
      for (let k = 0; k < a.numel; k++) if (!Number.isFinite(a.re[k]) || (a.isComplex && !Number.isFinite(a.im[k]))) return [Mat.logicalScalar(false)];
      return [Mat.logicalScalar(true)];
    },
  });
  // standardizeMissing(A, indicator): indicator values become NaN.
  reg.set('standardizeMissing', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('standardizeMissing: expected standardizeMissing(A, indicator)');
      const a = args[0];
      if (!(a instanceof Mat) || a.isChar) throw new MatlabError('standardizeMissing: input must be numeric');
      const flags = missingFlags(a, indicatorList(args[1], 'standardizeMissing'), 'standardizeMissing');
      const out = new Mat(a.rows, a.cols, Float64Array.from(a.re), a.im ? Float64Array.from(a.im) : null);
      flags.forEach((f, k) => { if (f) { out.re[k] = NaN; if (out.im) out.im[k] = 0; } });
      return [out];
    },
  });

  // [B, TF] = rmmissing(A) | rmmissing(A, dim) | rmmissing(..., 'MinNumMissing', n):
  // a vector loses its missing entries; a matrix loses the rows (or, with
  // dim 2, the columns) that have at least n (default 1) missing entries.
  reg.set('rmmissing', {
    fn: (args, nargout) => {
      const a = args[0];
      let dim = null, minMissing = 1;
      for (let i = 1; i < args.length; i++) {
        if (isText(args[i])) {
          if (args[i].toJSString().toLowerCase() !== 'minnummissing' || i + 1 >= args.length) throw new MatlabError(`rmmissing: unsupported option '${args[i].toJSString()}'`);
          minMissing = args[++i].toScalarNumber();
        } else dim = dimOf(args[i], 'rmmissing');
      }
      const flags = missingFlags(a, null, 'rmmissing');
      const isVector = a.rows === 1 || a.cols === 1;
      if (dim === null) dim = isVector ? firstDim(a) : 1;
      let out, tf;
      if (isVector && ((dim === 1 && a.cols === 1) || (dim === 2 && a.rows === 1))) {
        const keep = flags.map((f, k) => (f ? -1 : k)).filter(k => k >= 0);
        out = a.rows === 1 ? subset(a, 1, keep.length, keep) : subset(a, keep.length, 1, keep);
        tf = new Mat(a.rows, a.cols, Float64Array.from(flags, f => (f ? 1 : 0)));
      } else if (dim === 1) {
        const drop = Array.from({ length: a.rows }, (_, r) => {
          let n = 0;
          for (let c = 0; c < a.cols; c++) if (flags[c * a.rows + r]) n++;
          return n >= minMissing && a.cols > 0;
        });
        const rows = drop.map((d, r) => (d ? -1 : r)).filter(r => r >= 0);
        const positions = [];
        for (let c = 0; c < a.cols; c++) for (const r of rows) positions.push(c * a.rows + r);
        out = subset(a, rows.length, a.cols, positions);
        tf = new Mat(a.rows, 1, Float64Array.from(drop, d => (d ? 1 : 0)));
      } else if (dim === 2) {
        const drop = Array.from({ length: a.cols }, (_, c) => {
          let n = 0;
          for (let r = 0; r < a.rows; r++) if (flags[c * a.rows + r]) n++;
          return n >= minMissing && a.rows > 0;
        });
        const cols = drop.map((d, c) => (d ? -1 : c)).filter(c => c >= 0);
        const positions = [];
        for (const c of cols) for (let r = 0; r < a.rows; r++) positions.push(c * a.rows + r);
        out = subset(a, a.rows, cols.length, positions);
        tf = new Mat(1, a.cols, Float64Array.from(drop, d => (d ? 1 : 0)));
      } else {
        out = a; tf = new Mat(a.rows, a.cols, new Float64Array(a.numel));
      }
      return nargout >= 2 ? [out, tagLogical(tf)] : [out];
    },
  });

  // [B, TF] = fillmissing(A, 'constant', v) | fillmissing(A, method) |
  // fillmissing(A, method, dim): methods previous, next, nearest, linear,
  // spline, pchip (end points are extrapolated, MATLAB's default).
  reg.set('fillmissing', {
    fn: (args, nargout, ctx) => {
      if (args.length < 2 || !isText(args[1])) throw new MatlabError("fillmissing: expected fillmissing(A, method) or fillmissing(A, 'constant', v)");
      const a = args[0];
      if (!(a instanceof Mat) || a.isChar) throw new MatlabError('fillmissing: input must be numeric');
      if (a.isComplex) throw new MatlabError('fillmissing: complex input is not supported');
      const method = args[1].toJSString().toLowerCase();
      const methods = ['constant', 'previous', 'next', 'nearest', 'linear', 'spline', 'pchip'];
      if (!methods.includes(method)) throw new MatlabError(`fillmissing: unsupported method '${method}' (use ${methods.join(', ')})`);
      let i = 2, constant = null;
      if (method === 'constant') {
        if (args.length < 3) throw new MatlabError("fillmissing: 'constant' needs a fill value");
        constant = Array.from(args[2].re); i = 3;
      }
      const dim = i < args.length && !isText(args[i]) ? dimOf(args[i], 'fillmissing') : firstDim(a);
      const out = new Mat(a.rows, a.cols, Float64Array.from(a.re));
      const tf = new Mat(a.rows, a.cols, new Float64Array(a.numel));
      const lines = dim === 1 ? a.cols : dim === 2 ? a.rows : 0;
      const len = dim === 1 ? a.rows : a.cols;
      const pos = (line, k) => (dim === 1 ? line * a.rows + k : k * a.rows + line);
      if (constant && constant.length !== 1 && constant.length !== lines) throw new MatlabError('fillmissing: the fill value must be a scalar or have one value per column (or row)');
      const interp1 = ctx.interp.builtins.get('interp1').fn;
      for (let line = 0; line < lines; line++) {
        const known = [], missing = [];
        for (let k = 0; k < len; k++) (Number.isNaN(a.re[pos(line, k)]) ? missing : known).push(k);
        if (missing.length === 0) continue;
        let values;
        if (method === 'constant') values = missing.map(() => constant[constant.length === 1 ? 0 : line]);
        else if (known.length === 0) values = missing.map(() => NaN);
        else if (known.length === 1) {
          const k0 = known[0], v0 = a.re[pos(line, k0)];
          values = missing.map(k => (method === 'nearest' || (method === 'previous' && k > k0) || (method === 'next' && k < k0) ? v0 : NaN));
        } else {
          const x = new Mat(known.length, 1, Float64Array.from(known, k => k + 1));
          const y = new Mat(known.length, 1, Float64Array.from(known, k => a.re[pos(line, k)]));
          const xq = new Mat(missing.length, 1, Float64Array.from(missing, k => k + 1));
          const [v] = interp1([x, y, xq, Mat.fromString(method), Mat.fromString('extrap')]);
          values = Array.from(v.re);
        }
        missing.forEach((k, j) => {
          if (Number.isNaN(values[j])) return;
          out.re[pos(line, k)] = values[j];
          tf.re[pos(line, k)] = 1;
        });
      }
      return nargout >= 2 ? [out, tagLogical(tf)] : [out];
    },
  });
}
