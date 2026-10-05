// ode.js — ODE solvers: ode45, ode23, ode23s (and ode15s), with odeset /
// odeget and deval.
//
// ode45 (Dormand–Prince 4(5)) and ode23 (Bogacki–Shampine 2(3)) follow
// MATLAB's own implementations step for step: the same initial step
// guess, error norm, step-size control, FSAL reuse, "stretch" to hit the
// final time, and continuous extensions (ntrp45/ntrp23) for Refine and
// for output at the times in tspan. So the steps, and the points [t, y]
// returned, match MATLAB's closely, not just the accuracy.
//
// ode23s is MATLAB's modified Rosenbrock 2(3) method for stiff problems,
// with a finite-difference Jacobian (or the Jacobian option). ode15s is
// accepted for stiff problems too and uses the same method (not MATLAB's
// NDF method): the solution agrees within the tolerances, but the steps
// differ. Not supported: Events, Mass, OutputFcn, NonNegative,
// NormControl.

import { Mat, StructArray, MatlabError } from '../core/values.js';
import {
  funcCaller, getOption, getScalarOption, getTextOption, optionsArg, optionsSetter, optionsGetter,
  epsOf, solveLinear,
} from './numutil.js';

const ODE_FIELDS = [
  'AbsTol', 'BDF', 'Events', 'InitialStep', 'Jacobian', 'JConstant', 'JPattern', 'Mass', 'MassSingular',
  'MaxOrder', 'MaxStep', 'NonNegative', 'NormControl', 'OutputFcn', 'OutputSel', 'Refine', 'RelTol',
  'Stats', 'Vectorized', 'MStateDependence', 'MvPattern', 'InitialSlope',
];

// Butcher tableaus in MATLAB's layout: stage i+1 is evaluated at
// t + A[i]*h with y + h * sum_j B[j][i] * f_j; the last column of B gives
// the new solution; E the error estimate; BI the interpolant.
const DOPRI = {
  stages: 7, pow: 1 / 5, failFactor: 0.1, refine: 4,
  A: [1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1],
  B: [
    [1 / 5, 3 / 40, 44 / 45, 19372 / 6561, 9017 / 3168, 35 / 384],
    [0, 9 / 40, -56 / 15, -25360 / 2187, -355 / 33, 0],
    [0, 0, 32 / 9, 64448 / 6561, 46732 / 5247, 500 / 1113],
    [0, 0, 0, -212 / 729, 49 / 176, 125 / 192],
    [0, 0, 0, 0, -5103 / 18656, -2187 / 6784],
    [0, 0, 0, 0, 0, 11 / 84],
    [0, 0, 0, 0, 0, 0],
  ],
  E: [71 / 57600, 0, -71 / 16695, 71 / 1920, -17253 / 339200, 22 / 525, -1 / 40],
  BI: [
    [1, -183 / 64, 37 / 12, -145 / 128],
    [0, 0, 0, 0],
    [0, 1500 / 371, -1000 / 159, 1000 / 371],
    [0, -125 / 32, 125 / 12, -375 / 64],
    [0, 9477 / 3392, -729 / 106, 25515 / 6784],
    [0, -11 / 7, 11 / 3, -55 / 28],
    [0, 3 / 2, -4, 5 / 2],
  ],
};
const BS23 = {
  stages: 4, pow: 1 / 3, failFactor: 0.5, refine: 1,
  A: [1 / 2, 3 / 4, 1],
  B: [
    [1 / 2, 0, 2 / 9],
    [0, 3 / 4, 1 / 3],
    [0, 0, 4 / 9],
    [0, 0, 0],
  ],
  E: [-5 / 72, 1 / 12, 1 / 9, -1 / 8],
  BI: [
    [1, -4 / 3, 5 / 9],
    [0, 1, -2 / 3],
    [0, 4 / 3, -8 / 9],
    [0, -1, 1],
  ],
};
const ROS_D = 1 / (2 + Math.sqrt(2)), ROS_E32 = 6 + Math.sqrt(2);

