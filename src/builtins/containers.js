// containers.js — Cell array and struct builtins: cell, iscell,
// iscellstr, cellfun, arrayfun, num2cell, cell2mat, cellstr, strsplit,
// strjoin, struct, fieldnames, isfield, rmfield, isstruct, getfield,
// setfield, struct2cell, numfields.

import { Mat, Cell, StructArray, FunctionHandle, MatlabError, valueClassName, shapeArgs } from '../core/values.js';

function isText(v) { return v instanceof Mat && v.isChar; }
function textOf(v, what) {
  if (!isText(v)) throw new MatlabError(`${what} must be a character vector`);
  return v.toJSString();
}

// Sizes from (n), (m, n) or ([m n]) arguments, as used by cell().
function sizeArgs(args) {
  if (args.length === 0) return [0, 0];
  return shapeArgs(args, 'cell');
}

// The k-th element of an array as a 1x1 value of the same kind.
function elementAt(v, k) {
  if (v instanceof Mat) {
    return new Mat(1, 1, new Float64Array([v.re[k]]), v.isComplex ? new Float64Array([v.im[k]]) : null,
      { isChar: v.isChar, isLogical: v.isLogical });
  }
  if (v instanceof Cell) return new Cell(1, 1, [v.data[k]]);
  if (v instanceof StructArray) return new StructArray(1, 1, v.fieldNames, [new Map(v.data[k])], v.classOverride);
  throw new MatlabError(`Cannot iterate over a ${valueClassName(v)}`);
}

