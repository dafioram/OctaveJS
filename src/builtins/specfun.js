// specfun.js — Special functions: erf, erfc, erfinv, erfcinv, erfcx,
// gamma, gammaln, gammainc, beta, betaln, betainc, psi. Real arguments
// only (as for most of these in MATLAB), to near double precision.

import { Mat, MatlabError } from '../core/values.js';

const SQRT_PI = Math.sqrt(Math.PI);

// ---- error function ----
// |x| < 2: the series erf(x) = 2/sqrt(pi) * exp(-x^2) * sum 2^n x^(2n+1) / (1*3*...*(2n+1)),
// whose terms are all positive (no cancellation). Larger |x|: erfc by
// its continued fraction (modified Lentz).
function erfSeries(x) {
  const x2 = x * x;
  let term = x, sum = x;
  for (let n = 1; n < 200; n++) {
    term *= (2 * x2) / (2 * n + 1);
    sum += term;
    if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
  }
  return (2 / SQRT_PI) * Math.exp(-x2) * sum;
}
// erfc(x) * exp(x^2) for x >= 2, by the continued fraction
// sqrt(pi) e^{x^2} erfc(x) = 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + 2/(x + ...))))).
function erfcxCF(x) {
  const tiny = 1e-300;
  let f = x, C = x, D = 0;
  for (let n = 1; n < 500; n++) {
    const a = n / 2;
    D = x + a * D; D = Math.abs(D) < tiny ? tiny : D; D = 1 / D;
    C = x + a / C; C = Math.abs(C) < tiny ? tiny : C;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 / (f * SQRT_PI);
}
export function erf(x) {
  if (Number.isNaN(x)) return NaN;
  if (Math.abs(x) < 2) return erfSeries(x);
  const c = erfc(Math.abs(x));
  return x > 0 ? 1 - c : c - 1;
}
export function erfc(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 2) {
    if (x > -2) return 1 - erfSeries(x);
    return 2 - erfc(-x);
  }
  if (x > 27) return 0;
  return Math.exp(-x * x) * erfcxCF(x);
}
// erfcx(x) = exp(x^2) * erfc(x), without overflow for large x.
function erfcx(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return 0;
  if (x >= 2) return erfcxCF(x);
  if (x < -26.6) return Infinity;
  return Math.exp(x * x) * erfc(x);
}
// erfinv: Giles' single-precision approximation, then Newton steps.
export function erfinv(y) {
  if (Number.isNaN(y) || y < -1 || y > 1) return NaN;
  if (y === 1) return Infinity;
  if (y === -1) return -Infinity;
  if (y === 0) return y;
  let w = -Math.log((1 - y) * (1 + y)), p;
  if (w < 5) {
    w -= 2.5;
    p = 2.81022636e-08;
    for (const c of [3.43273939e-07, -3.5233877e-06, -4.39150654e-06, 0.00021858087, -0.00125372503, -0.00417768164, 0.246640727, 1.50140941]) p = c + p * w;
  } else {
    w = Math.sqrt(w) - 3;
    p = -0.000200214257;
    for (const c of [0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773, -0.0076224613, 0.00943887047, 1.00167406, 2.83297682]) p = c + p * w;
  }
  let x = p * y;
  // Newton on erf(x) = y (via erfc in the tails, where it is more accurate).
  for (let k = 0; k < 3; k++) {
    const err = Math.abs(y) > 0.5 ? Math.sign(y) * ((1 - Math.abs(y)) - erfc(Math.abs(x))) : erf(x) - y;
    x -= err / ((2 / SQRT_PI) * Math.exp(-x * x));
  }
  return x;
}
export function erfcinv(z) {
  if (Number.isNaN(z) || z < 0 || z > 2) return NaN;
  if (z === 0) return Infinity;
  if (z === 2) return -Infinity;
  if (z > 0.5) return erfinv(1 - z);
  // Small z: start from erfinv(1 - z) (or an asymptotic guess) and refine on erfc.
  let x = z > 1e-15 ? erfinv(1 - z) : Math.sqrt(-Math.log(z * SQRT_PI * Math.sqrt(-Math.log(z))));
  if (!Number.isFinite(x)) x = Math.sqrt(-Math.log(z));
  for (let k = 0; k < 6; k++) {
    const fx = erfc(x) - z;
    x += fx / ((2 / SQRT_PI) * Math.exp(-x * x));
  }
  return x;
}

