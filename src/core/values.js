// values.js — The runtime value model.
//
// Everything numeric in the interpreter is a `Mat`: a 2-D array stored
// column-major (matching real MATLAB's internal layout, which matters for
// linear indexing, `:` flattening, and reshape order). Scalars are 1x1
// Mats. Char arrays ('hello') are Mats with `isChar=true` whose real part
// holds character codes. Comparison/logical results are tagged
// `isLogical=true`, which changes indexing semantics (logical indexing
// selects where nonzero, vs. numeric indexing which uses values as
// 1-based positions) — this distinction is called out in the design brief
// as essential, and is the reason the tag exists at all.
//
// Function handles are a separate class, `FunctionHandle`; cell arrays
// are `Cell` and structs are `StructArray` (both 2-D arrays of elements,
// column-major like Mat).
//
// Copy-on-write: every value carries `_refs`, the number of places that
// hold it (workspace slots, cell/struct slots, closures). An indexed
// assignment may modify a value in place only when it has a single
// holder; otherwise it copies first. Counting errs high, never low — an
// over-count only costs an extra copy, an under-count would let one
// variable's assignment leak into another.
//
// NOT modeled at all: string arrays (double-quoted), categorical/table
// types, integer classes (int8/uint8/...), sparse matrices, N-D arrays.
// See README "What isn't supported".

export class MatlabError extends Error {
  constructor(message, identifier = '') {
    super(message);
    this.name = 'MatlabError';
    this.identifier = identifier;
  }
}

// MATLAB's error for a call with the wrong number of arguments.
export function argCountError(got, expected) {
  return got < expected ? new MatlabError('Not enough input arguments.', 'MATLAB:minrhs') : new MatlabError('Too many input arguments.', 'MATLAB:TooManyInputs');
}

// [rows, cols] from a list of dimension sizes (a size vector or separate
// size arguments). Trailing singleton dimensions are allowed, as in
// MATLAB (zeros(2, 3, 1) is 2-by-3); anything else would be an N-D array.
// Negative sizes count as 0, as in MATLAB.
export function shape2D(dims, fname) {
  for (const d of dims) {
    if (!Number.isFinite(d) || !Number.isInteger(d)) throw new MatlabError(`${fname}: size inputs must be integers`);
  }
  for (let k = 2; k < dims.length; k++) {
    if (dims[k] !== 1) throw new MatlabError(`${fname}: N-D arrays are not supported (size ${dims.join('x')}); dimensions after the second must be 1`);
  }
  return [Math.max(dims[0] ?? 0, 0), Math.max(dims[1] ?? 0, 0)];
}

// Sizes for an array constructor: f(n) is n-by-n; f(m, n, ...) and
// f([m n ...]) give each dimension.
export function shapeArgs(args, fname) {
  if (args.length === 1) {
    const v = args[0];
    if (v.numel === 1) { const n = v.re[0]; return shape2D([n, n], fname); }
    if (v.numel === 0) throw new MatlabError(`${fname}: size vector must have at least two elements`);
    return shape2D(Array.from(v.re), fname);
  }
  return shape2D(args.map(a => {
    if (a.numel !== 1) throw new MatlabError(`${fname}: size inputs must be scalar`);
    return a.re[0];
  }), fname);
}

// Truth value of one element for the logical operators and logical():
// MATLAB refuses to convert NaN.
export function truthOf(r, i) {
  if (Number.isNaN(r) || Number.isNaN(i)) throw new MatlabError("NaN's cannot be converted to logicals.", 'MATLAB:nologicalnan');
  return r !== 0 || i !== 0;
}

export function retain(v) { if (v && typeof v === 'object' && '_refs' in v) v._refs++; return v; }
export function release(v) { if (v && typeof v === 'object' && '_refs' in v && v._refs > 0) v._refs--; }

