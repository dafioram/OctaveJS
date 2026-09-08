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
// Function handles are a separate class, `FunctionHandle`.
//
// NOT modeled at all: cell arrays, structs, string arrays (double-quoted),
// categorical/table types, integer classes (int8/uint8/...), sparse
// matrices. See README "What isn't supported".

export class MatlabError extends Error {
  constructor(message) { super(message); this.name = 'MatlabError'; }
}

export class Mat {
  constructor(rows, cols, re, im = null, opts = {}) {
    this.rows = rows;
    this.cols = cols;
    this.re = re; // Float64Array, column-major, length rows*cols
    this.im = im; // Float64Array or null
    this.isLogical = !!opts.isLogical;
    this.isChar = !!opts.isChar;
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
  isTruthy() {
    if (this.isEmpty) return false;
    for (let k = 0; k < this.re.length; k++) {
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
      if (i !== 0) { if (!im) im = new Float64Array(n); im[k] = i; }
    }
    return new Mat(a.rows, a.cols, re, im);
  }

  // Elementwise binary op with MATLAB-style broadcasting: same size, or
  // either operand is scalar.
  static broadcastBinary(a, b, fn) {
    const aScalar = a.numel === 1, bScalar = b.numel === 1;
    let rows, cols;
    if (aScalar && bScalar) { rows = 1; cols = 1; }
    else if (aScalar) { rows = b.rows; cols = b.cols; }
    else if (bScalar) { rows = a.rows; cols = a.cols; }
    else {
      if (a.rows !== b.rows || a.cols !== b.cols) {
        throw new MatlabError(`Matrix dimensions must agree (got ${a.sizeStr()} and ${b.sizeStr()})`);
      }
      rows = a.rows; cols = a.cols;
    }
    const n = rows * cols;
    const re = new Float64Array(n);
    let im = null;
    for (let k = 0; k < n; k++) {
      const ak = aScalar ? 0 : k, bk = bScalar ? 0 : k;
      const ar = a.re[ak], ai = a.isComplex ? a.im[ak] : 0;
      const br = b.re[bk], bi = b.isComplex ? b.im[bk] : 0;
      const [r, i] = fn(ar, ai, br, bi);
      re[k] = r;
      if (i !== 0) { if (!im) im = new Float64Array(n); im[k] = i; }
    }
    return new Mat(rows, cols, re, im);
  }
}

export class FunctionHandle {
  constructor({ name = null, params = null, body = null, closure = null, builtin = null }) {
    this.name = name;         // for @sin / @myfunc
    this.params = params;     // for anonymous functions: array of param names
    this.body = body;         // AST expr, for anonymous functions
    this.closure = closure;   // captured Map<string, value>, for anonymous functions
    this.builtin = builtin;   // JS function, if this wraps a builtin directly
  }
  displayName() {
    if (this.name) return `@${this.name}`;
    if (this.params) return `@(${this.params.join(',')}) ...`;
    return '@(function handle)';
  }
}
