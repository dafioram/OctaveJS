// cmath.js — Scalar complex arithmetic on plain (re, im) pairs, returned as
// [re, im] tuples. Used by the elementwise operator/function evaluators so
// the whole interpreter can stay agnostic about real-vs-complex: every
// binary op and every math function is written once, generically.

export function cadd(ar, ai, br, bi) { return [ar + br, ai + bi]; }
export function csub(ar, ai, br, bi) { return [ar - br, ai - bi]; }
// Real operands take the plain real operation: the complex formulas
// would turn 1/0 or 0*NaN into a NaN imaginary part (Inf + NaNi).
export function cmul(ar, ai, br, bi) {
  if (ai === 0 && bi === 0) return [ar * br, 0];
  return [ar * br - ai * bi, ar * bi + ai * br];
}
export function cdiv(ar, ai, br, bi) {
  if (ai === 0 && bi === 0) return [ar / br, 0];
  const d = br * br + bi * bi;
  if (d === 0) {
    if (ar === 0 && ai === 0) return [NaN, NaN];
    return [ar / 0, ai / 0]; // yields +-Infinity / NaN like IEEE division
  }
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
}
export function cneg(ar, ai) { return [-ar, -ai]; }
export function cconj(ar, ai) { return [ar, -ai]; }
export function cabs(ar, ai) { return Math.hypot(ar, ai); }
export function cangle(ar, ai) { return Math.atan2(ai, ar); }

export function cexp(ar, ai) {
  if (ai === 0) return [Math.exp(ar), 0];
  const e = Math.exp(ar);
  return [e * Math.cos(ai), e * Math.sin(ai)];
}
export function clog(ar, ai) {
  if (ai === 0 && !(ar < 0)) return [Math.log(ar), 0]; // includes NaN
  return [Math.log(Math.hypot(ar, ai)), Math.atan2(ai, ar)];
}
export function csqrt(ar, ai) {
  if (ai === 0 && !(ar < 0)) return [Math.sqrt(ar), 0]; // includes NaN
  if (ai === 0) return [0, Math.sqrt(-ar)]; // negative real: purely imaginary (sqrt(-Inf) = 0 + Infi)
  const r = Math.hypot(ar, ai);
  const re = Math.sqrt((r + ar) / 2);
  const im = Math.sign(ai || 1) * Math.sqrt((r - ar) / 2);
  return [re, im];
}
export function cpow(ar, ai, br, bi) {
  if (Number.isNaN(ar) || Number.isNaN(ai)) return [NaN, ai === 0 && bi === 0 ? 0 : NaN]; // NaN^0 is NaN in MATLAB
  if (ar === 0 && ai === 0) {
    if (br === 0 && bi === 0) return [1, 0];
    return [0, 0];
  }
  // Fast, exact path for the common real^real case (avoids floating-point
  // drift from routing everything through exp(b*log(a))); MATLAB still
  // promotes to complex for a negative real base with a non-integer
  // exponent, so only take this path when the result is genuinely real.
  if (ai === 0 && bi === 0 && (!(ar < 0) || Number.isInteger(br) || Number.isNaN(br))) {
    return [Math.pow(ar, br), 0];
  }
  // A complex base with a real integer exponent: repeated multiplication,
  // as MATLAB does, so 1i^2 is exactly -1.
  if (bi === 0 && Number.isInteger(br) && Math.abs(br) <= 1024) {
    let rr = 1, ri = 0, xr = ar, xi = ai;
    for (let e = Math.abs(br); e > 0; e >>= 1) {
      if (e & 1) [rr, ri] = cmul(rr, ri, xr, xi);
      [xr, xi] = cmul(xr, xi, xr, xi);
    }
    return br < 0 ? cdiv(1, 0, rr, ri) : [rr, ri];
  }
  // a^b = exp(b * log(a))
  const [lr, li] = clog(ar, ai);
  const [er, ei] = cmul(br, bi, lr, li);
  return cexp(er, ei);
}
export function csin(ar, ai) {
  if (ai === 0) return [Math.sin(ar), 0];
  return [Math.sin(ar) * Math.cosh(ai), Math.cos(ar) * Math.sinh(ai)];
}
export function ccos(ar, ai) {
  if (ai === 0) return [Math.cos(ar), 0];
  return [Math.cos(ar) * Math.cosh(ai), -Math.sin(ar) * Math.sinh(ai)];
}
export function ctan(ar, ai) {
  if (ai === 0) return [Math.tan(ar), 0];
  const [sr, si] = csin(ar, ai);
  const [cr, ci] = ccos(ar, ai);
  return cdiv(sr, si, cr, ci);
}
export function isReal(im) { return im === 0; }