export class Mat {
  constructor(rows, cols, re, im = null, opts = {}) {
    // A malformed array (from an argument a builtin didn't expect) fails
    // here, where the builtin's error guard can report it, rather than
    // surfacing later as a confusing display or indexing error.
    if (!(rows >= 0 && cols >= 0 && Number.isInteger(rows) && Number.isInteger(cols)) || !re || re.length !== rows * cols || (im && im.length !== re.length)) {
      throw new TypeError(`malformed ${rows}x${cols} array`);
    }
    this.rows = rows;
    this.cols = cols;
    this.re = re; // Float64Array, column-major, length rows*cols
    this.im = im; // Float64Array or null
    this.isLogical = !!opts.isLogical;
    this.isChar = !!opts.isChar;
    this._refs = 0;
  }

  get numel() { return this.rows * this.cols; }
  get isComplex() { return this.im !== null; }
  get isVector() { return this.rows === 1 || this.cols === 1; }
  get isScalar() { return this.rows === 1 && this.cols === 1; }
  get isEmpty() { return this.rows === 0 || this.cols === 0; }

  static zeros(rows, cols) {
    return new Mat(rows, cols, new Float64Array(rows * cols));
  }

  static scalar(x, opts = {}) {
    const m = new Mat(1, 1, new Float64Array([x]), null, opts);
    return m;
  }

  static complexScalar(re, im) {
    return new Mat(1, 1, new Float64Array([re]), new Float64Array([im]));
  }

  static logicalScalar(b) {
    return new Mat(1, 1, new Float64Array([b ? 1 : 0]), null, { isLogical: true });
  }

