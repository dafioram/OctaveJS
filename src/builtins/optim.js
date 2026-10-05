// optim.js — Roots, minimization and integration of user functions:
// fzero, fminbnd, fminsearch (with optimset / optimget), integral,
// integral2 and quad.
//
// fzero (Brent's zeroin, after a search for a sign change when given a
// single starting point), fminbnd (Brent's golden-section + parabolic
// search) and fminsearch (Nelder–Mead, Lagarias et al.) are ports of the
// algorithms MATLAB's own functions use, with the same defaults, so they
// stop at the same points. integral is adaptive Gauss–Kronrod (7, 15)
// like MATLAB's, with its default tolerances (AbsTol 1e-10, RelTol 1e-6)
// and infinite limits handled by a change of variable.

import { Mat, StructArray, MatlabError } from '../core/values.js';
import {
  funcCaller, realScalar, getScalarOption, getTextOption, optionsArg, optionsSetter,
  optionsGetter, epsOf,
} from './numutil.js';

const OPTIM_FIELDS = ['Display', 'FunValCheck', 'MaxFunEvals', 'MaxIter', 'OutputFcn', 'PlotFcns', 'TolFun', 'TolX'];

function displayMode(opts, fname, dflt) {
  const d = getTextOption(opts, 'Display', fname) ?? dflt;
  if (!['off', 'none', 'iter', 'final', 'notify', 'iter-detailed', 'final-detailed', 'notify-detailed'].includes(d)) {
    throw new MatlabError(`${fname}: invalid Display option '${d}'`);
  }
  return d.replace('-detailed', '').replace('none', 'off');
}

const outputStruct = (fields) => StructArray.scalar(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? Mat.fromString(v) : Mat.scalar(v)])));

// ---------------- fzero ----------------

