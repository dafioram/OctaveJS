// sets.js — Set operations and row sorting: intersect, union, setdiff,
// setxor (numbers, text and cell arrays of text; 'rows', 'stable'), and
// sortrows, issorted, rot90.
//
// As in MATLAB: results are sorted unless 'stable' is given; each NaN is
// distinct from every other value (so union keeps them all and intersect
// none); index outputs are column vectors of first occurrences; the
// result is a row vector when the inputs are row vectors and a column
// otherwise.

import { Mat, Cell, MatlabError, selectElements } from '../core/values.js';
import { sortComparator, cellstrValues, codeOrder } from './arrayops.js';
import { charCode } from './system.js';

const isText = (v) => v instanceof Mat && v.isChar;
// Each NaN gets its own key, distinct across both arguments.
let nanSerial = 0;
const nanKey = () => `nan:${nanSerial++}`;
const column = (idx) => new Mat(idx.length, 1, Float64Array.from(idx, i => i + 1));

// The items of a set argument: elements (or rows, with 'rows') with a key
// for equality and a comparator for sorting.
function itemsOf(a, rows, fname) {
  if (a instanceof Cell) {
    if (rows) throw new MatlabError(`${fname}: 'rows' is not supported for cell arrays`);
    const strs = cellstrValues(a, fname);
    return { kind: 'text', items: strs.map((s, i) => ({ key: `s:${s}`, s, idx: i })) };
  }
  if (!(a instanceof Mat)) throw new MatlabError(`${fname}: inputs must be numeric, char, logical or cell arrays of character vectors`);
  if (rows) {
    const items = [];
    for (let r = 0; r < a.rows; r++) {
      const vals = [];
      for (let c = 0; c < a.cols; c++) {
        const k = c * a.rows + r;
        vals.push({ re: a.re[k], im: a.isComplex ? a.im[k] : 0 });
      }
      const hasNaN = vals.some(v => Number.isNaN(v.re) || Number.isNaN(v.im));
      items.push({ key: hasNaN ? nanKey() : vals.map(v => `${v.re}_${v.im}`).join(','), vals, idx: r });
    }
    return { kind: 'rows', items };
  }
  const items = [];
  for (let k = 0; k < a.numel; k++) {
    const re = a.re[k], im = a.isComplex ? a.im[k] : 0;
    const nan = Number.isNaN(re) || Number.isNaN(im);
    items.push({ key: nan ? nanKey() : `${re}_${im}`, re, im, idx: k });
  }
  return { kind: 'values', items };
}

function comparatorFor(kind, complex) {
  if (kind === 'text') return (x, y) => codeOrder(x.s, y.s);
  const elem = sortComparator({ descending: false, nanFirst: false, byAbs: complex });
  if (kind === 'values') return (x, y) => elem({ ...x, idx: 0 }, { ...y, idx: 0 });
  return (x, y) => {
    for (let c = 0; c < x.vals.length; c++) {
      const d = elem({ ...x.vals[c], idx: 0 }, { ...y.vals[c], idx: 0 });
      if (d) return d;
    }
    return 0;
  };
}

// Options: 'rows', 'stable', 'sorted' (and 'legacy' is rejected).
function setOptions(args, fname) {
  const opts = { rows: false, stable: false };
  for (const v of args) {
    if (!isText(v)) throw new MatlabError(`${fname}: invalid option`);
    const o = v.toJSString().toLowerCase();
    if (o === 'rows') opts.rows = true;
    else if (o === 'stable') opts.stable = true;
    else if (o !== 'sorted') throw new MatlabError(`${fname}: unsupported option '${v.toJSString()}'`);
  }
  return opts;
}