// ---- gamma family ----
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function gamma(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return NaN;
  if (Number.isInteger(x)) {
    if (x <= 0) return Infinity; // MATLAB: Inf at 0 and the negative integers
    if (x <= 171) { let f = 1; for (let k = 2; k < x; k++) f *= k; return f; }
    return Infinity;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  if (x > 171.62) return Infinity;
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let k = 1; k < 9; k++) a += LANCZOS[k] / (y + k);
  // t^(y+0.5) overflows for large x before e^-t brings it back: split it.
  const half = t ** ((y + 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * half * (half * Math.exp(-t)) * a;
}
export function gammaln(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) throw new MatlabError('gammaln: input must be nonnegative');
  if (x === 0 || x === Infinity) return Infinity;
  if (x === 1 || x === 2) return 0;
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - gammaln(1 - x);
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let k = 1; k < 9; k++) a += LANCZOS[k] / (y + k);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}
// psi (digamma): recurrence up to x >= 12, then the asymptotic series.
function psi(x) {
  if (Number.isNaN(x) || x === -Infinity) return NaN;
  if (x === Infinity) return Infinity;
  if (x <= 0 && Number.isInteger(x)) return -Infinity;
  if (x < 0) return psi(1 - x) - Math.PI / Math.tan(Math.PI * x);
  let r = 0;
  while (x < 12) { r -= 1 / x; x += 1; }
  const f = 1 / (x * x);
  return r + Math.log(x) - 0.5 / x - f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f * (1 / 240 - f * (1 / 132 - f * (691 / 32760 - f / 12))))));
}

