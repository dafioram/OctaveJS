// elementwise.js — Elementwise math builtins. Where real MATLAB auto-
// promotes to a complex result (sqrt(-1), log(-1), asin(2), ...), we do
// the same by implementing these generically over the complex domain.

import { Mat, MatlabError, argCountError } from '../core/values.js';
import * as C from '../core/cmath.js';

// fn works over the complex domain; realFn, when given, handles real
// input inside its real domain (returning undefined outside it), which is
// both exact and right at the extremes (atan(Inf) = pi/2, tanh(Inf) = 1).
function unary(fn, realFn = null) {
  const f = realFn ? (r, i) => {
    if (i === 0) { const v = realFn(r); if (v !== undefined) return [v, 0]; }
    return fn(r, i);
  } : fn;
  return (args) => {
    if (args.length !== 1) throw argCountError(args.length, 1);
    return [Mat.mapElementwise(args[0], f)];
  };
}
const inUnit = (fn) => (r) => (!(Math.abs(r) > 1) ? fn(r) : undefined); // |r| <= 1, or NaN
const nonNegative = (fn) => (r) => (!(r < 0) ? fn(r) : undefined); // r >= 0, or NaN
function unaryRealOut(fn) {
  return (args) => {
    if (args.length !== 1) throw argCountError(args.length, 1);
    return [Mat.mapElementwise(args[0], (r, i) => [fn(r, i), 0])];
  };
}
function binaryReal(fn) {
  return (args) => {
    if (args.length !== 2) throw argCountError(args.length, 2);
    return [Mat.broadcastBinary(args[0], args[1], (ar, _ai, br, _bi) => [fn(ar, br), 0])];
  };
}

function csinh(r, i) { const [er, ei] = C.cexp(r, i); const [nr, ni] = C.cexp(-r, -i); return [(er - nr) / 2, (ei - ni) / 2]; }
function ccosh(r, i) { const [er, ei] = C.cexp(r, i); const [nr, ni] = C.cexp(-r, -i); return [(er + nr) / 2, (ei + ni) / 2]; }
function ctanh(r, i) { const [sr, si] = csinh(r, i); const [cr, ci] = ccosh(r, i); return C.cdiv(sr, si, cr, ci); }

// asin(z) = -i * log(iz + sqrt(1 - z^2))
function casin(r, i) {
  const z2 = C.cmul(r, i, r, i);
  const oneMinusZ2 = [1 - z2[0], -z2[1]];
  const sq = C.csqrt(oneMinusZ2[0], oneMinusZ2[1]);
  const iz = [-i, r]; // i*z
  const inner = [iz[0] + sq[0], iz[1] + sq[1]];
  const lg = C.clog(inner[0], inner[1]);
  return [lg[1], -lg[0]]; // -i * lg
}
// acos(z) = -i * log(z + i*sqrt(1 - z^2))
function cacos(r, i) {
  const z2 = C.cmul(r, i, r, i);
  const oneMinusZ2 = [1 - z2[0], -z2[1]];
  const sq = C.csqrt(oneMinusZ2[0], oneMinusZ2[1]);
  const iSq = [-sq[1], sq[0]];
  const inner = [r + iSq[0], i + iSq[1]];
  const lg = C.clog(inner[0], inner[1]);
  return [lg[1], -lg[0]];
}
// atan(z) = (i/2) * log((i+z)/(i-z))
function catan(r, i) {
  const num = [r, i + 1];
  const den = [-r, 1 - i];
  const q = C.cdiv(num[0], num[1], den[0], den[1]);
  const lg = C.clog(q[0], q[1]);
  return [-lg[1] / 2, lg[0] / 2];
}

