// Tests for the numerical solvers: ODEs (ode.js), roots / minimization /
// integration (optim.js), interpolation and polynomials (interp.js) and
// the matrix functions in linalg.js. Reference values come from MATLAB's
// documentation examples or from closed-form answers.
import { makeInterp, fmtVar } from './harness.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkClose(label, actual, expected, tol = 1e-9) {
  const a = [actual].flat(Infinity), e = [expected].flat(Infinity);
  if (a.length === e.length && a.every((v, k) => Math.abs(v - e[k]) <= tol || (Number.isNaN(v) && Number.isNaN(e[k])))) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function checkThrows(label, fn, pattern) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { fail++; console.log(`FAIL(wrong error): ${label}\n  got: ${e.message}`); }
    else pass++;
  }
}
function setup() {
  const h = makeInterp();
  h.v = (name) => fmtVar(h.interp, name);
  h.re = (name) => { const x = h.interp.workspace.get(name); return Array.from(x.re); };
  h.size = (name) => { const x = h.interp.workspace.get(name); return [x.rows, x.cols]; };
  return h;
}

// ---------------- ODE solvers ----------------
{
  const h = setup();
  h.run('[t, y] = ode45(@(t,y) -y, [0 1], 1);');
  // MATLAB: MaxStep is 0.1*(tf - t0), so 10 steps, each refined into 4.
  check('ode45 output points (10 steps x Refine 4)', [h.size('t'), h.size('y')], [[41, 1], [41, 1]]);
  checkClose('ode45 first refined point', h.re('t')[1], 0.025);
  checkClose('ode45 accuracy', h.re('y')[40], Math.exp(-1), 1e-7);
  h.run('[t, y] = ode45(@(t,y) cos(t), 0:0.5:2, 0);');
  check('tspan with several times: output at exactly those times', h.re('t'), [0, 0.5, 1, 1.5, 2]);
  checkClose('... with the continuous extension', h.re('y'), [0, 0.5, 1, 1.5, 2].map(Math.sin), 1e-6);
  h.run('[t, y] = ode45(@(t,y) y, [1 0], 1);');
  checkClose('integrating backward', h.re('y').at(-1), Math.exp(-1), 1e-6);
  h.run("vdp = @(t,y) [y(2); (1-y(1)^2)*y(2)-y(1)]; [t, y] = ode45(vdp, [0 20], [2; 0]);");
  check('systems: y has one column per equation', h.size('y')[1], 2);
  h.run("opts = odeset('RelTol', 1e-8, 'AbsTol', 1e-10); [t, y] = ode45(@(t,y) -2*y, [0 1], 1, opts);");
  checkClose('odeset tolerances', h.re('y').at(-1), Math.exp(-2), 1e-9);
  h.run("[t, y] = ode23(@(t,y) -y, [0 1], 1); sol = ode23(@(t,y) -y, [0 1], 1); same = isequal(t', sol.x);");
  checkClose('ode23', h.re('y').at(-1), Math.exp(-1), 1e-3);
  check('ode23 has no refinement: one output point per step', h.v('same'), 1);
  h.run("mu = 1000; f = @(t,y) [y(2); mu*(1-y(1)^2)*y(2)-y(1)]; [t, y] = ode23s(f, [0 3000], [2; 0]); n = numel(t); y1 = y(end, 1);");
  check('ode23s solves the stiff van der Pol problem in few steps', h.v('n') < 2000, true);
  checkClose('... ending near the limit cycle', h.v('y1'), -1.51, 0.05);
  h.run("[t, y] = ode15s(@(t,y) -1000*(y - cos(t)), [0 1], 0); last = y(end);");
  checkClose('ode15s (stiff, Rosenbrock method)', h.v('last'), Math.cos(1) + 1000 * Math.sin(1) / 1000001, 1e-3);
  h.run("[t, y] = ode23s(@(t,y) -5*y, [0 1], 1, odeset('Jacobian', -5)); last = y(end);");
  checkClose('ode23s with a constant Jacobian', h.v('last'), Math.exp(-5), 1e-3);
  h.run("[t, y] = ode45(@(t,y,k) -k*y, [0 1], 1, [], 3); last = y(end);");
  checkClose('extra parameters after the options', h.v('last'), Math.exp(-3), 1e-5);

  h.run("sol = ode45(@(t,y) -2*y, [0 1], 3); v = deval(sol, [0 0.5 1]); s = sol.solver; nx = size(sol.x, 1);");
  checkClose('sol = ode45(...) and deval', h.re('v'), [0, 0.5, 1].map(t => 3 * Math.exp(-2 * t)), 1e-5);
  check('solution structure fields', [h.v('s'), h.v('nx')], ['ode45', 1]);
  h.run("sol = ode23(@(t,y) [y(2); -y(1)], [0 pi], [0; 1]); v = deval(sol, pi/2, 1); w = deval(pi/2, sol);");
  checkClose('deval of one component, and deval(x, sol)', [h.v('v'), h.re('w')], [1, 1, 0], 2e-3);
  checkThrows('deval outside the interval', () => h.run('deval(sol, 4)'), /outside the interval/);

  h.clearOutput();
  h.run("[t, y] = ode45(@(t,y) -y, [0 1], 1, odeset('Stats', 'on'));");
  check('Stats on', /10 successful steps\n0 failed attempts\n61 function evaluations/.test(h.getOutput()), true);
  h.run("o = odeset('RelTol', 1e-4); o2 = odeset(o, 'AbsTol', 1e-9); r = odeget(o2, 'RelTol'); a = odeget(o2, 'abstol'); m = odeget(o2, 'MaxStep', 7);");
  check('odeset/odeget', [h.v('r'), h.v('a'), h.v('m')], [1e-4, 1e-9, 7]);
  checkThrows('unknown odeset property', () => h.run("odeset('Reltol2', 1)"), /unrecognized property name/);
  checkThrows('unsupported Events option', () => h.run("ode45(@(t,y) -y, [0 1], 1, odeset('Events', @(t,y) y))"), /Events option is not supported/);
  checkThrows('wrong-length derivative', () => h.run('ode45(@(t,y) [1; 2], [0 1], 1)'), /column vector of length 1/);
  checkThrows('equal tspan endpoints', () => h.run('ode45(@(t,y) -y, [1 1], 1)'), /different from the first/);
  h.run("figure; ode45(@(t,y) -y, [0 1], 1);");
  const fig = h.interp.figures.get(h.interp.figureState.current);
  check('no outputs: plots the solution with markers', [fig.axes[0].objects.length, fig.axes[0].objects[0].marker], [1, 'o']);
}