  static fromRows(rows2d) {
    // rows2d: array of arrays of plain numbers
    const r = rows2d.length;
    const c = r > 0 ? rows2d[0].length : 0;
    const re = new Float64Array(r * c);
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < c; j++) {
        re[j * r + i] = rows2d[i][j];
      }
    }
    return new Mat(r, c, re);
  }

  static fromString(str) {
    const re = new Float64Array(str.length);
    for (let k = 0; k < str.length; k++) re[k] = str.charCodeAt(k);
    return new Mat(1, str.length, re, null, { isChar: true });
  }

  static empty() { return new Mat(0, 0, new Float64Array(0)); }

  toJSString() {
    if (!this.isChar) throw new MatlabError('Value is not a char array');
    let s = '';
    for (let k = 0; k < this.re.length; k++) s += String.fromCharCode(Math.round(this.re[k]));
    return s;
  }

  // 0-based column-major linear get/set
  getLin(k) {
    return this.isComplex ? { re: this.re[k], im: this.im[k] } : this.re[k];
  }
  setLin(k, re, im = 0) {
    this.re[k] = re;
    if (im !== 0 && !this.isComplex) this._promoteComplex();
    if (this.isComplex) this.im[k] = im;
  }
  _promoteComplex() {
    this.im = new Float64Array(this.re.length);
  }

  get2(row, col) { return this.getLin(col * this.rows + row); }
  set2(row, col, re, im = 0) { this.setLin(col * this.rows + row, re, im); }

  clone() {
    const m = new Mat(this.rows, this.cols, Float64Array.from(this.re),
      this.im ? Float64Array.from(this.im) : null,
      { isLogical: this.isLogical, isChar: this.isChar });
    return m;
  }

  toScalarNumber() {
    if (this.numel !== 1) throw new MatlabError('Expected a scalar value here');
    if (this.isComplex && this.im[0] !== 0) {
      throw new MatlabError('Complex value used where a real scalar was required');
    }
    return this.re[0];
  }

  toScalarComplex() {
    if (this.numel !== 1) throw new MatlabError('Expected a scalar value here');
    return { re: this.re[0], im: this.isComplex ? this.im[0] : 0 };
  }

  // True/false test used by if/while/&&/||: nonempty and all elements nonzero.
  // NaN can't be converted to a logical, so (like MATLAB) it's an error here.
  isTruthy() {
    if (this.isEmpty) return false;
    for (let k = 0; k < this.re.length; k++) {
      if (Number.isNaN(this.re[k]) || (this.isComplex && Number.isNaN(this.im[k]))) {
        throw new MatlabError("NaN's cannot be converted to logicals.", 'MATLAB:nologicalnan');
      }
      const zero = this.re[k] === 0 && (!this.isComplex || this.im[k] === 0);
      if (zero) return false;
    }
    return true;
  }

  className() {
    if (this.isChar) return 'char';
    if (this.isLogical) return 'logical';
    return 'double';
  }

  sizeStr() { return `${this.rows}x${this.cols}`; }

  // Map a function over every element, producing a new Mat with the same
  // shape. `fn(re, im) -> [re, im]`.
  static mapElementwise(a, fn) {
    const n = a.numel;
    const re = new Float64Array(n);
    let im = null;
    for (let k = 0; k < n; k++) {
      const ai = a.isComplex ? a.im[k] : 0;
      const [r, i] = fn(a.re[k], ai);
      re[k] = r;
      // A NaN imaginary part from real input is an artifact of the complex
      // formulas (e.g. Inf*0), not a complex result.
      if (i !== 0 && !(Number.isNaN(i) && ai === 0)) { if (!im) im = new Float64Array(n); im[k] = i; }
    }
    return new Mat(a.rows, a.cols, re, im);
  }

  // Elementwise binary op with MATLAB's implicit expansion: in each
  // dimension the sizes must match or one of them must be 1, which is then
  // repeated (so a 3x3 minus a 1x3 subtracts the row from every row).
  static broadcastBinary(a, b, fn) {
    const rows = expandDim(a.rows, b.rows), cols = expandDim(a.cols, b.cols);
    if (rows < 0 || cols < 0) {
      throw new MatlabError('Arrays have incompatible sizes for this operation.', 'MATLAB:sizeDimensionsMustMatch');
    }
    const n = rows * cols;
    const re = new Float64Array(n);
    let im = null;
    const aSame = a.rows === rows && a.cols === cols, bSame = b.rows === rows && b.cols === cols;
    const aRowStep = a.rows === 1 ? 0 : 1, aColStep = a.cols === 1 ? 0 : a.rows;
    const bRowStep = b.rows === 1 ? 0 : 1, bColStep = b.cols === 1 ? 0 : b.rows;
    let k = 0;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++, k++) {
        const ak = aSame ? k : r * aRowStep + c * aColStep;
        const bk = bSame ? k : r * bRowStep + c * bColStep;
        const ar = a.re[ak], ai = a.isComplex ? a.im[ak] : 0;
        const br = b.re[bk], bi = b.isComplex ? b.im[bk] : 0;
        const [vr, vi] = fn(ar, ai, br, bi);
        re[k] = vr;
        if (vi !== 0 && !(Number.isNaN(vi) && ai === 0 && bi === 0)) { if (!im) im = new Float64Array(n); im[k] = vi; }
      }
    }
    return new Mat(rows, cols, re, im);
  }
}

// Size of one dimension under implicit expansion, or -1 if incompatible.
function expandDim(x, y) {
  if (x === y) return x;
  if (x === 1) return y;
  if (y === 1) return x;
  return -1;
}

