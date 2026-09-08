// matlab-lang.js — A hand-written CodeMirror 6 language mode for the
// MATLAB subset, using StreamLanguage (the "port a simple tokenizer"
// API) rather than a full Lezer grammar — there's no off-the-shelf
// MATLAB grammar for CodeMirror 6, and hand-writing a full LR grammar
// for this app would be disproportionate to the payoff versus a
// straightforward token-by-token highlighter.
//
// Mirrors the real lexer's `'` transpose-vs-string-literal disambiguation
// (based on the previous significant token) so highlighting doesn't get
// confused by `A'` / `A(1,:)'` the way a naive mode would.

import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const KEYWORDS = new Set([
  'if', 'elseif', 'else', 'end', 'for', 'while', 'switch', 'case',
  'otherwise', 'break', 'continue', 'return', 'function', 'global',
  'persistent', 'true', 'false',
]);

const BUILTIN_HINTS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'exp', 'log', 'log10', 'log2', 'sqrt', 'abs', 'angle', 'real', 'imag', 'conj',
  'sign', 'floor', 'ceil', 'round', 'fix', 'mod', 'rem', 'power', 'hypot',
  'sum', 'prod', 'mean', 'median', 'std', 'var', 'min', 'max', 'range',
  'cumsum', 'cumprod', 'size', 'length', 'numel', 'reshape', 'diag', 'triu',
  'tril', 'det', 'trace', 'rank', 'norm', 'dot', 'cross', 'inv', 'pinv', 'eig',
  'svd', 'lu', 'qr', 'transpose', 'ctranspose', 'fft', 'ifft', 'zeros', 'ones',
  'eye', 'rand', 'randn', 'randi', 'linspace', 'logspace', 'colon', 'class',
  'isa', 'isnumeric', 'ischar', 'islogical', 'isreal', 'iscomplex', 'double',
  'logical', 'char', 'disp', 'fprintf', 'sprintf', 'num2str', 'mat2str',
  'who', 'whos', 'clear', 'clc', 'help', 'exist', 'feval', 'arrayfun', 'deal', 'plot',
  'scatter', 'bar', 'histogram', 'hist', 'figure', 'hold', 'xlabel', 'ylabel',
  'title', 'legend', 'grid', 'xlim', 'ylim', 'axis', 'readmatrix',
  'writematrix', 'save', 'load', 'run', 'pi', 'eps', 'nargin', 'nargout',
  'find', 'any', 'all', 'isnan', 'isinf', 'isfinite', 'fliplr', 'flipud',
  'flip', 'sort', 'unique', 'repmat', 'cat', 'horzcat', 'vertcat',
  'polyfit', 'polyval', 'interp1', 'strcmp', 'strcmpi', 'upper', 'lower',
  'strtrim', 'strrep', 'str2double', 'str2num',
]);

function endsValue(prev) {
  return prev === 'ident' || prev === 'number' || prev === 'imag' ||
    prev === ')' || prev === ']' || prev === '}' || prev === 'transpose' || prev === 'end';
}

const matlabMode = {
  startState() {
    return { inBlockComment: false, prev: null };
  },
  token(stream, state) {
    if (state.inBlockComment) {
      const line = stream.string.trim();
      stream.skipToEnd();
      if (line === '%}') state.inBlockComment = false;
      return 'comment';
    }
    if (stream.sol() && stream.string.trim() === '%{') {
      state.inBlockComment = true;
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;

    if (stream.match('%')) { stream.skipToEnd(); return 'comment'; }

    if (stream.match(/^\.\.\..*/)) { state.prev = null; return 'meta'; }

    // Numbers (incl. leading-dot decimals and imaginary suffix)
    if (stream.match(/^(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?[ij]?\b/)) {
      state.prev = stream.current().match(/[ij]$/) ? 'imag' : 'number';
      return 'number';
    }

    // Strings vs transpose
    if (stream.peek() === "'") {
      if (endsValue(state.prev)) {
        stream.next();
        state.prev = 'transpose';
        return 'operator';
      }
      stream.next();
      let closed = false;
      while (!stream.eol()) {
        if (stream.peek() === "'") {
          stream.next();
          if (stream.peek() === "'") { stream.next(); continue; }
          closed = true;
          break;
        }
        stream.next();
      }
      state.prev = 'string';
      return closed ? 'string' : 'invalid';
    }
    if (stream.peek() === '"') { stream.skipToEnd(); state.prev = null; return 'invalid'; }

    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) { state.prev = 'keyword'; return 'keyword'; }
      state.prev = 'ident';
      if (BUILTIN_HINTS.has(word)) return 'builtin';
      return 'variableName';
    }

    if (stream.match(/^(\.\*|\.\/|\.\^|\.\\|\.'|==|~=|<=|>=|&&|\|\|)/)) { state.prev = 'op'; return 'operator'; }
    if (stream.match(/^[+\-*/\\^<>~&|=]/)) { state.prev = 'op'; return 'operator'; }

    const ch = stream.next();
    if (ch === '(' ) { state.prev = '('; return 'bracket'; }
    if (ch === ')') { state.prev = ')'; return 'bracket'; }
    if (ch === '[') { state.prev = '['; return 'bracket'; }
    if (ch === ']') { state.prev = ']'; return 'bracket'; }
    if (ch === '{') { state.prev = '{'; return 'bracket'; }
    if (ch === '}') { state.prev = '}'; return 'bracket'; }
    if (ch === ',' || ch === ';') { state.prev = null; return 'punctuation'; }
    if (ch === ':') { state.prev = ':'; return 'operator'; }
    if (ch === '@') { state.prev = '@'; return 'meta'; }
    if (ch === '.') { state.prev = '.'; return 'punctuation'; }
    state.prev = null;
    return null;
  },
};

export const matlabStreamLanguage = StreamLanguage.define(matlabMode);

const matlabHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: '#1d4e89', fontWeight: '600' },
  { tag: t.comment, color: '#7c7566', fontStyle: 'italic' },
  { tag: t.string, color: '#8a4b2f' },
  { tag: t.invalid, color: '#b4432e', textDecoration: 'underline wavy' },
  { tag: t.number, color: '#3c6e58' },
  { tag: t.operator, color: '#4a463d' },
  { tag: t.bracket, color: '#4a463d' },
  { tag: t.variableName, color: '#2b2822' },
  { tag: t.standard(t.variableName), color: '#1d4e89' },
  { tag: t.meta, color: '#7c7566' },
  { tag: t.punctuation, color: '#8a8371' },
]);

export function matlabLanguageSupport() {
  return new LanguageSupport(matlabStreamLanguage);
}

export const matlabHighlighting = [
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  syntaxHighlighting(matlabHighlightStyle),
];

export const matlabCompletionWords = [...KEYWORDS, ...BUILTIN_HINTS].sort();
