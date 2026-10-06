// fft.js — FFT/IFFT, fft2/ifft2 and fftshift/ifftshift.
//
// fft(X) transforms a vector, or each column of a matrix; fft(X, n) pads
// with zeros or truncates to length n first; fft(X, n, dim) / fft(X, [], dim)
// work along a chosen dimension. ifft takes the same arguments plus
// 'symmetric'. Transforms run on typed arrays: iterative radix-2 for
// power-of-two lengths, a direct DFT for short odd lengths and
// Bluestein's chirp-z algorithm otherwise, so every length is O(n log n).

import { Mat, Cell, StructArray, MatlabError, selectElements, valueClassName } from '../core/values.js';

// In-place radix-2 FFT (length a power of two); `sign` -1 forward, +1 inverse
// (unscaled).
function radix2(re, im, sign) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    for (let k = 0; k < half; k++) {
      // Twiddles from the exact angle (not by repeated multiplication).
      const ang = sign * 2 * Math.PI * k / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = k; i < n; i += len) {
        const j = i + half;
        const xr = re[j] * wr - im[j] * wi, xi = re[j] * wi + im[j] * wr;
        re[j] = re[i] - xr; im[j] = im[i] - xi;
        re[i] += xr; im[i] += xi;
      }
    }
  }
}

// Unscaled DFT of any length; returns new [re, im] arrays.
function dft(xr, xi, sign) {
  const n = xr.length;
  if (n <= 1) return [Float64Array.from(xr), Float64Array.from(xi)];
  if ((n & (n - 1)) === 0) {
    const re = Float64Array.from(xr), im = Float64Array.from(xi);
    radix2(re, im, sign);
    return [re, im];
  }
  if (n <= 64) {
    const re = new Float64Array(n), im = new Float64Array(n);
    // cos/sin of 2*pi*k/n, symmetric in k <-> n-k.
    const c = Float64Array.from({ length: n }, (_, k) => Math.cos(2 * Math.PI * Math.min(k, n - k) / n));
    const s = Float64Array.from({ length: n }, (_, k) => (k <= n - k ? 1 : -1) * sign * Math.sin(2 * Math.PI * Math.min(k, n - k) / n));
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let j = 0, idx = 0; j < n; j++, idx = (idx + k) % n) {
        sr += xr[j] * c[idx] - xi[j] * s[idx];
        si += xr[j] * s[idx] + xi[j] * c[idx];
      }
      re[k] = sr; im[k] = si;
    }
    return [re, im];
  }
  // Bluestein: X_k = w_k * sum_j (x_j w_j) conj(w_{k-j}), w_k = exp(sign*i*pi*k^2/n),
  // a convolution done with power-of-two FFTs.
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const wr = new Float64Array(n), wi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = sign * Math.PI * ((k * k) % (2 * n)) / n;
    wr[k] = Math.cos(ang); wi[k] = Math.sin(ang);
  }
  const ar = new Float64Array(m), ai = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = xr[k] * wr[k] - xi[k] * wi[k];
    ai[k] = xr[k] * wi[k] + xi[k] * wr[k];
  }
  const br = new Float64Array(m), bi = new Float64Array(m);
  br[0] = wr[0]; bi[0] = -wi[0];
  for (let k = 1; k < n; k++) {
    br[k] = br[m - k] = wr[k];
    bi[k] = bi[m - k] = -wi[k];
  }
  radix2(ar, ai, -1);
  radix2(br, bi, -1);
  for (let k = 0; k < m; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k];
    ai[k] = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
  }
  radix2(ar, ai, 1);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const cr = ar[k] / m, ci = ai[k] / m;
    re[k] = cr * wr[k] - ci * wi[k];
    im[k] = cr * wi[k] + ci * wr[k];
  }
  return [re, im];
}

// X(k) == conj(X(n-k)) for every k: the inverse transform is real.
function conjugateSymmetric(re, im) {
  const n = re.length;
  for (let k = 0; k < n; k++) {
    const j = (n - k) % n;
    if (re[k] !== re[j] || im[k] !== -im[j]) return false;
  }
  return true;
}