// ---------------- fzero / fminbnd / fminsearch ----------------
{
  const h = setup();
  h.run('x = fzero(@cos, [1 2]); y = fzero(@sin, 3); z = fzero(\'cos\', 1);');
  checkClose('fzero on an interval and from a point', [h.v('x'), h.v('y'), h.v('z')], [Math.PI / 2, Math.PI, Math.PI / 2], 1e-15);
  h.run('[x, fv, flag, out] = fzero(@(x) x^3 - 2*x - 5, 2); it = out.iterations;');
  checkClose('fzero (MATLAB doc example)', h.v('x'), 2.0945514815423265, 1e-14);
  check('fzero flag and output', [h.v('flag'), Math.abs(h.v('fv')) < 1e-14, typeof h.v('it')], [1, true, 'number']);
  h.run("[x, fv, flag] = fzero(@(x, a) x - a, 0, [], 4);");
  check('fzero extra parameter', h.v('x'), 4);
  h.clearOutput();
  h.run('[x, fv, flag] = fzero(@tan, [1 2]);');
  check('fzero at a pole: exitflag -5', [h.v('flag'), /singular point/.test(h.getOutput())], [-5, true]);
  h.clearOutput();
  h.run('[x, fv, flag] = fzero(@(x) x.^2 + 1, 1);');
  check('fzero with no sign change', [Number.isNaN(h.interp.workspace.get('x').re[0]), h.v('flag') < 0, /aborting search/.test(h.getOutput())], [true, true, true]);
  checkThrows('fzero interval without a sign change', () => h.run('fzero(@(x) x.^2 + 1, [0 1])'), /differ in sign/);
  h.run("x = fzero(@(x) exp(x) - 2, [0 1], optimset('TolX', 1e-3));");
  checkClose('fzero TolX', h.v('x'), Math.log(2), 1e-3);

  h.run('[x, fv] = fminbnd(@cos, 3, 4);');
  checkClose('fminbnd (MATLAB doc example)', [h.v('x'), h.v('fv')], [Math.PI, -1], 1e-5);
  h.run('[x, fv, flag, out] = fminbnd(@(x) (x-2).^2 + 1, 0, 5); fc = out.funcCount;');
  checkClose('fminbnd parabola', [h.v('x'), h.v('fv'), h.v('flag')], [2, 1, 1], 1e-8);
  h.run("banana = @(x) 100*(x(2)-x(1)^2)^2 + (1-x(1))^2; [x, fv, flag, out] = fminsearch(banana, [-1.2, 1]); it = out.iterations; fc = out.funcCount;");
  // MATLAB's documented result: 85 iterations, 159 function evaluations, fval 8.1777e-10.
  check('fminsearch matches MATLAB step for step', [h.v('it'), h.v('fc'), h.v('flag')], [85, 159, 1]);
  checkClose('fminsearch minimum', [...h.re('x'), h.v('fv')], [1, 1, 8.1777e-10], 1e-4);
  check('fminsearch keeps the shape of x0', h.size('x'), [1, 2]);
  h.run("o = optimset('TolX', 1e-10, 'TolFun', 1e-10); x = fminsearch(@(x) (x(1)-1)^2 + (x(2)+2)^2, [0; 0], o);");
  checkClose('fminsearch with optimset', h.re('x'), [1, -2], 1e-6);
  check('column x0 gives a column', h.size('x'), [2, 1]);
  h.clearOutput();
  h.run("x = fminsearch(@(x) sum(x.^2), [1 1], optimset('MaxIter', 5));");
  check('fminsearch MaxIter reports', /Exiting: Maximum number of iterations/.test(h.getOutput()), true);
  h.run("o = optimset('Display', 'off'); d = optimget(o, 'Display'); t = optimget(o, 'TolX', 3);");
  check('optimset/optimget', [h.v('d'), h.v('t')], ['off', 3]);
  checkThrows('unknown optimset name', () => h.run("optimset('Tolerance', 1)"), /unrecognized property name/);
}