// The values of the colon operator a:step:b. Computed as a + k*step
// (never by repeated addition, which accumulates rounding error), with
// the count and final element snapped using a small relative tolerance —
// so 0:0.1:1 has exactly 11 elements and ends at exactly 1, as in MATLAB.
export function colonRange(start, step, stop) {
  if (Number.isNaN(start) || Number.isNaN(step) || Number.isNaN(stop)) return new Mat(1, 1, new Float64Array([NaN]));
  if (step === 0 || (step > 0 && start > stop) || (step < 0 && start < stop)) return Mat.zeros(1, 0);
  const q = (stop - start) / step;
  if (!Number.isFinite(q)) throw new MatlabError('Range has too many elements');
  const tol = 2 * Number.EPSILON * Math.max(Math.abs(start), Math.abs(stop)) / Math.abs(step);
  const n = Math.floor(q + Math.max(tol, 4 * Number.EPSILON * Math.abs(q)));
  if (n + 1 > 2 ** 31) throw new MatlabError('Range has too many elements');
  let last = start + n * step;
  if (Math.abs(last - stop) <= tol * Math.abs(step) + 4 * Number.EPSILON * Math.abs(stop)) last = stop;
  const re = new Float64Array(n + 1);
  const half = Math.floor(n / 2);
  for (let k = 0; k <= n; k++) re[k] = k <= half ? start + k * step : last - (n - k) * step;
  return new Mat(1, n + 1, re);
}

export class FunctionHandle {
  constructor({ name = null, params = null, body = null, closure = null, builtin = null, source = null, locals = null }) {
    this.name = name;         // for @sin / @myfunc
    this.params = params;     // for anonymous functions: array of param names
    this.body = body;         // AST expr, for anonymous functions
    this.closure = closure;   // captured Map<string, value>, for anonymous functions
    this.builtin = builtin;   // JS function, if this wraps a builtin directly
    this.source = source;     // original source text of the body, for anonymous functions
    this.locals = locals;     // local-function table of the file the handle was created in (or null)
  }
  displayName() {
    if (this.name) return `@${this.name}`;
    if (this.params) return `@(${this.params.join(',')})${this.source !== null ? this.source : ' ...'}`;
    return '@(function handle)';
  }
}

// ---------------- containers: cell arrays and structs ----------------

function shapeStr(rows, cols) { return `${rows}x${cols}`; }

class ElementArray {
  constructor(rows, cols, data) {
    this.rows = rows;
    this.cols = cols;
    this.data = data; // plain Array, column-major, length rows*cols
    this._refs = 0;
  }
  get numel() { return this.rows * this.cols; }
  get isVector() { return this.rows === 1 || this.cols === 1; }
  get isScalar() { return this.rows === 1 && this.cols === 1; }
  get isEmpty() { return this.rows === 0 || this.cols === 0; }
  get isComplex() { return false; }
  sizeStr() { return shapeStr(this.rows, this.cols); }
}

export class Cell extends ElementArray {
  // `data` holds values (Mat, Cell, StructArray, FunctionHandle). The
  // constructor takes ownership and retains each element.
  constructor(rows, cols, data) {
    super(rows, cols, data || Array.from({ length: rows * cols }, () => Mat.empty()));
    for (const v of this.data) retain(v);
  }
  static empty(rows = 0, cols = 0) { return new Cell(rows, cols); }
  className() { return 'cell'; }
  // Shallow copy: a new container whose elements are shared (and retained).
  clone() { return new Cell(this.rows, this.cols, this.data.slice()); }
  setLin(k, v) { if (this.data[k] !== v) { retain(v); release(this.data[k]); this.data[k] = v; } }
  isCellstr() { return this.data.every(v => v instanceof Mat && v.isChar && (v.rows === 1 || v.isEmpty)); }
}

