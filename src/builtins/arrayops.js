// arrayops.js — find/any/all, NaN/Inf predicates, fliplr/flipud/flip,
// sort, unique, repmat, permute/ipermute/squeeze, and the cat/horzcat/vertcat function forms of
// matrix concatenation (which the interpreter already does for `[A B]`
// and `[A;B]` — these just expose that as callable functions).

import { Mat, Cell, StructArray, MatlabError, shapeArgs, shape2D, selectElements } from '../core/values.js';

// Cell arrays of strings sort/unique by character codes (MATLAB's order).
export function cellstrValues(c, fname) {
  if (!c.isCellstr()) throw new MatlabError(`${fname}: cell array input must contain only character vectors`);
  return c.data.map(v => v.toJSString());
}
export const codeOrder = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

function tagLogical(mat) { mat.isLogical = true; return mat; }

function nonzeroPositions(mat) {
  const positions = [];
  for (let k = 0; k < mat.numel; k++) {
    const re = mat.re[k], im = mat.isComplex ? mat.im[k] : 0;
    if (re !== 0 || im !== 0) positions.push(k);
  }
  return positions;
}

// A dimension argument: a positive integer.
function dimArg(v, fname) {
  const d = v.toScalarNumber();
  if (!Number.isInteger(d) || d < 1) throw new MatlabError(`${fname}: dimension argument must be a positive integer`);
  return d;
}

// any(A) | any(A, dim) | any(A, 'all'), and the same for all. As in MATLAB
// the default dimension is the first non-singleton one, and a dimension of
// 3 or more (a singleton of a 2-D array) tests each element on its own.
function anyAll(args, mode) {
  const allMode = mode === 'all';
  let mat = args[0];
  let dim = null;
  if (args.length >= 2) {
    if (args[1].isChar) {
      if (args[1].toJSString().toLowerCase() !== 'all') throw new MatlabError(`${mode}: unrecognized option '${args[1].toJSString()}'`);
      mat = new Mat(mat.numel, 1, mat.re, mat.im);
      dim = 1;
    } else dim = dimArg(args[1], mode);
  }
  if (dim === null) {
    if (mat.rows === 0 && mat.cols === 0) return Mat.logicalScalar(allMode); // any([]) = false, all([]) = true
    dim = mat.rows === 1 ? 2 : 1;
  }
  // any ignores NaN (MATLAB's rule); for all, NaN is nonzero and so true.
  const nz = allMode
    ? (k) => mat.re[k] !== 0 || (mat.isComplex && mat.im[k] !== 0)
    : (k) => (mat.re[k] !== 0 && !Number.isNaN(mat.re[k])) || (mat.isComplex && mat.im[k] !== 0 && !Number.isNaN(mat.im[k]));
  if (dim >= 3) return tagLogical(new Mat(mat.rows, mat.cols, Float64Array.from({ length: mat.numel }, (_, k) => (nz(k) ? 1 : 0))));
  const test = (start, count, stride) => {
    for (let i = 0; i < count; i++) {
      const hit = nz(start + i * stride);
      if (!allMode && hit) return 1;
      if (allMode && !hit) return 0;
    }
    return allMode ? 1 : 0;
  };
  if (dim === 1) return tagLogical(new Mat(1, mat.cols, Float64Array.from({ length: mat.cols }, (_, c) => test(c * mat.rows, mat.rows, 1))));
  return tagLogical(new Mat(mat.rows, 1, Float64Array.from({ length: mat.rows }, (_, r) => test(r, mat.cols, mat.rows))));
}

