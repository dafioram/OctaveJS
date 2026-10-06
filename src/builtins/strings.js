// strings.js — Text functions: strcat, strfind, contains, startsWith,
// endsWith, regexp, regexpi, regexprep, int2str.
//
// Regular expressions run on JavaScript's engine, whose syntax matches
// MATLAB's for the common constructs (classes, quantifiers, groups,
// lookaround, named tokens (?<name>...)). MATLAB's word anchors \< and \>
// are translated to \b; and in regexprep's replacement text, $0 means the
// whole match, as in MATLAB.

import { Mat, Cell, StructArray, MatlabError } from '../core/values.js';
import { charMatrix } from './format.js';
import { charCode } from './system.js';

function isText(v) { return v instanceof Mat && v.isChar && v.rows <= 1; }
function text(v, what) {
  if (!isText(v)) throw new MatlabError(`${what} must be a character vector`);
  return v.toJSString();
}

// Applies fn to a char vector, or to each element of a cell array of
// strings (giving a same-shape result built by `collect`).
function mapText(v, what, fn, collect) {
  if (v instanceof Cell) {
    if (!v.isCellstr()) throw new MatlabError(`${what} must be a cell array of character vectors`);
    return collect(v, v.data.map(x => fn(x.toJSString())));
  }
  return fn(text(v, what));
}
const toLogicalArray = (shape, vals) => {
  const out = new Mat(shape.rows, shape.cols, Float64Array.from(vals, b => (b ? 1 : 0)));
  out.isLogical = true;
  return out;
};
const toCell = (shape, vals) => new Cell(shape.rows, shape.cols, vals);

function rowVector(vals) { return new Mat(1, vals.length, Float64Array.from(vals)); }
// Match positions: a row, or [] (0x0) when there are none, as MATLAB.
const indices = (vals) => (vals.length ? rowVector(vals) : Mat.empty());

// Escapes MATLAB processes in regexprep replacement text.
function unescapeText(s) {
  return s.replace(/\\([ntrfv\\])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', '\\': '\\' }[c]));
}

function compileRegex(expr, flags) {
  const src = expr.replace(/\\<|\\>/g, '\\b');
  try {
    return new RegExp(src, flags);
  } catch (e) {
    throw new MatlabError(`Invalid regular expression: ${e.message}`);
  }
}

function allMatches(str, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m);
    if (m[0] === '') re.lastIndex++; // don't loop forever on empty matches
  }
  return out;
}

const REGEXP_OUTPUTS = ['start', 'end', 'tokenextents', 'match', 'tokens', 'names', 'split'];

