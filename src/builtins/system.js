// system.js — Constructors (zeros/ones/eye/rand/linspace), type predicates,
// printing (disp/fprintf/sprintf/num2str), and workspace management
// (who/whos/clear/exist), plus feval/arrayfun/deal.

import { Mat, FunctionHandle, MatlabError } from '../core/values.js';
import { formatMat } from '../core/interpreter.js';
import { parse } from '../core/parser.js';
import { HELP_DATA } from './help-data.js';

function shapeFromArgs(args, ignoreTrailingString = true) {
  let a = args;
  if (ignoreTrailingString && a.length > 0 && a[a.length - 1].isChar) a = a.slice(0, -1);
  if (a.length === 0) return [1, 1];
  if (a.length === 1) {
    if (a[0].numel === 2) return [Math.round(a[0].re[0]), Math.round(a[0].re[1])];
    const n = Math.round(a[0].toScalarNumber());
    return [n, n];
  }
  return [Math.round(a[0].toScalarNumber()), Math.round(a[1].toScalarNumber())];
}

function boxMuller() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function formatNumForPrint(x) {
  if (Number.isInteger(x)) return String(x);
  if (!isFinite(x)) return String(x);
  return Number(x.toPrecision(5)).toString();
}

// A pragmatic sprintf: supports %d %i %f %g %e %s %% with optional
// width/precision (e.g. %6.2f), recycling the format string across the
// flattened list of numeric/char arguments the way MATLAB's sprintf does.
function doSprintf(fmt, valueList) {
  // MATLAB's fprintf/sprintf process C-style backslash escapes in the
  // format string itself (independently of how the string literal was
  // written), so `fprintf('done\n')` really does emit a newline.
  fmt = fmt.replace(/\\[ntr\\]/g, (m) => ({ '\\n': '\n', '\\t': '\t', '\\r': '\r', '\\\\': '\\' }[m]));
  const specRe = /%(-?\d+)?(\.\d+)?([diouxXeEfFgGsc%])/g;
  let out = '';
  let vi = 0;
  const specs = [...fmt.matchAll(specRe)];
  if (specs.length === 0) return fmt;
  do {
    let last = 0;
    for (const m of specs) {
      out += fmt.slice(last, m.index);
      last = m.index + m[0].length;
      const [, width, prec, conv] = m;
      if (conv === '%') { out += '%'; continue; }
      const val = valueList[vi++];
      let piece;
      if (conv === 's') {
        piece = val === undefined ? '' : (typeof val === 'string' ? val : formatNumForPrint(val));
      } else if (conv === 'c') {
        piece = String.fromCharCode(Math.round(Number(val) || 0));
      } else if ('di'.includes(conv)) {
        piece = String(Math.round(Number(val) || 0));
      } else if ('ouxX'.includes(conv)) {
        const n = Math.round(Number(val) || 0);
        piece = conv === 'o' ? n.toString(8) : n.toString(16);
        if (conv === 'X') piece = piece.toUpperCase();
      } else if ('eE'.includes(conv)) {
        const p = prec ? parseInt(prec.slice(1)) : 6;
        piece = Number(val).toExponential(p);
        if (conv === 'E') piece = piece.toUpperCase();
      } else { // f, g, G
        const p = prec ? parseInt(prec.slice(1)) : (conv === 'f' ? 6 : undefined);
        piece = p !== undefined ? Number(val).toFixed(p) : formatNumForPrint(Number(val));
      }
      if (width) {
        const w = parseInt(width);
        piece = w < 0 ? piece.padEnd(-w) : piece.padStart(w);
      }
      out += piece;
    }
    out += fmt.slice(last);
  } while (vi < valueList.length && specs.length > 0);
  return out;
}

function flattenArgsForPrintf(args) {
  const vals = [];
  for (const a of args) {
    if (a.isChar) vals.push(a.toJSString());
    else for (let k = 0; k < a.numel; k++) vals.push(a.re[k]);
  }
  return vals;
}