// MATLAB's escape processing for strsplit/strjoin delimiters.
function unescapeDelim(s) {
  return s.replace(/\\([ntrfv\\0])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', '\\': '\\', 0: '\0' }[c]));
}

function toHandle(f) {
  if (f instanceof FunctionHandle) return f;
  if (isText(f)) return new FunctionHandle({ name: f.toJSString() });
  throw new MatlabError('First argument must be a function handle or function name');
}

// Splits trailing Name,Value options (e.g. 'UniformOutput', false) off an
// argument list. Only the given option names are recognized.
function splitOptions(args, names, minPositional) {
  const opts = {};
  let end = args.length;
  while (end - 2 >= minPositional && isText(args[end - 2]) && names.includes(args[end - 2].toJSString().toLowerCase())) {
    opts[args[end - 2].toJSString().toLowerCase()] = args[end - 1];
    end -= 2;
  }
  return { positional: args.slice(0, end), opts };
}

// Shared engine for cellfun/arrayfun: calls f on corresponding elements
// of each input; collects results into arrays (UniformOutput true, each
// result must be a scalar) or into cell arrays (UniformOutput false).
function mapElements(ctx, fname, f, inputs, getElem, nargout, uniform) {
  const shape = inputs[0];
  const n = shape.numel;
  for (const x of inputs) {
    if (x.rows !== shape.rows || x.cols !== shape.cols) throw new MatlabError(`${fname}: all input arguments must be the same size`);
  }
  const nout = Math.max(nargout, 1);
  const results = Array.from({ length: nout }, () => new Array(n));
  let produced = true;
  for (let k = 0; k < n; k++) {
    const outs = ctx.interp.callFunctionValue(f, inputs.map(x => getElem(x, k)), nout, ctx.scope);
    if (outs.length === 0 && nargout === 0) { produced = false; continue; }
    if (outs.length < nout) throw new MatlabError(`${fname}: the function returned fewer outputs than requested`);
    for (let j = 0; j < nout; j++) results[j][k] = outs[j];
  }
  if (!produced) return [];
  if (!uniform) return results.map(vals => new Cell(shape.rows, shape.cols, vals));
  return results.map(vals => {
    const out = Mat.zeros(shape.rows, shape.cols);
    let allLogical = n > 0, allChar = n > 0;
    vals.forEach((v, k) => {
      if (!(v instanceof Mat) || v.numel !== 1) {
        throw new MatlabError(`${fname}: non-scalar result in uniform output; set 'UniformOutput' to false to collect results in a cell array`);
      }
      out.re[k] = v.re[0];
      if (v.isComplex && v.im[0] !== 0) { if (!out.im) out.im = new Float64Array(n); out.im[k] = v.im[0]; }
      allLogical = allLogical && v.isLogical;
      allChar = allChar && v.isChar;
    });
    out.isLogical = allLogical; out.isChar = allChar;
    return out;
  });
}

function makeCellstrColumn(strings) {
  return new Cell(strings.length, 1, strings.map(s => Mat.fromString(s)));
}

export function registerContainers(reg) {
  // ---------------- cells ----------------
  reg.set('cell', { fn: (args) => { const [r, c] = sizeArgs(args); return [new Cell(r, c)]; } });
  reg.set('iscell', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Cell)] });
  reg.set('iscellstr', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Cell && args[0].isCellstr())] });

  reg.set('cellfun', {
    fn: (args, nargout, ctx) => {
      const { positional, opts } = splitOptions(args, ['uniformoutput'], 2);
      if (positional.length < 2) throw new MatlabError('cellfun requires a function and at least one cell array');
      const inputs = positional.slice(1);
      if (!inputs.every(x => x instanceof Cell)) throw new MatlabError('cellfun: inputs must be cell arrays (use arrayfun for other arrays)');
      const uniform = opts.uniformoutput ? opts.uniformoutput.isTruthy() : true;
      return mapElements(ctx, 'cellfun', toHandle(positional[0]), inputs, (c, k) => c.data[k], nargout, uniform);
    },
  });
  reg.set('arrayfun', {
    fn: (args, nargout, ctx) => {
      const { positional, opts } = splitOptions(args, ['uniformoutput'], 2);
      if (positional.length < 2) throw new MatlabError('arrayfun requires a function and at least one array');
      const uniform = opts.uniformoutput ? opts.uniformoutput.isTruthy() : true;
      return mapElements(ctx, 'arrayfun', toHandle(positional[0]), positional.slice(1), elementAt, nargout, uniform);
    },
  });

  reg.set('num2cell', {
    fn: (args) => {
      const a = args[0];
      if (a instanceof Cell) return [a];
      return [new Cell(a.rows, a.cols, Array.from({ length: a.numel }, (_, k) => elementAt(a, k)))];
    },
  });

  reg.set('cell2mat', {
    fn: (args, _n, ctx) => {
      const c = args[0];
      if (!(c instanceof Cell)) throw new MatlabError('cell2mat: input must be a cell array');
      if (c.isEmpty) return [Mat.empty()];
      if (c.data.some(v => v instanceof Cell)) throw new MatlabError('cell2mat: cell arrays inside the cell array are not supported');
      const rows = [];
      for (let r = 0; r < c.rows; r++) {
        const row = [];
        for (let k = 0; k < c.cols; k++) row.push(c.data[k * c.rows + r]);
        rows.push(ctx.interp.hconcat(row));
      }
      return [ctx.interp.vconcat(rows)];
    },
  });

  reg.set('cellstr', {
    fn: (args) => {
      const a = args[0];
      if (a instanceof Cell) {
        if (!a.isCellstr()) throw new MatlabError('cellstr: cell array must contain only character vectors');
        return [a];
      }
      if (!isText(a)) throw new MatlabError('cellstr: input must be a character array or cell array of character vectors');
      if (a.isEmpty) return [new Cell(1, 1, [Mat.fromString('')])];
      const strings = [];
      for (let r = 0; r < a.rows; r++) {
        let s = '';
        for (let c = 0; c < a.cols; c++) s += String.fromCharCode(a.re[c * a.rows + r]);
        strings.push(s.replace(/\s+$/, ''));
      }
      return [makeCellstrColumn(strings)];
    },
  });

  reg.set('strsplit', {
    fn: (args) => {
      const { positional, opts } = splitOptions(args, ['collapsedelimiters'], 1);
      const s = textOf(positional[0], 'strsplit: input');
      let delims;
      if (positional.length >= 2) {
        const d = positional[1];
        if (d instanceof Cell) delims = d.data.map(x => unescapeDelim(textOf(x, 'strsplit: delimiter')));
        else delims = [unescapeDelim(textOf(d, 'strsplit: delimiter'))];
      } else {
        delims = [' ', '\f', '\n', '\r', '\t', '\v'];
      }
      const collapse = opts.collapsedelimiters ? opts.collapsedelimiters.isTruthy() : true;
      const alt = delims.filter(x => x.length > 0).sort((x, y) => y.length - x.length)
        .map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const parts = alt ? s.split(new RegExp(collapse ? `(?:${alt})+` : `(?:${alt})`)) : [s];
      return [new Cell(1, parts.length, parts.map(p => Mat.fromString(p)))];
    },
  });

  reg.set('strjoin', {
    fn: (args) => {
      const c = args[0];
      if (!(c instanceof Cell) || !c.isCellstr()) throw new MatlabError('strjoin: first input must be a cell array of character vectors');
      const delim = args.length >= 2 ? unescapeDelim(textOf(args[1], 'strjoin: delimiter')) : ' ';
      return [Mat.fromString(c.data.map(v => v.toJSString()).join(delim))];
    },
  });

  // ---------------- structs ----------------
  reg.set('struct', {
    fn: (args) => {
      if (args.length === 0) return [new StructArray(1, 1, [])];
      if (args.length === 1 && args[0] instanceof Mat && args[0].isEmpty) return [new StructArray(0, 0, [])];
      if (args.length === 1 && args[0] instanceof StructArray) return [args[0]];
      if (args.length % 2 !== 0) throw new MatlabError('struct: arguments must be field name / value pairs');
      const names = [], values = [];
      for (let i = 0; i < args.length; i += 2) {
        const name = textOf(args[i], 'struct: field name');
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new MatlabError(`Invalid field name '${name}'`);
        names.push(name); values.push(args[i + 1]);
      }
      // A cell value with other than one element makes a struct array of
      // that size, one element per cell; 1x1 cells and non-cells apply to all.
      let rows = 1, cols = 1, sized = false;
      for (const v of values) {
        if (v instanceof Cell && v.numel !== 1) {
          if (sized && (v.rows !== rows || v.cols !== cols)) throw new MatlabError('struct: cell array values must all be the same size');
          rows = v.rows; cols = v.cols; sized = true;
        }
      }
      const n = rows * cols;
      const data = Array.from({ length: n }, (_, k) => new Map(names.map((name, i) => {
        const v = values[i];
        return [name, v instanceof Cell ? v.data[v.numel === 1 ? 0 : k] : v];
      })));
      return [new StructArray(rows, cols, names, data)];
    },
  });

  reg.set('isstruct', { fn: (args) => [Mat.logicalScalar(args[0] instanceof StructArray && !args[0].classOverride)] });

  reg.set('fieldnames', {
    fn: (args) => {
      if (!(args[0] instanceof StructArray)) throw new MatlabError('fieldnames: input must be a struct');
      return [makeCellstrColumn(args[0].fieldNames)];
    },
  });
  reg.set('numfields', { fn: (args) => [Mat.scalar(args[0] instanceof StructArray ? args[0].fieldNames.length : 0)] });

  reg.set('isfield', {
    fn: (args) => {
      const s = args[0], f = args[1];
      const has = (name) => s instanceof StructArray && s.hasField(name);
      if (f instanceof Cell) {
        const out = Mat.zeros(f.rows, f.cols);
        f.data.forEach((v, k) => { out.re[k] = isText(v) && has(v.toJSString()) ? 1 : 0; });
        out.isLogical = true;
        return [out];
      }
      return [Mat.logicalScalar(isText(f) && has(f.toJSString()))];
    },
  });

  reg.set('rmfield', {
    fn: (args) => {
      const s = args[0];
      if (!(s instanceof StructArray)) throw new MatlabError('rmfield: first input must be a struct');
      const f = args[1];
      const drop = f instanceof Cell ? f.data.map(v => textOf(v, 'rmfield: field name')) : [textOf(f, 'rmfield: field name')];
      for (const name of drop) if (!s.hasField(name)) throw new MatlabError(`A field named '${name}' doesn't exist.`);
      const keep = s.fieldNames.filter(n => !drop.includes(n));
      return [new StructArray(s.rows, s.cols, keep, s.data.map(el => new Map(keep.map(n => [n, el.get(n)]))), s.classOverride)];
    },
  });

  reg.set('getfield', {
    fn: (args) => {
      const s = args[0];
      if (!(s instanceof StructArray) || s.numel < 1) throw new MatlabError('getfield: first input must be a struct');
      return [s.getField(0, textOf(args[1], 'getfield: field name'))];
    },
  });
  reg.set('setfield', {
    fn: (args) => {
      const s0 = args[0];
      if (!(s0 instanceof StructArray) || s0.numel !== 1) throw new MatlabError('setfield: first input must be a 1x1 struct');
      const s = s0.clone();
      const name = textOf(args[1], 'setfield: field name');
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new MatlabError(`Invalid field name '${name}'`);
      s.setField(0, name, args[2]);
      return [s];
    },
  });

  reg.set('struct2cell', {
    fn: (args) => {
      const s = args[0];
      if (!(s instanceof StructArray)) throw new MatlabError('struct2cell: input must be a struct');
      const nf = s.fieldNames.length;
      const data = [];
      for (const el of s.data) for (const f of s.fieldNames) data.push(el.get(f));
      return [new Cell(nf, s.numel, data)];
    },
  });
}
