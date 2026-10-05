// format.js — Number-to-text formatting shared by sprintf/fprintf (and
// error/warning messages), num2str and mat2str, following MATLAB's (C's)
// rules: %e exponents have at least two digits, %g uses 6 significant
// digits by default, NaN/Inf print as NaN/Inf for every numeric
// conversion, and a non-integer given to an integer conversion (%d, %i,
// %u, %o, %x, %c, %s) is printed with %e instead, as MATLAB does.

import { Mat, MatlabError, valueClassName } from '../core/values.js';

const nonFinite = (v) => (Number.isNaN(v) ? 'NaN' : v > 0 ? 'Inf' : '-Inf');

// C-style %e: mantissa with p decimals, exponent with at least 2 digits.
function expForm(v, p, upper = false, alt = false) {
  let s = v.toExponential(Math.min(p, 100)).replace(/e([+-])(\d)$/, 'e$10$2');
  if (alt && p === 0) s = s.replace('e', '.e');
  return upper ? s.toUpperCase() : s;
}

// C-style %g with p significant digits.
function genForm(v, p, upper = false, alt = false) {
  if (p === 0) p = 1;
  if (v === 0) return alt ? (0).toFixed(p - 1) : '0';
  const exp = Number(v.toExponential(p - 1).split('e')[1]);
  let s;
  if (exp < -4 || exp >= p) {
    s = expForm(v, p - 1, false, alt);
    if (!alt) s = s.replace(/\.?0+e/, 'e');
  } else {
    s = v.toFixed(Math.max(p - 1 - exp, 0));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return upper ? s.toUpperCase() : s;
}

// Formats one value for one conversion spec (before padding to the
// field width).
function convert(conv, val, prec, flags) {
  const alt = flags.includes('#');
  const signed = (body, neg) => (neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + body;
  if (conv === 's') {
    if (val === undefined) return '';
    if (typeof val === 'string') return prec !== null ? val.slice(0, prec) : val;
    // A number with %s: its character when it is an integer, else %e.
    if (Number.isInteger(val) && val >= 0) return String.fromCharCode(val);
    if (!Number.isFinite(val)) return signed(Number.isNaN(val) ? 'NaN' : 'Inf', val < 0);
    return signed(expForm(Math.abs(val), prec ?? 6), val < 0);
  }
  if (val === undefined) return '';
  if (typeof val === 'string') return val; // text with a numeric conversion prints as text
  if (Number.isNaN(val)) return signed('NaN', false);
  if (!Number.isFinite(val)) return signed('Inf', val < 0);
  const neg = val < 0, a = Math.abs(val);
  if (conv === 'c') return Number.isInteger(val) && !neg ? String.fromCharCode(val) : signed(expForm(a, 6), neg);
  if ('diouxX'.includes(conv)) {
    // A non-integer (or a negative value for an unsigned conversion) prints with %e.
    if (!Number.isInteger(val) || ('ouxX'.includes(conv) && neg)) return signed(expForm(a, prec ?? 6), neg);
    if ('diu'.includes(conv)) {
      let digits = a < 1e21 ? String(a) : BigInt(a).toString();
      if (prec !== null) digits = digits.padStart(prec, '0');
      return signed(digits, neg);
    }
    let t = a < 1e21 ? a.toString(conv === 'o' ? 8 : 16) : BigInt(a).toString(conv === 'o' ? 8 : 16);
    if (conv === 'X') t = t.toUpperCase();
    if (alt && a !== 0) t = (conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X') + t;
    return t;
  }
  if (conv === 'e' || conv === 'E') return signed(expForm(a, prec ?? 6, conv === 'E', alt), neg);
  if (conv === 'f' || conv === 'F') {
    let t = a.toFixed(Math.min(prec ?? 6, 100));
    if (alt && (prec ?? 6) === 0) t += '.';
    return signed(t, neg);
  }
  return signed(genForm(a, prec ?? 6, conv === 'G', alt), neg);
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\' };

// sprintf/fprintf: the format is applied to the flattened values,
// repeating as long as values remain (MATLAB's recycling rule).
export function doSprintf(fmt, valueList) {
  // fprintf/sprintf process escapes in the format itself, however the
  // literal was written, so fprintf('done\n') emits a newline.
  fmt = fmt.replace(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|[ntrabfv\\])/g, (m, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ESCAPES[e];
  });
  const specRe = /%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?([diouxXeEfFgGsc%])/g;
  const specs = [...fmt.matchAll(specRe)];
  if (specs.length === 0 || specs.every(m => m[4] === '%')) return fmt.replace(/%%/g, '%');
  let out = '';
  let vi = 0;
  const anyValues = valueList.length > 0;
  do {
    let last = 0;
    for (const m of specs) {
      out += fmt.slice(last, m.index);
      // Out of values: output stops at the first conversion that needs
      // one. (With no values at all, the format prints with empty fields.)
      if (m[4] !== '%' && anyValues && vi >= valueList.length) { last = -1; break; }
      last = m.index + m[0].length;
      const [, flags, widthSpec, precSpec, conv] = m;
      if (conv === '%') { out += '%'; continue; }
      let width = widthSpec === '*' ? Math.round(Number(valueList[vi++]) || 0) : widthSpec ? parseInt(widthSpec, 10) : 0;
      const prec = precSpec === '*' ? Math.round(Number(valueList[vi++]) || 0) : precSpec !== undefined ? parseInt(precSpec, 10) : null;
      let left = flags.includes('-');
      if (width < 0) { left = true; width = -width; }
      let piece = convert(conv, valueList[vi++], prec, flags);
      if (piece.length < width) {
        const zeroPad = flags.includes('0') && !left && !'sc'.includes(conv) && /^[+ -]?[0-9]/.test(piece);
        if (left) piece = piece.padEnd(width);
        else if (zeroPad) {
          const signChar = /^[+ -]/.test(piece) ? piece[0] : '';
          piece = signChar + piece.slice(signChar.length).padStart(width - signChar.length, '0');
        } else piece = piece.padStart(width);
      }
      out += piece;
    }
    if (last >= 0) out += fmt.slice(last);
  } while (vi < valueList.length);
  return out;
}

export function flattenArgsForPrintf(args) {
  const vals = [];
  for (const a of args) {
    if (!(a instanceof Mat)) throw new MatlabError(`Formatted printing doesn't accept ${valueClassName(a)} arguments; pass the contents instead (e.g. c{:} or s.field)`);
    if (a.isChar) vals.push(a.toJSString());
    else for (let k = 0; k < a.numel; k++) vals.push(a.re[k]);
  }
  return vals;
}

// A char matrix from lines of text (shorter lines padded with blanks).
export function charMatrix(lines) {
  const cols = Math.max(0, ...lines.map(l => l.length));
  const m = new Mat(lines.length, cols, new Float64Array(lines.length * cols).fill(32), null, { isChar: true });
  lines.forEach((l, r) => { for (let c = 0; c < l.length; c++) m.re[c * lines.length + r] = l.charCodeAt(c); });
  return m;
}

// num2str(A): MATLAB's default formats. Integers print as integers;
// other values with %g and 4 digits after the leading digit
// (max(floor(log10(max|A|)) + 5, 5) significant digits); matrices in
// right-aligned columns, with the common leading blanks removed.
export function num2strDefault(a) {
  const vals = Array.from(a.re);
  const finite = vals.filter(Number.isFinite);
  const isInt = vals.every(v => !Number.isFinite(v) || Number.isInteger(v));
  const fmtReal = (v, digits) => (Number.isFinite(v) ? (isInt ? String(v) : genForm(Math.abs(v), digits).replace(/^/, v < 0 ? '-' : '')) : nonFinite(v));
  const maxAbs = finite.length ? Math.max(...finite.map(Math.abs)) : 0;
  const digits = Math.min(Math.max((maxAbs > 0 ? Math.floor(Math.log10(maxAbs)) : 0) + 5, 5), 16);
  const fmtElem = (k) => {
    const re = fmtReal(a.re[k], digits);
    if (!a.isComplex) return re;
    const im = a.im[k];
    return `${re}${im < 0 || Object.is(im, -0) ? '-' : '+'}${fmtReal(Math.abs(im), digits)}i`;
  };
  if (a.numel === 1) return Mat.fromString(fmtElem(0));
  const strs = vals.map((_, k) => fmtElem(k));
  const width = isInt && !a.isComplex
    ? Math.max(...strs.map(s => s.length)) + 2
    : Math.max(digits + 7 + (vals.some(v => v < 0) ? 1 : 0), ...strs.map(s => s.length + 2));
  const lines = [];
  for (let r = 0; r < a.rows; r++) {
    let line = '';
    for (let c = 0; c < a.cols; c++) line += strs[c * a.rows + r].padStart(width);
    lines.push(line);
  }
  const lead = Math.min(...lines.map(l => l.length - l.trimStart().length));
  return charMatrix(lines.map(l => l.slice(lead)));
}

// mat2str(A) / mat2str(A, n): text that evaluates back to A (15
// significant digits by default).
export function mat2strValue(a, digits = 15) {
  const one = (k) => {
    if (a.isChar) return null;
    const v = a.re[k];
    const re = a.isLogical ? (v ? 'true' : 'false') : Number.isFinite(v) ? genForm(Math.abs(v), digits).replace(/^/, v < 0 ? '-' : '') : nonFinite(v);
    if (!a.isComplex) return re;
    const im = a.im[k];
    const ims = Number.isFinite(im) ? genForm(Math.abs(im), digits) : nonFinite(Math.abs(im));
    return `${re}${im < 0 ? '-' : '+'}${ims}i`;
  };
  if (a.isChar) {
    const rows = [];
    for (let r = 0; r < a.rows; r++) {
      let s = '';
      for (let c = 0; c < a.cols; c++) s += String.fromCharCode(a.re[c * a.rows + r]);
      rows.push(`'${s.replace(/'/g, "''")}'`);
    }
    return a.rows === 1 ? rows[0] : `[${rows.join(';')}]`;
  }
  if (a.numel === 1) return one(0);
  const rows = [];
  for (let r = 0; r < a.rows; r++) {
    const parts = [];
    for (let c = 0; c < a.cols; c++) parts.push(one(c * a.rows + r));
    rows.push(parts.join(' '));
  }
  if (a.isEmpty) return `zeros(${a.rows},${a.cols})`;
  return `[${rows.join(';')}]`;
}