export function registerSystem(reg) {
  // Constants (real MATLAB implements these as ordinary functions too, so
  // they can be shadowed by a variable of the same name — our normal
  // "check scope first" lookup already gives us that for free).
  reg.set('pi', { fn: () => [Mat.scalar(Math.PI)] });
  reg.set('e', { fn: () => [Mat.scalar(Math.E)] });
  reg.set('Inf', { fn: () => [Mat.scalar(Infinity)] });
  reg.set('inf', { fn: () => [Mat.scalar(Infinity)] });
  reg.set('NaN', { fn: () => [Mat.scalar(NaN)] });
  reg.set('nan', { fn: () => [Mat.scalar(NaN)] });
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

  reg.set('zeros', { fn: (args) => { const [r, c] = shapeFromArgs(args); return [Mat.zeros(r, c)]; } });
  reg.set('ones', { fn: (args) => { const [r, c] = shapeFromArgs(args); const m = Mat.zeros(r, c); m.re.fill(1); return [m]; } });
  reg.set('eye', { fn: (args) => { const [r, c] = shapeFromArgs(args); const m = Mat.zeros(r, c); for (let k = 0; k < Math.min(r, c); k++) m.set2(k, k, 1); return [m]; } });
  reg.set('rand', { fn: (args) => { const [r, c] = shapeFromArgs(args); const m = Mat.zeros(r, c); for (let k = 0; k < m.numel; k++) m.re[k] = Math.random(); return [m]; } });
  reg.set('randn', { fn: (args) => { const [r, c] = shapeFromArgs(args); const m = Mat.zeros(r, c); for (let k = 0; k < m.numel; k++) m.re[k] = boxMuller(); return [m]; } });
  reg.set('randi', {
    fn: (args) => {
      let hi = 1, lo = 1;
      if (args[0].numel === 2) { lo = Math.round(args[0].re[0]); hi = Math.round(args[0].re[1]); }
      else { hi = Math.round(args[0].toScalarNumber()); lo = 1; }
      const [r, c] = shapeFromArgs(args.slice(1));
      const m = Mat.zeros(r, c);
      for (let k = 0; k < m.numel; k++) m.re[k] = lo + Math.floor(Math.random() * (hi - lo + 1));
      return [m];
    },
  });
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
      const a = args[0].toScalarNumber(), b = args[1].toScalarNumber();
      const n = args.length >= 3 ? Math.round(args[2].toScalarNumber()) : 50;
      const re = new Float64Array(Math.max(n, 0));
      for (let k = 0; k < n; k++) re[k] = Math.pow(10, a + (b - a) * k / (n - 1));
      return [new Mat(1, re.length, re)];
    },
  });
  reg.set('colon', {
    fn: (args) => {
      const start = args[0].toScalarNumber();
      const step = args.length >= 3 ? args[1].toScalarNumber() : 1;
      const stop = args.length >= 3 ? args[2].toScalarNumber() : args[1].toScalarNumber();
      const vals = [];
      if (step > 0) for (let v = start; v <= stop + 1e-10; v += step) vals.push(v);
      else if (step < 0) for (let v = start; v >= stop - 1e-10; v += step) vals.push(v);
      return [new Mat(1, vals.length, Float64Array.from(vals))];
    },
  });

  reg.set('class', { fn: (args) => [Mat.fromString(args[0] instanceof FunctionHandle ? 'function_handle' : args[0].className())] });
  reg.set('isa', {
    fn: (args) => {
      const cn = args[1].toJSString();
      const actual = args[0] instanceof FunctionHandle ? 'function_handle' : args[0].className();
      const numericAliases = (cn === 'numeric' || cn === 'float' || cn === 'double') && actual === 'double';
      return [Mat.logicalScalar(actual === cn || numericAliases)];
    },
  });
  reg.set('isnumeric', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Mat && !args[0].isChar && !args[0].isLogical)] });
  reg.set('ischar', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Mat && args[0].isChar)] });
  reg.set('islogical', { fn: (args) => [Mat.logicalScalar(args[0] instanceof Mat && args[0].isLogical)] });
  reg.set('isreal', { fn: (args) => [Mat.logicalScalar(!args[0].isComplex)] });
  reg.set('iscomplex', { fn: (args) => [Mat.logicalScalar(!!args[0].isComplex)] });
  reg.set('is_function_handle', { fn: (args) => [Mat.logicalScalar(args[0] instanceof FunctionHandle)] });

  reg.set('double', {
    fn: (args) => {
      const a = args[0];
      const out = a.clone(); out.isChar = false; out.isLogical = false;
      return [out];
    },
  });
  reg.set('logical', {
    fn: (args) => [Mat.mapElementwise(args[0], (r) => [r !== 0 ? 1 : 0, 0])].map(m => { m.isLogical = true; return m; }),
  });
  reg.set('char', {
    fn: (args) => {
      const a = args[0];
      if (a.isChar) return [a];
      const out = a.clone(); out.isChar = true; out.isLogical = false;
      return [out];
    },
  });

  reg.set('disp', {
    fn: (args, _n, ctx) => {
      const a = args[0];
      ctx.interp.print((a.isChar ? a.toJSString() : formatMat(a)) + '\n');
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
      if (a.numel === 1) {
        if (args.length >= 2) {
          const p = Math.round(args[1].toScalarNumber());
          return [Mat.fromString(Number(a.re[0]).toPrecision(p))];
        }
        return [Mat.fromString(formatNumForPrint(a.re[0]))];
      }
      const rows = [];
      for (let r = 0; r < a.rows; r++) {
        const parts = [];
        for (let c = 0; c < a.cols; c++) parts.push(formatNumForPrint(a.get2(r, c)));
        rows.push(parts.join('  '));
      }
      return [Mat.fromString(rows.join('\n'))];
    },
  });
  reg.set('mat2str', {
    fn: (args) => {
      const a = args[0];
      const rows = [];
      for (let r = 0; r < a.rows; r++) {
        const parts = [];
        for (let c = 0; c < a.cols; c++) parts.push(formatNumForPrint(a.get2(r, c)));
        rows.push(parts.join(' '));
      }
      return [Mat.fromString('[' + rows.join(';') + ']')];
    },
  });

  reg.set('who', {
    fn: (_args, _n, ctx) => {
      const names = [...ctx.scope.names()].filter(n => n !== 'ans');
      ctx.interp.print(names.length ? 'Your variables are:\n\n' + names.join('  ') + '\n' : 'No variables in the current workspace.\n');
      return [];
    },
  });
  reg.set('whos', {
    fn: (_args, _n, ctx) => {
      const names = [...ctx.scope.names()];
      let text = 'Name         Size       Class\n';
      for (const n of names) {
        const v = ctx.scope.get(n);
        if (v instanceof Mat) text += `${n.padEnd(12)} ${v.sizeStr().padEnd(10)} ${v.className()}\n`;
        else text += `${n.padEnd(12)} ${'1x1'.padEnd(10)} function_handle\n`;
      }
      ctx.interp.print(text);
      return [];
    },
  });
  reg.set('clear', {
    fn: (args, _n, ctx) => {
      if (args.length === 0) { ctx.scope.vars.clear(); return []; }
      // note: clear takes variable *names*, evaluated builtins get values;
      // handled specially in the interpreter dispatch below is overkill,
      // so we accept char-array names too, for `clear('x')` style calls.
      for (const a of args) { if (a.isChar) ctx.scope.vars.delete(a.toJSString()); }
      return [];
    },
  });
  reg.set('exist', {
    fn: (args, _n, ctx) => {
      const name = args[0].toJSString();
      if (ctx.scope.has(name)) return [Mat.scalar(1)];
      if (ctx.interp.funcTable.has(name)) return [Mat.scalar(2)];
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
  reg.set('arrayfun', {
    fn: (args, nargout, ctx) => {
      const f = args[0];
      const arrays = args.slice(1).filter(a => a instanceof Mat);
      const n = arrays[0].numel;
      for (const a of arrays) if (a.numel !== n) throw new MatlabError('arrayfun: all array inputs must have the same number of elements');
      const re = new Float64Array(n);
      let im = null;
      for (let k = 0; k < n; k++) {
        const callArgs = arrays.map(a => new Mat(1, 1, new Float64Array([a.re[k]]), a.isComplex ? new Float64Array([a.im[k]]) : null));
        const [r] = ctx.interp.callFunctionValue(f, callArgs, 1, ctx.scope);
        re[k] = r.re[0];
        if (r.isComplex && r.im[0] !== 0) { if (!im) im = new Float64Array(n); im[k] = r.im[0]; }
      }
      return [new Mat(arrays[0].rows, arrays[0].cols, re, im)];
    },
  });
  reg.set('deal', {
    fn: (args, nargout) => {
      if (args.length === 1) return Array.from({ length: Math.max(nargout, 1) }, () => args[0]);
      return args;
    },
  });

  // ---- string utilities (cheap and useful now that char arrays exist) ----
  reg.set('strcmp', { fn: (args) => [Mat.logicalScalar(args[0].isChar && args[1].isChar && args[0].toJSString() === args[1].toJSString())] });
  reg.set('strcmpi', { fn: (args) => [Mat.logicalScalar(args[0].isChar && args[1].isChar && args[0].toJSString().toLowerCase() === args[1].toJSString().toLowerCase())] });
  reg.set('upper', { fn: (args) => [Mat.fromString(args[0].toJSString().toUpperCase())] });
  reg.set('lower', { fn: (args) => [Mat.fromString(args[0].toJSString().toLowerCase())] });
  reg.set('strtrim', { fn: (args) => [Mat.fromString(args[0].toJSString().trim())] });
  reg.set('strrep', {
    fn: (args) => {
      const s = args[0].toJSString(), from = args[1].toJSString(), to = args[2].toJSString();
      return [Mat.fromString(from === '' ? s : s.split(from).join(to))];
    },
  });
  reg.set('strsplit', {
    fn: (args) => {
      const s = args[0].toJSString();
      const delim = args.length >= 2 ? args[1].toJSString() : ' ';
      const parts = s.split(delim).filter(p => p !== '');
      // No cell arrays in this app: return the pieces vertically concatenated
      // as a char matrix isn't right either (ragged widths), so this is
      // deliberately limited — see README. Most useful with strjoin/strcmp
      // on a single expected piece, or just avoid strsplit for now.
      throw new MatlabError("strsplit's result would be a cell array, which isn't supported. Use strtrim/strrep, or String.split-like manual parsing via a loop, instead.");
    },
  });
  reg.set('str2double', {
    fn: (args) => {
      const s = args[0].toJSString();
      const v = parseFloat(s);
      return [Mat.scalar(Number.isNaN(v) ? NaN : v)];
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