// Builds the result array from chosen items (each with its source array).
function build(picks, A, B, kind, rows, rowVector, setdiffMode = false) {
  if (kind === 'text') {
    const data = picks.map(p => Mat.fromString(p.item.s));
    return rowVector ? new Cell(1, data.length, data) : new Cell(data.length, 1, data);
  }
  if (kind === 'rows') {
    const cols = (A.numel ? A : B).cols;
    const n = picks.length;
    const out = new Mat(n, cols, new Float64Array(n * cols));
    const complex = picks.some(p => p.item.vals.some(v => v.im !== 0));
    if (complex) out.im = new Float64Array(n * cols);
    picks.forEach((p, r) => p.item.vals.forEach((v, c) => { out.re[c * n + r] = v.re; if (complex) out.im[c * n + r] = v.im; }));
    out.isChar = A.isChar && (B ? (B.isChar || B.isEmpty) : true);
    return out;
  }
  const n = picks.length;
  const re = Float64Array.from(picks, p => p.item.re);
  const complex = picks.some(p => p.item.im !== 0);
  const out = rowVector ? new Mat(1, n, re) : new Mat(n, 1, re);
  if (complex) out.im = Float64Array.from(picks, p => p.item.im);
  // Char if either input is char (setdiff: if A is), the numbers becoming
  // character codes, as MATLAB.
  out.isChar = !complex && (A.isChar || (!!B && B.isChar && !setdiffMode));
  if (out.isChar) out.re = out.re.map(charCode);
  out.isLogical = !out.isChar && A.isLogical && (!B || B.isLogical || B.isEmpty);
  return out;
}

// Row-vector output: the inputs that matter are row vectors (an empty
// 0-by-0 input doesn't count against it).

function setOperation(fname, args, nargout) {
  if (args.length < 2) throw new MatlabError(`${fname}: expected ${fname}(A, B)`);
  const [A, B] = args;
  const { rows, stable } = setOptions(args.slice(2), fname);
  if ((A instanceof Cell) !== (B instanceof Cell) && !(A instanceof Mat && A.isEmpty) && !(B instanceof Mat && B.isEmpty)) {
    throw new MatlabError(`${fname}: both inputs must be cell arrays of text, or neither`);
  }
  const textMode = A instanceof Cell || B instanceof Cell;
  // A char result: the numbers become character codes before comparing,
  // so union('ab', NaN) puts char(0) first, as MATLAB.
  if (!textMode && !A.isComplex && !B.isComplex && !(A.isChar && B.isChar) && (A.isChar || (B.isChar && fname !== 'setdiff'))) {
    const asChar = (m) => (m.isChar ? m : new Mat(m.rows, m.cols, Float64Array.from(m.re, charCode), null, { isChar: true }));
    return setOperation(fname, [asChar(A), asChar(B), ...args.slice(2)], nargout);
  }
  const ia0 = itemsOf(textMode && !(A instanceof Cell) ? new Cell(0, 0, []) : A, rows, fname);
  const ib0 = itemsOf(textMode && !(B instanceof Cell) ? new Cell(0, 0, []) : B, rows, fname);
  if (rows && A.numel && B.numel && A.cols !== B.cols) throw new MatlabError(`${fname}: A and B must have the same number of columns with 'rows'`);
  const kind = textMode ? 'text' : rows ? 'rows' : 'values';
  const compare = comparatorFor(kind, !textMode && (A.isComplex || B.isComplex));
  // A row result when both inputs are rows (setdiff: when A is), as MATLAB.
  const rowVector = !rows && (fname === 'setdiff' ? A.rows === 1 : A.rows === 1 && B.rows === 1);
  // First occurrence of each key in A and in B.
  const firstOf = (items) => {
    const m = new Map();
    for (const it of items) if (!m.has(it.key)) m.set(it.key, it);
    return m;
  };
  const fa = firstOf(ia0.items), fb = firstOf(ib0.items);
  let picks; // [{ item, from: 'A' | 'B' }]
  if (fname === 'intersect') picks = [...fa.values()].filter(it => fb.has(it.key)).map(it => ({ item: it, from: 'A', other: fb.get(it.key) }));
  else if (fname === 'union') picks = [...[...fa.values()].map(it => ({ item: it, from: 'A' })), ...[...fb.values()].filter(it => !fa.has(it.key)).map(it => ({ item: it, from: 'B' }))];
  else if (fname === 'setdiff') picks = [...fa.values()].filter(it => !fb.has(it.key)).map(it => ({ item: it, from: 'A' }));
  else picks = [...[...fa.values()].filter(it => !fb.has(it.key)).map(it => ({ item: it, from: 'A' })), ...[...fb.values()].filter(it => !fa.has(it.key)).map(it => ({ item: it, from: 'B' }))];
  if (!stable) picks.sort((x, y) => compare(x.item, y.item) || (x.from === y.from ? x.item.idx - y.item.idx : x.from === 'A' ? -1 : 1));
  const C = build(picks, A instanceof Mat ? A : B, B, kind, rows, rowVector, fname === 'setdiff');
  const out = [C];
  if (fname === 'intersect') {
    out.push(column(picks.map(p => p.item.idx)), column(picks.map(p => p.other.idx)));
  } else if (fname === 'setdiff') {
    out.push(column(picks.map(p => p.item.idx)));
  } else {
    out.push(column(picks.filter(p => p.from === 'A').map(p => p.item.idx)), column(picks.filter(p => p.from === 'B').map(p => p.item.idx)));
  }
  return out.slice(0, Math.max(nargout, 1));
}

