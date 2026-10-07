// logic.js — Comparison, set membership and the function forms of
// operators: isequal, isequaln, ismember, xor/not/and/or, and plus,
// minus, times, mtimes, eq, lt, ... (which MATLAB code passes around as
// handles, e.g. cellfun(@plus, ...) or arrayfun(@times, ...)).

import { Mat, Cell, StructArray, FunctionHandle, MatlabError, argCountError, truthOf } from '../core/values.js';
import { applyBinaryOp } from '../core/interpreter.js';

// Deep equality as isequal defines it: same size and values, ignoring the
// numeric class (isequal('a', 97) is true). NaN equals NaN only when
// `nanEqual` (isequaln).
function valuesEqual(a, b, nanEqual) {
  if (a instanceof Mat && b instanceof Mat) {
    if (a.rows !== b.rows || a.cols !== b.cols) return false;
    for (let k = 0; k < a.numel; k++) {
      const ar = a.re[k], br = b.re[k];
      const ai = a.isComplex ? a.im[k] : 0, bi = b.isComplex ? b.im[k] : 0;
      const same = (x, y) => x === y || (nanEqual && Number.isNaN(x) && Number.isNaN(y));
      if (!same(ar, br) || !same(ai, bi)) return false;
    }
    return true;
  }
  if (a instanceof Cell && b instanceof Cell) {
    if (a.rows !== b.rows || a.cols !== b.cols) return false;
    return a.data.every((v, k) => valuesEqual(v, b.data[k], nanEqual));
  }
  if (a instanceof StructArray && b instanceof StructArray) {
    if (a.rows !== b.rows || a.cols !== b.cols) return false;
    if (a.fieldNames.length !== b.fieldNames.length || !a.fieldNames.every(f => b.hasField(f))) return false;
    return a.data.every((el, k) => a.fieldNames.every(f => valuesEqual(el.get(f), b.data[k].get(f), nanEqual)));
  }
  if (a instanceof FunctionHandle && b instanceof FunctionHandle) {
    return a === b || (a.name !== null && a.name === b.name);
  }
  return false;
}

function isText(v) { return v instanceof Mat && v.isChar && v.rows <= 1; }

export function registerLogic(reg) {
  const allEqual = (nanEqual) => (args) => {
    if (args.length < 2) throw new MatlabError('isequal requires at least two inputs');
    return [Mat.logicalScalar(args.slice(1).every(b => valuesEqual(args[0], b, nanEqual)))];
  };
  reg.set('isequal', { fn: allEqual(false) });
  reg.set('isequaln', { fn: allEqual(true) });

  // [tf, loc] = ismember(A, S): tf(i) says whether A(i) occurs in S, loc(i)
  // is the lowest index where it does (0 if not). Works on numbers, and
  // on text against a cell array of strings.
  reg.set('ismember', {
    fn: (args, nargout) => {
      const [a, s] = args;
      if (args.length > 2) throw new MatlabError("ismember: options such as 'rows' are not supported");
      if (a instanceof Cell || s instanceof Cell) {
        const strs = (v) => {
          if (isText(v)) return [v.toJSString()];
          if (v instanceof Cell && v.isCellstr()) return v.data.map(x => x.toJSString());
          throw new MatlabError('ismember: text inputs must be character vectors or cell arrays of character vectors');
        };
        const set = new Map();
        strs(s).forEach((x, i) => { if (!set.has(x)) set.set(x, i + 1); });
        const items = strs(a);
        const shape = a instanceof Cell ? a : { rows: 1, cols: 1 };
        const tf = Mat.zeros(shape.rows, shape.cols), loc = Mat.zeros(shape.rows, shape.cols);
        items.forEach((x, k) => { const i = set.get(x); tf.re[k] = i ? 1 : 0; loc.re[k] = i || 0; });
        tf.isLogical = true;
        return nargout >= 2 ? [tf, loc] : [tf];
      }
      if (!(a instanceof Mat) || !(s instanceof Mat)) throw new MatlabError('ismember: unsupported input types');
      const key = (m, k) => `${m.re[k]}_${m.isComplex ? m.im[k] : 0}`;
      const set = new Map();
      for (let k = 0; k < s.numel; k++) { const kk = key(s, k); if (!set.has(kk)) set.set(kk, k + 1); }
      const tf = Mat.zeros(a.rows, a.cols), loc = Mat.zeros(a.rows, a.cols);
      for (let k = 0; k < a.numel; k++) {
        const i = Number.isNaN(a.re[k]) ? undefined : set.get(key(a, k));
        tf.re[k] = i ? 1 : 0; loc.re[k] = i || 0;
      }
      tf.isLogical = true;
      return nargout >= 2 ? [tf, loc] : [tf];
    },
  });

  const binary = (op) => ({
    fn: (args, _n, ctx) => {
      if (args.length !== 2) throw argCountError(args.length, 2);
      if (!(args[0] instanceof Mat) || !(args[1] instanceof Mat)) throw new MatlabError(`Operator '${op}' is only defined for numeric, logical and char arrays`);
      return [ctx.interp.reportWarnings(applyBinaryOp(op, args[0], args[1]))];
    },
  });
  const ops = {
    plus: '+', minus: '-', times: '.*', rdivide: './', ldivide: '.\\', mtimes: '*',
    mrdivide: '/', mldivide: '\\', mpower: '^', eq: '==', ne: '~=', lt: '<', gt: '>',
    le: '<=', ge: '>=', and: '&', or: '|',
  };
  for (const [name, op] of Object.entries(ops)) reg.set(name, binary(op));

  const truth = (v) => {
    if (!(v instanceof Mat)) throw new MatlabError('Logical operations require numeric, logical or char inputs');
    return v;
  };
  reg.set('xor', {
    fn: (args) => {
      const out = Mat.broadcastBinary(truth(args[0]), truth(args[1]),
        (ar, ai, br, bi) => [(truthOf(ar, ai) !== truthOf(br, bi)) ? 1 : 0, 0]);
      out.isLogical = true;
      return [out];
    },
  });
  reg.set('not', {
    fn: (args) => {
      const out = Mat.mapElementwise(truth(args[0]), (r, i) => {
        return [truthOf(r, i) ? 0 : 1, 0];
      });
      out.isLogical = true;
      return [out];
    },
  });
  // bsxfun(f, A, B): older spelling of implicit expansion; f(A, B) already
  // expands for the element-wise builtins.
  reg.set('bsxfun', {
    fn: (args, _n, ctx) => {
      if (args.length !== 3) throw new MatlabError('bsxfun requires a function and two arrays');
      return ctx.interp.callFunctionValue(args[0], [args[1], args[2]], 1, ctx.scope);
    },
  });
  reg.set('uminus', { fn: (args) => [Mat.mapElementwise(truth(args[0]), (r, i) => [-r, -i])] });
  reg.set('uplus', { fn: (args) => { const v = truth(args[0]); return [v.isChar || v.isLogical ? Mat.mapElementwise(v, (r, i) => [r, i]) : v]; } });
}