// permute(A, order) for a 2-D A: dimensions 3 and up have size 1, so
// the result is 2-D as long as only those move past the second place.
function permuteArray(a, orderArg, fname, inverse) {
  let order = Array.from(orderArg.re);
  const n = order.length;
  if (n < 2 || order.slice().sort((x, y) => x - y).some((d, k) => d !== k + 1)) {
    throw new MatlabError(`${fname}: the order must be a permutation of 1:N with N >= 2`);
  }
  if (inverse) { const inv = new Array(n); order.forEach((d, k) => { inv[d - 1] = k + 1; }); order = inv; }
  const inSize = order.map((_, k) => (k === 0 ? a.rows : k === 1 ? a.cols : 1));
  const [rows, cols] = shape2D(order.map(d => inSize[d - 1]), fname);
  // Element (i, j) of the result is the input element whose subscript
  // along dimension order(1) is i and along order(2) is j.
  const src = new Array(rows * cols);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) {
      const sub = [0, 0];
      if (order[0] <= 2) sub[order[0] - 1] = i;
      if (order[1] <= 2) sub[order[1] - 1] = j;
      src[j * rows + i] = sub[1] * a.rows + sub[0];
    }
  }
  if (a instanceof Cell) return new Cell(rows, cols, src.map(k => a.data[k]));
  if (a instanceof StructArray) return new StructArray(rows, cols, a.fieldNames, src.map(k => new Map(a.data[k])), a.classOverride);
  const re = Float64Array.from(src, k => a.re[k]);
  const im = a.im ? Float64Array.from(src, k => a.im[k]) : null;
  return new Mat(rows, cols, re, im, { isChar: a.isChar, isLogical: a.isLogical });
}

// A flipped along dimension dim (1 or 2), for any kind of array.
function flipDim(a, dim) {
  const m = a.rows, n = a.cols, positions = [];
  for (let c = 0; c < n; c++) for (let r = 0; r < m; r++) positions.push(dim === 2 ? (n - 1 - c) * m + r : c * m + (m - 1 - r));
  return selectElements(a, m, n, positions);
}