function fzero(args, nargout, ctx) {
  if (args.length < 2) throw new MatlabError('fzero: expected fzero(fun, x0)');
  const opts = optionsArg(args[2], 'fzero');
  const fn = funcCaller(ctx, args[0], 'fzero', args.slice(3));
  const tol = getScalarOption(opts, 'TolX', 'fzero') ?? epsOf(1);
  const display = displayMode(opts, 'fzero', 'notify');
  const x0 = args[1];
  let fcount = 0, iter = 0;
  const F = (x) => { fcount++; return realScalar(fn(Mat.scalar(x)), 'fzero'); };
  const finish = (x, fx, flag, message) => {
    if ((display === 'notify' && flag < 0) || display === 'final' || display === 'iter') ctx.interp.print(`\n${message}\n\n`);
    return [Mat.scalar(x), Mat.scalar(fx), Mat.scalar(flag),
      outputStruct({ intervaliterations: intervalIter, iterations: iter, funcCount: fcount, algorithm: 'bisection, interpolation', message })].slice(0, Math.max(nargout, 1));
  };
  let a, b, fa, fb, intervalIter = 0;
  if (x0.numel === 2) {
    [a, b] = x0.re;
    fa = F(a); fb = F(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) throw new MatlabError('fzero: function values at the interval endpoints must be finite and real.');
    if ((fa > 0) === (fb > 0) && fa !== 0 && fb !== 0) throw new MatlabError('fzero: the function values at the interval endpoints must differ in sign.');
    if (fa === 0) return finish(a, fa, 1, 'Zero found in the interval.');
  } else if (x0.numel === 1) {
    // Look for an interval around x0 where the function changes sign.
    const x = x0.re[0];
    const fx = F(x);
    if (fx === 0) return finish(x, fx, 1, 'Zero found at the initial point.');
    if (!Number.isFinite(fx)) throw new MatlabError('fzero: the function value at the initial point must be finite and real.');
    let dx = x !== 0 ? x / 50 : 1 / 50;
    a = x; fa = fx; b = x; fb = fx;
    const twosqrt = Math.sqrt(2);
    while ((fa > 0) === (fb > 0)) {
      intervalIter++;
      dx *= twosqrt;
      a = x - dx; fa = F(a);
      if (!Number.isFinite(fa) || !Number.isFinite(b)) {
        return finish(NaN, NaN, -3, `Exiting fzero: aborting search for an interval containing a sign change\n    because NaN or Inf function value encountered during search.\n(Function value at ${a} is ${fa}.)\nCheck function or try again with a different starting value.`);
      }
      if (!Number.isFinite(a)) return finish(NaN, NaN, -6, 'Exiting fzero: aborting search for an interval containing a sign change\n    because no sign change is detected during search.\nFunction may not have a root.');
      if ((fa > 0) !== (fb > 0)) break;
      b = x + dx; fb = F(b);
      if (!Number.isFinite(fb)) {
        return finish(NaN, NaN, -3, `Exiting fzero: aborting search for an interval containing a sign change\n    because NaN or Inf function value encountered during search.\n(Function value at ${b} is ${fb}.)\nCheck function or try again with a different starting value.`);
      }
    }
  } else throw new MatlabError('fzero: the second argument must be a scalar or a 2-element interval');

  // Brent's method (zeroin).
  const savea = a, saveb = b, savefa = fa, savefb = fb;
  let c = a, fc = fb, d = b - a, e = d;
  while (fb !== 0 && a !== b) {
    // b is the best estimate so far, a the previous one, and the zero
    // lies between b and c.
    if ((fb > 0) === (fc > 0)) { c = a; fc = fa; d = b - a; e = d; }
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
    const m = 0.5 * (c - b);
    const toler = 2.0 * tol * Math.max(Math.abs(b), 1.0);
    if (Math.abs(m) <= toler || fb === 0) break;
    if (Math.abs(e) < toler || Math.abs(fa) <= Math.abs(fb)) { d = m; e = m; } // bisection
    else {
      let p, q;
      const s = fb / fa;
      if (a === c) { p = 2.0 * m * s; q = 1.0 - s; } // linear interpolation
      else { // inverse quadratic interpolation
        const qq = fa / fc, r = fb / fc;
        p = s * (2.0 * m * qq * (qq - r) - (b - a) * (r - 1.0));
        q = (qq - 1.0) * (r - 1.0) * (s - 1.0);
      }
      if (p > 0) q = -q; else p = -p;
      if (2.0 * p < 3.0 * m * q - Math.abs(toler * q) && p < Math.abs(0.5 * e * q)) { e = d; d = p / q; }
      else { d = m; e = m; }
    }
    a = b; fa = fb;
    if (Math.abs(d) > toler) b += d;
    else if (b > c) b -= toler;
    else b += toler;
    fb = F(b);
    iter++;
  }
  if (Math.abs(fb) > Math.max(Math.abs(savefa), Math.abs(savefb))) {
    // Converged to a sign change that isn't a zero (a pole, e.g. tan at pi/2).
    return finish(b, fb, -5, `Current point x may be near a singular point. The interval [${Math.min(savea, saveb)}, ${Math.max(savea, saveb)}] reduced to the requested tolerance and the function changes sign in the interval, but f(x) increased in magnitude as the interval reduced.`);
  }
  return finish(b, fb, 1, `Zero found in the interval [${Math.min(b, c)}, ${Math.max(b, c)}]`);
}

// ---------------- fminbnd ----------------