// ---------------- integral / integral2 / quad ----------------
{
  const h = setup();
  h.run('q1 = integral(@(x) exp(-x.^2), -Inf, Inf); q2 = integral(@(x) 1./x, 1, 2); q3 = integral(@log, 0, 1); q4 = integral(@(x) x.^5.*exp(-x).*sin(x), 0, Inf);');
  checkClose('integral: infinite, ordinary, endpoint singularity, semi-infinite', [h.v('q1'), h.v('q2'), h.v('q3'), h.v('q4')], [Math.sqrt(Math.PI), Math.log(2), -1, -15], 1e-6);
  h.run("q = integral(@(x) [sin(x); cos(x)], 0, pi, 'ArrayValued', true);");
  checkClose('ArrayValued', h.re('q'), [2, 0], 1e-9);
  h.run("q = integral(@(x) abs(x - 1), 0, 2, 'Waypoints', 1); r = integral(@(x) x.^2, 2, 0); z = integral(@(x) x, 3, 3);");
  checkClose('Waypoints, reversed limits, empty interval', [h.v('q'), h.v('r'), h.v('z')], [1, -8 / 3, 0], 1e-10);
  h.run("q = integral(@(x) exp(1i*x), 0, pi);");
  checkClose('complex integrand', [h.interp.workspace.get('q').re[0], h.interp.workspace.get('q').im[0]], [0, 2], 1e-9);
  checkThrows('non-vectorized integrand', () => h.run('integral(@(x) 1, 0, 1)'), /ArrayValued/);
  h.run("q = integral2(@(x,y) x.*y, 0, 1, 0, 2); t = integral2(@(x,y) ones(size(x)), 0, 1, 0, @(x) x);");
  checkClose('integral2, with a variable limit', [h.v('q'), h.v('t')], [1, 0.5], 1e-8);
  h.run('[q, n] = quad(@(x) 1./(x.^3 - 2*x - 5), 0, 2); s = quad(@sin, 0, pi);');
  checkClose('quad (MATLAB doc example)', [h.v('q'), h.v('s')], [-0.4605, 2], 1e-4);
}

