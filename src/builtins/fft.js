// fft.js — FFT/IFFT (and fft2/ifft2, fftshift/ifftshift), delegated to math.js (confirmed working for both
// power-of-two and arbitrary lengths during development).
//
// fft(X) transforms a vector, or each column of a matrix; fft(X, n) pads
// with zeros or truncates to length n first; fft(X, n, dim) / fft(X, [], dim)
// work along a chosen dimension. ifft takes the same arguments.

import * as math from 'mathjs';
import { Mat, MatlabError } from '../core/values.js';

function transform(args, fname, kernel) {
  const a = args[0];
  if (!(a instanceof Mat)) throw new MatlabError(`${fname}: input must be numeric`);
  let n = null;
  if (args.length >= 2 && !args[1].isEmpty) {
    n = Math.round(args[1].toScalarNumber());
    if (!(n >= 1)) throw new MatlabError(`${fname}: N must be a positive integer`);
  }
  let dim;
  if (args.length >= 3) dim = Math.round(args[2].toScalarNumber());
  else dim = a.rows !== 1 ? 1 : 2;
  if (dim !== 1 && dim !== 2) throw new MatlabError(`${fname}: dimension must be 1 or 2`);
  if (a.isEmpty && n === null) return a;

  const len = dim === 1 ? a.rows : a.cols;
  const outLen = n === null ? len : n;
  const lines = dim === 1 ? a.cols : a.rows;
  const outRows = dim === 1 ? outLen : a.rows, outCols = dim === 1 ? a.cols : outLen;
  const re = new Float64Array(outRows * outCols), im = new Float64Array(outRows * outCols);
  let anyIm = false;
  for (let l = 0; l < lines; l++) {
    const src = (k) => (dim === 1 ? l * a.rows + k : k * a.rows + l);
    const dst = (k) => (dim === 1 ? l * outRows + k : k * outRows + l);
    const input = [];
    for (let k = 0; k < outLen; k++) {
      input.push(k < len ? math.complex(a.re[src(k)], a.isComplex ? a.im[src(k)] : 0) : math.complex(0, 0));
    }
    const result = kernel(input);
    result.forEach((v, k) => { re[dst(k)] = v.re; im[dst(k)] = v.im; if (v.im !== 0) anyIm = true; });
  }
  return new Mat(outRows, outCols, re, anyIm ? im : null);
}

// Circular shift of x by k along dim (1 or 2), for fftshift/ifftshift.
function shiftAlong(x, dim, k) {
  const m = x.rows, n = x.cols;
  const len = dim === 1 ? m : n;
  if (len === 0) return x;
  const s = ((k % len) + len) % len;
  const out = new Mat(m, n, new Float64Array(x.numel), x.im ? new Float64Array(x.numel) : null, { isChar: x.isChar, isLogical: x.isLogical });
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < m; r++) {
      const dst = dim === 1 ? c * m + (r + s) % m : ((c + s) % n) * m + r;
      out.re[dst] = x.re[c * m + r];
      if (out.im) out.im[dst] = x.im[c * m + r];
    }
  }
  return out;
}
// fftshift(X) | fftshift(X, dim): move the zero-frequency term to the
// middle (both dimensions of a matrix); ifftshift undoes it.
function centerShift(args, inverse) {
  const x = args[0];
  if (!(x instanceof Mat)) throw new MatlabError(`${inverse ? 'ifftshift' : 'fftshift'}: input must be numeric`);
  const amount = (len) => (inverse ? -Math.floor(len / 2) : Math.floor(len / 2));
  if (args.length >= 2) {
    const d = Math.round(args[1].toScalarNumber());
    if (d >= 3) return x;
    return shiftAlong(x, d, amount(d === 1 ? x.rows : x.cols));
  }
  if (x.rows === 1 || x.cols === 1) {
    const d = x.rows === 1 ? 2 : 1;
    return shiftAlong(x, d, amount(x.numel));
  }
  return shiftAlong(shiftAlong(x, 1, amount(x.rows)), 2, amount(x.cols));
}

export function registerFFT(reg) {
  reg.set('fft', { fn: (args) => [transform(args, 'fft', (x) => math.fft(x))] });
  reg.set('ifft', { fn: (args) => [transform(args, 'ifft', (x) => math.ifft(x))] });
  // fft2(X) | fft2(X, m, n): fft down the columns, then along the rows.
  const twoD = (fname, kernel) => ({
    fn: (args) => {
      const x = args[0];
      const m = args.length >= 3 ? args[1] : Mat.empty(), n = args.length >= 3 ? args[2] : Mat.empty();
      if (args.length === 2) throw new MatlabError(`${fname}: expected ${fname}(X) or ${fname}(X, m, n)`);
      if (x.isEmpty) return [x];
      const cols = transform([x, m, Mat.scalar(1)], fname, kernel);
      return [transform([cols, n, Mat.scalar(2)], fname, kernel)];
    },
  });
  reg.set('fft2', twoD('fft2', (x) => math.fft(x)));
  reg.set('ifft2', twoD('ifft2', (x) => math.ifft(x)));
  reg.set('fftshift', { fn: (args) => [centerShift(args, false)] });
  reg.set('ifftshift', { fn: (args) => [centerShift(args, true)] });
}