// y at t + s*h within a step, from the stage derivatives k (array of
// stage vectors) of an explicit method.
function rkInterp(method, y, h, k, s) {
  const n = y.length, out = y.slice();
  const powers = method.BI[0].map((_, p) => s ** (p + 1));
  for (let j = 0; j < method.stages; j++) {
    let c = 0;
    for (let p = 0; p < powers.length; p++) c += method.BI[j][p] * powers[p];
    if (c === 0) continue;
    for (let i = 0; i < n; i++) out[i] += h * c * k[j][i];
  }
  return out;
}
// ... and for ode23s (MATLAB's ntrp23s), from k1 and k2.
function rosInterp(y, h, k, s) {
  const c1 = (s * (1 - s)) / (1 - 2 * ROS_D), c2 = (s * (s - 2 * ROS_D)) / (1 - 2 * ROS_D);
  return y.map((v, i) => v + h * (c1 * k[0][i] + c2 * k[1][i]));
}

function realVector(v, what, fname) {
  if (!(v instanceof Mat) || v.isChar) throw new MatlabError(`${fname}: ${what} must be numeric`);
  if (v.isComplex && v.im.some(x => x !== 0)) throw new MatlabError(`${fname}: complex ${what} is not supported`);
  return Array.from(v.re);
}

function solveOde(fname, method, args, nargout, ctx) {
  if (args.length < 3) throw new MatlabError(`${fname}: expected ${fname}(odefun, tspan, y0)`);
  const opts = optionsArg(args[3], fname);
  const extra = args.slice(4);
  const rhs = funcCaller(ctx, args[0], fname, extra);
  const tspan = realVector(args[1], 'tspan', fname);
  let y = realVector(args[2], 'the initial condition y0', fname);
  const neq = y.length;
  if (tspan.length < 2) throw new MatlabError(`${fname}: tspan must have at least two elements [t0 tfinal]`);
  const t0 = tspan[0], tfinal = tspan[tspan.length - 1];
  if (t0 === tfinal) throw new MatlabError(`${fname}: the last entry in tspan must be different from the first entry`);
  const tdir = Math.sign(tfinal - t0);
  for (let k = 1; k < tspan.length; k++) {
    if (tdir * (tspan[k] - tspan[k - 1]) <= 0) throw new MatlabError(`${fname}: the entries in tspan must strictly increase or decrease`);
  }
  for (const name of ['Events', 'Mass', 'OutputFcn', 'NonNegative']) {
    if (getOption(opts, name) !== null) throw new MatlabError(`${fname}: the ${name} option is not supported`);
  }
  if (getTextOption(opts, 'NormControl', fname) === 'on') throw new MatlabError(`${fname}: NormControl 'on' is not supported`);

  let nfevals = 0;
  const f = (t, yv) => {
    nfevals++;
    const out = rhs(Mat.scalar(t), new Mat(neq, 1, Float64Array.from(yv)));
    if (out.numel !== neq) throw new MatlabError(`${fname}: the ODE function must return a column vector of length ${neq} (got ${out.sizeStr()})`);
    if (out.isComplex && out.im.some(x => x !== 0)) throw new MatlabError(`${fname}: complex derivatives are not supported`);
    return Array.from(out.re);
  };

  // Tolerances and step limits, as in MATLAB's odearguments.
  let rtol = getScalarOption(opts, 'RelTol', fname) ?? 1e-3;
  if (!(rtol > 0)) throw new MatlabError(`${fname}: RelTol must be a positive scalar`);
  if (rtol < 100 * epsOf(1)) {
    rtol = 100 * epsOf(1);
    ctx.interp.print(`Warning: RelTol has been increased to ${rtol.toExponential(6)}.\n`);
  }
  const atolOpt = getOption(opts, 'AbsTol');
  const atol = atolOpt === null ? [1e-6] : realVector(atolOpt, 'AbsTol', fname);
  if (atol.length !== 1 && atol.length !== neq) throw new MatlabError(`${fname}: AbsTol must be a scalar or a vector with one entry per equation`);
  if (atol.some(v => !(v > 0))) throw new MatlabError(`${fname}: AbsTol must be positive`);
  const threshold = Array.from({ length: neq }, (_, i) => (atol.length === 1 ? atol[0] : atol[i]) / rtol);
  const htspan = Math.abs(tfinal - t0);
  const hmax = Math.min(Math.abs(getScalarOption(opts, 'MaxStep', fname) ?? 0.1 * htspan), htspan);
  const htry = getScalarOption(opts, 'InitialStep', fname);
  const refineOpt = getScalarOption(opts, 'Refine', fname);
  const refine = tspan.length === 2 ? Math.max(1, Math.round(refineOpt ?? method.refine)) : 1;
  const stats = getTextOption(opts, 'Stats', fname) === 'on';
  const wantSol = nargout === 1;

  // Ode23s: the Jacobian, from the option (a matrix or a function of
  // (t, y)) or by finite differences.
  const jacOpt = getOption(opts, 'Jacobian');
  let npds = 0;
  const jacobian = (t, yv, fv) => {
    if (jacOpt instanceof Mat && !jacOpt.isChar) {
      if (jacOpt.rows !== neq || jacOpt.cols !== neq) throw new MatlabError(`${fname}: Jacobian must be ${neq}-by-${neq}`);
      return Array.from({ length: neq }, (_, r) => Array.from({ length: neq }, (_, c) => jacOpt.re[c * neq + r]));
    }
    npds++;
    if (jacOpt !== null) {
      const J = funcCaller(ctx, jacOpt, `${fname} Jacobian`, extra)(Mat.scalar(t), new Mat(neq, 1, Float64Array.from(yv)));
      if (J.rows !== neq || J.cols !== neq) throw new MatlabError(`${fname}: the Jacobian function must return a ${neq}-by-${neq} matrix`);
      return Array.from({ length: neq }, (_, r) => Array.from({ length: neq }, (_, c) => J.re[c * neq + r]));
    }
    const J = Array.from({ length: neq }, () => new Array(neq).fill(0));
    for (let j = 0; j < neq; j++) {
      const del = Math.sqrt(epsOf(1)) * Math.max(Math.abs(yv[j]), threshold[j]);
      const yp = yv.slice(); yp[j] += del;
      const fp = f(t, yp);
      for (let i = 0; i < neq; i++) J[i][j] = (fp[i] - fv[i]) / del;
    }
    return J;
  };

  const rosenbrock = method === 'rosenbrock';
  const pow = rosenbrock ? 1 / 3 : method.pow;
  const failFactor = rosenbrock ? 0.5 : method.failFactor;

  let t = t0;
  let f0 = f(t, y);
  if (f0.length !== neq) throw new MatlabError(`${fname}: the ODE function must return a vector of length ${neq}`);
  const tout = [t0], yout = [y.slice()];
  const stepK = []; // per step: stage derivatives, for deval
  let nsteps = 0, nfailed = 0;
  let next = 1; // next tspan entry to output (when tspan lists times)

  const wtNorm = (vec, ya, yb) => {
    let m = 0;
    for (let i = 0; i < neq; i++) m = Math.max(m, Math.abs(vec[i]) / Math.max(Math.abs(ya[i]), Math.abs(yb ? yb[i] : 0), threshold[i]));
    return m;
  };

  // Initial step size, from y'(t0).
  let hmin = 16 * epsOf(t);
  let absh;
  if (htry === null) {
    absh = Math.min(hmax, htspan);
    const rh = wtNorm(f0, y) / (0.8 * rtol ** pow);
    if (absh * rh > 1) absh = 1 / rh;
    absh = Math.max(absh, hmin);
  } else {
    if (!(htry > 0)) throw new MatlabError(`${fname}: InitialStep must be positive`);
    absh = Math.min(hmax, Math.max(hmin, htry));
  }

  let done = false;
  while (!done) {
    hmin = 16 * epsOf(t);
    absh = Math.min(hmax, Math.max(hmin, absh));
    let h = tdir * absh;
    // Stretch the step if within 10% of tfinal - t.
    if (1.1 * absh >= Math.abs(tfinal - t)) { h = tfinal - t; absh = Math.abs(h); done = true; }

    let nofailed = true, tnew, ynew, err, k;
    let J = null, dfdt = null;
    for (;;) {
      if (rosenbrock) {
        if (!J) {
          J = jacobian(t, y, f0);
          const dt = Math.sqrt(epsOf(1)) * Math.max(Math.abs(t), Math.abs(h));
          const ft = f(t + tdir * dt, y);
          dfdt = ft.map((v, i) => (v - f0[i]) / (tdir * dt));
        }
        const W = J.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) - h * ROS_D * v));
        const T = dfdt.map(v => h * ROS_D * v);
        const k1 = solveLinear(W, f0.map((v, i) => v + T[i]));
        const F1 = f(t + 0.5 * h, y.map((v, i) => v + 0.5 * h * k1[i]));
        const k2 = solveLinear(W, F1.map((v, i) => v - k1[i])).map((v, i) => v + k1[i]);
        tnew = done ? tfinal : t + h;
        h = tnew - t;
        ynew = y.map((v, i) => v + h * k2[i]);
        const F2 = f(tnew, ynew);
        const k3 = solveLinear(W, F2.map((v, i) => v - ROS_E32 * (k2[i] - F1[i]) - 2 * (k1[i] - f0[i]) + T[i]));
        err = (absh / 6) * wtNorm(k1.map((v, i) => v - 2 * k2[i] + k3[i]), y, ynew);
        k = [k1, k2, F2];
      } else {
        k = [f0];
        for (let s = 1; s < method.stages; s++) {
          const ys = y.slice();
          for (let j = 0; j < s; j++) {
            const b = method.B[j][s - 1];
            if (b !== 0) for (let i = 0; i < neq; i++) ys[i] += h * b * k[j][i];
          }
          if (s === method.stages - 1) {
            tnew = done ? tfinal : t + h * method.A[s - 1];
            h = tnew - t;
            ynew = ys;
          }
          k.push(f(s === method.stages - 1 ? tnew : t + h * method.A[s - 1], ys));
        }
        const fe = new Array(neq).fill(0);
        for (let j = 0; j < method.stages; j++) {
          const e = method.E[j];
          if (e !== 0) for (let i = 0; i < neq; i++) fe[i] += e * k[j][i];
        }
        err = absh * wtNorm(fe, y, ynew);
      }

      if (!(err <= rtol)) {
        nfailed++;
        if (absh <= hmin || Number.isNaN(err)) {
          ctx.interp.print(`Warning: Failure at t=${t.toExponential(6)}.  Unable to meet integration tolerances without reducing the step size below the smallest value allowed (${hmin.toExponential(6)}) at time t.\n`);
          done = true;
          tnew = null;
          break;
        }
        if (nofailed) { nofailed = false; absh = Math.max(hmin, absh * Math.max(failFactor, 0.8 * (rtol / err) ** pow)); }
        else absh = Math.max(hmin, 0.5 * absh);
        h = tdir * absh;
        done = false;
        J = rosenbrock ? J : null; // the Jacobian stays valid for a retried step
      } else break;
    }
    if (tnew === null) break;
    nsteps++;

    // Output: every step for a solution struct; otherwise the step end
    // plus Refine-1 points inside it, or the tspan times it covers.
    const interp = (tq) => (rosenbrock ? rosInterp(y, h, k, (tq - t) / h) : rkInterp(method, y, h, k, (tq - t) / h));
    if (wantSol) {
      tout.push(tnew); yout.push(ynew);
      stepK.push(rosenbrock ? [k[0], k[1]] : k);
    } else if (tspan.length === 2) {
      for (let r = 1; r < refine; r++) { const tq = t + (tnew - t) * (r / refine); tout.push(tq); yout.push(interp(tq)); }
      tout.push(tnew); yout.push(ynew);
    } else {
      while (next < tspan.length && tdir * (tnew - tspan[next]) >= 0) {
        tout.push(tspan[next]);
        yout.push(tspan[next] === tnew ? ynew : interp(tspan[next]));
        next++;
      }
    }

    if (done) break;
    // Step size for the next step.
    if (nofailed) {
      const temp = 1.25 * (err / rtol) ** pow;
      absh = temp > 0.2 ? absh / temp : 5 * absh;
    }
    t = tnew; y = ynew;
    f0 = rosenbrock ? k[2] : k[method.stages - 1];
  }

  if (stats) {
    let text = `${nsteps} successful steps\n${nfailed} failed attempts\n${nfevals} function evaluations\n`;
    if (rosenbrock) text += `${npds} partial derivatives\n${nsteps + nfailed} LU decompositions\n${3 * (nsteps + nfailed)} solutions of linear systems\n`;
    ctx.interp.print(text);
  }

  const n = tout.length;
  if (wantSol) {
    const stages = stepK.length ? stepK[0].length : 0;
    const kvec = new Mat(neq * stages, stepK.length, new Float64Array(neq * stages * stepK.length));
    stepK.forEach((ks, s) => ks.forEach((kj, j) => kj.forEach((v, i) => { kvec.re[s * neq * stages + j * neq + i] = v; })));
    return [StructArray.scalar({
      solver: Mat.fromString(fname),
      x: new Mat(1, n, Float64Array.from(tout)),
      y: new Mat(neq, n, Float64Array.from(yout.flat())),
      stats: StructArray.scalar({ nsteps: Mat.scalar(nsteps), nfailed: Mat.scalar(nfailed), nfevals: Mat.scalar(nfevals) }),
      idata: StructArray.scalar({ kvec }),
    })];
  }
  const T = new Mat(n, 1, Float64Array.from(tout));
  const Y = new Mat(n, neq, new Float64Array(n * neq));
  yout.forEach((row, r) => row.forEach((v, c) => { Y.re[c * n + r] = v; }));
  if (nargout === 0) {
    // No outputs: plot the solution, as MATLAB's odeplot does.
    ctx.interp.builtins.get('plot').fn([T, Y, Mat.fromString('-o')], 0, ctx);
    return [];
  }
  return [T, Y];
}

