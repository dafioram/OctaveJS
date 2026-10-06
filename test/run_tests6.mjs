// Tests for implicit expansion, comparison/set/operator functions, the
// added numeric and string functions, reduction flags ('all', 'omitnan'),
// column-wise FFT, tic/toc and `format long`.
import { makeInterp, fmtVar } from './harness.js';
import { createSession } from '../src/worker/session.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkClose(label, actual, expected, tol = 1e-9) {
  const arrA = Array.isArray(actual) ? actual : [actual];
  const arrE = Array.isArray(expected) ? expected : [expected];
  let ok = arrA.length === arrE.length;
  if (ok) for (let i = 0; i < arrA.length; i++) if (!(Math.abs(arrA[i] - arrE[i]) <= tol)) ok = false;
  if (ok) pass++; else { fail++; console.log(`FAIL(close): ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function checkThrows(label, fn, pattern) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { fail++; console.log(`FAIL(wrong error): ${label}\n  got: ${e.message}`); }
    else pass++;
  }
}
const row = (...re) => ({ rows: 1, cols: re.length, re, im: null });
const col = (...re) => ({ rows: re.length, cols: 1, re, im: null });
const mat = (rows2d) => {
  const rows = rows2d.length, cols = rows2d[0].length, re = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) re.push(rows2d[r][c]);
  return { rows, cols, re, im: null };
};

// ---------------- implicit expansion ----------------
{
  const { interp, run } = makeInterp();
  run('A = [8 1 6; 3 5 7; 4 9 2]; B = A - mean(A); C = [1; 2] + [10 20 30]; D = [1 2 3] .* [1; 2]; E = [1 2] == [1; 2]; F = max([1 5; 7 2], [3; 4]);');
  check('matrix minus row', fmtVar(interp, 'B'), mat([[3, -4, 1], [-2, 0, 2], [-1, 4, -3]]));
  check('column plus row', fmtVar(interp, 'C'), mat([[11, 21, 31], [12, 22, 32]]));
  check('row times column', fmtVar(interp, 'D'), mat([[1, 2, 3], [2, 4, 6]]));
  check('comparison expands', fmtVar(interp, 'E'), mat([[1, 0], [0, 1]]));
  check('two-argument max expands', fmtVar(interp, 'F'), mat([[3, 5], [7, 4]]));
  checkThrows('incompatible sizes error', () => run('[1 2 3] + [1 2]'), /incompatible sizes/);
  run('G = bsxfun(@minus, [1 2; 3 4], [1 2]);');
  check('bsxfun', fmtVar(interp, 'G'), mat([[0, 0], [2, 2]]));
}

// ---------------- comparison, sets, operator functions ----------------
{
  const { interp, run } = makeInterp();
  run("e1 = isequal([1 2], [1 2], [1 2]); e2 = isequal('a', 97); e3 = isequal(NaN, NaN); e4 = isequaln(NaN, NaN); e5 = isequal({1, 'a'}, {1, 'a'}); e6 = isequal(struct('a', 1, 'b', 2), struct('b', 2, 'a', 1)); e7 = isequal([1 2], [1 2]');");
  check('isequal', ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'].map(n => fmtVar(interp, n)), [1, 1, 0, 1, 1, 1, 0]);
  run("[tf, loc] = ismember([1 5 2], [2 1 1]); s1 = ismember('b', {'a', 'b'}); [tc, lc] = ismember({'x', 'a'}, {'a', 'b'}); nn = ismember(NaN, NaN);");
  check('ismember tf', fmtVar(interp, 'tf'), row(1, 0, 1));
  check('ismember loc (lowest index)', fmtVar(interp, 'loc'), row(2, 0, 1));
  check('ismember text in cellstr', fmtVar(interp, 's1'), 1);
  check('ismember cellstr', [fmtVar(interp, 'tc'), fmtVar(interp, 'lc')], [row(0, 1), row(0, 1)]);
  check('NaN is never a member', fmtVar(interp, 'nn'), 0);
  run('x = xor([1 0 1], [1 1 0]); n = not([1 0]); a = and(1, 0); o = or([1 0], 0); p = plus(1, 2); m = mtimes([1 2], [3; 4]); c = cellfun(@plus, {1, 2}, {10, 20}); t = arrayfun(@times, [1 2], [3 4]); u = uminus(3); l = le(2, [1 2 3]);');
  check('xor', fmtVar(interp, 'x'), row(0, 1, 1));
  check('not', fmtVar(interp, 'n'), row(0, 1));
  check('and/or', [fmtVar(interp, 'a'), fmtVar(interp, 'o')], [0, row(1, 0)]);
  check('plus/mtimes', [fmtVar(interp, 'p'), fmtVar(interp, 'm')], [3, 11]);
  check('operator handles in cellfun/arrayfun', [fmtVar(interp, 'c'), fmtVar(interp, 't')], [row(11, 22), row(3, 8)]);
  check('uminus/le', [fmtVar(interp, 'u'), fmtVar(interp, 'l')], [-3, row(0, 1, 1)]);
  check('logical results are logical', interp.workspace.get('x').isLogical && interp.workspace.get('l').isLogical, true);
}

// ---------------- numerics ----------------
{
  const { interp, run } = makeInterp();
  run('m2 = magic(2); m3 = magic(3); m4 = magic(4); m6 = magic(6); M = magic(10); sums = [unique(sum(M)) unique(sum(M, 2))\' trace(M) trace(fliplr(M))];');
  check('magic(2)', fmtVar(interp, 'm2'), mat([[1, 3], [4, 2]]));
  check('magic(3)', fmtVar(interp, 'm3'), mat([[8, 1, 6], [3, 5, 7], [4, 9, 2]]));
  check('magic(4)', fmtVar(interp, 'm4'), mat([[16, 2, 3, 13], [5, 11, 10, 8], [9, 7, 6, 12], [4, 14, 15, 1]]));
  check('magic(6)', fmtVar(interp, 'm6'), mat([[35, 1, 6, 26, 19, 24], [3, 32, 7, 21, 23, 25], [31, 9, 2, 22, 27, 20], [8, 28, 33, 17, 10, 15], [30, 5, 34, 12, 14, 16], [4, 36, 29, 13, 18, 11]]));
  check('magic(10) is magic', fmtVar(interp, 'sums'), row(505, 505, 505, 505));
  run('[X, Y] = meshgrid(1:3, 10:10:20); [P, Q] = ndgrid(1:2, 5:7);');
  check('meshgrid X', fmtVar(interp, 'X'), mat([[1, 2, 3], [1, 2, 3]]));
  check('meshgrid Y', fmtVar(interp, 'Y'), mat([[10, 10, 10], [20, 20, 20]]));
  check('ndgrid', [fmtVar(interp, 'P'), fmtVar(interp, 'Q')], [mat([[1, 1, 1], [2, 2, 2]]), mat([[5, 6, 7], [5, 6, 7]])]);
  run('d1 = diff([1 4 9 16]); d2 = diff([1 4 9 16], 2); d3 = diff([1 2; 4 8]); d4 = diff([1 2; 4 8], 1, 2);');
  check('diff', [fmtVar(interp, 'd1'), fmtVar(interp, 'd2'), fmtVar(interp, 'd3'), fmtVar(interp, 'd4')], [row(3, 5, 7), row(2, 2), row(3, 6), col(1, 4)]);
  run('t1 = trapz([1 2 3]); t2 = trapz([0 1 2], [0 1 4]); t3 = trapz([1 2; 3 4]); t4 = trapz(0.5, [1 2 3]); ct = cumtrapz([1 2 3]); t5 = trapz([1 2; 3 4], 2);');
  check('trapz', [fmtVar(interp, 't1'), fmtVar(interp, 't2'), fmtVar(interp, 't3'), fmtVar(interp, 't4'), fmtVar(interp, 't5')], [4, 3, row(2, 3), 2, col(1.5, 3.5)]);
  check('cumtrapz', fmtVar(interp, 'ct'), row(0, 1.5, 4));
  run('c1 = circshift(1:5, 2); c2 = circshift([1 2; 3 4; 5 6], 1); c3 = circshift([1 2 3; 4 5 6], [0 1]); c4 = circshift(1:4, -1); c5 = circshift([1 2; 3 4], 1, 2);');
  check('circshift', [fmtVar(interp, 'c1'), fmtVar(interp, 'c2'), fmtVar(interp, 'c3'), fmtVar(interp, 'c4'), fmtVar(interp, 'c5')],
    [row(4, 5, 1, 2, 3), mat([[5, 6], [1, 2], [3, 4]]), mat([[3, 1, 2], [6, 4, 5]]), row(2, 3, 4, 1), mat([[2, 1], [4, 3]])]);
  run('k = kron([1 2], [1; 1]); z = nnz([1 0 2 0]); ix = sub2ind([3 4], [1 3], [2 4]); [r, c] = ind2sub([3 4], [4 12]);');
  check('kron', fmtVar(interp, 'k'), mat([[1, 2], [1, 2]]));
  check('nnz', fmtVar(interp, 'z'), 2);
  check('sub2ind', fmtVar(interp, 'ix'), row(4, 12));
  check('ind2sub', [fmtVar(interp, 'r'), fmtVar(interp, 'c')], [row(1, 3), row(2, 4)]);
  checkThrows('sub2ind range check', () => run('sub2ind([2 2], 3, 1)'), /Out of range/);
  run('mo = mode([1 2 2 3 3]); [mm, mf] = mode([4 4 NaN 1]); mc = mode([1 2; 1 3; 2 3]);');
  check('mode (smallest on ties)', fmtVar(interp, 'mo'), 2);
  check('mode ignores NaN, frequency', [fmtVar(interp, 'mm'), fmtVar(interp, 'mf')], [4, 2]);
  check('mode by column', fmtVar(interp, 'mc'), row(1, 3));
  run('f = factorial([0 5 10]); n1 = nchoosek(5, 2); n2 = nchoosek(30, 15); nv = nchoosek([1 2 3 4], 2); p = primes(20); ip = isprime([1 2 9 11]); g = gcd(12, [18 7]); l = lcm(4, 6);');
  check('factorial', fmtVar(interp, 'f'), row(1, 120, 3628800));
  check('nchoosek', [fmtVar(interp, 'n1'), fmtVar(interp, 'n2')], [10, 155117520]);
  check('nchoosek combinations', fmtVar(interp, 'nv'), mat([[1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]]));
  check('primes', fmtVar(interp, 'p'), row(2, 3, 5, 7, 11, 13, 17, 19));
  check('isprime', fmtVar(interp, 'ip'), row(0, 1, 0, 1));
  check('gcd/lcm', [fmtVar(interp, 'g'), fmtVar(interp, 'l')], [row(6, 1), 12]);
  checkThrows('factorial of a non-integer', () => run('factorial(2.5)'), /non-negative integers/);
  run('rt = sort(roots([1 -3 2])); rc = roots([1 0 1]); rz = roots([1 -6 11 -6 0]);');
  checkClose('roots of x^2-3x+2', fmtVar(interp, 'rt').re, [1, 2], 1e-12);
  checkClose('complex roots', [...fmtVar(interp, 'rc').re, ...fmtVar(interp, 'rc').im.map(Math.abs)], [0, 0, 1, 1], 1e-12);
  checkClose('trailing zero coefficient gives a zero root', [...fmtVar(interp, 'rz').re].sort(), [0, 1, 2, 3], 1e-9);
  run("cv = conv([1 1], [1 -1]); cs = conv([1 2 3], [1 1 1], 'same'); cl = conv([1 2 3], [1 1], 'valid'); [q, rr] = deconv([1 0 -1], [1 1]);");
  check('conv', [fmtVar(interp, 'cv'), fmtVar(interp, 'cs'), fmtVar(interp, 'cl')], [row(1, 0, -1), row(3, 6, 5), row(3, 5)]);
  check('deconv', [fmtVar(interp, 'q'), fmtVar(interp, 'rr')], [row(1, -1), row(0, 0, 0)]);
  run('y1 = filter(1, [1 -0.5], [1 1 1]); y2 = filter([1 1]/2, 1, [2 4 6 8]); y3 = filter(1, [2], [2; 4]);');
  check('filter IIR', fmtVar(interp, 'y1'), row(1, 1.5, 1.75));
  check('filter FIR moving average', fmtVar(interp, 'y2'), row(1, 3, 5, 7));
  check('filter normalizes by a(1)', fmtVar(interp, 'y3'), col(1, 2));
}

// ---------------- FFT ----------------
{
  const { interp, run } = makeInterp();
  run('F = fft([1 2; 3 4]); P = fft([1 0 0 0], 2); A = abs(fft([1 2 3], 5)); R = real(ifft(fft([1 2 3 4]))); T = fft([1 2; 3 4], [], 2);');
  check('fft of a matrix works per column', fmtVar(interp, 'F'), mat([[4, 6], [-2, -2]]));
  check('fft(x, n) truncates', fmtVar(interp, 'P'), row(1, 1));
  checkClose('fft(x, n) zero-pads', fmtVar(interp, 'A').re, [6, 3.7537, 1.7058, 1.7058, 3.7537], 1e-4);
  checkClose('ifft inverts fft', fmtVar(interp, 'R').re, [1, 2, 3, 4], 1e-12);
  check('fft along dim 2', fmtVar(interp, 'T'), mat([[3, -1], [7, -1]]));
}

// ---------------- reductions: 'all' and NaN flags ----------------
{
  const { interp, run } = makeInterp();
  run("a = sum([1 2; 3 4], 'all'); b = sum([1 NaN 3], 'omitnan'); c = mean([1 NaN 3], 'omitnan'); d = max([1 5; 7 2], [], 'all'); e = max([1 NaN 3], [], 'includenan'); f = median([3 NaN 1]); g = median([3 NaN 1], 'omitnan'); h = cumsum([1 NaN 2], 'omitnan'); k = range([1 9; 3 4], 'all'); m = mean([1 2; 3 4], 'all'); p = prod([1 NaN 2], 'omitnan'); s = sum([1 NaN]);");
  check("sum 'all'", fmtVar(interp, 'a'), 10);
  check("sum/mean 'omitnan'", [fmtVar(interp, 'b'), fmtVar(interp, 'c')], [4, 2]);
  check("max 'all'", fmtVar(interp, 'd'), 7);
  check("max 'includenan'", Number.isNaN(fmtVar(interp, 'e')), true);
  check('median includes NaN by default', Number.isNaN(fmtVar(interp, 'f')), true);
  check("median 'omitnan'", fmtVar(interp, 'g'), 2);
  check("cumsum 'omitnan'", fmtVar(interp, 'h'), row(1, 1, 3));
  check("range/mean/prod with flags", [fmtVar(interp, 'k'), fmtVar(interp, 'm'), fmtVar(interp, 'p')], [8, 2.5, 2]);
  check('sum includes NaN by default', Number.isNaN(fmtVar(interp, 's')), true);
  run("v = std([1 2 NaN 4], 'omitnan'); w = var([1 2; 3 4], 0, 'all');");
  checkClose("std 'omitnan'", fmtVar(interp, 'v'), Math.sqrt(7 / 3));
  checkClose("var 'all'", fmtVar(interp, 'w'), 5 / 3);
  checkThrows('unknown flag', () => run("sum([1 2], 'bogus')"), /Unrecognized option/);
}

// ---------------- strings ----------------
{
  const { interp, run } = makeInterp();
  run("s1 = strcat('a ', 'b ', 'c'); s2 = strcat({'a', 'b'}, '_x'); s3 = strcat('x', 65);");
  check('strcat trims trailing blanks of char inputs', fmtVar(interp, 's1'), 'abc');
  check('strcat with a cell', interp.workspace.get('s2').data.map(v => v.toJSString()), ['a_x', 'b_x']);
  check('strcat number as char code', fmtVar(interp, 's3'), 'xA');
  run("f1 = strfind('abcabc', 'bc'); f2 = strfind('aaa', 'aa'); f3 = strfind({'ab', 'b'}, 'b'); f4 = strfind('abc', 'z');");
  check('strfind', [fmtVar(interp, 'f1'), fmtVar(interp, 'f2')], [row(2, 5), row(1, 2)]);
  check('strfind over a cell', interp.workspace.get('f3').data.map(v => v.re[0]), [2, 1]);
  check('strfind no match is empty', fmtVar(interp, 'f4'), { rows: 0, cols: 0, re: [], im: null });
  run("c1 = contains('hello', 'ell'); c2 = contains({'apple', 'kiwi'}, {'pp', 'zz'}); c3 = startsWith('Hello', 'he', 'IgnoreCase', true); c4 = startsWith('Hello', 'he'); c5 = endsWith({'a.m', 'b.txt'}, '.m');");
  check('contains/startsWith/endsWith', ['c1', 'c2', 'c3', 'c4', 'c5'].map(n => fmtVar(interp, n)), [1, row(1, 0), 1, 0, row(1, 0)]);
  run("[tok, mt] = regexp('x=12, y=345', '(\\w)=(\\d+)', 'tokens', 'match'); t22 = tok{2}{2}; m1 = mt{1};");
  check('regexp tokens', fmtVar(interp, 't22'), '345');
  check('regexp match', fmtVar(interp, 'm1'), 'x=12');
  run("o = regexp('abc123def', '\\d+', 'match', 'once'); [st, en] = regexp('aXbXc', 'X'); nm = regexp('key=val', '(?<k>\\w+)=(?<v>\\w+)', 'names'); sp = regexp('a,b;c', '[,;]', 'split'); nsp = numel(sp); none = regexp('abc', '\\d', 'match', 'once');");
  check("regexp 'once'", fmtVar(interp, 'o'), '123');
  check('regexp start/end (default outputs)', [fmtVar(interp, 'st'), fmtVar(interp, 'en')], [row(2, 4), row(2, 4)]);
  check('regexp names', [interp.workspace.get('nm').data[0].get('k').toJSString(), interp.workspace.get('nm').data[0].get('v').toJSString()], ['key', 'val']);
  check('regexp split', fmtVar(interp, 'nsp'), 3);
  check("regexp 'once' with no match is ''", fmtVar(interp, 'none'), '');
  run("r1 = regexprep('hello world', 'o', '0'); r2 = regexprep('abc', '(\\w)', '$1$1'); r3 = regexprep('Hi', 'hi', 'yo', 'ignorecase'); r4 = regexprep({'a1', 'b2'}, '\\d', '#'); r5 = regexprep('cat', '\\<c', 'b'); r6 = regexprep('ab', 'b', '[$0]'); r7 = regexprep('aaa', 'a', 'b', 'once'); ri = regexpi('ABC', 'b', 'match');");
  check('regexprep', ['r1', 'r2', 'r3', 'r5', 'r6', 'r7'].map(n => fmtVar(interp, n)), ['hell0 w0rld', 'aabbcc', 'yo', 'bat', 'a[b]', 'baa']);
  check('regexprep over a cell', interp.workspace.get('r4').data.map(v => v.toJSString()), ['a#', 'b#']);
  check('regexpi', interp.workspace.get('ri').data[0].toJSString(), 'B');
  run("i1 = int2str(2.7); i2 = int2str(-2.5); n1 = num2str(pi, '%10.5f'); n2 = num2str([1 2 3], '%d,'); n3 = num2str('abc');");
  check('int2str rounds', [fmtVar(interp, 'i1'), fmtVar(interp, 'i2')], ['3', '-3']);
  check('num2str with a format', [fmtVar(interp, 'n1'), fmtVar(interp, 'n2'), fmtVar(interp, 'n3')], ['3.14159', '1,2,3,', 'abc']);
}

// ---------------- tic/toc and format ----------------
{
  const h = makeInterp();
  const { interp, run } = h;
  run('t = tic; e = toc(t); ok = e >= 0 && e < 5;');
  check('toc(t) measures elapsed seconds', fmtVar(interp, 'ok'), 1);
  h.clearOutput(); run('tic; toc');
  check('toc prints elapsed time', /^Elapsed time is \d+\.\d{6} seconds\.\n$/.test(h.getOutput()), true);
  checkThrows('toc before tic', () => makeInterp().run('toc'), /TIC/);
  const show = (src) => { h.clearOutput(); run(src); return h.getOutput(); };
  check('format long scalar', show('format long; x = pi'), 'x =\n   3.141592653589793\n');
  check('format long vector', show('y = [1 2.5]'), 'y =\n   1.000000000000000   2.500000000000000\n');
  check('format long e-notation', show('z = 1e10'), 'z =\n     1.000000000000000e+10\n');
  check('format (no argument) restores short', show('format; x = pi'), 'x =\n    3.1416\n');
  checkThrows('unknown format style', () => run('format bank'), /Unknown command option 'bank'/);
}

// ---------------- settings survive a Stop (session restore) ----------------
{
  const msgs = [];
  const s1 = createSession((m) => msgs.push(m));
  s1.handle({ type: 'init', files: [] });
  s1.handle({ type: 'run', id: 1, src: "format long; warning('off', 'my:w'); tic;" });
  const delta = msgs.find(m => m.type === 'done').delta;
  const out = [];
  const s2 = createSession((m) => out.push(m));
  s2.handle({ type: 'init', files: [], snapshot: { vars: delta.vars, settings: delta.settings } });
  s2.handle({ type: 'run', id: 1, src: "x = pi, warning('my:w', 'hidden'); t = toc;" });
  const printed = out.filter(m => m.type === 'print').map(m => m.text).join('');
  check('format long survives restore', printed.includes('3.141592653589793'), true);
  check('warning state survives restore', printed.includes('hidden'), false);
  check('tic survives restore', out.find(m => m.type === 'done').error, null);
  s2.handle({ type: 'getVar', id: 2, name: 't' });
  const t = out.find(m => m.type === 'var').value.re[0];
  check('toc after restore is non-negative', t >= 0 && t < 60, true);
}

// ---------------- text classification, base conversion, orderfields ----------------
{
  const { interp, run } = makeInterp();
  const v = (name) => fmtVar(interp, name);
  run("a = strncmp('abcdef', 'abcxyz', 3); b = strncmpi('ABCdef', 'abcxyz', 3); c = strncmp({'abc', 'abd', 'x'}, 'abz', 2); d = strncmp('ab', 'abc', 5);");
  check('strncmp/strncmpi', [v('a'), v('b'), v('c'), v('d')], [1, 1, row(1, 1, 0), 0]);
  run("e = isspace(sprintf('a b\\t')); f = isletter('a1B_'); g = isstrprop('a1 F', 'digit'); h = isstrprop('aB1', 'upper'); k = isspace(5);");
  check('character classes', [v('e'), v('f'), v('g'), v('h'), v('k')], [row(0, 1, 0, 1), row(1, 0, 1, 0), row(0, 1, 0, 0), row(0, 1, 0), 0]);
  run("bl = blanks(3); db = deblank(sprintf('ab \\t')); dc = deblank({'a  ', ' b '});");
  check('blanks/deblank', [v('bl'), v('db'), interp.workspace.get('dc').data.map(x => x.toJSString())], ['   ', 'ab', ['a', ' b']]);
  run("b1 = dec2bin(10); b2 = dec2bin([1 5], 4); h1 = dec2hex(255); x1 = dec2base(23, 3); n1 = bin2dec('1010'); n2 = hex2dec({'ff', '10'}); n3 = base2dec('212', 3); n4 = bin2dec('1 0 1');");
  check('dec2bin/dec2hex/dec2base', [v('b1'), interp.workspace.get('b2').rows, v('h1'), v('x1')], ['1010', 2, 'FF', '212']);
  check('bin2dec/hex2dec/base2dec', [v('n1'), v('n2'), v('n3'), v('n4')], [10, col(255, 16), 23, 5]);
  checkThrows('dec2bin of a negative', () => run('dec2bin(-1)'), /nonnegative integer/);
  checkThrows('bin2dec of a bad digit', () => run("bin2dec('12')"), /only of characters 0 and 1/);
  run("s = struct('b', 1, 'a', 2, 'c', 3); [t, p] = orderfields(s); u = orderfields(s, {'c', 'a', 'b'}); fu = fieldnames(u)';");
  check('orderfields', [interp.workspace.get('t').fieldNames, v('p'), interp.workspace.get('fu').data.map(x => x.toJSString())], [['a', 'b', 'c'], col(2, 1, 3), ['c', 'a', 'b']]);
  checkThrows('orderfields needs every field', () => run("orderfields(s, {'a'})"), /every field/);
  run("r1 = realmax; r2 = realmin; r3 = flintmax; e1 = eps(1); e2 = eps([0.5 2]);");
  check('realmax/realmin/flintmax/eps', [v('r1'), v('r2'), v('r3'), v('e1'), v('e2')], [Number.MAX_VALUE, 2.2250738585072014e-308, 2 ** 53, 2 ** -52, row(2 ** -53, 2 ** -51)]);
}

// ---------------- format short g / long g / short e ----------------
{
  const { run, getOutput, clearOutput } = makeInterp();
  const show = (src) => { clearOutput(); run(src); return getOutput(); };
  check('format short g', show('format short g; x = [pi 1e6 1e-6]'), 'x =\n       3.1416        1e+06        1e-06\n');
  check('format long g', show('format long g; x = pi'), 'x =\n          3.14159265358979\n');
  check('format short e', show('format short e; x = pi'), 'x =\n   3.1416e+00\n');
  check('format shortG spelling', show("format('shortG'); x = 0.5"), 'x =\n          0.5\n');
  check('integers stay integers', show('format long g; x = [1 2 3]'), 'x =\n     1     2     3\n');
  check('format long keeps integer widths', show('format long; x = [1 1e6]'), 'x =\n           1     1000000\n');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