export function registerElementwise(reg) {
  reg.set('sin', { fn: unary(C.csin) });
  reg.set('cos', { fn: unary(C.ccos) });
  reg.set('tan', { fn: unary(C.ctan) });
  reg.set('asin', { fn: unary(casin, inUnit(Math.asin)) });
  reg.set('acos', { fn: unary(cacos, inUnit(Math.acos)) });
  reg.set('atan', { fn: unary(catan, Math.atan) });
  reg.set('atan2', { fn: binaryReal((y, x) => Math.atan2(y, x)) });
  reg.set('sinh', { fn: unary(csinh, Math.sinh) });
  reg.set('cosh', { fn: unary(ccosh, Math.cosh) });
  reg.set('tanh', { fn: unary(ctanh, Math.tanh) });
  reg.set('exp', { fn: unary(C.cexp) });
  reg.set('log', { fn: unary(C.clog) });
  reg.set('log10', { fn: unary((r, i) => { const [lr, li] = C.clog(r, i); return [lr / Math.LN10, li / Math.LN10]; }, nonNegative(Math.log10)) });
  const log2Values = unary((r, i) => { const [lr, li] = C.clog(r, i); return [lr / Math.LN2, li / Math.LN2]; }, nonNegative(Math.log2));
  // log2(X) | [F, E] = log2(X): X = F.*2.^E with 0.5 <= abs(F) < 1 (F = X,
  // E = 0 for 0, Inf and NaN), from the real part as MATLAB does.
  reg.set('log2', {
    fn: (args, nargout) => {
      if (nargout < 2) return log2Values(args);
      if (args.length !== 1) throw argCountError(args.length, 1);
      const x = args[0];
      const F = new Mat(x.rows, x.cols, new Float64Array(x.numel)), E = new Mat(x.rows, x.cols, new Float64Array(x.numel));
      for (let k = 0; k < x.numel; k++) {
        const v = x.re[k];
        if (v === 0 || !Number.isFinite(v)) { F.re[k] = v; continue; }
        let e = Math.floor(Math.log2(Math.abs(v))) + 1;
        let f = v / 2 ** e;
        // Correct for rounding in log2 near powers of two.
        if (Math.abs(f) >= 1) { f /= 2; e++; } else if (Math.abs(f) < 0.5) { f *= 2; e--; }
        F.re[k] = f; E.re[k] = e;
      }
      return [F, E];
    },
  });
  reg.set('sqrt', { fn: unary(C.csqrt) });
  reg.set('abs', { fn: unaryRealOut(C.cabs) });
  reg.set('angle', { fn: unaryRealOut(C.cangle) });
  reg.set('real', { fn: unaryRealOut((r) => r) });
  reg.set('imag', { fn: unaryRealOut((_r, i) => i) });
  reg.set('conj', { fn: unary(C.cconj) });
  // complex(a) | complex(a, b): a + b*1i from real parts, kept complex even
  // when the imaginary part is zero (so isreal(complex(1)) is false), and
  // without the NaN/Inf mixing of a + b*1i (complex(1, NaN) is 1 + NaNi).
  reg.set('complex', {
    fn: (args) => {
      if (args.length < 1 || args.length > 2) throw new MatlabError('complex: expected complex(a) or complex(a, b)');
      const [a, b] = args;
      for (const v of args) {
        if (!(v instanceof Mat) || v.isChar) throw new MatlabError('complex: inputs must be numeric');
        if (v.isComplex && v.im.some(x => x !== 0)) throw new MatlabError('complex: inputs must be real');
      }
      const out = b ? Mat.broadcastBinary(a, b, (ar, _ai, br) => [ar, 0]) : new Mat(a.rows, a.cols, Float64Array.from(a.re));
      out.im = b ? Mat.broadcastBinary(a, b, (_ar, _ai, br) => [br, 0]).re : new Float64Array(a.numel);
      out.isLogical = false;
      return [out];
    },
  });
  reg.set('sign', { fn: unary((r, i) => { if (r === 0 && i === 0) return [0, 0]; const m = Math.hypot(r, i); return [r / m, i / m]; }, Math.sign) });
  reg.set('floor', { fn: unary((r, i) => [Math.floor(r), Math.floor(i)]) });
  reg.set('ceil', { fn: unary((r, i) => [Math.ceil(r), Math.ceil(i)]) });
  // MATLAB rounds halves away from zero (round(-2.5) = -3); JS Math.round
  // rounds them toward +Inf, so round the magnitude and restore the sign.
  const roundHalfAway = (x) => Math.sign(x) * Math.round(Math.abs(x));
  reg.set('round', { fn: unary((r, i) => [roundHalfAway(r), roundHalfAway(i)]) });
  reg.set('fix', { fn: unary((r, i) => [Math.trunc(r), Math.trunc(i)]) });
  reg.set('mod', { fn: binaryReal((a, b) => { if (b === 0) return a; const r = a - Math.floor(a / b) * b; return r; }) });
  reg.set('rem', { fn: binaryReal((a, b) => { if (b === 0) return NaN; const r = a - Math.trunc(a / b) * b; return r; }) });
  reg.set('power', { fn: (args) => [Mat.broadcastBinary(args[0], args[1], C.cpow)] });
  // hypot of complex values uses their magnitudes.
  reg.set('hypot', {
    fn: (args) => {
      if (args.length !== 2) throw argCountError(args.length, 2);
      return [Mat.broadcastBinary(args[0], args[1], (ar, ai, br, bi) => [Math.hypot(ar, ai, br, bi), 0])];
    },
  });
  registerMoreElementary(reg);
}

// ---------------- more elementary functions ----------------