// ---------------- interpolation ----------------
{
  const h = setup();
  h.run("v = interp1([1 2 3], [10 20 30], [1.5 0 3.5]);");
  checkClose('interp1 linear, NaN outside', h.re('v'), [15, NaN, NaN]);
  h.run("a = interp1([1 2 3], [10 20 30], [0 3.5], 'linear', 'extrap'); b = interp1([1 2 3], [10 20 30], [0 3.5], 'linear', -1);");
  check('extrapolation', [h.re('a'), h.re('b')], [[0, 35], [-1, -1]]);
  h.run("n = interp1([1 2 3], [10 20 30], [1.5 1.4 2.6], 'nearest'); x = interp1([1 2 3], [10 20 30], [1.5 2], 'next'); p = interp1([1 2 3], [10 20 30], [1.5 2.9], 'previous');");
  check('nearest / next / previous', [h.re('n'), h.re('x'), h.re('p')], [[20, 10, 30], [20, 20], [10, 20]]);
  h.run("a = interp1([10 20 30], 2.5); b = interp1([3 1 2], [30 10 20], 1.5); M = interp1((1:3)', [1 10; 2 20; 3 30], [1.5; 2.5]);");
  check('interp1(v, xq), unsorted x, matrix v', [h.v('a'), h.v('b'), h.re('M')], [25, 15, [1.5, 2.5, 15, 25]]);
  h.run("s = interp1(1:4, [1 4 9 16], 2.5, 'spline'); c = interp1(1:4, [1 4 9 16], 2.5, 'cubic');");
  checkClose("interp1 'spline' and 'cubic' (pchip)", [h.v('s'), h.v('c')], [6.25, 6.25], 0.05);
  checkThrows('duplicate sample points', () => h.run('interp1([1 1 2], [1 2 3], 1.5)'), /unique/);

  h.run('x = 0:5; y = x.^3 - 2*x; q = [0.5 2.25 4.9 6]; v = spline(x, y, q); ex = q.^3 - 2*q;');
  checkClose('not-a-knot spline reproduces cubics (and extrapolates)', h.re('v'), h.re('ex'), 1e-12);
  h.run('pp = spline(0:3, [0 1 0 1]); c = pp.coefs; v = ppval(pp, 1.5); f = pp.form;');
  checkClose('spline pp form', [h.re('c').slice(0, 3), h.v('v')], [[2 / 3, 2 / 3, 2 / 3], 0.5], 1e-12);
  check('pp form field', h.v('f'), 'pp');
  h.run('a = spline(0:2, [0 1 4], 1.5); b = spline([0 1], [1 3], 0.25); c = spline(0:3, [0 0 1 8 27 0], 2.5);');
  checkClose('3 points (parabola), 2 points (line), clamped end slopes', [h.v('a'), h.v('b')], [2.25, 1.5], 1e-12);
  check('clamped spline gives a value', Number.isFinite(h.v('c')), true);
  h.run('p = pchip(-3:3, [-1 -1 -1 0 1 1 1], [0.5 -2.5 3.5]);');
  checkClose('pchip (shape-preserving)', h.re('p'), [0.625, -1, 1], 1e-12);
  h.run('pp = mkpp([0 1 2], [1 0; 2 1]); v = ppval(pp, [0.5 1.5]); [b, c, l, k, d] = unmkpp(pp);');
  check('mkpp / ppval / unmkpp', [h.re('v'), h.v('l'), h.v('k'), h.v('d')], [[0.5, 2], 2, 2, 1]);

  h.run('[X, Y] = meshgrid(1:3, 1:2); Z = X + 10*Y; v = interp2(X, Y, Z, 1.5, 1.5); G = interp2(magic(4), [1.5 2.5], [1.5; 3]); o = interp2(magic(4), 5, 1); r = interp2(magic(4), 9, 1, \'linear\', 0);');
  check('interp2 linear, grid queries, outside', [h.v('v'), h.re('G'), Number.isNaN(h.interp.workspace.get('o').re[0]), h.v('r')], [16.5, [8.5, 8, 6.5, 6.5], true, 0]);
  h.run("[X, Y] = meshgrid(0:4); s = interp2(X, Y, X.^2 + Y.^3, 1.5, 2.5, 'spline'); c = interp2(X, Y, X.^2 + Y, 1.5, 2.5, 'cubic'); n = interp2(magic(3), 1.4, 2.6, 'nearest');");
  checkClose('interp2 spline / cubic / nearest', [h.v('s'), h.v('c'), h.v('n')], [1.5 ** 2 + 2.5 ** 3, 1.5 ** 2 + 2.5, 4], 1e-12);

  h.run('a = polyder([1 2 3 4]); b = polyder([1 1], [1 -1]); [q, d] = polyder([1 0], [1 1]); c = polyder(5); p = polyint([3 2 1]); p2 = polyint([3 2 1], 5);');
  check('polyder / polyint', [h.re('a'), h.re('b'), h.v('q'), h.re('d'), h.v('c'), h.re('p'), h.re('p2')], [[3, 4, 3], [2, 0], 1, [1, 2, 1], 0, [1, 1, 1, 0], [1, 1, 1, 5]]);
}