function fminbnd(args, nargout, ctx) {
  if (args.length < 3) throw new MatlabError('fminbnd: expected fminbnd(fun, x1, x2)');
  const opts = optionsArg(args[3], 'fminbnd');
  const fn = funcCaller(ctx, args[0], 'fminbnd', args.slice(4));
  const ax = args[1].toScalarNumber(), bx = args[2].toScalarNumber();
  if (!(ax <= bx)) throw new MatlabError('fminbnd: the lower bound must not exceed the upper bound');
  const tol = getScalarOption(opts, 'TolX', 'fminbnd') ?? 1e-4;
  const maxfun = getScalarOption(opts, 'MaxFunEvals', 'fminbnd') ?? 500;
  const maxiter = getScalarOption(opts, 'MaxIter', 'fminbnd') ?? 500;
  const display = displayMode(opts, 'fminbnd', 'notify');
  let funccount = 0, iter = 0;
  const F = (x) => { funccount++; return realScalar(fn(Mat.scalar(x)), 'fminbnd'); };
  const seps = Math.sqrt(epsOf(1));
  const c = 0.5 * (3.0 - Math.sqrt(5.0));
  let a = ax, b = bx;
  let v = a + c * (b - a), w = v, xf = v, d = 0.0, e = 0.0;
  let x = xf, fx = F(x);
  let fv = fx, fw = fx;
  let xm = 0.5 * (a + b);
  let tol1 = seps * Math.abs(xf) + tol / 3.0, tol2 = 2.0 * tol1;
  let flag = 1;
  while (Math.abs(xf - xm) > tol2 - 0.5 * (b - a)) {
    if (funccount >= maxfun || iter >= maxiter) { flag = 0; break; }
    let golden = true;
    if (Math.abs(e) > tol1) {
      // Try a parabolic fit.
      golden = false;
      let r = (xf - w) * (fx - fv);
      let q = (xf - v) * (fx - fw);
      let p = (xf - v) * q - (xf - w) * r;
      q = 2.0 * (q - r);
      if (q > 0.0) p = -p;
      q = Math.abs(q);
      r = e; e = d;
      if (Math.abs(p) < Math.abs(0.5 * q * r) && p > q * (a - xf) && p < q * (b - xf)) {
        d = p / q;
        x = xf + d;
        // f must not be evaluated too close to ax or bx.
        if (x - a < tol2 || b - x < tol2) d = tol1 * (Math.sign(xm - xf) + (xm - xf === 0 ? 1 : 0));
      } else golden = true;
    }
    if (golden) { e = xf >= xm ? a - xf : b - xf; d = c * e; }
    // The function must not be evaluated too close to xf.
    x = xf + (Math.sign(d) + (d === 0 ? 1 : 0)) * Math.max(Math.abs(d), tol1);
    const fu = F(x);
    iter++;
    if (fu <= fx) {
      if (x >= xf) a = xf; else b = xf;
      v = w; fv = fw; w = xf; fw = fx; xf = x; fx = fu;
    } else {
      if (x < xf) a = x; else b = x;
      if (fu <= fw || w === xf) { v = w; fv = fw; w = x; fw = fu; }
      else if (fu <= fv || v === xf || v === w) { v = x; fv = fu; }
    }
    xm = 0.5 * (a + b);
    tol1 = seps * Math.abs(xf) + tol / 3.0; tol2 = 2.0 * tol1;
  }
  const message = flag === 1
    ? `Optimization terminated:\n the current x satisfies the termination criteria using OPTIONS.TolX of ${tol.toExponential(6)}`
    : 'Exiting: Maximum number of function evaluations or iterations has been exceeded.';
  if ((display === 'notify' && flag <= 0) || display === 'final' || display === 'iter') ctx.interp.print(`\n${message}\n\n`);
  return [Mat.scalar(xf), Mat.scalar(fx), Mat.scalar(flag),
    outputStruct({ iterations: iter, funcCount: funccount, algorithm: 'golden section search, parabolic interpolation', message })].slice(0, Math.max(nargout, 1));
}

// ---------------- fminsearch ----------------