const recip = ([r, i]) => C.cdiv(1, 0, r, i);
// Inverse hyperbolic functions over the complex plane, with MATLAB's branches.
function casinh(r, i) { // log(z + sqrt(z^2 + 1))
  const [zr, zi] = C.cmul(r, i, r, i);
  const [sr, si] = C.csqrt(zr + 1, zi);
  return C.clog(r + sr, i + si);
}
function cacosh(r, i) { // log(z + sqrt(z + 1) * sqrt(z - 1))
  const [ar, ai] = C.csqrt(r + 1, i), [br, bi] = C.csqrt(r - 1, i);
  const [pr, pi] = C.cmul(ar, ai, br, bi);
  return C.clog(r + pr, i + pi);
}
function catanh(r, i) { // log((1 + z) / (1 - z)) / 2
  // Real x outside [-1, 1] (and +-Inf), as MATLAB: the imaginary part
  // takes the sign of x.
  if (i === 0 && Math.abs(r) > 1) {
    const re = r === Infinity || r === -Infinity ? 0 : Math.atanh(1 / r);
    return [re, Math.sign(r) * Math.PI / 2];
  }
  const [qr, qi] = C.cdiv(1 + r, i, 1 - r, -i);
  const [lr, li] = C.clog(qr, qi);
  return [lr / 2, li / 2];
}

const DEG = Math.PI / 180;
// MATLAB's sind/cosd/tand reduce the angle by multiples of 90 degrees
// first, so sind(180) is exactly 0, cosd(90) is exactly 0 and
// tand(90) is Inf.
function quadrant(x) {
  const n = Math.round(x / 90);
  return { n: ((n % 4) + 4) % 4, rad: (x - n * 90) * DEG };
}
function sind(x) {
  if (!Number.isFinite(x)) return NaN;
  const { n, rad } = quadrant(x);
  return [Math.sin(rad), Math.cos(rad), -Math.sin(rad), -Math.cos(rad)][n];
}
function cosd(x) {
  if (!Number.isFinite(x)) return NaN;
  const { n, rad } = quadrant(x);
  return [Math.cos(rad), -Math.sin(rad), -Math.cos(rad), Math.sin(rad)][n];
}
function tand(x) {
  if (!Number.isFinite(x)) return NaN;
  const { n, rad } = quadrant(x);
  if (n % 2 === 0) return Math.tan(rad);
  if (rad === 0) return n === 1 ? Infinity : -Infinity;
  return -1 / Math.tan(rad);
}
// Degree versions of complex arguments: the radian function of z*pi/180.
const degIn = (f) => (r, i) => f(r * DEG, i * DEG);
const degOut = (f) => (r, i) => { const [a, b] = f(r, i); return [a / DEG, b / DEG]; };