const SOLVER_METHODS = { ode45: DOPRI, ode23: BS23, ode23s: 'rosenbrock', ode15s: 'rosenbrock' };

// deval(sol, xint) | deval(sol, xint, idx) | deval(xint, sol): the
// solution at xint from the solver's own interpolant.
function deval(args) {
  let sol, xint, idx = null;
  if (args[0] instanceof StructArray) [sol, xint, idx] = args;
  else [xint, sol, idx] = args;
  if (!(sol instanceof StructArray) || !sol.hasField('idata')) throw new MatlabError('deval: expected a solution structure from ode45, ode23, ode23s or ode15s');
  const name = sol.data[0].get('solver').toJSString();
  const method = SOLVER_METHODS[name];
  if (!method) throw new MatlabError(`deval: unsupported solver '${name}'`);
  const X = Array.from(sol.data[0].get('x').re);
  const Ym = sol.data[0].get('y');
  const neq = Ym.rows;
  const kvec = sol.data[0].get('idata').data[0].get('kvec');
  const stages = method === 'rosenbrock' ? 2 : method.stages;
  const tdir = Math.sign(X[X.length - 1] - X[0]) || 1;
  const rows = idx ? Array.from(idx.re).map(v => v - 1) : Array.from({ length: neq }, (_, i) => i);
  for (const r of rows) if (!(r >= 0 && r < neq && Number.isInteger(r))) throw new MatlabError('deval: idx must contain valid component indices');
  const xs = Array.from(xint.re);
  const out = new Mat(rows.length, xs.length, new Float64Array(rows.length * xs.length));
  xs.forEach((xq, q) => {
    if (tdir * (xq - X[0]) < 0 || tdir * (xq - X[X.length - 1]) > 0) {
      throw new MatlabError(`deval: attempting to evaluate the solution outside the interval [${Math.min(X[0], X[X.length - 1])}, ${Math.max(X[0], X[X.length - 1])}] where it is defined`);
    }
    let s = 0;
    while (s < X.length - 2 && tdir * (xq - X[s + 1]) > 0) s++;
    const y = Array.from({ length: neq }, (_, i) => Ym.re[s * neq + i]);
    const h = X[s + 1] - X[s];
    const k = Array.from({ length: stages }, (_, j) => Array.from({ length: neq }, (_, i) => kvec.re[s * neq * stages + j * neq + i]));
    const yq = xq === X[s + 1] ? Array.from({ length: neq }, (_, i) => Ym.re[(s + 1) * neq + i])
      : method === 'rosenbrock' ? rosInterp(y, h, k, (xq - X[s]) / h) : rkInterp(method, y, h, k, (xq - X[s]) / h);
    rows.forEach((r, i) => { out.re[q * rows.length + i] = yq[r]; });
  });
  return [out];
}

export function registerOde(reg) {
  for (const [name, method] of Object.entries(SOLVER_METHODS)) {
    reg.set(name, { fn: (args, nargout, ctx) => solveOde(name, method, args, nargout, ctx) });
  }
  reg.set('odeset', { fn: optionsSetter('odeset', ODE_FIELDS) });
  reg.set('odeget', { fn: optionsGetter('odeget') });
  reg.set('deval', {
    fn: (args, nargout) => {
      if (args.length < 2) throw new MatlabError('deval: expected deval(sol, xint)');
      if (nargout > 1) throw new MatlabError('deval: the derivative output is not supported');
      return deval(args);
    },
  });
}