function fminsearch(args, nargout, ctx) {
  if (args.length < 2) throw new MatlabError('fminsearch: expected fminsearch(fun, x0)');
  const opts = optionsArg(args[2], 'fminsearch');
  const fn = funcCaller(ctx, args[0], 'fminsearch', args.slice(3));
  const x0 = args[1];
  if (x0.isComplex) throw new MatlabError('fminsearch: x0 must be real');
  const n = x0.numel;
  const tolx = getScalarOption(opts, 'TolX', 'fminsearch') ?? 1e-4;
  const tolf = getScalarOption(opts, 'TolFun', 'fminsearch') ?? 1e-4;
  const maxfun = getScalarOption(opts, 'MaxFunEvals', 'fminsearch') ?? 200 * n;
  const maxiter = getScalarOption(opts, 'MaxIter', 'fminsearch') ?? 200 * n;
  const display = displayMode(opts, 'fminsearch', 'notify');
  let funccount = 0;
  // The function sees x in the shape of x0.
  const F = (x) => { funccount++; return realScalar(fn(new Mat(x0.rows, x0.cols, Float64Array.from(x))), 'fminsearch'); };
  const rho = 1, chi = 2, psi = 0.5, sigma = 0.5;
  // Initial simplex: x0 plus a 5% step along each coordinate (0.00025 for zeros).
  let v = [Array.from(x0.re)];
  let fv = [F(v[0])];
  for (let j = 0; j < n; j++) {
    const y = v[0].slice();
    y[j] = y[j] !== 0 ? 1.05 * y[j] : 0.00025;
    v.push(y); fv.push(F(y));
  }
  const sort = () => {
    const order = fv.map((f, i) => i).sort((i, j) => fv[i] - fv[j] || i - j);
    v = order.map(i => v[i]); fv = order.map(i => fv[i]);
  };
  sort();
  let iter = 1;
  let flag = 1;
  for (;;) {
    let fspread = 0, xspread = 0;
    for (let j = 1; j <= n; j++) {
      fspread = Math.max(fspread, Math.abs(fv[0] - fv[j]));
      for (let i = 0; i < n; i++) xspread = Math.max(xspread, Math.abs(v[j][i] - v[0][i]));
    }
    if (fspread <= Math.max(tolf, 10 * epsOf(fv[0])) && xspread <= Math.max(tolx, 10 * epsOf(Math.max(...v[0])))) break;
    if (funccount >= maxfun || iter >= maxiter) { flag = 0; break; }
    const xbar = Array.from({ length: n }, (_, i) => v.slice(0, n).reduce((s, p) => s + p[i], 0) / n);
    const worst = v[n];
    const along = (coef) => xbar.map((xb, i) => (1 + coef) * xb - coef * worst[i]);
    const xr = along(rho), fxr = F(xr);
    let shrink = false;
    if (fxr < fv[0]) {
      const xe = along(rho * chi), fxe = F(xe);
      if (fxe < fxr) { v[n] = xe; fv[n] = fxe; } else { v[n] = xr; fv[n] = fxr; }
    } else if (fxr < fv[n - 1]) {
      v[n] = xr; fv[n] = fxr;
    } else if (fxr < fv[n]) {
      const xc = along(psi * rho), fxc = F(xc); // outside contraction
      if (fxc <= fxr) { v[n] = xc; fv[n] = fxc; } else shrink = true;
    } else {
      const xcc = xbar.map((xb, i) => (1 - psi) * xb + psi * worst[i]), fxcc = F(xcc); // inside contraction
      if (fxcc < fv[n]) { v[n] = xcc; fv[n] = fxcc; } else shrink = true;
    }
    if (shrink) {
      for (let j = 1; j <= n; j++) {
        v[j] = v[j].map((x, i) => v[0][i] + sigma * (x - v[0][i]));
        fv[j] = F(v[j]);
      }
    }
    sort();
    iter++;
  }
  const message = flag === 1
    ? `Optimization terminated:\n the current x satisfies the termination criteria using OPTIONS.TolX of ${tolx.toExponential(6)} \n and F(X) satisfies the convergence criteria using OPTIONS.TolFun of ${tolf.toExponential(6)} \n`
    : `Exiting: Maximum number of ${funccount >= maxfun ? 'function evaluations' : 'iterations'} has been exceeded\n         - increase ${funccount >= maxfun ? 'MaxFunEvals' : 'MaxIter'} option.\n         Current function value: ${fv[0].toFixed(6)} \n`;
  if ((display === 'notify' && flag <= 0) || display === 'final' || display === 'iter') ctx.interp.print(`\n${message}\n`);
  return [new Mat(x0.rows, x0.cols, Float64Array.from(v[0])), Mat.scalar(fv[0]), Mat.scalar(flag),
    outputStruct({ iterations: iter, funcCount: funccount, algorithm: 'Nelder-Mead simplex direct search', message })].slice(0, Math.max(nargout, 1));
}

