// fft.js — FFT/IFFT, delegated to math.js (confirmed working for both
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

export function registerFFT(reg) {
  reg.set('fft', { fn: (args) => [transform(args, 'fft', (x) => math.fft(x))] });
  reg.set('ifft', { fn: (args) => [transform(args, 'ifft', (x) => math.ifft(x))] });
}