// ---------------- matrix functions ----------------
{
  const h = setup();
  h.run('E = expm([0 1; -1 0]); F = expm([1 2; 0 1]);');
  checkClose('expm (rotation)', h.re('E'), [Math.cos(1), -Math.sin(1), Math.sin(1), Math.cos(1)], 1e-12);
  checkClose('expm (Jordan block)', h.re('F'), [Math.E, 0, 2 * Math.E, Math.E], 1e-12);
  h.run('S = sqrtm([4 1; 0 9]); T = sqrtm([-1 0; 0 4]);');
  checkClose('sqrtm', h.re('S'), [2, 0, 0.2, 3], 1e-12);
  const T = h.interp.workspace.get('T');
  checkClose('sqrtm with a negative eigenvalue is complex', [...T.re, ...T.im], [0, 0, 0, 2, 1, 0, 0, 0], 1e-12);
  h.run("A = [4 12 -16; 12 37 -43; -16 -43 98]; R = chol(A); L = chol(A, 'lower'); [R2, p] = chol([1 2; 2 1]);");
  check('chol (upper and lower)', [h.re('R'), h.re('L')], [[2, 0, 0, 6, 1, 0, -8, 5, 3], [2, 6, -8, 0, 1, 5, 0, 0, 3]]);
  check('[R, p] = chol of an indefinite matrix', [h.v('R2'), h.v('p')], [1, 2]);
  checkThrows('chol of an indefinite matrix', () => h.run('chol([1 2; 2 1])'), /positive definite/);
  h.run('c = cond([1 2; 3 4]); c1 = cond([1 2; 3 4], 1); ci = cond([1 2; 3 4], Inf);');
  checkClose('cond', [h.v('c'), h.v('c1'), h.v('ci')], [14.933034373659268, 21, 21], 1e-10);
  h.run('N = null([1 2 3; 4 5 6]); E3 = null(eye(3)); Q = orth([1 1; 1 1]); M = null([1 1; 1 1]);');
  checkClose('null (as MATLAB, sign included)', h.re('N'), [0.4082482904638632, -0.8164965809277261, 0.408248290463863], 1e-12);
  check('null of a full-rank matrix is empty, orth of rank 1', [h.size('E3'), h.size('Q')], [[3, 0], [2, 1]]);
  checkClose('null basis is orthonormal and annihilated', [Math.hypot(...h.re('M'))], [1], 1e-12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
