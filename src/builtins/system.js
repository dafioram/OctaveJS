// system.js — Constructors (zeros/ones/eye/linspace; rand & co. are in random.js), type predicates,
// printing (disp/fprintf/sprintf/num2str), and workspace management
// (who/whos/clear/exist), plus feval/arrayfun/deal.

import { Mat, Cell, FunctionHandle, MatlabError, colonRange, valueClassName, shapeArgs, truthOf } from '../core/values.js';
import { formatValue } from '../core/interpreter.js';
import { parse } from '../core/parser.js';
import { HELP_DATA } from './help-data.js';
import { doSprintf, flattenArgsForPrintf, num2strDefault, mat2strValue, charMatrix, trimmedRows } from './format.js';

// Sizes for zeros/ones/rand/...: trailing class names ('double',
// 'like', ...) are ignored; no size arguments gives a scalar.
function shapeFromArgs(args, fname) {
  let a = args;
  // f(..., 'like', p): the class of p (always double here).
  if (a.length >= 2 && a[a.length - 2].isChar && a[a.length - 2].toJSString().toLowerCase() === 'like') a = a.slice(0, -2);
  while (a.length > 0 && a[a.length - 1].isChar) a = a.slice(0, -1);
  if (a.length === 0) return [1, 1];
  return shapeArgs(a, fname);
}

export { doSprintf, flattenArgsForPrintf };

// str2double's parser: the whole text must be one real or complex number
// (digits with optional commas as thousands separators, exponent with e or
// d, Inf, NaN, i/j imaginary unit); anything else is NaN.
const REAL = String.raw`(?:(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?|inf|nan)`;
const REAL_RE = new RegExp(`^([+-]?${REAL})$`, 'i');
const IMAG_RE = new RegExp(`^([+-]?${REAL})?\\s*([+-])\\s*(${REAL})?\\s*\\*?\\s*[ij]$`, 'i');
const IMAG_ONLY_RE = new RegExp(`^([+-]?)(${REAL})?\\s*\\*?\\s*[ij]$`, 'i');
function realValue(t) {
  const s = t.replace(/,/g, '').replace(/[dD]/, 'e').toLowerCase();
  if (/^[+-]?inf$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(s)) return NaN;
  return Number(s);
}
export function parseNumberText(text) {
  const t = text.trim();
  let m = REAL_RE.exec(t);
  if (m) return [realValue(m[1]), 0];
  m = IMAG_RE.exec(t);
  if (m && m[1] !== undefined) return [realValue(m[1]), (m[2] === '-' ? -1 : 1) * (m[3] === undefined ? 1 : realValue(m[3]))];
  m = IMAG_ONLY_RE.exec(t);
  if (m) return [0, (m[1] === '-' ? -1 : 1) * (m[2] === undefined ? 1 : realValue(m[2]))];
  return [NaN, 0];
}

// A number as a character code, as char() converts it: truncated and
// clamped to 0..65535, NaN as 0.
export const charCode = (x) => (Number.isNaN(x) ? 0 : Math.min(65535, Math.max(0, Math.trunc(x))));

// Memory a value takes, as whos reports it.
function valueBytes(v) {
  if (v instanceof Mat) return v.numel * (v.isChar ? 2 : v.isLogical ? 1 : v.isComplex ? 16 : 8);
  if (v instanceof Cell) return v.data.reduce((s, x) => s + 104 + valueBytes(x), 0);
  if (v instanceof FunctionHandle) return 32;
  if (v && v.data && v.fieldNames) return 64 + v.data.reduce((s, m) => s + [...m.values()].reduce((t, x) => t + 104 + valueBytes(x), 0), 0);
  return 0;
}

// Applies fn to a char array, or to each element of a cell array of text
// (returning a cell array of the same shape).
function eachText(v, fname, fn) {
  if (v instanceof Cell) {
    return new Cell(v.rows, v.cols, v.data.map(x => {
      if (!(x instanceof Mat) || !(x.isChar || x.isEmpty)) throw new MatlabError(`${fname}: cell array elements must be character vectors`);
      return fn(x.isChar ? x : new Mat(x.rows, x.cols, x.re, null, { isChar: true }));
    }));
  }
  if (!(v instanceof Mat)) throw new MatlabError(`Undefined function '${fname}' for input arguments of type '${valueClassName(v)}'.`, 'MATLAB:UndefinedFunction');
  return fn(v);
}