// ---------------- integral (adaptive Gauss–Kronrod 7-15) ----------------

const GK_NODES = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926,
  0.741531185599394439863864773280788, 0.586087235467691130294144845693013, 0.405845151377397166906606412076961,
  0.207784955007898467600689403773245, 0,
];
const GK_WK = [
  0.022935322010529224963732008058970, 0.063092092629978553290700663189204, 0.104790010322250183839876322541518,
  0.140653259715525918745189590510238, 0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
  0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
];
const GK_WG = [0, 0.129484966168869693270611432679082, 0, 0.279705391489276667901467771423780, 0, 0.381830050505118944950369775488975, 0, 0.417959183673469387755102040816327];
// The 15 nodes on [-1, 1] and their Kronrod / Gauss weights.
const GK15 = (() => {
  const x = [], wk = [], wg = [];
  for (let i = 0; i < 7; i++) { x.push(-GK_NODES[i]); wk.push(GK_WK[i]); wg.push(GK_WG[i]); }
  x.push(0); wk.push(GK_WK[7]); wg.push(GK_WG[7]);
  for (let i = 6; i >= 0; i--) { x.push(GK_NODES[i]); wk.push(GK_WK[i]); wg.push(GK_WG[i]); }
  return { x, wk, wg };
})();

// Integrates g (taking an array of points and returning {re, im} arrays,
// or arrays of vectors when array-valued) over [a, b] to the tolerances.
function adaptiveGK(g, a, b, { absTol, relTol, waypoints = [], maxIntervals = 650 }, fname, warn) {
  // Initial subintervals: 10 per waypoint-separated piece, as in MATLAB.
  const cuts = [a, ...waypoints.filter(w => w > Math.min(a, b) && w < Math.max(a, b)).sort((p, q) => (a < b ? p - q : q - p)), b];
  let intervals = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    for (let i = 0; i < 10; i++) intervals.push([cuts[k] + (cuts[k + 1] - cuts[k]) * i / 10, cuts[k] + (cuts[k + 1] - cuts[k]) * (i + 1) / 10]);
  }
  const evalPiece = ([l, r]) => {
    const half = (r - l) / 2, mid = (l + r) / 2;
    const pts = GK15.x.map(x => mid + half * x);
    const vals = g(pts); // array of {re, im} (or of arrays of them)
    const sum = (w) => {
      const acc = vals[0].map(() => ({ re: 0, im: 0 }));
      vals.forEach((vec, k) => vec.forEach((v, i) => { acc[i].re += w[k] * v.re; acc[i].im += w[k] * v.im; }));
      return acc.map(v => ({ re: v.re * half, im: v.im * half }));
    };
    const K = sum(GK15.wk), G = sum(GK15.wg);
    const err = Math.max(...K.map((v, i) => Math.hypot(v.re - G[i].re, v.im - G[i].im)));
    return { l, r, q: K, err };
  };
  let pieces = intervals.map(evalPiece);
  let total = null;
  for (;;) {
    total = pieces[0].q.map((_, i) => ({ re: pieces.reduce((s, p) => s + p.q[i].re, 0), im: pieces.reduce((s, p) => s + p.q[i].im, 0) }));
    const errSum = pieces.reduce((s, p) => s + p.err, 0);
    const size = Math.max(...total.map(v => Math.hypot(v.re, v.im)));
    const tolerance = Math.max(absTol, relTol * size);
    if (!Number.isFinite(errSum)) {
      if (total.some(v => !Number.isFinite(v.re) || !Number.isFinite(v.im))) break;
    }
    if (errSum <= tolerance) break;
    if (pieces.length >= maxIntervals) {
      warn(`Warning: Reached the limit on the maximum number of intervals in use.\nApproximate bound on error is ${errSum.toExponential(1)}. The integral may not exist, or it may be difficult to approximate numerically to the requested accuracy.\n`);
      break;
    }
    // Split every piece whose error is above its share of the tolerance
    // (at least the worst one).
    const share = tolerance / pieces.length;
    const worstErr = Math.max(...pieces.map(p => p.err));
    const keep = [], split = [];
    for (const p of pieces) ((p.err > share || p.err === worstErr) ? split : keep).push(p);
    if (split.every(p => Math.abs(p.r - p.l) <= 64 * epsOf(Math.max(Math.abs(p.l), Math.abs(p.r))))) {
      warn('Warning: Minimum step size reached near x = ' + split[0].l + '; singularity possible.\n');
      break;
    }
    pieces = keep.concat(split.flatMap(p => { const m = (p.l + p.r) / 2; return [evalPiece([p.l, m]), evalPiece([m, p.r])]; }));
  }
  return total;
}

