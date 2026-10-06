// Regression tests for the MATLAB-compatibility bug fixes: each block
// pins down a behavior that previously diverged from real MATLAB.
import { makeInterp, fmtVar } from './harness.js';

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
  if (ok) for (let i = 0; i < arrA.length; i++) if (Math.abs(arrA[i] - arrE[i]) > tol) ok = false;
  if (ok) pass++; else { fail++; console.log(`FAIL(close): ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function checkThrows(label, fn, pattern) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { fail++; console.log(`FAIL(wrong error): ${label}\n  got: ${e.message}`); }
    else pass++;
  }
}
const isLogical = (interp, name) => interp.workspace.get(name).isLogical;

// ---- ~ produces a logical, usable as a mask ----
{
  const { interp, run } = makeInterp();
  run('v = [1 2 3 4]; m = ~(v > 2); w = v(m);');
  check('~ result is logical', isLogical(interp, 'm'), true);
  check('~mask indexing', fmtVar(interp, 'w'), { rows: 1, cols: 2, re: [1, 2], im: null });
  checkThrows('~NaN errors', () => run('q = ~NaN;'), /NaN/);
}

// ---- bare variable display: shows its own name, leaves ans alone ----
{
  const { interp, run, getOutput, clearOutput } = makeInterp();
  run('ans = 7; x = 5;');
  clearOutput();
  run('x');
  check('bare var display name', getOutput(), 'x =\n     5\n');
  check('bare var keeps ans', fmtVar(interp, 'ans'), 7);
}

// ---- colon ranges computed without accumulated rounding error ----
{
  const { interp, run } = makeInterp();
  run('r = 0:0.1:1; n = numel(r); last = r(end);');
  check('0:0.1:1 count', fmtVar(interp, 'n'), 11);
  check('0:0.1:1 ends exactly at 1', fmtVar(interp, 'last'), 1);
  run('r2 = 1:-0.1:0; n2 = numel(r2); last2 = r2(end);');
  check('descending float range count', fmtVar(interp, 'n2'), 11);
  check('descending float range end', fmtVar(interp, 'last2'), 0);
  run('n3 = numel(0:0.1:0.3); n4 = numel(colon(0, 0.1, 1)); e = 5:1;');
  check('0:0.1:0.3 count', fmtVar(interp, 'n3'), 4);
  check('colon() matches operator', fmtVar(interp, 'n4'), 11);
  check('empty range is 1x0', fmtVar(interp, 'e'), { rows: 1, cols: 0, re: [], im: null });
}

// ---- round halves away from zero ----
{
  const { interp, run } = makeInterp();
  run('r = round([-2.5 -1.5 -0.5 0.5 1.5 2.5]);');
  check('round half away from zero', fmtVar(interp, 'r'), { rows: 1, cols: 6, re: [-3, -2, -1, 1, 2, 3], im: null });
}

// ---- max/min: NaN handling, dim argument, complex magnitude ----
{
  const { interp, run } = makeInterp();
  run('a = max([NaN 1 2]); [m, i] = min([NaN 4 1]); allnan = max([NaN NaN]);');
  check('max ignores NaN', fmtVar(interp, 'a'), 2);
  check('min ignores NaN (value)', fmtVar(interp, 'm'), 1);
  check('min ignores NaN (index)', fmtVar(interp, 'i'), 3);
  check('max of all-NaN is NaN', Number.isNaN(fmtVar(interp, 'allnan')), true);
  run('r = max([1 5; 7 2], [], 2); c = min([1 5; 7 2], [], 1); s = max([1 2; 3 4], [], 3);');
  check('max(A,[],2)', fmtVar(interp, 'r'), { rows: 2, cols: 1, re: [5, 7], im: null });
  check('min(A,[],1)', fmtVar(interp, 'c'), { rows: 1, cols: 2, re: [1, 2], im: null });
  check('max(A,[],3) is A', fmtVar(interp, 's'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  run('p = max([NaN 2], [1 NaN]); z = max([3, 1+4i]);');
  check('elementwise max skips NaN', fmtVar(interp, 'p'), { rows: 1, cols: 2, re: [1, 2], im: null });
  check('complex max by magnitude', fmtVar(interp, 'z'), { re: 1, im: 4 });
  run('rg = range([1 5; 2 9], 2);');
  check('range(X, dim)', fmtVar(interp, 'rg'), { rows: 2, cols: 1, re: [4, 7], im: null });
}

// ---- reductions along dim >= 3, std/var weights ----
{
  const { interp, run } = makeInterp();
  run('s = sum([1 2; 3 4], 3); m = mean([1 2; 3 4], 3); c = cumsum([1 2; 3 4], 3);');
  check('sum(A,3) is A', fmtVar(interp, 's'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  check('mean(A,3) is A', fmtVar(interp, 'm'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  check('cumsum(A,3) is A', fmtVar(interp, 'c'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  run('sp = std([1 2 3 4], 1); ss = std([1 2 3 4]); vd = var([1 2; 3 5], 0, 2); ve = var([1 2 3 4], []);');
  checkClose('std(x,1) population', fmtVar(interp, 'sp'), Math.sqrt(1.25));
  checkClose('std(x) sample', fmtVar(interp, 'ss'), Math.sqrt(5 / 3));
  checkClose('var(X,0,2)', fmtVar(interp, 'vd').re, [0.5, 2]);
  checkClose('var(x,[]) sample', fmtVar(interp, 've'), 5 / 3);
}

// ---- unique: orientation, outputs, 'stable' ----
{
  const { interp, run } = makeInterp();
  run('u = unique([3 1 2 1]); uc = unique([3; 1; 1]); [C, ia, ic] = unique([3 1 3 2]); st = unique([3 1 3 2], \'stable\'); ch = unique(\'hello\');');
  check('unique row stays row', fmtVar(interp, 'u'), { rows: 1, cols: 3, re: [1, 2, 3], im: null });
  check('unique column stays column', fmtVar(interp, 'uc'), { rows: 2, cols: 1, re: [1, 3], im: null });
  check('unique ia', fmtVar(interp, 'ia'), { rows: 3, cols: 1, re: [2, 4, 1], im: null });
  check('unique ic', fmtVar(interp, 'ic'), { rows: 4, cols: 1, re: [3, 1, 3, 2], im: null });
  check('unique stable', fmtVar(interp, 'st'), { rows: 1, cols: 3, re: [3, 1, 2], im: null });
  check('unique keeps char', fmtVar(interp, 'ch'), 'ehlo');
}

// ---- complex A\b no longer silently returns NaN ----
{
  const { interp, run } = makeInterp();
  run('A = [1 1i; 0 2]; x = A \\ [1; 2];');
  const x = fmtVar(interp, 'x');
  checkClose('complex solve re', x.re, [1, 1]);
  checkClose('complex solve im', x.im, [-1, 0]);
  run('B = [1 1; 1 2; 1 3]; y = B \\ [1; 2; 2];');
  checkClose('real least squares', fmtVar(interp, 'y').re, [2 / 3, 0.5]);
  run('C = [1 1i; 1 2; 1i 3]; z = C \\ [1; 2; 1i]; res = C\' * (C * z - [1; 2; 1i]);');
  const res = fmtVar(interp, 'res');
  checkClose('complex least squares normal-equation residual', [...res.re, ...(res.im || [0, 0])], [0, 0, 0, 0], 1e-9);
}

// ---- anonymous functions: constants, multiple outputs, display ----
{
  const { interp, run, getOutput, clearOutput } = makeInterp();
  run('f = @(x) x*pi; y = f(2);');
  checkClose('anon fn uses pi as a value', fmtVar(interp, 'y'), 2 * Math.PI);
  run('g = @() deal(1, 2); [a, b] = g();');
  check('anon multi-output a', fmtVar(interp, 'a'), 1);
  check('anon multi-output b', fmtVar(interp, 'b'), 2);
  clearOutput();
  run('h = @(x) x.^2 + 1');
  check('function handle display', getOutput(), 'h =\n  function_handle with value:\n\n    @(x)x.^2+1\n');
  run('s = func2str(h); t = func2str(@sin);');
  check('func2str anon', fmtVar(interp, 's'), '@(x)x.^2+1');
  check('func2str named', fmtVar(interp, 't'), 'sin');
  checkThrows('operator on a handle errors clearly', () => run('q = h + 1;'), /function_handle/);
}

// ---- function files in the virtual file store ----
{
  const { interp, run } = makeInterp();
  interp.files.set('sq.m', { kind: 'm', text: 'function y = sq(x)\n  y = helper(x);\nend\nfunction z = helper(x)\n  z = x.^2;\nend\n' });
  interp.files.set('mk.m', { kind: 'm', text: 'function h = mk()\n  h = @scale;\nend\nfunction z = scale(x)\n  z = 10*x;\nend\n' });
  interp.files.set('setq.m', { kind: 'm', text: 'q = 42;\n' });
  run('r = sq(3); h = mk(); v = h(4); e = exist(\'sq\');');
  check('function file called with args', fmtVar(interp, 'r'), 9);
  check('handle to local subfunction', fmtVar(interp, 'v'), 40);
  check('exist() sees function files', fmtVar(interp, 'e'), 2);
  checkThrows('subfunctions are private to their file', () => run('helper(2)'), /^Unrecognized function or variable 'helper'\.$/);
  run('setq;');
  check('script file by bare name', fmtVar(interp, 'q'), 42);
  checkThrows('script file rejects arguments', () => run('setq(1)'), /script/);
  interp.files.set('sq.m', { kind: 'm', text: 'function y = sq(x)\n  y = x + 100;\nend\n' });
  run('r2 = sq(3);');
  check('edited function file is re-read', fmtVar(interp, 'r2'), 103);
}

// ---- unassigned outputs, return in scripts, recursion errors ----
{
  const { interp, run } = makeInterp();
  checkThrows('unassigned output errors', () => run('function [a, b] = g()\n a = 1;\nend\n[p, q] = g();'), /not assigned/);
  interp.files.set('s.m', { kind: 'm', text: 'a = 1;\nreturn\na = 2;\n' });
  run("run('s.m');");
  check('return ends a run() script', fmtVar(interp, 'a'), 1);
  checkThrows('runaway recursion is a MATLAB error', () => run('function r = inf_rec(n)\n r = inf_rec(n + 1);\nend\ninf_rec(1);'), /recursion/i);
}

// ---- NaN in conditions errors, like MATLAB ----
{
  const { run } = makeInterp();
  checkThrows('if NaN', () => run('if NaN, x = 1; end'), /NaN/);
  checkThrows('while NaN', () => run('while NaN, end'), /NaN/);
}

// ---- logical class: true/false sizes, concatenation, assignment ----
{
  const { interp, run } = makeInterp();
  run('t = true(2, 3); f = false(2); c = [true false]; b = [true false]; b(2) = 5;');
  check('true(2,3) size', fmtVar(interp, 't'), { rows: 2, cols: 3, re: [1, 1, 1, 1, 1, 1], im: null });
  check('true(2,3) is logical', isLogical(interp, 't'), true);
  check('false(2) is logical', isLogical(interp, 'f'), true);
  check('[true false] is logical', isLogical(interp, 'c'), true);
  check('number stored into logical becomes 1', fmtVar(interp, 'b'), { rows: 1, cols: 2, re: [1, 1], im: null });
  run("s = []; s(1) = 'a'; s(2) = 'b';");
  check('assigning char into [] gives char', fmtVar(interp, 's'), 'ab');
}

// ---- display formatting (format short) ----
{
  const { run, getOutput, clearOutput } = makeInterp();
  const show = (src) => { clearOutput(); run(src); return getOutput(); };
  check('pi display', show('x = pi'), 'x =\n    3.1416\n');
  check('Inf/NaN display', show('x = [NaN Inf -Inf]'), 'x =\n   NaN   Inf  -Inf\n');
  check('large scalar e-notation', show('x = 1e10'), 'x =\n   1.0000e+10\n');
  check('small scalar e-notation', show('x = 0.0001'), 'x =\n   1.0000e-04\n');
  check('integer matrix', show('x = [1 2; 3 4]'), 'x =\n     1     2\n     3     4\n');
  check('non-integer matrix', show('x = [1.5 2; 3 4]'), 'x =\n    1.5000    2.0000\n    3.0000    4.0000\n');
  check('scale factor', show('x = [1 1000.5]'), 'x =\n   1.0e+03 *\n\n    0.0010    1.0005\n');
}

// ---- number followed by an element-wise operator ----
{
  const { interp, run } = makeInterp();
  run("a = 10.^(1:3); b = 2.*[1 2]; c = 6./[2 3]; d = 2.\\[4 8]; e = [1 2].^2; f = 3.'; g = 1.5.^2;");
  check('10.^v is element-wise power', fmtVar(interp, 'a'), { rows: 1, cols: 3, re: [10, 100, 1000], im: null });
  check('2.*v, 6./v, 2.\\v', [fmtVar(interp, 'b').re, fmtVar(interp, 'c').re, fmtVar(interp, 'd').re], [[2, 4], [3, 2], [2, 4]]);
  check("3.' and 1.5.^2", [fmtVar(interp, 'f'), fmtVar(interp, 'g')], [3, 2.25]);
}

// ---- dimensions past the second: 2-D arrays have singleton trailing dims ----
{
  const { interp, run } = makeInterp();
  const v = (name) => fmtVar(interp, name);
  const sz = (name) => { const x = interp.workspace.get(name); return [x.rows, x.cols]; };
  // N-D requests used to be silently truncated to 2-D; now they error.
  checkThrows('zeros(2,2,2) is N-D', () => run('zeros(2, 2, 2)'), /N-D arrays are not supported/);
  checkThrows('ones([2 3 4]) is N-D', () => run('ones([2 3 4])'), /N-D arrays are not supported/);
  checkThrows('rand(2,2,2) is N-D', () => run('rand(2, 2, 2)'), /N-D/);
  checkThrows('cell(2,2,2) is N-D', () => run('cell(2, 2, 2)'), /N-D/);
  checkThrows('cat(3, A, B) is N-D', () => run('cat(3, [1 2], [3 4])'), /N-D array/);
  checkThrows('reshape to 2x2x2 is N-D', () => run('reshape(1:8, 2, 2, 2)'), /N-D/);
  checkThrows('repmat(A, [2 2 2]) is N-D', () => run('repmat(1, [2 2 2])'), /N-D/);
  checkThrows('non-integer size', () => run('zeros(2.5)'), /must be integers/);
  run('a = zeros(2, 3, 1); b = ones([2 3 1 1]); c = cell(2, 3, 1); d = NaN(2, 3); e = Inf(2); f = randi(5, 2, 3, 1); g = true(2, 1, 1);');
  check('trailing singleton sizes are fine', ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(sz), [[2, 3], [2, 3], [2, 3], [2, 3], [2, 2], [2, 3], [2, 1]]);
  run('h = cat(3, [], [3 4], []); k = reshape(1:6, 2, [], 1); m = repmat(7, [2 3 1]);');
  check('cat(3) of one array, reshape/repmat with trailing 1s', [v('h').re, sz('k'), sz('m')], [[3, 4], [2, 3], [2, 3]]);

  // Along dimension 3 a 2-D array is a single page: these return A.
  run('A = [3 1; 2 4]; s3 = sort(A, 3); [~, i3] = sort(A, 3); f3 = flip(A, 3); n3 = any([1 0; 3 4], 3); l3 = all([1 0; 3 4], 3);');
  check('sort(A, 3) leaves A', [v('s3').re, v('i3').re], [[3, 2, 1, 4], [1, 1, 1, 1]]);
  check('flip(A, 3) leaves A', v('f3').re, [3, 2, 1, 4]);
  check('any/all(A, 3) test each element', [v('n3').re, v('l3').re], [[1, 1, 0, 1], [1, 1, 0, 1]]);
  // any/all used to ignore their dimension argument entirely.
  run("p = any([1 0; 0 0], 2); q = all([1 1; 0 1], 2); r = all([1 1; 0 1], 'all'); t = any([0 0 1], 1); u = all(zeros(0, 3));");
  check('any/all(A, 2)', [v('p'), v('q')], [{ rows: 2, cols: 1, re: [1, 0], im: null }, { rows: 2, cols: 1, re: [1, 0], im: null }]);
  check("all(A, 'all')", v('r'), 0);
  check('any(row, 1) works element by element', v('t').re, [0, 0, 1]);
  check('all of a 0x3 array is 1x3 true', v('u').re, [1, 1, 1]);

  // size with more outputs or dimensions than 2.
  run('[r1, c1, p1] = size([1 2 3; 4 5 6]); s12 = size(ones(2, 3), [1 2]); [m2, n2] = size(ones(2, 3), [2 1]); s3 = size(ones(2, 3), 3); s23 = size(ones(2, 3), 2, 3);');
  check('[r, c, p] = size(A)', [v('r1'), v('c1'), v('p1')], [2, 3, 1]);
  check('size(A, [1 2]) and [m, n] = size(A, [2 1])', [v('s12').re, v('m2'), v('n2')], [[2, 3], 3, 2]);
  check('size(A, 3) and size(A, 2, 3)', [v('s3'), v('s23').re], [1, [3, 1]]);

  // Trailing subscripts that address the singleton dimensions.
  run('B = [1 2; 3 4]; x1 = B(:, :, 1); x2 = B(2, end, end); x3 = B(1, 2, :); B(:, 1, 1) = 0; c = {1, 2; 3, 4}; x4 = c{2, 1, 1}; st(2).f = 7; x5 = st(1, 2, 1).f;');
  check('A(:, :, 1), A(i, end, end), A(i, j, :)', [v('x1').re, v('x2'), v('x3')], [[1, 3, 2, 4], 4, 2]);
  check('assignment with a trailing 1', v('B').re, [0, 0, 2, 4]);
  check('cell and struct trailing subscripts', [v('x4'), v('x5')], [3, 7]);
  checkThrows('third subscript out of range', () => run('B(1, 1, 2)'), /position 3 exceeds array bounds/);
  checkThrows('assignment past dim 2 would be N-D', () => run('B(1, 1, 2) = 5'), /would create an N-D array/);

  // permute / ipermute / squeeze on 2-D arrays.
  run("P = permute([1 2 3; 4 5 6], [2 1]); Q = permute([1 2 3], [2 3 1]); R = ipermute([1 2 3], [3 1 2]); S = squeeze([1 2; 3 4]); Z = permute([1i 2], [2 1]); C = permute({1, 'a'}, [2 1]);");
  check('permute(A, [2 1]) transposes', [sz('P'), v('P').re], [[3, 2], [1, 2, 3, 4, 5, 6]]);
  check('permute moving a singleton', [sz('Q'), sz('R')], [[3, 1], [3, 1]]);
  check('squeeze of a 2-D array', v('S').re, [1, 3, 2, 4]);
  check('permute does not conjugate', v('Z').im, [1, 0]);
  check('permute of a cell', [sz('C'), interp.workspace.get('C').data[1].toJSString()], [[2, 1], 'a']);
  checkThrows('permute to N-D', () => run('permute([1 2; 3 4], [1 3 2])'), /N-D/);
  checkThrows('permute order must be a permutation', () => run('permute([1 2], [1 1])'), /permutation/);
}

// ---- NaN and Inf follow MATLAB ----
{
  const { interp, run, getOutput, clearOutput } = makeInterp();
  const v = (name) => fmtVar(interp, name);
  const isReal = (name) => !interp.workspace.get(name).isComplex;
  const show = (src) => { clearOutput(); run(src); return getOutput(); };
  // Real arithmetic stays real: the complex formulas used to turn 1/0 into Inf + NaNi.
  run('a = 1/0; b = -1/0; c = 0/0; d = [1 2]/0; e = NaN/2; f = 0*Inf; g = 0*NaN; h = [0 1]./[0 0]; k = Inf - Inf;');
  check('division by zero and NaN arithmetic stay real', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'k'].every(isReal), true);
  check('1/0, -1/0, [1 2]/0', [v('a'), v('b'), v('d').re], [Infinity, -Infinity, [Infinity, Infinity]]);
  run('s1 = sqrt(NaN); s2 = exp(NaN); s3 = log(NaN); s4 = sign(NaN); s5 = sin(Inf); s6 = exp(Inf); s7 = atan(Inf); s8 = tanh(Inf); s9 = sign(-Inf); s10 = log(0);');
  check('elementary functions of NaN/Inf are real', ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'].every(isReal), true);
  checkClose('atan(Inf), tanh(Inf), sign(-Inf), exp(Inf), log(0)', [v('s7'), v('s8'), v('s9'), v('s6'), v('s10')], [Math.PI / 2, 1, -1, Infinity, -Infinity]);
  run('z = sqrt(-Inf); w = sqrt(-4); l = log(-1);');
  check('negative reals still go complex', [interp.workspace.get('z').im[0], v('w'), interp.workspace.get('l').im[0]], [Infinity, { re: 0, im: 2 }, Math.PI]);
  // Logical conversion of NaN is an error, as in MATLAB.
  for (const src of ['logical(NaN)', 'NaN & true', 'true | NaN', 'xor(NaN, 1)', '~NaN', 'and(NaN, 1)', 'if NaN, end']) {
    checkThrows(`${src} errors`, () => run(src), /NaN's cannot be converted to logicals/);
  }
  checkThrows('logical of a complex value', () => run('logical(1i)'), /Complex values cannot be converted/);
  // any ignores NaN; all treats it as nonzero.
  run('a1 = any([0 NaN]); a2 = any(NaN); a3 = all([1 NaN]); a4 = any([NaN 1]);');
  check('any ignores NaN', [v('a1'), v('a2'), v('a3'), v('a4')], [0, 0, 1, 1]);
  // NaN placement in sort: last ascending, first descending.
  run("p = sort([3 NaN 1], 'descend'); [q, i] = sort([NaN 2 NaN 1], 'descend'); r = sort([3 NaN 1], 'MissingPlacement', 'first'); t = sort([3 NaN 1], 'descend', 'MissingPlacement', 'last');");
  check('sort descend puts NaN first', [v('p').re, v('q').re, v('i').re], [[NaN, 3, 1], [NaN, NaN, 2, 1], [1, 3, 2, 4]]);
  check('MissingPlacement', [v('r').re, v('t').re], [[NaN, 1, 3], [3, 1, NaN]]);
  run("c = sort([-3, 2, 1i]); cr = sort([2+1i, 1+5i], 'ComparisonMethod', 'real');");
  check('complex sort by abs, or by real part', [interp.workspace.get('c').im[0], interp.workspace.get('c').re[2], interp.workspace.get('cr').re[0]], [1, -3, 1]);
  // sprintf/num2str/mat2str
  run("t1 = sprintf('%d|%i|%x|%f|%e|%g', NaN, Inf, -Inf, NaN, Inf, -Inf); t2 = sprintf('%d', 1.5); t3 = sprintf('%e', 1.5); t4 = sprintf('%g', pi); t5 = sprintf('%5.1f|%+d|%05d', NaN, 3, -42); t6 = sprintf('%s', 65); t7 = sprintf('%d %d\\n', 1, 2, 3); t8 = sprintf('Value: %d.');");
  check('sprintf NaN/Inf', v('t1'), 'NaN|Inf|-Inf|NaN|Inf|-Inf');
  check('sprintf %d of a non-integer uses %e; %e has two exponent digits; %g has 6 digits', [v('t2'), v('t3'), v('t4')], ['1.500000e+00', '1.500000e+00', '3.14159']);
  check('sprintf width, flags, %s of a number, value recycling, no values', [v('t5'), v('t6'), v('t7'), v('t8')], ['  NaN|+3|-0042', 'A', '1 2\n3 ', 'Value: .']);
  check('fprintf NaN', show("fprintf('%d %d\\n', NaN, Inf)"), 'NaN Inf\n');
  run("n1 = num2str(Inf); n2 = num2str(123.456); n3 = num2str([1 10 100]); n4 = num2str([1 NaN Inf]); n5 = mat2str(pi); n6 = mat2str([1 NaN; -Inf 0.5]);");
  check('num2str / mat2str', [v('n1'), v('n2'), v('n3'), v('n4'), v('n5'), v('n6')], ['Inf', '123.456', '1   10  100', '1  NaN  Inf', '3.14159265358979', '[1 NaN;-Inf 0.5]']);
  // Reductions over empty arrays
  run('e1 = sum([]); e2 = prod([]); e3 = mean([]); e4 = median([]); e5 = std([]); e6 = var([]); e7 = sum(zeros(0, 3)); e8 = mean(zeros(0, 3)); e9 = sum(zeros(1, 0));');
  check('empty reductions', [v('e1'), v('e2'), v('e3'), v('e4'), v('e5'), v('e6'), v('e7').re, v('e8').re, v('e9')], [0, 1, NaN, NaN, NaN, NaN, [0, 0, 0], [NaN, NaN, NaN], 0]);
  check('mean of empty columns stays real', isReal('e8'), true);
  // Linear algebra with NaN/Inf and singular matrices
  run('x1 = [1 2; 3 4] \\ [1; NaN];');
  check('NaN in b propagates through A\\b', v('x1').re, [NaN, NaN]);
  check('singular A\\b warns', show('x2 = [1 0; 0 0] \\ [1; 1];'), 'Warning: Matrix is singular to working precision.\n');
  check('singular inv warns and is Inf', [show('x3 = inv([1 0; 0 0]);'), v('x3').re], ['Warning: Matrix is singular to working precision.\n', [Infinity, Infinity, Infinity, Infinity]]);
  check('nearly singular warns with RCOND', /close to singular or badly scaled\. Results may be inaccurate\. RCOND = \d\.\d{6}e-\d\d\./.test(show('x4 = magic(4) \\ [1;2;3;4];')), true);
  check("warning('off', id) silences it", show("warning('off', 'MATLAB:singularMatrix'); x5 = [1 0; 0 0] \\ [1; 1];"), '');
  // 'like' and complex()
  run("l1 = nan(1, 2, 'like', 1); l2 = zeros(2, 'like', 5); c1 = complex(1, NaN); c2 = complex(1); c3 = isreal(complex(2)); c4 = complex([1 2], 3);");
  check("'like'", [v('l1').re, v('l2').re], [[NaN, NaN], [0, 0, 0, 0]]);
  check('complex()', [v('c1'), v('c2'), v('c3'), v('c4').im], [{ re: 1, im: NaN }, { re: 1, im: 0 }, 0, [3, 3]]);
  checkThrows('complex() of a complex input', () => run('complex(1i, 2)'), /must be real/);
  // Complex display, as MATLAB: decimals always, parts aligned.
  check('complex display', [show('z1 = 1 + 2i'), show('z2 = [1+2i 3]'), show('z3 = NaN + 1i'), show('z4 = -1i'), show('z5 = 1e5 + 1i')],
    ['z1 =\n   1.0000 + 2.0000i\n', 'z2 =\n   1.0000 + 2.0000i   3.0000 + 0.0000i\n', 'z3 =\n   NaN + 1.0000i\n', 'z4 =\n   0.0000 - 1.0000i\n', 'z5 =\n   1.0000e+05 + 1.0000e+00i\n']);
}

// ---- missing data ----
{
  const { interp, run } = makeInterp();
  const v = (name) => fmtVar(interp, name);
  run("m1 = ismissing([1 NaN 3]); m2 = ismissing({'a', '', 'b'}); m3 = ismissing([1 -99 3], -99); m4 = anynan([1 NaN]); m5 = allfinite([1 Inf]); m6 = standardizeMissing([1 -99 3], -99);");
  check('ismissing / anynan / allfinite / standardizeMissing', [v('m1').re, v('m2').re, v('m3').re, v('m4'), v('m5'), v('m6').re], [[0, 1, 0], [0, 1, 0], [0, 1, 0], 1, 0, [1, NaN, 3]]);
  run("r1 = rmmissing([1 NaN 3]); r2 = rmmissing([1 2; NaN 4; 5 6]); [r3, tf] = rmmissing([1 NaN; 3 4], 2); r4 = rmmissing({'a', '', 'b'}); r5 = rmmissing([NaN NaN; 1 NaN; 1 2], 'MinNumMissing', 2);");
  check('rmmissing', [v('r1').re, v('r2').re, v('r3').re, v('tf').re, interp.workspace.get('r4').numel, v('r5').re], [[1, 3], [1, 5, 2, 6], [1, 3], [0, 1], 2, [1, 1, NaN, 2]]);
  run("f1 = fillmissing([1 NaN 3], 'linear'); f2 = fillmissing([NaN 2 NaN 4 NaN], 'previous'); f3 = fillmissing([NaN 2 NaN 4 NaN], 'next'); f4 = fillmissing([NaN 2 NaN 4 NaN], 'nearest'); f5 = fillmissing([NaN 2 NaN 4 NaN], 'linear'); f6 = fillmissing([1 NaN; NaN 4], 'constant', [7 8]); [f7, ft] = fillmissing([1 NaN NaN 4], 'spline'); f8 = fillmissing([1 NaN; NaN 4], 'constant', 0, 2);");
  check('fillmissing', [v('f1').re, v('f2').re, v('f3').re, v('f4').re, v('f5').re, v('f6').re, v('f7').re, v('ft').re, v('f8').re],
    [[1, 2, 3], [NaN, 2, 2, 4, 4], [2, 2, 4, 4, NaN], [2, 2, 4, 4, 4], [1, 2, 3, 4, 5], [1, 7, 8, 4], [1, 2, 3, 4], [0, 1, 1, 0], [1, 0, 0, 4]]);
  checkThrows('fillmissing unknown method', () => run("fillmissing([1 NaN], 'movmean')"), /unsupported method/);
}

// ---- robustness-sweep fixes (test/run_tests12.mjs found these) ----
{
  const { interp, run } = makeInterp();
  const v = (name) => fmtVar(interp, name);
  const sz = (name) => { const x = interp.workspace.get(name); return [x.rows, x.cols]; };
  // Unexpected argument types and missing arguments raise MATLAB's errors.
  checkThrows('sin of a cell', () => run('sin({1})'), /^Undefined function 'sin' for input arguments of type 'cell'\.$/);
  checkThrows('mean of a function handle', () => run('mean(@sin)'), /^Undefined function 'mean' for input arguments of type 'function_handle'\.$/);
  checkThrows('missing argument', () => run('circshift(1:3)'), /^Not enough input arguments\.$/);
  checkThrows('no arguments', () => run('disp()'), /^Not enough input arguments\.$/);
  checkThrows('magic(NaN)', () => run('magic(NaN)'), /finite/);
  checkThrows('parula(Inf)', () => run('parula(Inf)'), /finite/);
  // Empty matrices in decompositions, as MATLAB.
  run('e0 = eig([]); [L0, U0] = lu([]); [Q0, R0] = qr(zeros(2, 0)); s0 = svd(zeros(1, 0)); p0 = pinv(zeros(1, 0)); x0 = expm([]); c0 = cov([]); r0 = corrcoef([]); x1 = expm(NaN);');
  check('empty decompositions', [sz('e0'), sz('L0'), sz('U0'), sz('Q0'), sz('R0'), sz('s0'), sz('p0'), sz('x0'), v('c0'), v('r0'), v('x1')],
    [[0, 1], [0, 0], [0, 0], [2, 2], [2, 0], [0, 1], [0, 1], [0, 0], NaN, NaN, NaN]);
  // svd: full-size U and V (orthonormal even for zero singular values), and 'econ'.
  run("A = [1 2; 3 4; 5 6]; [U, S, V] = svd(A); f1 = norm(U*S*V' - A) < 1e-12; f2 = norm(U'*U - eye(3)) < 1e-12; [Ue, Se, Ve] = svd(A, 'econ'); [Uz, Sz, Vz] = svd(ones(2)); f3 = norm(Uz'*Uz - eye(2)) < 1e-12;");
  check('svd sizes and orthogonality', [sz('U'), sz('S'), sz('V'), v('f1'), v('f2'), sz('Ue'), sz('Se'), sz('Ve'), v('f3')], [[3, 3], [3, 2], [2, 2], 1, 1, [3, 2], [2, 2], [2, 2], 1]);
  // eig of a nonsymmetric matrix (Hessenberg QR): MATLAB's values and order.
  run('ev = eig([1 2; 3 4]); em = eig(magic(4)); rt = roots(reshape(magic(4), 1, [])); r3 = roots([1 -6 11 -6]);');
  checkClose('eig nonsymmetric', [...v('ev').re, ...v('em').re.slice(0, 3)], [-0.3722813232690143, 5.372281323269014, 34, 8.94427190999916, -8.94427190999916], 1e-12);
  check('roots of a degree-15 polynomial converges', sz('rt'), [15, 1]);
  checkClose('roots order', v('r3').re, [3, 2, 1], 1e-12);
  // fft: any length in O(n log n); real input gives a conjugate-symmetric
  // transform, so ifft(fft(x)) is real; ifft(X, 'symmetric').
  const t0 = Date.now();
  run('big = fft2(magic(4), 1000, 1000); y = ifft(fft([1 2 3])); w = ifft([1 1i 3], \'symmetric\'); z = fft(1:5);');
  check('fft2 of a 1000x1000 grid is fast', Date.now() - t0 < 5000, true);
  check('ifft(fft(x)) is real', v('y').im, null);
  checkClose('ifft(fft(x))', v('y').re, [1, 2, 3], 1e-14);
  check("ifft 'symmetric' is real", v('w').im, null);
  check('fft of real input is conjugate symmetric', [v('z').re[1] === v('z').re[4], v('z').im[1] === -v('z').im[4], v('z').im[0]], [true, true, 0]);
}

// ---- fixes from the MATLAB R2015a reference run (run_tests16 locks in the rest) ----
{
  const { interp, run } = makeInterp();
  const v = (name) => fmtVar(interp, name);
  run("[Q, R] = qr([1 2; 3 4]); x = (1:5) \\ 1; p = pinv(magic(4)); e = norm(magic(4)*p*magic(4) - magic(4)); P = perms([1 2 3]);");
  checkClose('qr signs as LAPACK', [...v('Q').re, ...v('R').re], [-0.316227766016838, -0.9486832980505138, -0.9486832980505138, 0.316227766016838, -3.1622776601683795, 0, -4.427188724235731, -0.6324555320336751], 1e-12);
  check('wide A\\b is the basic solution', v('x').re, [0, 0, 0, 0, 0.2]);
  check('pinv of a singular matrix', v('e') < 1e-12, true);
  check("perms in MATLAB's order", v('P').re, [3, 3, 2, 2, 1, 1, 2, 1, 3, 1, 2, 3, 1, 2, 1, 3, 3, 2]);
  run("r = rat(pi); f = func2str(@(x) x.^2 + 1); g = @() 'it''s'; n = numel(magic(4), 1:2, ':'); s = num2str([4 -2; 1 3]); c = ['ab' 66]; k = class(max(true));");
  check('rat text', v('r'), '3 + 1/(7 + 1/(16))');
  check('func2str as MATLAB writes it', v('f'), '@(x)x.^2+1');
  check("a quote after @() starts a string", interp.workspace.get('g').displayName(), "@()'it''s'");
  check('numel with indices', v('n'), 8);
  check('num2str integer columns', [interp.workspace.get('s').rows, interp.workspace.get('s').cols], [2, 4]);
  check('number joined with text is a character', v('c'), 'abB');
  check('max keeps logical', v('k'), 'logical');
  run("m = max(zeros(0, 3)); d = diff([4 -2; 1 3], 2); z = isreal(kron([1+2i 3], 0)); u = upper(['ab'; 'cd']); h = hypot(3i, 4);");
  check('max of an empty', [interp.workspace.get('m').rows, interp.workspace.get('m').cols], [0, 3]);
  check('diff re-picks the dimension', v('d'), 8);
  check('zero imaginary parts are dropped', v('z'), 1);
  check('upper keeps a char matrix', [interp.workspace.get('u').rows, interp.workspace.get('u').cols], [2, 2]);
  check('hypot of complex input', v('h'), 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