// sortrows(A) | sortrows(A, column) | sortrows(A, column, direction) |
// sortrows(A, 'descend'): stable lexicographic sort of the rows; a
// negative column number sorts that column in descending order.
function sortrows(args, nargout) {
  const A = args[0];
  let cols = null, direction = null;
  for (const v of args.slice(1)) {
    if (isText(v)) {
      const d = v.toJSString().toLowerCase();
      if (d !== 'ascend' && d !== 'descend') throw new MatlabError(`sortrows: unsupported option '${v.toJSString()}'`);
      direction = d;
    } else if (v instanceof Cell) {
      direction = v.data.map(x => x.toJSString().toLowerCase());
    } else cols = Array.from(v.re);
  }
  const nCols = A.cols;
  if (!cols) cols = Array.from({ length: nCols }, (_, c) => c + 1);
  const keys = cols.map((c, k) => {
    const col = Math.abs(c);
    if (!Number.isInteger(col) || col < 1 || col > nCols) throw new MatlabError('sortrows: column numbers must be integers between 1 and the number of columns');
    const dir = Array.isArray(direction) ? direction[k] : direction;
    return { col: col - 1, descending: dir ? dir === 'descend' : c < 0 };
  });
  const rows = Array.from({ length: A.rows }, (_, r) => r);
  let compareRows;
  if (A instanceof Cell) {
    const get = (r, c) => A.data[c * A.rows + r].toJSString();
    compareRows = (x, y) => {
      for (const { col, descending } of keys) {
        const d = codeOrder(get(x, col), get(y, col));
        if (d) return descending ? -d : d;
      }
      return x - y;
    };
  } else {
    const cmps = keys.map(({ col, descending }) => ({
      col, cmp: sortComparator({ descending, nanFirst: descending, byAbs: A.isComplex }),
    }));
    const val = (r, c) => ({ re: A.re[c * A.rows + r], im: A.isComplex ? A.im[c * A.rows + r] : 0, idx: 0 });
    compareRows = (x, y) => {
      for (const { col, cmp } of cmps) {
        const d = cmp(val(x, col), val(y, col));
        if (d) return d;
      }
      return x - y;
    };
  }
  rows.sort(compareRows);
  let B;
  if (A instanceof Cell) {
    B = new Cell(A.rows, A.cols, Array.from({ length: A.numel }, (_, k) => A.data[Math.floor(k / A.rows) * A.rows + rows[k % A.rows]]));
  } else {
    B = new Mat(A.rows, A.cols, new Float64Array(A.numel), A.isComplex ? new Float64Array(A.numel) : null, { isChar: A.isChar, isLogical: A.isLogical });
    for (let c = 0; c < A.cols; c++) {
      for (let r = 0; r < A.rows; r++) {
        B.re[c * A.rows + r] = A.re[c * A.rows + rows[r]];
        if (B.im) B.im[c * A.rows + r] = A.im[c * A.rows + rows[r]];
      }
    }
  }
  return nargout >= 2 ? [B, column(rows)] : [B];
}