// integral(f, a, b, Name, Value...): f is called with arrays of points
// (or one point at a time with 'ArrayValued', true).
function integral(args, nargout, ctx) {
  if (args.length < 3) throw new MatlabError('integral: expected integral(fun, a, b)');
  const fn = funcCaller(ctx, args[0], 'integral');
  const a = args[1].toScalarNumber(), b = args[2].toScalarNumber();
  const o = parseNameValues(args.slice(3), 'integral', ['abstol', 'reltol', 'arrayvalued', 'waypoints']);
  const absTol = o.abstol ? o.abstol.toScalarNumber() : 1e-10;
  const relTol = o.reltol ? o.reltol.toScalarNumber() : 1e-6;
  const arrayValued = o.arrayvalued ? o.arrayvalued.re[0] !== 0 : false;
  const waypoints = o.waypoints ? Array.from(o.waypoints.re) : [];
  return [integrate1(ctx, fn, a, b, { absTol, relTol, arrayValued, waypoints }, 'integral')];
}

function parseNameValues(rest, fname, known) {
  if (rest.length % 2 !== 0) throw new MatlabError(`${fname}: options must be Name, Value pairs`);
  const out = {};
  for (let k = 0; k < rest.length; k += 2) {
    const name = rest[k] instanceof Mat && rest[k].isChar ? rest[k].toJSString().toLowerCase() : null;
    if (!name || !known.includes(name)) throw new MatlabError(`${fname}: unsupported option '${name ?? '?'}'`);
    out[name] = rest[k + 1];
  }
  return out;
}

