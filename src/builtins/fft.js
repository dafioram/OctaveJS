// fft.js — FFT/IFFT, delegated to math.js (confirmed working for both
// power-of-two and arbitrary lengths during development).

import * as math from 'mathjs';
import { Mat, MatlabError } from '../core/values.js';

function toComplexArray(mat) {
  const out = [];
  for (let k = 0; k < mat.numel; k++) out.push(math.complex(mat.re[k], mat.isComplex ? mat.im[k] : 0));
  return out;
}
function fromComplexArray(arr, shapeLike) {
  const n = arr.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let anyIm = false;
  arr.forEach((v, k) => { re[k] = v.re; im[k] = v.im; if (v.im !== 0) anyIm = true; });
  const rows = shapeLike.rows === 1 ? 1 : n;
  const cols = shapeLike.rows === 1 ? n : 1;
  return new Mat(rows, cols, re, anyIm ? im : null);
}

export function registerFFT(reg) {
  reg.set('fft', {
    fn: (args) => {
      const a = args[0];
      if (!a.isVector) throw new MatlabError('fft: only vector input is supported (matrix/columnwise FFT is out of scope)');
      const arr = toComplexArray(a);
      const result = math.fft(arr);
      return [fromComplexArray(result, a)];
    },
  });
  reg.set('ifft', {
    fn: (args) => {
      const a = args[0];
      if (!a.isVector) throw new MatlabError('ifft: only vector input is supported (matrix/columnwise IFFT is out of scope)');
      const arr = toComplexArray(a);
      const result = math.ifft(arr);
      return [fromComplexArray(result, a)];
    },
  });
}
