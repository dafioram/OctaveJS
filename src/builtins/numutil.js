// numutil.js — Helpers shared by the numerical solvers (ode.js, optim.js,
// interp.js): calling the user's function, option structs (odeset /
// optimset), and small dense linear algebra on plain JS arrays.

import { Mat, StructArray, FunctionHandle, MatlabError } from '../core/values.js';

// A JS function that calls the user's function f (a handle, or a function
// name as text, which MATLAB also accepts) and returns its first output.
// Extra trailing arguments (the old `fzero(f, x0, options, p1, p2)` style)
// are passed after the solver's own arguments.
export function funcCaller(ctx, f, fname, extra = []) {
  let call;
  if (f instanceof FunctionHandle) call = (args) => ctx.interp.callFunctionValue(f, args, 1, ctx.scope);
  else if (f instanceof Mat && f.isChar) {
    const name = f.toJSString();
    call = (args) => ctx.interp.callNamed(name, args, 1, ctx.scope);
  } else throw new MatlabError(`${fname}: the first input must be a function handle`);
  return (...args) => {
    const out = call([...args, ...extra]);
    const v = out[0];
    if (!(v instanceof Mat) || v.isChar) throw new MatlabError(`${fname}: the function must return numeric values`);
    return v;
  };
}

// A size or count argument (magic(n), parula(m), primes(n), ...): a
// finite real scalar, so Inf or NaN can't turn into an endless loop or a
// huge allocation.
export function finiteScalarArg(v, fname, what = 'the size') {
  const n = v.toScalarNumber();
  if (!Number.isFinite(n)) throw new MatlabError(`${fname}: ${what} must be a finite number`);
  return n;
}

// For a linear operation implemented on real arrays: applies it to the
// real and imaginary parts of the argument at `index` separately and
// combines the results, so complex input works too.
export function linearOnParts(args, index, op) {
  const z = args[index];
  if (!(z instanceof Mat) || !z.isComplex) return op(args);
  const part = (vals) => { const a = args.slice(); a[index] = new Mat(z.rows, z.cols, Float64Array.from(vals)); return op(a); };
  const re = part(z.re), im = part(z.im);
  return new Mat(re.rows, re.cols, re.re, im.re.some(v => v !== 0) ? Float64Array.from(im.re) : null);
}

// A real scalar from a function's return value.
export function realScalar(v, fname) {
  if (v.numel !== 1) throw new MatlabError(`${fname}: the function must return a scalar value (got ${v.sizeStr()})`);
  if (v.isComplex && v.im[0] !== 0) throw new MatlabError(`${fname}: the function must return a real value`);
  return v.re[0];
}

export const columnOf = (values) => new Mat(values.length, 1, Float64Array.from(values));

// MATLAB's eps(x): the spacing of doubles at x.
export function epsOf(x) {
  const a = Math.abs(x);
  if (a === 0) return 2 ** -1074;
  if (!Number.isFinite(a)) return NaN;
  const e = Math.floor(Math.log2(a));
  return 2 ** (Math.max(e, -1022) - 52);
}

// ---- option structs ----

// A field of an options struct (case-insensitive), or null when it is
// missing or empty — the solver's default then applies.
export function getOption(opts, name) {
  if (!opts) return null;
  const key = opts.fieldNames.find(f => f.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const v = opts.data[0].get(key);
  if (!v || (v instanceof Mat && v.isEmpty)) return null;
  return v;
}

export function getScalarOption(opts, name, fname) {
  const v = getOption(opts, name);
  if (v === null) return null;
  if (!(v instanceof Mat) || v.isChar || v.numel !== 1) throw new MatlabError(`${fname}: option ${name} must be a numeric scalar`);
  return v.re[0];
}

export function getTextOption(opts, name, fname) {
  const v = getOption(opts, name);
  if (v === null) return null;
  if (!(v instanceof Mat) || !v.isChar) throw new MatlabError(`${fname}: option ${name} must be text`);
  return v.toJSString().toLowerCase();
}

// An options argument: a struct (from odeset/optimset) or [] for defaults.
export function optionsArg(v, fname) {
  if (v === undefined || (v instanceof Mat && v.isEmpty)) return null;
  if (v instanceof StructArray && v.numel === 1) return v;
  throw new MatlabError(`${fname}: options must be a structure (see ${fname.startsWith('ode') ? 'odeset' : 'optimset'})`);
}

// odeset / optimset: a struct with every known field (empty unless set),
// built from Name,Value pairs, optionally starting from existing option
// structs: set(old, Name, Value, ...) or set(old, new).
export function optionsSetter(fname, fields) {
  return (args) => {
    const values = new Map(fields.map(f => [f, Mat.empty()]));
    const assign = (name, value) => {
      const key = fields.find(f => f.toLowerCase() === name.toLowerCase());
      if (!key) throw new MatlabError(`${fname}: unrecognized property name '${name}'`);
      values.set(key, value);
    };
    let i = 0;
    while (i < args.length && args[i] instanceof StructArray) {
      const s = args[i++];
      for (const f of s.fieldNames) {
        const v = s.data[0].get(f);
        if (!(v instanceof Mat && v.isEmpty)) assign(f, v);
      }
    }
    const rest = args.slice(i);
    if (rest.length % 2 !== 0) throw new MatlabError(`${fname}: arguments must be property name/value pairs`);
    for (let k = 0; k < rest.length; k += 2) {
      if (!(rest[k] instanceof Mat && rest[k].isChar)) throw new MatlabError(`${fname}: property names must be text`);
      assign(rest[k].toJSString(), rest[k + 1]);
    }
    return [StructArray.scalar(Object.fromEntries(values))];
  };
}

// odeget / optimget: get(options, name) or get(options, name, default).
export function optionsGetter(fname) {
  return (args) => {
    if (args.length < 2) throw new MatlabError(`${fname}: expected ${fname}(options, name)`);
    const opts = optionsArg(args[0], fname);
    const v = getOption(opts, args[1].toJSString());
    if (v !== null) return [v];
    return [args.length >= 3 ? args[2] : Mat.empty()];
  };
}

// ---- small dense linear algebra (row-major arrays of rows) ----

// Solves A x = b by Gaussian elimination with partial pivoting.
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (M[p][c] === 0) throw new MatlabError('Matrix is singular to working precision.');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