// [o1, o2, ...] = regexp(str, expr, options...) for one char vector.
function regexpOne(str, expr, opts, nargout) {
  const re = compileRegex(expr, 'gd' + (opts.ignoreCase ? 'i' : ''));
  let matches = allMatches(str, re);
  if (opts.once) matches = matches.slice(0, 1);
  const groupNames = [];
  const nameRe = /\(\?<([A-Za-z][A-Za-z0-9_]*)>/g;
  let g;
  while ((g = nameRe.exec(expr)) !== null) groupNames.push(g[1]);

  const tokensOf = (m) => {
    // With no capture groups, the "token" is the whole match (MATLAB rule).
    const groups = m.length > 1 ? m.slice(1) : [m[0]];
    return new Cell(1, groups.length, groups.map(t => Mat.fromString(t === undefined ? '' : t)));
  };
  const extentsOf = (m) => {
    const ranges = m.length > 1 ? m.indices.slice(1) : [m.indices[0]];
    return Mat.fromRows(ranges.map(r => (r ? [r[0] + 1, r[1]] : [m.index + 1, m.index])));
  };
  const build = {
    start: () => (opts.once ? (matches[0] ? Mat.scalar(matches[0].index + 1) : Mat.empty()) : indices(matches.map(m => m.index + 1))),
    end: () => (opts.once ? (matches[0] ? Mat.scalar(matches[0].index + matches[0][0].length) : Mat.empty()) : indices(matches.map(m => m.index + m[0].length))),
    tokenextents: () => (opts.once ? (matches[0] ? extentsOf(matches[0]) : Mat.empty()) : new Cell(1, matches.length, matches.map(extentsOf))),
    match: () => (opts.once ? Mat.fromString(matches[0] ? matches[0][0] : '') : new Cell(1, matches.length, matches.map(m => Mat.fromString(m[0])))),
    tokens: () => (opts.once ? (matches[0] ? tokensOf(matches[0]) : Cell.empty(1, 0)) : new Cell(1, matches.length, matches.map(tokensOf))),
    names: () => {
      if (groupNames.length === 0) return new StructArray(1, 1, []);
      const els = matches.map(m => new Map(groupNames.map(n => [n, Mat.fromString((m.groups && m.groups[n]) || '')])));
      if (opts.once) return els.length ? new StructArray(1, 1, groupNames, els.slice(0, 1)) : new StructArray(0, 0, groupNames);
      return new StructArray(els.length ? 1 : 0, els.length, groupNames, els);
    },
    split: () => {
      const pieces = [];
      let last = 0;
      for (const m of matches) { pieces.push(str.slice(last, m.index)); last = m.index + m[0].length; }
      pieces.push(str.slice(last));
      // An empty piece is a 0x0 char, as MATLAB returns it.
      return new Cell(1, pieces.length, pieces.map(p => (p ? Mat.fromString(p) : new Mat(0, 0, new Float64Array(0), null, { isChar: true }))));
    },
  };
  const order = opts.selected.length ? opts.selected : REGEXP_OUTPUTS;
  return order.slice(0, Math.max(nargout, 1)).map(k => build[k]());
}

function parseRegexpOptions(optArgs, fname) {
  const opts = { once: false, ignoreCase: false, selected: [] };
  for (const o of optArgs) {
    const name = text(o, `${fname}: option`).toLowerCase();
    if (name === 'once') opts.once = true;
    else if (name === 'ignorecase') opts.ignoreCase = true;
    else if (name === 'matchcase') opts.ignoreCase = false;
    else if (REGEXP_OUTPUTS.includes(name)) opts.selected.push(name);
    else throw new MatlabError(`${fname}: unsupported option '${name}'`);
  }
  return opts;
}

export function registerStrings(reg) {
  // strcat: char inputs lose trailing whitespace; any cell input makes the
  // result a cell array (scalars and char vectors repeat to match).
  reg.set('strcat', {
    fn: (args) => {
      if (args.length === 0) throw new MatlabError('strcat requires at least one input');
      const cells = args.filter(a => a instanceof Cell);
      if (cells.length === 0) {
        // Char (or numeric) arrays join side by side, row by row, each first
        // losing its trailing columns of whitespace or nulls; a single row
        // repeats to match the others. Numbers become character codes.
        for (const a of args) if (!(a instanceof Mat)) throw new MatlabError('Inputs must be cell arrays or strings.', 'MATLAB:strcat:InvalidInputType');
        const blank = (x) => x === 0 || x === 32 || (x >= 9 && x <= 13);
        const parts = args.filter(a => a.numel > 0).map(a => {
          let cols = a.cols;
          while (cols > 0 && Array.from({ length: a.rows }, (_, r) => a.re[(cols - 1) * a.rows + r]).every(blank)) cols--;
          return { a, cols };
        });
        // The rows of the nonempty arguments (all empty: strcat(zeros(1, 0)) is 1x0).
        const R = Math.max(0, ...(parts.length ? parts : args.map(a => ({ a }))).map(p => p.a.rows));
        if (R === 0) return [new Mat(0, 0, new Float64Array(0), null, { isChar: true })];
        for (const p of parts) if (p.a.rows !== 1 && p.a.rows !== R) throw new MatlabError('All the inputs must have the same number of rows or a single row.', 'MATLAB:strcat:NumberOfRowsMismatch');
        const width = parts.reduce((w, p) => w + p.cols, 0);
        const out = new Mat(R, width, new Float64Array(R * width), null, { isChar: true });
        let c0 = 0;
        for (const { a, cols } of parts) {
          for (let c = 0; c < cols; c++) for (let r = 0; r < R; r++) out.re[(c0 + c) * R + r] = charCode(a.re[c * a.rows + (a.rows === 1 ? 0 : r)]);
          c0 += cols;
        }
        return [out];
      }
      const shape = cells.find(c => c.numel !== 1) || cells[0];
      for (const c of cells) if (c.numel !== 1 && (c.rows !== shape.rows || c.cols !== shape.cols)) throw new MatlabError('strcat: cell array inputs must be the same size');
      const out = [];
      for (let k = 0; k < shape.numel; k++) {
        out.push(Mat.fromString(args.map(a => {
          const v = a instanceof Cell ? a.data[a.numel === 1 ? 0 : k] : a;
          if (!(v instanceof Mat) || !(v.isChar || v.isEmpty)) throw new MatlabError('Inputs must be cell arrays or strings.', 'MATLAB:strcat:InvalidInputType');
          // A char argument loses its trailing whitespace; cell contents keep it.
          return a instanceof Cell ? v.toJSString() : v.toJSString().replace(/[ \t\n\v\f\r]+$/, '');
        }).join('')));
      }
      return [new Cell(shape.rows, shape.cols, out)];
    },
  });

  // k = strfind(str, pat): 1-based start indices of every (possibly
  // overlapping) occurrence; a cell array str gives a cell of results.
  reg.set('strfind', {
    fn: (args) => {
      // Numeric arrays are searched as sequences of values, as MATLAB does.
      const seq = (v) => (v instanceof Mat ? Array.from(v.re) : null);
      if (args[0] instanceof Mat && !args[0].isChar && seq(args[1])) {
        const s = seq(args[0]), p = seq(args[1]);
        if (!p.length) return [Mat.empty()];
        const idx = [];
        for (let i = 0; i + p.length <= s.length; i++) if (p.every((x, k) => s[i + k] === x)) idx.push(i + 1);
        return [indices(idx)];
      }
      if (args[1] instanceof Mat && args[1].isEmpty) return [args[0] instanceof Cell ? new Cell(args[0].rows, args[0].cols, args[0].data.map(() => Mat.empty())) : Mat.empty()];
      const pat = text(args[1], 'strfind: pattern');
      const find = (s) => {
        const idx = [];
        if (pat.length === 0) return Mat.empty();
        for (let i = s.indexOf(pat); i !== -1; i = s.indexOf(pat, i + 1)) idx.push(i + 1);
        return idx.length ? rowVector(idx) : Mat.empty(); // no match: [] (0x0), as MATLAB
      };
      return [mapText(args[0], 'strfind: input', find, toCell)];
    },
  });

  // contains/startsWith/endsWith(str, pattern, 'IgnoreCase', tf): pattern
  // may be a cell array of alternatives; str may be a cell array.
  const textTest = (fname, test) => ({
    fn: (args) => {
      let ignoreCase = false;
      if (args.length >= 4 && isText(args[2]) && args[2].toJSString().toLowerCase() === 'ignorecase') ignoreCase = args[3].isTruthy();
      else if (args.length > 2) throw new MatlabError(`${fname}: expected ${fname}(str, pattern, 'IgnoreCase', tf)`);
      const pats = args[1] instanceof Cell ? args[1].data.map(p => text(p, `${fname}: pattern`)) : [text(args[1], `${fname}: pattern`)];
      const norm = (s) => (ignoreCase ? s.toLowerCase() : s);
      const ps = pats.map(norm);
      const one = (s) => ps.some(p => test(norm(s), p));
      const r = mapText(args[0], `${fname}: input`, one, toLogicalArray);
      return [r instanceof Mat ? r : Mat.logicalScalar(r)];
    },
  });
  reg.set('contains', textTest('contains', (s, p) => s.includes(p)));
  reg.set('startsWith', textTest('startsWith', (s, p) => s.startsWith(p)));
  reg.set('endsWith', textTest('endsWith', (s, p) => s.endsWith(p)));

  const regexpFn = (fname, forceIgnoreCase) => ({
    fn: (args, nargout) => {
      if (args.length < 2) throw new MatlabError(`${fname} requires a string and an expression`);
      const expr = text(args[1], `${fname}: expression`);
      const opts = parseRegexpOptions(args.slice(2), fname);
      if (forceIgnoreCase) opts.ignoreCase = true;
      const str = args[0];
      if (str instanceof Cell) {
        // One output cell per requested output, each holding per-string results.
        const per = str.data.map(s => regexpOne(text(s, `${fname}: input`), expr, opts, nargout));
        const nOut = per.length ? per[0].length : Math.max(nargout, 1);
        return Array.from({ length: nOut }, (_, j) => new Cell(str.rows, str.cols, per.map(r => r[j])));
      }
      return regexpOne(text(str, `${fname}: input`), expr, opts, nargout);
    },
  });
  reg.set('regexp', regexpFn('regexp', false));
  reg.set('regexpi', regexpFn('regexpi', true));

  reg.set('regexprep', {
    fn: (args) => {
      if (args.length < 3) throw new MatlabError('regexprep requires a string, an expression and a replacement');
      const expr = text(args[1], 'regexprep: expression');
      let once = false, ignoreCase = false;
      for (const o of args.slice(3)) {
        const name = text(o, 'regexprep: option').toLowerCase();
        if (name === 'once') once = true;
        else if (name === 'ignorecase') ignoreCase = true;
        else if (name !== 'matchcase') throw new MatlabError(`regexprep: unsupported option '${name}'`);
      }
      const rep = unescapeText(text(args[2], 'regexprep: replacement')).replace(/\$0/g, '$$&');
      const re = compileRegex(expr, (once ? '' : 'g') + (ignoreCase ? 'i' : ''));
      return [mapText(args[0], 'regexprep: input', (s) => Mat.fromString(s.replace(re, rep)), toCell)];
    },
  });

  reg.set('int2str', {
    fn: (args, _n, ctx) => {
      const a = args[0];
      if (!(a instanceof Mat)) throw new MatlabError('int2str: input must be numeric');
      const rounded = Mat.mapElementwise(a, (r) => [Math.sign(r) * Math.round(Math.abs(r)), 0]);
      // The builtin directly, so a user function named num2str can't intercept it.
      return ctx.interp.builtins.get('num2str').fn([rounded], 1, ctx);
    },
  });
  registerBaseConversions(reg);
}

// dec2bin/dec2hex/dec2base: one row per element of D (taken as D(:)),
// zero-padded to a common width (at least N digits). bin2dec/hex2dec/
// base2dec read each row of a char matrix (or each cell of a cellstr)
// into a column vector, ignoring spaces.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function registerBaseConversions(reg) {
  const toBase = (fname, fixedBase) => ({
    fn: (args) => {
      const d = args[0];
      if (!(d instanceof Mat) || d.isComplex) throw new MatlabError(`Undefined function '${fname}' for input arguments of type '${d instanceof Mat ? 'double' : 'cell'}'.`, 'MATLAB:UndefinedFunction');
      let symbols = DIGITS, k = 1;
      if (!fixedBase) {
        const b = args[1];
        if (b instanceof Mat && b.isChar && b.numel > 1) symbols = b.toJSString();
        else if (b instanceof Mat && b.numel === 1 && Number.isInteger(b.re[0]) && b.re[0] >= 2 && b.re[0] <= 36) symbols = DIGITS.slice(0, b.re[0]);
        else throw new MatlabError('Base B must be an integer between 2 and 36 or a string of symbols.', 'MATLAB:dec2base:BaseNotIntegerOrSymbols');
        k = 2;
      } else symbols = DIGITS.slice(0, fixedBase);
      let minLen = 0;
      if (args.length > k) {
        const n = args[k];
        if (!(n instanceof Mat) || n.numel !== 1 || !Number.isInteger(n.re[0]) || n.re[0] < 0) throw new MatlabError('N must be a nonnegative integer.', `MATLAB:${fname}:InvalidN`);
        minLen = n.re[0];
      }
      const base = symbols.length;
      const rows = Array.from(d.re, (x) => {
        if (!(x >= 0) || !Number.isInteger(x) || x >= 2 ** 53) throw new MatlabError('D must be a nonnegative integer smaller than flintmax.', `MATLAB:${fname}:InvalidInput`);
        let t = '';
        do { t = symbols[x % base] + t; x = Math.floor(x / base); } while (x > 0);
        return t;
      });
      if (!rows.length) return [new Mat(0, 0, new Float64Array(0), null, { isChar: true })];
      const width = Math.max(minLen, ...rows.map(t => t.length));
      return [charMatrix(rows.map(t => symbols[0].repeat(width - t.length) + t))];
    },
  });
  const fromBase = (fname, fixedBase, message) => ({
    fn: (args) => {
      const s = args[0];
      let base = fixedBase;
      if (!fixedBase) {
        const b = args[1];
        if (!(b instanceof Mat) || b.numel !== 1 || !Number.isInteger(b.re[0]) || b.re[0] < 2 || b.re[0] > 36) throw new MatlabError('Base B must be an integer between 2 and 36.', 'MATLAB:base2dec:InvalidBase');
        base = b.re[0];
      }
      let lines;
      if (s instanceof Cell) lines = s.data.map(x => { if (!(x instanceof Mat) || !(x.isChar || x.isEmpty)) throw new MatlabError('Input must be a character array or a cell array of strings.'); return x.toJSString(); });
      else if (s instanceof Mat && (s.isChar || s.isEmpty)) lines = Array.from({ length: s.rows }, (_, r) => { let t = ''; for (let c = 0; c < s.cols; c++) t += String.fromCharCode(s.re[c * s.rows + r]); return t; });
      else throw new MatlabError('Input must be a character array or a cell array of strings.', `MATLAB:${fname}:InputMustBeString`);
      const out = lines.map(line => {
        let v = 0;
        for (const ch of line.toUpperCase().replace(/ /g, '')) {
          const digit = DIGITS.indexOf(ch);
          if (digit < 0 || digit >= base) throw new MatlabError(message(base), `MATLAB:${fname}:IllegalCharacter`);
          v = v * base + digit;
        }
        return v;
      });
      return [new Mat(out.length, out.length ? 1 : 0, Float64Array.from(out))];
    },
  });
  reg.set('dec2bin', toBase('dec2bin', 2));
  reg.set('dec2hex', toBase('dec2hex', 16));
  reg.set('dec2base', toBase('dec2base', 0));
  reg.set('bin2dec', fromBase('bin2dec', 2, () => 'Binary string may consist only of characters 0 and 1'));
  reg.set('hex2dec', fromBase('hex2dec', 16, () => 'Input string found with characters other than 0-9, a-f, or A-F.'));
  reg.set('base2dec', fromBase('base2dec', 0, (b) => `String contains characters that are not valid digits in base ${b}.`));
}