function transform(args, fname, inverse) {
  const a = args[0];
  if (!(a instanceof Mat)) throw new MatlabError(`${fname}: input must be numeric`);
  let symmetric = false;
  if (inverse && args.length >= 2 && args[args.length - 1].isChar) {
    const flag = args[args.length - 1].toJSString().toLowerCase();
    if (flag !== 'symmetric' && flag !== 'nonsymmetric') throw new MatlabError(`${fname}: unknown option '${flag}'`);
    symmetric = flag === 'symmetric';
    args = args.slice(0, -1);
  }
  let n = null;
  if (args.length >= 2 && !args[1].isEmpty) {
    n = Math.round(args[1].toScalarNumber());
    if (!(n >= 1)) throw new MatlabError(`${fname}: N must be a positive integer`);
  }
  let dim;
  if (args.length >= 3) dim = Math.round(args[2].toScalarNumber());
  else dim = a.rows !== 1 ? 1 : 2;
  if (!(dim >= 1)) throw new MatlabError(`${fname}: dimension must be a positive integer`);
  if (dim > 2) {
    // A singleton dimension: each element is its own length-1 transform
    // (padded to n if given, which would need N-D output).
    if (n !== null && n !== 1) throw new MatlabError(`${fname}: N-D results are not supported`);
    return a;
  }
  if (a.isEmpty && n === null) return a;

  const len = dim === 1 ? a.rows : a.cols;
  const outLen = n === null ? len : n;
  const lines = dim === 1 ? a.cols : a.rows;
  const outRows = dim === 1 ? outLen : a.rows, outCols = dim === 1 ? a.cols : outLen;
  const re = new Float64Array(outRows * outCols), im = new Float64Array(outRows * outCols);
  let anyIm = false, allSymmetric = true;
  const xr = new Float64Array(outLen), xi = new Float64Array(outLen);
  for (let l = 0; l < lines; l++) {
    const src = (k) => (dim === 1 ? l * a.rows + k : k * a.rows + l);
    const dst = (k) => (dim === 1 ? l * outRows + k : k * outRows + l);
    for (let k = 0; k < outLen; k++) {
      xr[k] = k < len ? a.re[src(k)] : 0;
      xi[k] = k < len && a.isComplex ? a.im[src(k)] : 0;
    }
    if (inverse && allSymmetric && !conjugateSymmetric(xr, xi)) allSymmetric = false;
    const [yr, yi] = dft(xr, xi, inverse ? 1 : -1);
    if (!inverse && !a.isComplex) {
      // A real signal's transform is exactly conjugate symmetric (as from
      // FFTW's real-input transform), so ifft(fft(x)) comes back real.
      yi[0] = 0;
      if (outLen % 2 === 0) yi[outLen / 2] = 0;
      for (let k = 1; k < outLen - k; k++) { yr[outLen - k] = yr[k]; yi[outLen - k] = -yi[k]; }
    }
    for (let k = 0; k < outLen; k++) {
      re[dst(k)] = inverse ? yr[k] / outLen : yr[k];
      im[dst(k)] = inverse ? yi[k] / outLen : yi[k];
      if (im[dst(k)] !== 0) anyIm = true;
    }
  }
  // MATLAB's ifft returns a real result for conjugate-symmetric input (or
  // with 'symmetric'); fft of real input keeps exact zeros real.
  if (inverse && (symmetric || allSymmetric)) anyIm = false;
  return new Mat(outRows, outCols, re, anyIm ? im : null);
}

// Circular shift of x by k along dim (1 or 2), for fftshift/ifftshift.
function shiftAlong(x, dim, k) {
  const m = x.rows, n = x.cols;
  const len = dim === 1 ? m : n;
  if (len === 0) return x;
  const s = ((k % len) + len) % len;
  // Source position of each output element, for any kind of array.
  const positions = [];
  for (let c = 0; c < n; c++) for (let r = 0; r < m; r++) positions.push(dim === 1 ? c * m + (r - s + m) % m : ((c - s + n) % n) * m + r);
  return selectElements(x, m, n, positions);
}
// fftshift(X) | fftshift(X, dim): move the zero-frequency term to the
// middle (both dimensions of a matrix); ifftshift undoes it.
function centerShift(args, inverse) {
  const x = args[0];
  if (!(x instanceof Mat || x instanceof Cell || x instanceof StructArray)) throw new MatlabError(`Undefined function '${inverse ? 'ifftshift' : 'fftshift'}' for input arguments of type '${valueClassName(x)}'.`, 'MATLAB:UndefinedFunction');
  const amount = (len) => (inverse ? -Math.floor(len / 2) : Math.floor(len / 2));
  if (args.length >= 2) {
    const d = args[1].toScalarNumber();
    if (!(Number.isInteger(d) && d >= 1)) throw new MatlabError('DIM must be a positive integer.', `MATLAB:${inverse ? 'ifftshift' : 'fftshift'}:DimNotPosInt`);
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
  reg.set('fft', { fn: (args) => [transform(args, 'fft', false)] });
  reg.set('ifft', { fn: (args) => [transform(args, 'ifft', true)] });
  // fft2(X) | fft2(X, m, n): fft down the columns, then along the rows.
  const twoD = (fname, inverse) => ({
    fn: (args) => {
      let symmetric = null;
      if (inverse && args.length >= 2 && args[args.length - 1].isChar) { symmetric = args[args.length - 1]; args = args.slice(0, -1); }
      const x = args[0];
      const m = args.length >= 3 ? args[1] : Mat.empty(), n = args.length >= 3 ? args[2] : Mat.empty();
      if (args.length === 2) throw new MatlabError(`${fname}: expected ${fname}(X) or ${fname}(X, m, n)`);
      if (x.isEmpty) return [x];
      const cols = transform([x, m, Mat.scalar(1)], fname, inverse);
      return [transform([cols, n, Mat.scalar(2), ...(symmetric ? [symmetric] : [])], fname, inverse)];
    },
  });
  reg.set('fft2', twoD('fft2', false));
  reg.set('ifft2', twoD('ifft2', true));
  // fftshift/ifftshift rearrange any kind of array (cells too), so they
  // skip the numeric-only argument check.
  reg.set('fftshift', { fn: (args) => [centerShift(args, false)], anyType: true });
  reg.set('ifftshift', { fn: (args) => [centerShift(args, true)], anyType: true });
}
