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
  check('bare var display name', getOutput(), 'x =\n   5\n');
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
  check('function handle display', getOutput(), 'h =\n  function_handle with value:\n\n    @(x)x.^2 + 1\n');
  run('s = func2str(h); t = func2str(@sin);');
  check('func2str anon', fmtVar(interp, 's'), '@(x)x.^2 + 1');
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
  checkThrows('subfunctions are private to their file', () => run('helper(2)'), /Undefined/);
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
  check('pi display', show('x = pi'), 'x =\n   3.1416\n');
  check('Inf/NaN display', show('x = [NaN Inf -Inf]'), 'x =\n    NaN    Inf   -Inf\n');
  check('large scalar e-notation', show('x = 1e10'), 'x =\n   1.0000e+10\n');
  check('small scalar e-notation', show('x = 0.0001'), 'x =\n   1.0000e-04\n');
  check('integer matrix', show('x = [1 2; 3 4]'), 'x =\n   1   2\n   3   4\n');
  check('non-integer matrix', show('x = [1.5 2; 3 4]'), 'x =\n   1.5000   2.0000\n   3.0000   4.0000\n');
  check('scale factor', show('x = [1 1000.5]'), 'x =\n   1.0e+03 *\n\n   0.0010   1.0005\n');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