// issorted(A) | issorted(A, direction): direction 'ascend' (default),
// 'descend', 'monotonic', or the strict versions.
function issorted(args) {
  const A = args[0];
  const dir = args[1] && isText(args[1]) ? args[1].toJSString().toLowerCase() : 'ascend';
  const dirs = ['ascend', 'descend', 'monotonic', 'strictascend', 'strictdescend', 'strictmonotonic'];
  if (!dirs.includes(dir)) throw new MatlabError(`issorted: unsupported option '${dir}'`);
  const strict = dir.startsWith('strict');
  const check = (vals, descending, cmpFn) => {
    for (let i = 0; i + 1 < vals.length; i++) {
      const d = cmpFn(vals[i], vals[i + 1]);
      if (d > 0 || (strict && d === 0)) return false;
    }
    return true;
  };
  let lines;
  if (A instanceof Cell) {
    const strs = cellstrValues(A, 'issorted');
    const asc = check(strs, false, codeOrder), desc = check(strs, true, (x, y) => codeOrder(y, x));
    return [Mat.logicalScalar(dir.endsWith('monotonic') ? asc || desc : dir.endsWith('descend') ? desc : asc)];
  }
  if (A.rows === 1 || A.cols === 1) lines = [Array.from({ length: A.numel }, (_, k) => k)];
  else lines = Array.from({ length: A.cols }, (_, c) => Array.from({ length: A.rows }, (_, r) => c * A.rows + r));
  const val = (k) => ({ re: A.re[k], im: A.isComplex ? A.im[k] : 0, idx: 0 });
  const ok = (descending) => {
    const cmp = sortComparator({ descending, nanFirst: descending, byAbs: A.isComplex });
    return lines.every(line => check(line.map(val), descending, cmp));
  };
  const result = dir.endsWith('monotonic') ? ok(false) || ok(true) : ok(dir.endsWith('descend'));
  return [Mat.logicalScalar(result)];
}

// rot90(A) | rot90(A, k): rotate by k*90 degrees counterclockwise.
function rot90(args) {
  const A = args[0];
  const k = args.length >= 2 ? args[1].toScalarNumber() : 1;
  if (!Number.isInteger(k)) throw new MatlabError('rot90: k must be an integer');
  const turns = ((k % 4) + 4) % 4;
  const m = A.rows, n = A.cols;
  const outRows = turns % 2 ? n : m, outCols = turns % 2 ? m : n;
  // Source position in A of output element (i, j).
  const src = (i, j) => {
    if (turns === 0) return j * m + i;
    if (turns === 1) return j + (n - 1 - i) * m;
    if (turns === 2) return (m - 1 - i) + (n - 1 - j) * m;
    return (m - 1 - j) + i * m;
  };
  const positions = [];
  for (let j = 0; j < outCols; j++) for (let i = 0; i < outRows; i++) positions.push(src(i, j));
  return [selectElements(A, outRows, outCols, positions)];
}

export function registerSets(reg) {
  for (const name of ['intersect', 'union', 'setdiff', 'setxor']) {
    reg.set(name, { fn: (args, nargout) => setOperation(name, args, nargout) });
  }
  reg.set('sortrows', { fn: (args, nargout) => sortrows(args, nargout) });
  reg.set('issorted', { fn: issorted });
  reg.set('rot90', { fn: rot90 });
}
