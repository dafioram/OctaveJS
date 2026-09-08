// cmath.js — Scalar complex arithmetic on plain (re, im) pairs, returned as
// [re, im] tuples. Used by the elementwise operator/function evaluators so
// the whole interpreter can stay agnostic about real-vs-complex: every
// binary op and every math function is written once, generically.

export function cadd(ar, ai, br, bi) { return [ar + br, ai + bi]; }
export function csub(ar, ai, br, bi) { return [ar - br, ai - bi]; }
export function cmul(ar, ai, br, bi) { return [ar * br - ai * bi, ar * bi + ai * br]; }
export function cdiv(ar, ai, br, bi) {
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
  const e = Math.exp(ar);
  return [e * Math.cos(ai), e * Math.sin(ai)];
}
export function clog(ar, ai) {
  return [Math.log(Math.hypot(ar, ai)), Math.atan2(ai, ar)];
}
export function csqrt(ar, ai) {
  if (ai === 0 && ar >= 0) return [Math.sqrt(ar), 0];
  const r = Math.hypot(ar, ai);
  const re = Math.sqrt((r + ar) / 2);
  const im = Math.sign(ai || 1) * Math.sqrt((r - ar) / 2);
  return [re, im];
}
export function cpow(ar, ai, br, bi) {
  if (ar === 0 && ai === 0) {
    if (br === 0 && bi === 0) return [1, 0];
    return [0, 0];
  }
  // Fast, exact path for the common real^real case (avoids floating-point
  // drift from routing everything through exp(b*log(a))); MATLAB still
  // promotes to complex for a negative real base with a non-integer
  // exponent, so only take this path when the result is genuinely real.
  if (ai === 0 && bi === 0 && (ar >= 0 || Number.isInteger(br))) {
    return [Math.pow(ar, br), 0];
  }
  // a^b = exp(b * log(a))
  const [lr, li] = clog(ar, ai);
  const [er, ei] = cmul(br, bi, lr, li);
  return cexp(er, ei);
}
export function csin(ar, ai) {
  return [Math.sin(ar) * Math.cosh(ai), Math.cos(ar) * Math.sinh(ai)];
}
export function ccos(ar, ai) {
  return [Math.cos(ar) * Math.cosh(ai), -Math.sin(ar) * Math.sinh(ai)];
}
export function ctan(ar, ai) {
  const [sr, si] = csin(ar, ai);
  const [cr, ci] = ccos(ar, ai);
  return cdiv(sr, si, cr, ci);
}
export function isReal(im) { return im === 0; }