function registerMoreElementary(reg) {
  const set = (name, fn, realFn) => reg.set(name, { fn: unary(fn, realFn) });
  // reciprocal trigonometric and hyperbolic functions
  set('sec', (r, i) => recip(C.ccos(r, i)), (x) => 1 / Math.cos(x));
  set('csc', (r, i) => recip(C.csin(r, i)), (x) => 1 / Math.sin(x));
  set('cot', (r, i) => recip(C.ctan(r, i)), (x) => 1 / Math.tan(x));
  set('asec', (r, i) => cacos(...recip([r, i])), (x) => (Math.abs(x) >= 1 || Number.isNaN(x) ? Math.acos(1 / x) : undefined));
  set('acsc', (r, i) => casin(...recip([r, i])), (x) => (Math.abs(x) >= 1 || Number.isNaN(x) ? Math.asin(1 / x) : undefined));
  set('acot', (r, i) => catan(...recip([r, i])), (x) => Math.atan(1 / x));
  set('sech', (r, i) => recip(ccosh(r, i)), (x) => 1 / Math.cosh(x));
  set('csch', (r, i) => recip(csinh(r, i)), (x) => 1 / Math.sinh(x));
  set('coth', (r, i) => recip(ctanh(r, i)), (x) => 1 / Math.tanh(x));
  set('asinh', casinh, Math.asinh);
  set('acosh', cacosh, (x) => (x >= 1 || Number.isNaN(x) ? Math.acosh(x) : undefined));
  set('atanh', catanh, inUnit(Math.atanh));
  set('asech', (r, i) => cacosh(...recip([r, i])), (x) => (x > 0 && x <= 1) || Number.isNaN(x) ? Math.acosh(1 / x) : undefined);
  set('acsch', (r, i) => casinh(...recip([r, i])), (x) => Math.asinh(1 / x));
  set('acoth', (r, i) => (r === 0 && i === 0 ? [0, Math.PI / 2] : catanh(...recip([r, i]))), (x) => (Math.abs(x) >= 1 || Number.isNaN(x) ? Math.atanh(1 / x) : undefined));

  // degree-based trigonometry
  set('sind', degIn(C.csin), sind);
  set('cosd', degIn(C.ccos), cosd);
  set('tand', degIn(C.ctan), tand);
  set('secd', (r, i) => recip(degIn(C.ccos)(r, i)), (x) => 1 / cosd(x));
  set('cscd', (r, i) => recip(degIn(C.csin)(r, i)), (x) => 1 / sind(x));
  set('cotd', (r, i) => recip(degIn(C.ctan)(r, i)), (x) => 1 / tand(x));
  set('asind', degOut(casin), inUnit((x) => Math.asin(x) / DEG));
  set('acosd', degOut(cacos), inUnit((x) => Math.acos(x) / DEG));
  set('atand', degOut(catan), (x) => Math.atan(x) / DEG);
  set('asecd', degOut((r, i) => cacos(...recip([r, i]))), (x) => (Math.abs(x) >= 1 || Number.isNaN(x) ? Math.acos(1 / x) / DEG : undefined));
  set('acscd', degOut((r, i) => casin(...recip([r, i]))), (x) => (Math.abs(x) >= 1 || Number.isNaN(x) ? Math.asin(1 / x) / DEG : undefined));
  set('acotd', degOut((r, i) => catan(...recip([r, i]))), (x) => Math.atan(1 / x) / DEG);
  reg.set('atan2d', { fn: binaryReal((y, x) => Math.atan2(y, x) / DEG) });
  set('deg2rad', (r, i) => [r * DEG, i * DEG]);
  set('rad2deg', (r, i) => [r / DEG, i / DEG]);

  // exponentials and logarithms
  set('log1p', (r, i) => C.clog(1 + r, i), (x) => (x >= -1 || Number.isNaN(x) ? Math.log1p(x) : undefined));
  set('expm1', (r, i) => { const [er, ei] = C.cexp(r, i); return [er - 1, ei]; }, Math.expm1);
  // pow2(e) = 2.^e | pow2(f, e) = f .* 2.^e
  reg.set('pow2', {
    fn: (args) => {
      if (args.length === 1) return [Mat.broadcastBinary(Mat.scalar(2), args[0], C.cpow)];
      // pow2(F, E) = F .* 2.^E with E truncated to an integer (C's ldexp), as MATLAB.
      return [Mat.broadcastBinary(args[0], args[1], (fr, fi, er) => [fr * 2 ** Math.trunc(er), fi * 2 ** Math.trunc(er)])];
    },
  });
  // nextpow2(n): the smallest p with 2^p >= abs(n)
  reg.set('nextpow2', {
    fn: (args) => [Mat.mapElementwise(args[0], (r, i) => {
      const a = Math.hypot(r, i);
      if (a === 0) return [0, 0];
      if (!Number.isFinite(a)) return [a, 0];
      let p = Math.ceil(Math.log2(a));
      while (2 ** (p - 1) >= a) p--;
      while (2 ** p < a) p++;
      return [p, 0];
    })],
  });
  // nthroot(x, n): the real n-th root (negative x needs an odd n).
  reg.set('nthroot', {
    fn: (args) => {
      if (args.length !== 2) throw new MatlabError('nthroot: expected nthroot(x, n)');
      for (const v of args) if (v.isComplex && v.im.some(z => z !== 0)) throw new MatlabError('nthroot: both inputs must be real');
      return [Mat.broadcastBinary(args[0], args[1], (x, _xi, n) => {
        if (x < 0 && !(Number.isInteger(n) && Math.abs(n % 2) === 1)) throw new MatlabError('nthroot: if x is negative, n must be an odd integer');
        if (x === 0 || !Number.isFinite(x) || !Number.isFinite(n)) {
          if (Number.isNaN(x) || Number.isNaN(n)) return [NaN, 0];
          return [Math.sign(x) * Math.abs(x) ** (1 / n), 0];
        }
        let y = Math.sign(x) * Math.abs(x) ** (1 / n);
        // One Newton step makes exact roots exact (nthroot(27, 3) = 3), as MATLAB does.
        const yn1 = y ** (n - 1);
        if (Number.isFinite(yn1) && yn1 !== 0) y -= (y * yn1 - x) / (n * yn1);
        return [y, 0];
      })];
    },
  });
  // realsqrt / reallog / realpow: error instead of returning complex results.
  const realOnly = (name, fn) => reg.set(name, {
    fn: (args) => {
      const out = fn(args);
      if (out.isComplex && out.im.some(z => z !== 0)) throw new MatlabError(`${name} produced complex result.`);
      out.im = null;
      return [out];
    },
  });
  realOnly('realsqrt', (args) => Mat.mapElementwise(args[0], C.csqrt));
  realOnly('reallog', (args) => Mat.mapElementwise(args[0], C.clog));
  realOnly('realpow', (args) => Mat.broadcastBinary(args[0], args[1], C.cpow));
}