// The integral of fn over [a, b] (either may be infinite) as a Mat.
function integrate1(ctx, fn, a, b, { absTol, relTol, arrayValued = false, waypoints = [] }, fname) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Mat.scalar(NaN);
  if (a === b) {
    if (!arrayValued) return Mat.scalar(0);
    const shape = fn(Mat.scalar(a));
    return new Mat(shape.rows, shape.cols, new Float64Array(shape.numel));
  }
  let shape = null;
  // Values of fn at the points xs, as arrays (one per point) of {re, im}.
  const values = (xs) => {
    if (arrayValued) {
      return xs.map(x => {
        const v = fn(Mat.scalar(x));
        if (!shape) shape = [v.rows, v.cols];
        else if (v.rows !== shape[0] || v.cols !== shape[1]) throw new MatlabError(`${fname}: the function must return values of the same size at every point`);
        return Array.from(v.re, (re, i) => ({ re, im: v.im ? v.im[i] : 0 }));
      });
    }
    const v = fn(new Mat(1, xs.length, Float64Array.from(xs)));
    if (v.numel !== xs.length) {
      throw new MatlabError(`${fname}: output of the function must be the same size as the input. If the function is not vectorized, use element-wise operators (.* ./ .^) or set 'ArrayValued' to true.`);
    }
    return Array.from(v.re, (re, i) => [{ re, im: v.im ? v.im[i] : 0 }]);
  };
  // Infinite limits: change variables to a finite interval.
  let g, lo, hi, wp = waypoints;
  const sign = a > b ? -1 : 1;
  const [l, r] = a > b ? [b, a] : [a, b];
  const scaled = (xs, ts, dxdt) => values(xs).map((vec, k) => vec.map(v => ({ re: sign * v.re * dxdt[k], im: sign * v.im * dxdt[k] })));
  if (Number.isFinite(l) && Number.isFinite(r)) {
    // x = (r-l)/4 * t*(3 - t^2) + (r+l)/2 on t in [-1, 1], as MATLAB does:
    // its derivative vanishes at the ends, which tames endpoint
    // singularities such as log(x) at 0.
    const xOf = (t) => ((r - l) / 4) * t * (3 - t * t) + (r + l) / 2;
    g = (ts) => scaled(ts.map(xOf), ts, ts.map(t => (3 * (r - l) / 4) * (1 - t * t)));
    lo = -1; hi = 1;
    // Waypoints move to t-space (xOf is increasing, so bisect).
    wp = waypoints.map(w => {
      let tl = -1, th = 1;
      for (let i = 0; i < 100; i++) { const tm = (tl + th) / 2; if (xOf(tm) < w) tl = tm; else th = tm; }
      return (tl + th) / 2;
    });
  } else if (Number.isFinite(l)) { // [l, Inf): x = l + t/(1-t)
    g = (ts) => scaled(ts.map(t => l + t / (1 - t)), ts, ts.map(t => 1 / (1 - t) ** 2)); lo = 0; hi = 1; wp = [];
  } else if (Number.isFinite(r)) { // (-Inf, r]: x = r - t/(1-t)
    g = (ts) => scaled(ts.map(t => r - t / (1 - t)), ts, ts.map(t => 1 / (1 - t) ** 2)); lo = 0; hi = 1; wp = [];
  } else { // (-Inf, Inf): x = t/(1-t^2)
    g = (ts) => scaled(ts.map(t => t / (1 - t * t)), ts, ts.map(t => (1 + t * t) / (1 - t * t) ** 2)); lo = -1; hi = 1; wp = [];
  }
  const total = adaptiveGK(g, lo, hi, { absTol, relTol, waypoints: wp }, fname, (msg) => ctx.interp.print(msg));
  const im = total.some(v => v.im !== 0) ? Float64Array.from(total, v => v.im) : null;
  if (arrayValued) return new Mat(shape[0], shape[1], Float64Array.from(total, v => v.re), im);
  return new Mat(1, 1, Float64Array.from([total[0].re]), im);
}

// integral2(f, xmin, xmax, ymin, ymax): ymin/ymax may be functions of x.
// Computed as an iterated integral, with f called on arrays of points.
function integral2(args, nargout, ctx) {
  if (args.length < 5) throw new MatlabError('integral2: expected integral2(fun, xmin, xmax, ymin, ymax)');
  const fn = funcCaller(ctx, args[0], 'integral2');
  const xmin = args[1].toScalarNumber(), xmax = args[2].toScalarNumber();
  const o = parseNameValues(args.slice(5), 'integral2', ['abstol', 'reltol', 'method']);
  const absTol = o.abstol ? o.abstol.toScalarNumber() : 1e-10;
  const relTol = o.reltol ? o.reltol.toScalarNumber() : 1e-6;
  const limit = (v) => {
    if (v instanceof Mat && !v.isChar) { const c = v.toScalarNumber(); return () => c; }
    const f = funcCaller(ctx, v, 'integral2');
    return (x) => realScalar(f(Mat.scalar(x)), 'integral2');
  };
  const ylo = limit(args[3]), yhi = limit(args[4]);
  const inner = (x) => {
    const g = (yRow) => {
      const out = fn(new Mat(yRow.rows, yRow.cols, new Float64Array(yRow.numel).fill(x)), yRow);
      if (out.numel !== yRow.numel) throw new MatlabError('integral2: the function must accept arrays and return an array of the same size (use .* ./ .^)');
      return out;
    };
    return integrate1(ctx, g, ylo(x), yhi(x), { absTol: absTol / 10, relTol: relTol / 10 }, 'integral2');
  };
  const outer = (xRow) => {
    const re = new Float64Array(xRow.numel);
    let im = null;
    for (let k = 0; k < xRow.numel; k++) {
      const v = inner(xRow.re[k]);
      re[k] = v.re[0];
      if (v.im) { if (!im) im = new Float64Array(xRow.numel); im[k] = v.im[0]; }
    }
    return new Mat(1, xRow.numel, re, im);
  };
  return [integrate1(ctx, outer, xmin, xmax, { absTol, relTol }, 'integral2')];
}