export class StructArray extends ElementArray {
  // `data` holds one Map(fieldName -> value) per element; every element
  // has exactly the fields in `fieldNames` (in that order).
  constructor(rows, cols, fieldNames = [], data = null, classOverride = null) {
    super(rows, cols, data || Array.from({ length: rows * cols }, () => new Map(fieldNames.map(f => [f, Mat.empty()]))));
    this.fieldNames = fieldNames.slice();
    this.classOverride = classOverride; // e.g. 'MException'
    for (const el of this.data) for (const v of el.values()) retain(v);
  }
  static scalar(fields = {}) {
    const names = Object.keys(fields);
    return new StructArray(1, 1, names, [new Map(names.map(n => [n, fields[n]]))]);
  }
  className() { return this.classOverride || 'struct'; }
  // Copies the per-element Maps (never shared between arrays) but shares,
  // and retains, the field values themselves.
  clone() {
    return new StructArray(this.rows, this.cols, this.fieldNames, this.data.map(el => new Map(el)), this.classOverride);
  }
  hasField(name) { return this.fieldNames.includes(name); }
  addField(name) {
    if (this.hasField(name)) return;
    this.fieldNames.push(name);
    for (const el of this.data) el.set(name, Mat.empty());
  }
  setField(k, name, v) {
    this.addField(name);
    const el = this.data[k];
    const old = el.get(name);
    if (old !== v) { retain(v); release(old); el.set(name, v); }
  }
  getField(k, name) {
    if (!this.hasField(name)) throw new MatlabError(`Unrecognized field name "${name}".`, 'MATLAB:nonExistentField');
    return this.data[k].get(name);
  }
  newElement() { return new Map(this.fieldNames.map(f => [f, Mat.empty()])); }
}

// MException objects are modeled as 1x1 structs (class 'MException') with
// identifier/message/stack fields, so ME.message etc. just work.
export function makeMException(identifier, message) {
  const stack = new StructArray(0, 1, ['file', 'name', 'line']);
  const me = StructArray.scalar({ identifier: Mat.fromString(identifier || ''), message: Mat.fromString(message || ''), stack });
  me.classOverride = 'MException';
  return me;
}

export function isMException(v) { return v instanceof StructArray && v.classOverride === 'MException'; }

export function valueClassName(v) {
  if (v instanceof FunctionHandle) return 'function_handle';
  if (v && typeof v.className === 'function') return v.className();
  return 'unknown';
}

// ---------------- serialization (worker <-> page, workspace snapshots) ----------------
//
// Converts values to plain, structured-clone-friendly objects and back.
// Function handles keep their AST and closure; a handle created inside a
// function file records that file's name so `resolveLocals(name)` can
// re-attach its local-function table on the other side.

export function serializeValue(v) {
  if (v instanceof Mat) {
    return { t: 'm', r: v.rows, c: v.cols, re: v.re, im: v.im, L: v.isLogical, C: v.isChar };
  }
  if (v instanceof Cell) return { t: 'c', r: v.rows, c: v.cols, d: v.data.map(serializeValue) };
  if (v instanceof StructArray) {
    return {
      t: 's', r: v.rows, c: v.cols, f: v.fieldNames, cls: v.classOverride,
      d: v.data.map(el => v.fieldNames.map(n => serializeValue(el.get(n)))),
    };
  }
  if (v instanceof FunctionHandle) {
    return {
      t: 'f', name: v.name, params: v.params, body: v.body, source: v.source,
      closure: v.closure ? [...v.closure.entries()].map(([k, x]) => [k, serializeValue(x)]) : null,
      localsFile: v.locals && v.locals.fileName ? v.locals.fileName : null,
    };
  }
  throw new Error('serializeValue: unsupported value');
}

export function deserializeValue(o, resolveLocals = () => null) {
  switch (o.t) {
    case 'm': return new Mat(o.r, o.c, o.re, o.im, { isLogical: o.L, isChar: o.C });
    case 'c': return new Cell(o.r, o.c, o.d.map(x => deserializeValue(x, resolveLocals)));
    case 's': return new StructArray(o.r, o.c, o.f,
      o.d.map(vals => new Map(o.f.map((n, i) => [n, deserializeValue(vals[i], resolveLocals)]))), o.cls);
    case 'f': {
      const closure = o.closure ? new Map(o.closure.map(([k, x]) => [k, retain(deserializeValue(x, resolveLocals))])) : null;
      return new FunctionHandle({ name: o.name, params: o.params, body: o.body, source: o.source, closure,
        locals: o.localsFile ? resolveLocals(o.localsFile) : null });
    }
    default: throw new Error('deserializeValue: unknown tag ' + o.t);
  }
}