export function registerSystem(reg) {
  // Constants (real MATLAB implements these as ordinary functions too, so
  // they can be shadowed by a variable of the same name — our normal
  // "check scope first" lookup already gives us that for free).
  reg.set('pi', { fn: () => [Mat.scalar(Math.PI)] });
  // Inf(2, 3), NaN(n), ... fill an array, like zeros.
  const constFill = (v, name) => ({ fn: (args) => { const [r, c] = shapeFromArgs(args, name); const m = Mat.zeros(r, c); m.re.fill(v); return [m]; } });
  reg.set('Inf', constFill(Infinity, 'Inf'));
  reg.set('inf', constFill(Infinity, 'inf'));
  reg.set('NaN', constFill(NaN, 'NaN'));
  reg.set('nan', constFill(NaN, 'nan'));
  reg.set('eps', { fn: () => [Mat.scalar(Number.EPSILON)] });
  reg.set('i', { fn: () => [Mat.complexScalar(0, 1)] });
  reg.set('j', { fn: () => [Mat.complexScalar(0, 1)] });

  reg.set('clc', {
    fn: (_args, _n, ctx) => {
      if (ctx.host.clearConsole) ctx.host.clearConsole();
      return [];
    },
  });

  reg.set('help', {
    fn: (args, _n, ctx) => {
      if (args.length === 0) {
        ctx.interp.print("help('name') shows syntax and a short description for a function. Try help('plot') or help('find').\n");
        return [];
      }
      const name = args[0].toJSString();
      const entry = HELP_DATA.get(name);
      if (entry) {
        ctx.interp.print(`${name}\n\n  ${entry.syntax}\n\n  ${entry.desc}\n`);
        return [];
      }
      if (ctx.interp.funcTable.has(name)) {
        const def = ctx.interp.funcTable.get(name);
        const outputs = def.outputs.length === 0 ? ''
          : def.outputs.length === 1 ? `${def.outputs[0]} = `
          : `[${def.outputs.join(', ')}] = `;
        ctx.interp.print(`${name}\n\n  ${outputs}${name}(${def.params.join(', ')})\n\n  (user-defined function — no further description available; this app doesn't extract help text from comments)\n`);
        return [];
      }
      ctx.interp.print(`'${name}' not found — no builtin or user-defined function by that name.\n`);
      return [];
    },
  });

  // true/false are ordinary functions in MATLAB, so true(2,3) works too.
  const logicalFill = (v, name) => (args) => {
    const [r, c] = shapeFromArgs(args, name);
    const m = Mat.zeros(r, c); m.re.fill(v); m.isLogical = true;
    return [m];
  };
  reg.set('true', { fn: logicalFill(1, 'true') });
  reg.set('false', { fn: logicalFill(0, 'false') });

  reg.set('zeros', { fn: (args) => { const [r, c] = shapeFromArgs(args, 'zeros'); return [Mat.zeros(r, c)]; } });
  reg.set('ones', { fn: (args) => { const [r, c] = shapeFromArgs(args, 'ones'); const m = Mat.zeros(r, c); m.re.fill(1); return [m]; } });
  reg.set('eye', { fn: (args) => { const [r, c] = shapeFromArgs(args, 'eye'); const m = Mat.zeros(r, c); for (let k = 0; k < Math.min(r, c); k++) m.set2(k, k, 1); return [m]; } });
  reg.set('linspace', {
    fn: (args) => {
      const a = args[0].toScalarNumber(), b = args[1].toScalarNumber();
      const n = args.length >= 3 ? Math.round(args[2].toScalarNumber()) : 100;
      const re = new Float64Array(Math.max(n, 0));
      if (n === 1) re[0] = b;
      else for (let k = 0; k < n; k++) re[k] = a + (b - a) * k / (n - 1);
      return [new Mat(1, re.length, re)];
    },
  });
  reg.set('logspace', {
    fn: (args) => {
      const a = args[0].toScalarNumber();
      let b = args[1].toScalarNumber();
      // MATLAB: logspace(a, pi) spaces the points between 10^a and pi.
      if (b === Math.PI) b = Math.log10(Math.PI);
      const n = args.length >= 3 ? Math.floor(args[2].toScalarNumber()) : 50;
      const re = new Float64Array(Math.max(n, 0));
      for (let k = 0; k < n; k++) re[k] = Math.pow(10, k === n - 1 ? b : a + (b - a) * k / (n - 1));
      return [new Mat(1, re.length, re)];
    },
  });
  reg.set('colon', {
    fn: (args) => {
      const start = args[0].toScalarNumber();
      const step = args.length >= 3 ? args[1].toScalarNumber() : 1;
      const stop = args.length >= 3 ? args[2].toScalarNumber() : args[1].toScalarNumber();
      return [colonRange(start, step, stop)];
    },
  });

  reg.set('class', { fn: (args) => [Mat.fromString(valueClassName(args[0]))] });
  reg.set('isa', {
    fn: (args) => {
      const cn = args[1].toJSString();
      const actual = valueClassName(args[0]);
      const numericAliases = (cn === 'numeric' || cn === 'float' || cn === 'double') && actual === 'double';
      return [Mat.logicalScalar(actual === cn || numericAliases)];
    },
  });
  reg.set('isnumeric', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Mat && !args[0].isChar && !args[0].isLogical)] });
  reg.set('ischar', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Mat && args[0].isChar)] });
  reg.set('islogical', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Mat && args[0].isLogical)] });
  reg.set('iscomplex', { fn: (args) => [Mat.logicalScalar(!!args[0].isComplex)] });
  reg.set('isreal', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Mat && !args[0].isComplex)] });

  reg.set('double', {
    fn: (args) => {
      const a = args[0];
      const out = a.clone(); out.isChar = false; out.isLogical = false;
      return [out];
    },
  });
  reg.set('logical', {
    fn: (args) => {
      if (args[0].isComplex && args[0].im.some(v => v !== 0)) throw new MatlabError('Complex values cannot be converted to logicals.');
      const m = Mat.mapElementwise(args[0], (r, i) => [truthOf(r, i) ? 1 : 0, 0]);
      m.isLogical = true;
      return [m];
    },
  });
  reg.set('char', {
    fn: (args) => {
      // char(A) with numeric A keeps its shape; text arguments (char
      // arrays, cell arrays of text, several arguments) become the rows of
      // a char matrix padded with blanks.
      if (args.length === 1 && args[0] instanceof Mat) {
        const a = args[0];
        if (a.isChar) return [a];
        if (a.isLogical) throw new MatlabError('Conversion to char from logical is not possible.');
        if (a.isComplex) throw new MatlabError('Complex values cannot be converted to chars', 'MATLAB:noConversionComplexToChar');
        return [new Mat(a.rows, a.cols, Float64Array.from(a.re, charCode), null, { isChar: true })];
      }
      const lines = [];
      // Each argument adds its rows; an empty one adds a blank row.
      const addRows = (m) => {
        if (m.rows === 0) { lines.push(''); return; }
        for (let r = 0; r < m.rows; r++) {
          let s = '';
          for (let c = 0; c < m.cols; c++) s += String.fromCharCode(m.isChar ? m.re[c * m.rows + r] : charCode(m.re[c * m.rows + r]));
          lines.push(s);
        }
      };
      if (args.length > 1 && args.some(a => a instanceof Cell)) throw new MatlabError('Inputs must be character arrays.');
      for (const a of args) {
        if (a instanceof Mat && a.isComplex) throw new MatlabError('Complex values cannot be converted to chars', 'MATLAB:noConversionComplexToChar');
        if (a instanceof Cell) {
          for (const x of a.data) {
            if (!(x instanceof Mat) || !(x.isChar || x.isEmpty)) throw new MatlabError('Cell elements must be character arrays.');
            addRows(x);
          }
        } else if (a instanceof Mat) addRows(a);
        else if (a instanceof FunctionHandle) lines.push(a.name || a.displayName()); // char(@sin) is 'sin'
        else throw new MatlabError(`char: cannot convert ${valueClassName(a)} to char`);
      }
      return [charMatrix(lines)];
    },
  });

  reg.set('disp', {
    fn: (args, _n, ctx) => {
      const a = args[0];
      if ((a instanceof Mat || a instanceof Cell) && a.isEmpty) return []; // disp([]) prints nothing
      ctx.interp.print((a instanceof Mat && a.isChar && a.rows <= 1 ? a.toJSString() : formatValue(a, ctx.interp.displayFormat)) + '\n');
      return [];
    },
  });
  reg.set('fprintf', {
    fn: (args, _n, ctx) => {
      const fmt = args[0].toJSString();
      const text = doSprintf(fmt, flattenArgsForPrintf(args.slice(1)));
      ctx.interp.print(text);
      return [];
    },
  });
  reg.set('sprintf', {
    fn: (args) => {
      const fmt = args[0].toJSString();
      const text = doSprintf(fmt, flattenArgsForPrintf(args.slice(1)));
      return [Mat.fromString(text)];
    },
  });
  reg.set('num2str', {
    fn: (args) => {
      const a = args[0];
      if (!(a instanceof Mat)) throw new MatlabError('num2str: input must be numeric or char');
      if (a.isChar) return [a];
      if (a.isEmpty) return [new Mat(0, 0, new Float64Array(0), null, { isChar: true })];
      if (args.length >= 2 && args[1] instanceof Mat && args[1].isChar) {
        // num2str(A, format): the format applied to each row, leading blanks
        // shared by all rows removed.
        const fmt = args[1].toJSString();
        const lines = [];
        for (let r = 0; r < a.rows; r++) {
          const vals = [];
          for (let c = 0; c < a.cols; c++) vals.push(a.re[c * a.rows + r]);
          lines.push(doSprintf(fmt, vals));
        }
        return [trimmedRows(lines)];
      }
      if (args.length >= 2 && !args[1].isEmpty) {
        // num2str(A, precision): MATLAB's %<p+7>.<p>g for each column, leading
        // blanks shared by all rows removed.
        const p = Math.round(args[1].toScalarNumber());
        if (!(p >= 0)) throw new MatlabError('num2str: precision must be a non-negative integer');
        const lines = [];
        for (let r = 0; r < a.rows; r++) {
          const vals = [];
          for (let c = 0; c < a.cols; c++) vals.push(a.re[c * a.rows + r]);
          lines.push(vals.map(v => doSprintf(`%${p + 7}.${Math.max(p, 1)}g`, [v])).join(''));
        }
        return [trimmedRows(lines)];
      }
      return [num2strDefault(a)];
    },
  });
  // mat2str(A) | mat2str(A, n): text that evaluates back to A.
  reg.set('mat2str', {
    fn: (args) => {
      const a = args[0];
      if (!(a instanceof Mat)) throw new MatlabError('mat2str: input must be numeric, logical or char');
      const n = args.length >= 2 && !args[1].isEmpty ? Math.round(args[1].toScalarNumber()) : 15;
      if (n > 100) throw new MatlabError('mat2str: precision must be at most 100');
      return [Mat.fromString(mat2strValue(a, n >= 1 ? n : 1))];
    },
  });

  // tic starts a stopwatch (returning its id if asked); toc reports the
  // seconds since the last tic, or since tic's returned id: toc(id).
  // Absolute time in ms (not performance.now() alone, which restarts at 0 in
  // every worker — a tic restored after Stop must still mean the same moment).
  const now = () => (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now());
  reg.set('tic', {
    fn: (_args, nargout, ctx) => {
      const t = now();
      if (nargout >= 1) return [Mat.scalar(t)];
      ctx.interp.ticTime = t;
      return [];
    },
  });
  reg.set('toc', {
    fn: (args, nargout, ctx) => {
      let start;
      if (args.length >= 1) start = args[0].toScalarNumber();
      else if (ctx.interp.ticTime !== undefined) start = ctx.interp.ticTime;
      else throw new MatlabError('You must call TIC without an output argument before calling TOC without an input argument.');
      const secs = (now() - start) / 1000;
      if (nargout >= 1) return [Mat.scalar(secs)];
      ctx.interp.print(`Elapsed time is ${secs.toFixed(6)} seconds.\n`);
      return [];
    },
  });

  // format long / format short / format (= short). compact/loose are
  // accepted for compatibility and change nothing.
  reg.set('format', {
    fn: (args, _n, ctx) => {
      const mode = args.length ? args[0].toJSString().toLowerCase() : 'short';
      if (mode === 'long' || mode === 'short') ctx.interp.displayFormat = mode;
      else if (mode !== 'compact' && mode !== 'loose') throw new MatlabError(`format: unsupported style '${mode}' (use short or long)`);
      return [];
    },
  });

  reg.set('who', {
    // who prints the variable names; w = who returns them as a sorted
    // cell column.
    fn: (_args, nargout, ctx) => {
      const names = [...ctx.scope.names()].sort();
      if (nargout >= 1) return [new Cell(names.length, 1, names.map(n => Mat.fromString(n)))];
      if (names.length) ctx.interp.print('\nYour variables are:\n\n' + names.join('  ') + '  \n\n');
      return [];
    },
  });
  reg.set('whos', {
    // MATLAB's table layout. Bytes are exact for numeric, char and
    // logical arrays and MATLAB-like estimates for containers.
    fn: (_args, _n, ctx) => {
      const names = [...ctx.scope.names()].sort();
      if (!names.length) return [];
      const width = Math.max(4, ...names.map(n => n.length));
      let text = `  ${'Name'.padEnd(width)}      Size            Bytes  Class     Attributes\n\n`;
      for (const n of names) {
        const v = ctx.scope.get(n);
        const size = v instanceof FunctionHandle ? '1x1' : v.sizeStr();
        text += `  ${n.padEnd(width)}      ${size.padEnd(15)}${String(valueBytes(v)).padStart(6)}  ${valueClassName(v)}\n`;
      }
      ctx.interp.print(text + '\n');
      return [];
    },
  });
  reg.set('clear', {
    fn: (args, _n, ctx) => {
      // `clear`, `clear all`, `clear variables` empty the workspace;
      // otherwise each argument names a variable (`clear x y`, clear('x')).
      const names = args.filter(a => a instanceof Mat && a.isChar).map(a => a.toJSString());
      if (names.length === 0 || names.some(n => n === 'all' || n === '-all' || n === 'variables' || n === '-variables')) {
        ctx.scope.clearAll();
        return [];
      }
      for (const n of names) ctx.scope.delete(n);
      return [];
    },
  });
  reg.set('exist', {
    fn: (args, _n, ctx) => {
      const name = args[0].toJSString();
      if (ctx.scope.has(name)) return [Mat.scalar(1)];
      if (ctx.interp.funcTable.has(name)) return [Mat.scalar(2)];
      if (ctx.interp.files.has(name + '.m') || ctx.interp.files.has(name)) return [Mat.scalar(2)];
      if (ctx.interp.builtins.has(name)) return [Mat.scalar(5)];
      return [Mat.scalar(0)];
    },
  });

  reg.set('feval', {
    fn: (args, nargout, ctx) => {
      const f = args[0];
      const rest = args.slice(1);
      if (f instanceof FunctionHandle) return ctx.interp.callFunctionValue(f, rest, nargout, ctx.scope);
      const name = f.toJSString();
      return ctx.interp.callNamed(name, rest, nargout, ctx.scope);
    },
  });
  reg.set('func2str', {
    fn: (args) => {
      if (!(args[0] instanceof FunctionHandle)) throw new MatlabError('func2str: input must be a function handle');
      const fh = args[0];
      return [Mat.fromString(fh.name ? fh.name : fh.displayName())];
    },
  });
  reg.set('deal', {
    fn: (args, nargout) => {
      if (args.length === 1) return Array.from({ length: Math.max(nargout, 1) }, () => args[0]);
      return args;
    },
  });

  // ---- string utilities (cheap and useful now that char arrays exist) ----
  // strcmp/strcmpi compare text; with a cell array of strings on either
  // side they compare element by element and return a logical array.
  function strCompare(args, fold) {
    const norm = (v) => (v instanceof Mat && v.isChar && v.rows <= 1) ? (fold ? v.toJSString().toLowerCase() : v.toJSString()) : null;
    const [a, b] = args;
    if (!(a instanceof Cell) && !(b instanceof Cell)) {
      const x = norm(a), y = norm(b);
      return Mat.logicalScalar(x !== null && y !== null && x === y);
    }
    const ca = a instanceof Cell ? a : null, cb = b instanceof Cell ? b : null;
    if (ca && cb && ca.numel !== 1 && cb.numel !== 1 && (ca.rows !== cb.rows || ca.cols !== cb.cols)) {
      throw new MatlabError('Inputs must be the same size or either one can be a scalar.');
    }
    const shape = ca && ca.numel !== 1 ? ca : (cb && cb.numel !== 1 ? cb : (ca || cb));
    const n = shape.numel;
    const out = Mat.zeros(shape.rows, shape.cols);
    for (let k = 0; k < n; k++) {
      const x = norm(ca ? ca.data[ca.numel === 1 ? 0 : k] : a);
      const y = norm(cb ? cb.data[cb.numel === 1 ? 0 : k] : b);
      out.re[k] = x !== null && y !== null && x === y ? 1 : 0;
    }
    out.isLogical = true;
    return out;
  }
  reg.set('strcmp', { fn: (args) => [strCompare(args, false)] });
  reg.set('strcmpi', { fn: (args) => [strCompare(args, true)] });
  // upper/lower keep the shape of a char array, map a cell array of text
  // element by element and return other numeric input unchanged.
  const changeCase = (fname, upper) => ({
    fn: (args) => [!(args[0] instanceof Mat || args[0] instanceof Cell) ? args[0] : eachText(args[0], fname, (m) => {
      if (!m.isChar) return m;
      const out = new Mat(m.rows, m.cols, Float64Array.from(m.re, c => { const ch = String.fromCharCode(c); const t = upper ? ch.toUpperCase() : ch.toLowerCase(); return t.length === 1 ? t.charCodeAt(0) : c; }), null, { isChar: true });
      return out;
    })],
  });
  reg.set('upper', changeCase('upper', true));
  reg.set('lower', changeCase('lower', false));
  // strtrim removes leading and trailing whitespace (and null characters);
  // for a char matrix, the columns that are blank in every row.
  reg.set('strtrim', {
    fn: (args) => [eachText(args[0], 'strtrim', (m) => {
      if (!m.isChar) throw new MatlabError('strtrim: input must be a character array or a cell array of character vectors');
      if (m.isEmpty) return m;
      const blank = (c) => c === 0 || /\s/.test(String.fromCharCode(c));
      const colBlank = (c) => { for (let r = 0; r < m.rows; r++) if (!blank(m.re[c * m.rows + r])) return false; return true; };
      let first = 0, last = m.cols - 1;
      while (first <= last && colBlank(first)) first++;
      while (last >= first && colBlank(last)) last--;
      const cols = Math.max(0, last - first + 1);
      return new Mat(m.rows, cols, m.re.slice(first * m.rows, (first + cols) * m.rows), null, { isChar: true });
    })],
  });
  reg.set('strrep', {
    fn: (args) => {
      const from = args[1].toJSString(), to = args[2].toJSString();
      return [eachText(args[0], 'strrep', (m) => {
        const s = m.toJSString();
        return from === '' ? m : Mat.fromString(s.split(from).join(to));
      })];
    },
  });
  reg.set('str2double', {
    fn: (args) => {
      const a = args[0];
      if (a instanceof Cell) {
        const re = new Float64Array(a.numel);
        let im = null;
        a.data.forEach((x, k) => {
          const [r, i] = x instanceof Mat && x.isChar && x.rows <= 1 ? parseNumberText(x.toJSString()) : [NaN, 0];
          re[k] = r;
          if (i !== 0) { if (!im) im = new Float64Array(a.numel); im[k] = i; }
        });
        return [new Mat(a.rows, a.cols, re, im)];
      }
      if (!(a instanceof Mat) || !a.isChar) return [Mat.scalar(NaN)];
      const [r, i] = parseNumberText(a.toJSString());
      return [i !== 0 ? Mat.complexScalar(r, i) : Mat.scalar(r)];
    },
  });
  reg.set('str2num', {
    fn: (args, _n, ctx) => {
      const s = args[0].toJSString();
      let ast;
      try { ast = parse(s); } catch (e) { return [Mat.empty()]; }
      const stmt = ast.body[0];
      if (!stmt || stmt.type !== 'ExprStmt') return [Mat.empty()];
      const [result] = ctx.interp.evalForNargout(stmt.expr, ctx.scope, 1);
      return [result];
    },
  });
}