// quad(f, a, b, tol): adaptive Simpson with Richardson extrapolation, a
// port of MATLAB's quad/quadstep (default tol 1e-6).
function quad(args, nargout, ctx) {
  if (args.length < 3) throw new MatlabError('quad: expected quad(fun, a, b)');
  const fn = funcCaller(ctx, args[0], 'quad', args.slice(5));
  const a = args[1].toScalarNumber(), b = args[2].toScalarNumber();
  const tol = args[3] && !args[3].isEmpty ? args[3].re[0] : 1e-6;
  let fcnt = 0;
  const F = (xs) => {
    fcnt += xs.length;
    const v = fn(new Mat(1, xs.length, Float64Array.from(xs)));
    if (v.numel !== xs.length) throw new MatlabError('quad: the function must accept a vector and return a vector of the same size (use .* ./ .^)');
    return Array.from(v.re);
  };
  const hmin = epsOf(b - a) / 1024;
  const warnings = new Set();
  const quadstep = (l, r, fl, fc, fr) => {
    const h = r - l, c = (l + r) / 2;
    if (Math.abs(h) < hmin || c === l || c === r) { warnings.add(1); return h * fc; }
    const [fd, fe] = F([(l + c) / 2, (c + r) / 2]);
    if (fcnt > 10000) { warnings.add(2); return h * fc; }
    const q1 = (h / 6) * (fl + 4 * fc + fr);
    const q2 = (h / 12) * (fl + 4 * fd + 2 * fc + 4 * fe + fr);
    const q = q2 + (q2 - q1) / 15;
    if (!Number.isFinite(q)) { warnings.add(3); return q; }
    if (Math.abs(q2 - q) <= tol) return q;
    return quadstep(l, c, fl, fd, fc) + quadstep(c, r, fc, fe, fr);
  };
  // Three unequal subintervals to start.
  const h = 0.13579 * (b - a);
  const x = [a, a + h, a + 2 * h, (a + b) / 2, b - 2 * h, b - h, b];
  const y = F(x);
  const q = quadstep(x[0], x[2], y[0], y[1], y[2]) + quadstep(x[2], x[4], y[2], y[3], y[4]) + quadstep(x[4], x[6], y[4], y[5], y[6]);
  if (warnings.has(1)) ctx.interp.print('Warning: Minimum step size reached; singularity possible.\n');
  if (warnings.has(2)) ctx.interp.print('Warning: Maximum function count exceeded; singularity likely.\n');
  if (warnings.has(3)) ctx.interp.print('Warning: Infinite or Not-a-Number function value encountered.\n');
  return nargout >= 2 ? [Mat.scalar(q), Mat.scalar(fcnt)] : [Mat.scalar(q)];
}

export function registerOptim(reg) {
  reg.set('fzero', { fn: fzero });
  reg.set('fminbnd', { fn: fminbnd });
  reg.set('fminsearch', { fn: fminsearch });
  reg.set('optimset', { fn: optionsSetter('optimset', OPTIM_FIELDS) });
  reg.set('optimget', { fn: optionsGetter('optimget') });
  reg.set('integral', { fn: integral });
  reg.set('integral2', { fn: integral2 });
  reg.set('quad', { fn: quad });
}