// Regularized lower incomplete gamma P(a, x): series for x < a + 1,
// continued fraction for Q otherwise.
function gammaincPQ(x, a) {
  if (Number.isNaN(x) || Number.isNaN(a)) return [NaN, NaN];
  if (x <= 0) return [0, 1];
  if (a === 0) return [1, 0];
  if (x === Infinity) return [1, 0];
  const lnPre = a * Math.log(x) - x - gammaln(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 10000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    const P = sum * Math.exp(lnPre);
    return [P, 1 - P];
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  const Q = Math.exp(lnPre) * h;
  return [1 - Q, Q];
}

// Regularized incomplete beta I_x(a, b) by its continued fraction.
function betacf(x, a, b) {
  const tiny = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 10000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}
function betainc(x, a, b) {
  if ([x, a, b].some(Number.isNaN)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(lnFront) * betacf(x, a, b)) / a;
  return 1 - (Math.exp(lnFront) * betacf(1 - x, b, a)) / b;
}

// ---- builtins ----

function realOnly(v, fname) {
  if (!(v instanceof Mat) || v.isChar) throw new MatlabError(`${fname}: input must be numeric`);
  if (v.isComplex && v.im.some(z => z !== 0)) throw new MatlabError(`${fname}: input must be real`);
  return v;
}
const unaryReal = (fname, f) => ({
  fn: (args) => {
    if (args.length !== 1) throw new MatlabError(`${fname}: expected exactly 1 argument`);
    return [Mat.mapElementwise(realOnly(args[0], fname), (x) => [f(x), 0])];
  },
});
const binaryReal = (fname, f) => ({
  fn: (args) => {
    if (args.length !== 2) throw new MatlabError(`${fname}: expected exactly 2 arguments`);
    return [Mat.broadcastBinary(realOnly(args[0], fname), realOnly(args[1], fname), (x, _xi, y) => [f(x, y), 0])];
  },
});
// Elementwise over three arrays with implicit expansion (betainc).
function ternary(a, b, c, f) {
  const ab = Mat.broadcastBinary(a, b, (x, _i, y) => [x, 0]);
  const ba = Mat.broadcastBinary(a, b, (_x, _i, y) => [y, 0]);
  const xs = Mat.broadcastBinary(ab, c, (x) => [x, 0]);
  const ys = Mat.broadcastBinary(ba, c, (y) => [y, 0]);
  const zs = Mat.broadcastBinary(ab, c, (_x, _i, z) => [z, 0]);
  return new Mat(xs.rows, xs.cols, Float64Array.from(xs.re, (x, k) => f(x, ys.re[k], zs.re[k])));
}

export function registerSpecfun(reg) {
  reg.set('erf', unaryReal('erf', erf));
  reg.set('erfc', unaryReal('erfc', erfc));
  reg.set('erfcx', unaryReal('erfcx', erfcx));
  reg.set('erfinv', unaryReal('erfinv', erfinv));
  reg.set('erfcinv', unaryReal('erfcinv', erfcinv));
  reg.set('gamma', unaryReal('gamma', gamma));
  reg.set('gammaln', unaryReal('gammaln', gammaln));
  reg.set('psi', {
    fn: (args) => {
      if (args.length !== 1) throw new MatlabError('psi: only psi(x) (the digamma function) is supported');
      return [Mat.mapElementwise(realOnly(args[0], 'psi'), (x) => [psi(x), 0])];
    },
  });
  reg.set('beta', binaryReal('beta', (z, w) => {
    if (z < 0 || w < 0) return gamma(z) * gamma(w) / gamma(z + w);
    return Math.exp(gammaln(z) + gammaln(w) - gammaln(z + w));
  }));
  reg.set('betaln', binaryReal('betaln', (z, w) => {
    if (z < 0 || w < 0) throw new MatlabError('betaln: inputs must be nonnegative');
    return gammaln(z) + gammaln(w) - gammaln(z + w);
  }));
  // gammainc(x, a) | gammainc(x, a, 'upper'): regularized incomplete gamma (note MATLAB's argument order).
  reg.set('gammainc', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('gammainc: expected gammainc(x, a)');
      const tail = args[2] ? args[2].toJSString().toLowerCase() : 'lower';
      if (tail !== 'lower' && tail !== 'upper') throw new MatlabError("gammainc: the tail must be 'lower' or 'upper'");
      return [Mat.broadcastBinary(realOnly(args[0], 'gammainc'), realOnly(args[1], 'gammainc'), (x, _i, a) => {
        if (a < 0) throw new MatlabError('gammainc: a must be nonnegative');
        if (x < 0) throw new MatlabError('gammainc: x must be nonnegative');
        return [gammaincPQ(x, a)[tail === 'lower' ? 0 : 1], 0];
      })];
    },
  });
  // betainc(x, a, b) | betainc(x, a, b, 'upper'): regularized incomplete beta.
  reg.set('betainc', {
    fn: (args) => {
      if (args.length < 3) throw new MatlabError('betainc: expected betainc(x, a, b)');
      const tail = args[3] ? args[3].toJSString().toLowerCase() : 'lower';
      if (tail !== 'lower' && tail !== 'upper') throw new MatlabError("betainc: the tail must be 'lower' or 'upper'");
      const [x, a, b] = args.slice(0, 3).map(v => realOnly(v, 'betainc'));
      return [ternary(x, a, b, (xv, av, bv) => {
        if (xv < 0 || xv > 1) throw new MatlabError('betainc: x must be in the interval [0, 1]');
        if (av < 0 || bv < 0) throw new MatlabError('betainc: a and b must be nonnegative');
        return tail === 'lower' ? betainc(xv, av, bv) : betainc(1 - xv, bv, av);
      })];
    },
  });
}
