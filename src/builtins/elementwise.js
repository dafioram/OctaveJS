// elementwise.js — Elementwise math builtins. Where real MATLAB auto-
// promotes to a complex result (sqrt(-1), log(-1), asin(2), ...), we do
// the same by implementing these generically over the complex domain.

import { Mat, MatlabError } from '../core/values.js';
import * as C from '../core/cmath.js';

function unary(fn) {
  return (args) => {
    if (args.length !== 1) throw new MatlabError('Expected exactly 1 argument');
    return [Mat.mapElementwise(args[0], fn)];
  };
}
function unaryRealOut(fn) {
  return (args) => {
    if (args.length !== 1) throw new MatlabError('Expected exactly 1 argument');
    return [Mat.mapElementwise(args[0], (r, i) => [fn(r, i), 0])];
  };
}
function binaryReal(fn) {
  return (args) => {
    if (args.length !== 2) throw new MatlabError('Expected exactly 2 arguments');
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
  reg.set('asin', { fn: unary(casin) });
  reg.set('acos', { fn: unary(cacos) });
  reg.set('atan', { fn: unary(catan) });
  reg.set('atan2', { fn: binaryReal((y, x) => Math.atan2(y, x)) });
  reg.set('sinh', { fn: unary(csinh) });
  reg.set('cosh', { fn: unary(ccosh) });
  reg.set('tanh', { fn: unary(ctanh) });
  reg.set('exp', { fn: unary(C.cexp) });
  reg.set('log', { fn: unary(C.clog) });
  reg.set('log10', { fn: unary((r, i) => { const [lr, li] = C.clog(r, i); return [lr / Math.LN10, li / Math.LN10]; }) });
  reg.set('log2', { fn: unary((r, i) => { const [lr, li] = C.clog(r, i); return [lr / Math.LN2, li / Math.LN2]; }) });
  reg.set('sqrt', { fn: unary(C.csqrt) });
  reg.set('abs', { fn: unaryRealOut(C.cabs) });
  reg.set('angle', { fn: unaryRealOut(C.cangle) });
  reg.set('arg', { fn: unaryRealOut(C.cangle) });
  reg.set('real', { fn: unaryRealOut((r) => r) });
  reg.set('imag', { fn: unaryRealOut((_r, i) => i) });
  reg.set('conj', { fn: unary(C.cconj) });
  reg.set('sign', { fn: unary((r, i) => { if (r === 0 && i === 0) return [0, 0]; const m = Math.hypot(r, i); return [r / m, i / m]; }) });
  reg.set('floor', { fn: unary((r, i) => [Math.floor(r), Math.floor(i)]) });
  reg.set('ceil', { fn: unary((r, i) => [Math.ceil(r), Math.ceil(i)]) });
  reg.set('round', { fn: unary((r, i) => [Math.round(r), Math.round(i)]) });
  reg.set('fix', { fn: unary((r, i) => [Math.trunc(r), Math.trunc(i)]) });
  reg.set('mod', { fn: binaryReal((a, b) => { if (b === 0) return a; const r = a - Math.floor(a / b) * b; return r; }) });
  reg.set('rem', { fn: binaryReal((a, b) => { if (b === 0) return NaN; const r = a - Math.trunc(a / b) * b; return r; }) });
  reg.set('power', { fn: (args) => [Mat.broadcastBinary(args[0], args[1], C.cpow)] });
  reg.set('hypot', { fn: binaryReal((a, b) => Math.hypot(a, b)) });
}