// Comparator for sort, following MATLAB: complex arrays sort by abs and
// then angle (or by real then imaginary part with ComparisonMethod
// 'real'); NaN (missing) values go last when ascending and first when
// descending, unless MissingPlacement says otherwise. Ties keep their
// original order.
export function sortComparator({ descending, nanFirst, byAbs }) {
  const keys = (v) => (byAbs ? [Math.hypot(v.re, v.im), Math.atan2(v.im, v.re)] : [v.re, v.im]);
  return (x, y) => {
    const xNaN = Number.isNaN(x.re) || Number.isNaN(x.im), yNaN = Number.isNaN(y.re) || Number.isNaN(y.im);
    if (xNaN || yNaN) {
      if (xNaN && yNaN) return x.idx - y.idx;
      return (xNaN ? 1 : -1) * (nanFirst ? -1 : 1);
    }
    const [x1, x2] = keys(x), [y1, y2] = keys(y);
    const d = x1 !== y1 ? (x1 < y1 ? -1 : 1) : x2 !== y2 ? (x2 < y2 ? -1 : 1) : 0;
    return (descending ? -d : d) || x.idx - y.idx;
  };
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
      // No match in a 0x0 or scalar input gives [] (0x0), as MATLAB.
      if ((a.rows === 0 && a.cols === 0) || (a.numel === 1 && positions.length === 0)) return Array.from({ length: Math.max(1, nargout) }, () => Mat.empty());
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

  reg.set('any', { fn: (args) => [anyAll(args, 'any')] });
  reg.set('all', { fn: (args) => [anyAll(args, 'all')] });

  reg.set('isnan', { fn: (args) => [tagLogical(Mat.mapElementwise(args[0], (r, i) => [(Number.isNaN(r) || Number.isNaN(i)) ? 1 : 0, 0]))] });
  reg.set('isinf', { fn: (args) => [tagLogical(Mat.mapElementwise(args[0], (r, i) => [((!isFinite(r) && !Number.isNaN(r)) || (!isFinite(i) && !Number.isNaN(i))) ? 1 : 0, 0]))] });
  reg.set('isfinite', { fn: (args) => [tagLogical(Mat.mapElementwise(args[0], (r, i) => [(isFinite(r) && isFinite(i)) ? 1 : 0, 0]))] });

  reg.set('fliplr', { fn: (args) => [flipDim(args[0], 2)] });
  reg.set('flipud', { fn: (args) => [flipDim(args[0], 1)] });
  reg.set('flip', {
    fn: (args) => {
      const a = args[0];
      const dim = args.length >= 2 ? dimArg(args[1], 'flip') : (a.rows === 1 ? 2 : 1);
      return [dim >= 3 ? a : flipDim(a, dim)]; // a 2-D array is a single page along dim 3+
    },
  });

  reg.set('sort', {
    fn: (args, nargout) => {
      const a = args[0];
      if (a instanceof Cell) {
        const strs = cellstrValues(a, 'sort');
        const descending = args.slice(1).some(x => x.isChar && x.toJSString().toLowerCase() === 'descend');
        const order = strs.map((s, i) => i).sort((i, j) => (descending ? -1 : 1) * codeOrder(strs[i], strs[j]) || i - j);
        const out = new Cell(a.rows, a.cols, order.map(i => a.data[i]));
        return nargout >= 2 ? [out, new Mat(a.rows, a.cols, Float64Array.from(order, i => i + 1))] : [out];
      }
      let dim = a.rows === 1 ? 2 : 1;
      let descending = false, placement = 'auto', method = 'auto';
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!arg.isChar) { dim = dimArg(arg, 'sort'); continue; }
        const opt = arg.toJSString().toLowerCase();
        if (opt === 'ascend' || opt === 'descend') { descending = opt === 'descend'; continue; }
        if (opt !== 'missingplacement' && opt !== 'comparisonmethod') throw new MatlabError(`sort: unknown option '${arg.toJSString()}'`);
        if (i + 1 >= args.length || !args[i + 1].isChar) throw new MatlabError(`sort: ${opt === 'missingplacement' ? 'MissingPlacement' : 'ComparisonMethod'} needs a value`);
        const val = args[++i].toJSString().toLowerCase();
        if (opt === 'missingplacement') {
          if (!['auto', 'first', 'last'].includes(val)) throw new MatlabError("sort: MissingPlacement must be 'auto', 'first' or 'last'");
          placement = val;
        } else {
          if (!['auto', 'real', 'abs'].includes(val)) throw new MatlabError("sort: ComparisonMethod must be 'auto', 'real' or 'abs'");
          method = val;
        }
      }
      const compare = sortComparator({
        descending,
        nanFirst: placement === 'first' || (placement === 'auto' && descending),
        byAbs: method === 'abs' || (method === 'auto' && a.isComplex),
      });
      if (dim >= 3) {
        // Sorting along a singleton dimension leaves A as it is.
        const ones = Mat.zeros(a.rows, a.cols); ones.re.fill(1);
        return nargout >= 2 ? [a.clone(), ones] : [a.clone()];
      }
      const sorted = Mat.zeros(a.rows, a.cols);
      if (a.isComplex) sorted.im = new Float64Array(a.numel);
      const idxMat = Mat.zeros(a.rows, a.cols);
      const sortSlice = (getter, setter, count) => {
        const entries = [];
        for (let i = 0; i < count; i++) entries.push({ ...getter(i), idx: i });
        entries.sort(compare);
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

  // [C, ia, ic] = unique(A) | unique(A, 'stable'). C is a row for row-vector
  // input and a column otherwise; ia (first occurrences) and ic satisfy
  // C = A(ia) and A = C(ic). Each NaN counts as distinct, as in MATLAB.
  reg.set('unique', {
    fn: (args, nargout) => {
      const a = args[0];
      if (a instanceof Cell) {
        const strs = cellstrValues(a, 'unique');
        const stable = args.slice(1).some(x => x.isChar && x.toJSString().toLowerCase() === 'stable');
        const first = new Map();
        strs.forEach((s, k) => { if (!first.has(s)) first.set(s, k); });
        let keys = [...first.keys()];
        if (!stable) keys.sort(codeOrder);
        const rank = new Map(keys.map((s, i) => [s, i]));
        const asRow = a.rows === 1 && a.numel > 0;
        const out = [new Cell(asRow ? 1 : keys.length, asRow ? keys.length : 1, keys.map(s => a.data[first.get(s)]))];
        if (nargout >= 2) out.push(new Mat(keys.length, 1, Float64Array.from(keys, s => first.get(s) + 1)));
        if (nargout >= 3) out.push(new Mat(strs.length, 1, Float64Array.from(strs, s => rank.get(s) + 1)));
        return out;
      }
      let stable = false;
      for (const opt of args.slice(1)) {
        const o = opt.isChar ? opt.toJSString().toLowerCase() : '';
        if (o === 'stable') stable = true;
        else if (o !== 'sorted') throw new MatlabError(`unique: unsupported option '${o}'`);
      }
      const groups = new Map(); // key -> index into `uniq`
      const uniq = [];          // { re, im, first }
      const ic = new Float64Array(a.numel);
      for (let k = 0; k < a.numel; k++) {
        const re = a.re[k], im = a.isComplex ? a.im[k] : 0;
        const key = Number.isNaN(re) || Number.isNaN(im) ? `nan${k}` : `${re}_${im}`;
        let g = groups.get(key);
        if (g === undefined) { g = uniq.length; groups.set(key, g); uniq.push({ re, im, first: k, slot: g }); }
        ic[k] = g;
      }
      const compare = sortComparator({ descending: false, nanFirst: false, byAbs: a.isComplex });
      const order = stable ? uniq.slice() : uniq.slice().sort((x, y) => compare({ ...x, idx: x.first }, { ...y, idx: y.first }));
      const rank = new Map(order.map((u, pos) => [u.slot, pos]));
      const n = order.length;
      const re = new Float64Array(n), ia = new Float64Array(n);
      let im = null;
      order.forEach((u, pos) => {
        re[pos] = u.re; ia[pos] = u.first + 1;
        if (u.im !== 0) { if (!im) im = new Float64Array(n); im[pos] = u.im; }
      });
      for (let k = 0; k < ic.length; k++) ic[k] = rank.get(ic[k]) + 1;
      const asRow = a.rows === 1; // a 1x0 input gives 1x0, as MATLAB
      const C = new Mat(asRow ? 1 : n, asRow ? n : 1, re, im, { isChar: a.isChar, isLogical: a.isLogical });
      const out = [C];
      if (nargout >= 2) out.push(new Mat(n, 1, ia));
      if (nargout >= 3) out.push(new Mat(ic.length, 1, ic));
      return out;
    },
  });

  // repmat(A, n) | repmat(A, m, n) | repmat(A, [m n]), for any kind of
  // array (cells and structs too).
  reg.set('repmat', {
    fn: (args) => {
      const a = args[0];
      if (args.length < 2) throw new MatlabError('Not enough input arguments.', 'MATLAB:minrhs');
      const [m, n] = args.length === 2 && args[1].isEmpty ? [1, 1] : shapeArgs(args.slice(1), 'repmat');
      const rows = a.rows * m, cols = a.cols * n, positions = [];
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) positions.push((c % a.cols) * a.rows + (r % a.rows));
      return [selectElements(a, rows, cols, positions)];
    },
  });

  reg.set('permute', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('permute: expected permute(A, order)');
      return [permuteArray(args[0], args[1], 'permute', false)];
    },
  });
  reg.set('ipermute', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('ipermute: expected ipermute(A, order)');
      return [permuteArray(args[0], args[1], 'ipermute', true)];
    },
  });
  // squeeze removes singleton dimensions; a 2-D array has none to remove.
  reg.set('squeeze', { fn: (args) => [args[0]] });

  reg.set('horzcat', { fn: (args, _n, ctx) => [ctx.interp.hconcat(args)] });
  reg.set('vertcat', { fn: (args, _n, ctx) => [ctx.interp.vconcat(args)] });
  reg.set('cat', {
    fn: (args, _n, ctx) => {
      const dim = dimArg(args[0], 'cat');
      const rest = args.slice(1);
      if (dim <= 2) return [dim === 1 ? ctx.interp.vconcat(rest) : ctx.interp.hconcat(rest)];
      // Along dimension 3 or more, only one non-empty array can take part
      // (more would make an N-D array).
      const parts = rest.filter(v => !(v.rows === 0 && v.cols === 0));
      if (parts.length > 1) throw new MatlabError(`cat: concatenating along dimension ${dim} would create an N-D array, which is not supported`);
      return [parts.length ? parts[0] : (rest[0] || Mat.empty())];
    },
  });
}
