// mathext.js — More everyday numeric functions: magic, meshgrid, ndgrid,
// diff, trapz, cumtrapz, circshift, kron, nnz, sub2ind, ind2sub, mode,
// factorial, nchoosek, primes, isprime, gcd, lcm, roots, conv, deconv,
// filter.

import { Mat, Cell, MatlabError, selectElements } from '../core/values.js';
import * as C from '../core/cmath.js';
import { finiteScalarArg, linearOnParts } from './numutil.js';

// MATLAB's default dimension: the first one whose size isn't 1.
function firstDim(m) { return m.rows !== 1 ? 1 : 2; }

function dimArg(v) {
  const d = Math.round(v.toScalarNumber());
  if (!(d >= 1)) throw new MatlabError('Dimension argument must be a positive integer');
  return d;
}

function requireReal(m, fname) {
  if (!(m instanceof Mat)) throw new MatlabError(`${fname}: input must be numeric`);
  if (m.isComplex) throw new MatlabError(`${fname}: complex input is not supported`);
  return m;
}


// Calls fn(get, set, len) once per line of `m` along `dim` (each column for
// dim 1, each row for dim 2), where get(k)/set(k, v) address the line's
// k-th element in a result of size outRows x outCols (lines keep their
// position; only the length along `dim` may differ).
// For dim >= 3 (a singleton dimension of a 2-D array) every element is a
// line of length 1.
function forEachLine(m, dim, outLen, fn) {
  if (dim >= 3) {
    if (outLen === 0) return Mat.empty();
    const out = Mat.zeros(m.rows, m.cols);
    for (let k = 0; k < m.numel; k++) fn(() => m.re[k], (_i, v) => { out.re[k] = v; }, 1);
    return out;
  }
  const outRows = dim === 1 ? outLen : m.rows, outCols = dim === 1 ? m.cols : outLen;
  const out = Mat.zeros(outRows, outCols);
  const lines = dim === 1 ? m.cols : m.rows;
  const len = dim === 1 ? m.rows : m.cols;
  for (let l = 0; l < lines; l++) {
    const src = (k) => (dim === 1 ? l * m.rows + k : k * m.rows + l);
    const dst = (k) => (dim === 1 ? l * outRows + k : k * outRows + l);
    fn((k) => m.re[src(k)], (k, v) => { out.re[dst(k)] = v; }, len);
  }
  return out;
}

function vectorValues(m) { return Array.from(m.re); }
function rowOrColumn(likeColumn, values) {
  const re = Float64Array.from(values);
  return likeColumn ? new Mat(re.length, 1, re) : new Mat(1, re.length, re);
}

function magicSquare(n) {
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  if (n % 2 === 1) {
    for (let i = 1; i <= n; i++) for (let j = 1; j <= n; j++) {
      const A = ((i + j - (n + 3) / 2) % n + n) % n;
      const B = ((i + 2 * j - 2) % n + n) % n;
      M[i - 1][j - 1] = n * A + B + 1;
    }
  } else if (n % 4 === 0) {
    for (let i = 1; i <= n; i++) for (let j = 1; j <= n; j++) {
      const v = (i - 1) * n + j;
      const K = Math.trunc((i % 4) / 2) === Math.trunc((j % 4) / 2);
      M[i - 1][j - 1] = K ? n * n + 1 - v : v;
    }
  } else {
    // Singly even (LUX-style construction, as in MATLAB's magic.m).
    const p = n / 2;
    const S = magicSquare(p);
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
      M[i][j] = S[i][j];
      M[i][j + p] = S[i][j] + 2 * p * p;
      M[i + p][j] = S[i][j] + 3 * p * p;
      M[i + p][j + p] = S[i][j] + p * p;
    }
    const k = (n - 2) / 4;
    const cols = [];
    for (let j = 1; j <= k; j++) cols.push(j);
    for (let j = n - k + 2; j <= n; j++) cols.push(j);
    const swap = (r, c) => { const t = M[r - 1][c - 1]; M[r - 1][c - 1] = M[r + p - 1][c - 1]; M[r + p - 1][c - 1] = t; };
    for (let i = 1; i <= p; i++) for (const c of cols) swap(i, c);
    const i = k + 1;
    // MATLAB's M([i; i+p], [1 i]) = M([i+p; i], [1 i]): a repeated column
    // (when i = 1, for n = 2) is swapped once, not twice.
    for (const c of new Set([1, i])) swap(i, c);
  }
  return M;
}

function gcd2(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function requireIntegers(m, fname) {
  for (let k = 0; k < m.numel; k++) {
    if (!Number.isInteger(m.re[k])) throw new MatlabError(`${fname}: inputs must be integers`);
  }
}

export function registerMathExt(reg) {
  reg.set('magic', {
    fn: (args) => {
      // The first element, truncated: magic(2.5) is 2-by-2, magic('ab') is 97-by-97.
      const n = Math.trunc(finiteScalarArg(args[0].numel ? new Mat(1, 1, args[0].re.slice(0, 1)) : args[0], 'magic'));
      if (n < 1) return [Mat.empty()];
      return [Mat.fromRows(magicSquare(n))];
    },
  });

  // [X, Y] = meshgrid(x, y): X repeats x across rows, Y repeats y down
  // columns (size numel(y)-by-numel(x)); ndgrid is the transposed layout.
  // [X, Y] = meshgrid(x, y): X repeats x across rows, Y repeats y down
  // columns (size numel(y)-by-numel(x)); ndgrid is the transposed layout,
  // and ndgrid(x) with one output is x(:). Built from the elements of x
  // and y, so their class (char, logical, complex, cell) carries over.
  const grid = (transposed) => (args, nargout) => {
    const x = args[0], y = args.length >= 2 ? args[1] : args[0];
    if (transposed && args.length === 1 && nargout <= 1) return [selectElements(x, x.numel, 1, Array.from({ length: x.numel }, (_, k) => k))];
    if (!transposed && (x.numel === 0 || y.numel === 0)) return [Mat.empty(), Mat.empty()].slice(0, Math.max(1, nargout)); // meshgrid of an empty vector is []
    const rows = transposed ? x.numel : y.numel, cols = transposed ? y.numel : x.numel;
    const xs = [], ys = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) { xs.push(transposed ? r : c); ys.push(transposed ? c : r); }
    const X = selectElements(x, rows, cols, xs);
    return nargout >= 2 ? [X, selectElements(y, rows, cols, ys)] : [X];
  };
  reg.set('meshgrid', { fn: grid(false) });
  reg.set('ndgrid', { fn: grid(true) });

  // diff(X) | diff(X, n) | diff(X, n, dim). Without dim, each pass works
  // along the first non-singleton dimension of the previous result (so
  // diff([4 -2; 1 3], 2) is 1x1), and a scalar's difference is [].
  reg.set('diff', {
    fn: (args) => [linearOnParts(args, 0, (a) => {
      let m = requireReal(a[0], 'diff');
      const order = a.length >= 2 && !a[1].isEmpty ? Math.round(a[1].toScalarNumber()) : 1;
      const fixedDim = a.length >= 3 ? dimArg(a[2]) : null;
      for (let pass = 0; pass < order; pass++) {
        if (!fixedDim && m.numel === 1) return Mat.empty();
        const dim = fixedDim || firstDim(m);
        const len = dim === 1 ? m.rows : dim === 2 ? m.cols : 1;
        m = forEachLine(m, dim, Math.max(len - 1, 0), (get, set, n) => {
          for (let k = 0; k + 1 < n; k++) set(k, get(k + 1) - get(k));
        });
      }
      return m;
    })],
  });

  // trapz(Y), trapz(X, Y), trapz(Y, dim), trapz(X, Y, dim); cumtrapz likewise.
  function trapzArgs(args) {
    let x = null, y, dim = null;
    if (args.length >= 3) { [x, y] = args; dim = dimArg(args[2]); }
    else if (args.length === 2 && args[1].isScalar && !args[0].isScalar) { y = args[0]; dim = dimArg(args[1]); }
    else if (args.length === 2) { [x, y] = args; }
    else { y = args[0]; }
    requireReal(y, 'trapz');
    dim = dim || firstDim(y);
    const len = dim === 1 ? y.rows : dim === 2 ? y.cols : 1;
    let spacing;
    if (!x) spacing = (k) => 1;
    else if (x.isScalar) { const h = x.re[0]; spacing = () => h; }
    else {
      if (x.numel !== len) throw new MatlabError('trapz: length of X must match the size of Y along the integration dimension');
      spacing = (k) => x.re[k + 1] - x.re[k];
    }
    return { y, dim, len, spacing };
  }
  // The argument holding Y (trapz(Y), trapz(Y, dim), trapz(X, Y, ...)).
  const yIndex = (args) => (args.length >= 3 || (args.length === 2 && !(args[1].isScalar && !args[0].isScalar)) ? 1 : 0);
  reg.set('trapz', {
    fn: (args) => [linearOnParts(args, yIndex(args), (a) => {
      const { y, dim, spacing } = trapzArgs(a);
      if (a.length === 1 && y.rows === 0 && y.cols === 0) return Mat.scalar(0); // trapz([]) is 0
      return forEachLine(y, dim, 1, (get, set, n) => {
        let s = 0;
        for (let k = 0; k + 1 < n; k++) s += spacing(k) * (get(k) + get(k + 1)) / 2;
        set(0, s);
      });
    })],
  });
  reg.set('cumtrapz', {
    fn: (args) => [linearOnParts(args, yIndex(args), (a) => {
      const { y, dim, len, spacing } = trapzArgs(a);
      return forEachLine(y, dim, dim >= 3 ? 1 : len, (get, set, n) => {
        let s = 0;
        if (n > 0) set(0, 0);
        for (let k = 0; k + 1 < n; k++) { s += spacing(k) * (get(k) + get(k + 1)) / 2; set(k + 1, s); }
      });
    })],
  });

  // circshift(A, k): shift along the first non-singleton dimension;
  // circshift(A, [r c]) shifts rows by r and columns by c;
  // circshift(A, k, dim) shifts along dim.
  reg.set('circshift', {
    fn: (args) => {
      const a = args[0];
      let dr = 0, dc = 0;
      const k = args[1];
      if (!(k instanceof Mat) || k.isChar || k.isComplex || !Array.from(k.re).every(Number.isInteger)) throw new MatlabError('Invalid shift type: must be a real finite integer vector.', 'MATLAB:circshift:InvalidShiftType');
      if (args.length >= 3) {
        const d = dimArg(args[2]);
        if (d === 1) dr = Math.round(k.toScalarNumber()); else if (d === 2) dc = Math.round(k.toScalarNumber());
      } else if (k.numel >= 2) { dr = Math.round(k.re[0]); dc = Math.round(k.re[1]); }
      else if (firstDim(a) === 1) dr = Math.round(k.toScalarNumber());
      else dc = Math.round(k.toScalarNumber());
      const R = a.rows, Cc = a.cols;
      const srcIndex = (r, c) => {
        const sr = R ? (((r - dr) % R) + R) % R : 0;
        const sc = Cc ? (((c - dc) % Cc) + Cc) % Cc : 0;
        return sc * R + sr;
      };
      if (a instanceof Cell) {
        const data = new Array(a.numel);
        for (let c = 0; c < Cc; c++) for (let r = 0; r < R; r++) data[c * R + r] = a.data[srcIndex(r, c)];
        return [new Cell(R, Cc, data)];
      }
      if (!(a instanceof Mat)) throw new MatlabError('circshift: unsupported input type');
      const out = new Mat(R, Cc, new Float64Array(a.numel), a.im ? new Float64Array(a.numel) : null, { isChar: a.isChar, isLogical: a.isLogical });
      for (let c = 0; c < Cc; c++) for (let r = 0; r < R; r++) {
        const s = srcIndex(r, c);
        out.re[c * R + r] = a.re[s];
        if (out.im) out.im[c * R + r] = a.im[s];
      }
      return [out];
    },
  });

  reg.set('kron', {
    fn: (args) => {
      const [a, b] = args;
      const rows = a.rows * b.rows, cols = a.cols * b.cols;
      const out = Mat.zeros(rows, cols);
      const cx = a.isComplex || b.isComplex;
      if (cx) out.im = new Float64Array(rows * cols);
      for (let j = 0; j < a.cols; j++) for (let i = 0; i < a.rows; i++) {
        const ar = a.re[j * a.rows + i], ai = a.isComplex ? a.im[j * a.rows + i] : 0;
        for (let l = 0; l < b.cols; l++) for (let k = 0; k < b.rows; k++) {
          const br = b.re[l * b.rows + k], bi = b.isComplex ? b.im[l * b.rows + k] : 0;
          const dst = (j * b.cols + l) * rows + i * b.rows + k;
          const [vr, vi] = C.cmul(ar, ai, br, bi);
          out.re[dst] = vr;
          if (cx) out.im[dst] = vi;
        }
      }
      return [out];
    },
  });

  reg.set('nnz', {
    fn: (args) => {
      const a = args[0];
      let n = 0;
      for (let k = 0; k < a.numel; k++) if (a.re[k] !== 0 || (a.isComplex && a.im[k] !== 0)) n++;
      return [Mat.scalar(n)];
    },
  });

  function sizePair(sz) {
    if (sz.numel < 2) throw new MatlabError('Size vector must have at least two elements');
    if (!Array.from(sz.re).every(v => Number.isInteger(v) && v >= 0)) throw new MatlabError('Size vector must contain non-negative integers');
    return [sz.re[0], sz.re[1]];
  }
  reg.set('sub2ind', {
    fn: (args) => {
      const [m, n] = sizePair(args[0]);
      const r = args[1], c = args.length >= 3 ? args[2] : Mat.scalar(1);
      if (r.numel !== c.numel && c.numel !== 1) throw new MatlabError('sub2ind: subscript arrays must be the same size');
      const out = Mat.zeros(r.rows, r.cols);
      for (let k = 0; k < r.numel; k++) {
        const ri = r.re[k], ci = c.re[c.numel === 1 ? 0 : k];
        if (!Number.isInteger(ri) || !Number.isInteger(ci) || ri < 1 || ci < 1 || ri > m || ci > n) throw new MatlabError('Out of range subscript.');
        out.re[k] = (ci - 1) * m + ri;
      }
      return [out];
    },
  });
  reg.set('ind2sub', {
    fn: (args, nargout) => {
      const [m, n] = sizePair(args[0]);
      const ind = args[1];
      if (nargout <= 1) return [ind];
      const r = Mat.zeros(ind.rows, ind.cols), c = Mat.zeros(ind.rows, ind.cols);
      for (let k = 0; k < ind.numel; k++) {
        const v = ind.re[k];
        if (!Number.isInteger(v) || v < 1 || v > m * n) throw new MatlabError('Index out of range.');
        r.re[k] = ((v - 1) % m) + 1;
        c.re[k] = Math.floor((v - 1) / m) + 1;
      }
      return [r, c];
    },
  });

  // [M, F] = mode(X, dim): most frequent value (smallest on ties), NaNs ignored.
  reg.set('mode', {
    fn: (args, nargout) => {
      const a = requireReal(args[0], 'mode');
      const dim = args.length >= 2 ? dimArg(args[1]) : firstDim(a);
      // mode([]) is NaN; an empty dimension gives NaN per line (mode(zeros(0, 3)) is 1x3).
      if (a.rows === 0 && a.cols === 0 && args.length < 2) return nargout >= 2 ? [Mat.scalar(NaN), Mat.scalar(0)] : [Mat.scalar(NaN)];
      const freq = [];
      const M = forEachLine(a, dim, 1, (get, set, n) => {
        const counts = new Map();
        for (let k = 0; k < n; k++) { const v = get(k); if (!Number.isNaN(v)) counts.set(v, (counts.get(v) || 0) + 1); }
        let best = NaN, bestCount = 0;
        for (const [v, cnt] of counts) if (cnt > bestCount || (cnt === bestCount && v < best)) { best = v; bestCount = cnt; }
        set(0, best);
        freq.push(bestCount);
      });
      return nargout >= 2 ? [M, new Mat(M.rows, M.cols, Float64Array.from(freq))] : [M];
    },
  });

  reg.set('factorial', {
    fn: (args) => {
      const a = requireReal(args[0], 'factorial');
      return [Mat.mapElementwise(a, (x) => {
        if (!Number.isInteger(x) || x < 0) throw new MatlabError('N must be a matrix of non-negative integers.');
        if (x > 170) return [Infinity, 0];
        let f = 1;
        for (let k = 2; k <= x; k++) f *= k;
        return [f, 0];
      })];
    },
  });

  // nchoosek(n, k): binomial coefficient; nchoosek(v, k): all k-element
  // combinations of the vector v, one per row.
  reg.set('nchoosek', {
    fn: (args) => {
      const v = requireReal(args[0], 'nchoosek');
      const k = Math.round(finiteScalarArg(args[1], 'nchoosek', 'K'));
      if (v.isScalar) {
        const n = v.re[0];
        if (!Number.isInteger(n) || n < 0 || k < 0 || k > n) throw new MatlabError('nchoosek: N and K must be non-negative integers with K <= N');
        let r = 1;
        for (let i = 1; i <= Math.min(k, n - k); i++) r = r * (n - Math.min(k, n - k) + i) / i;
        return [Mat.scalar(Math.round(r))];
      }
      const vals = vectorValues(v);
      const combos = [];
      const pick = [];
      const rec = (start) => {
        if (pick.length === k) { combos.push(pick.map(i => vals[i])); return; }
        for (let i = start; i < vals.length; i++) { pick.push(i); rec(i + 1); pick.pop(); }
      };
      if (k >= 0 && k <= vals.length) rec(0);
      if (combos.length === 0) return [Mat.zeros(0, Math.max(k, 0))];
      return [Mat.fromRows(combos)];
    },
  });

  reg.set('primes', {
    fn: (args) => {
      const n = Math.floor(finiteScalarArg(args[0], 'primes', 'the limit'));
      if (n < 2) return [Mat.zeros(1, 0)];
      const sieve = new Uint8Array(n + 1);
      const out = [];
      for (let i = 2; i <= n; i++) {
        if (sieve[i]) continue;
        out.push(i);
        for (let j = i * i; j <= n; j += i) sieve[j] = 1;
      }
      return [rowOrColumn(false, out)];
    },
  });
  reg.set('isprime', {
    fn: (args) => {
      const a = requireReal(args[0], 'isprime');
      const out = Mat.mapElementwise(a, (x) => {
        if (!Number.isInteger(x) || x < 0) throw new MatlabError('isprime: all entries must be non-negative integers');
        if (x < 2) return [0, 0];
        if (x % 2 === 0) return [x === 2 ? 1 : 0, 0];
        for (let d = 3; d * d <= x; d += 2) if (x % d === 0) return [0, 0];
        return [1, 0];
      });
      out.isLogical = true;
      return [out];
    },
  });

  reg.set('gcd', {
    fn: (args) => {
      requireIntegers(args[0], 'gcd'); requireIntegers(args[1], 'gcd');
      return [Mat.broadcastBinary(args[0], args[1], (a, _ai, b) => [gcd2(a, b), 0])];
    },
  });
  reg.set('lcm', {
    fn: (args) => {
      requireIntegers(args[0], 'lcm'); requireIntegers(args[1], 'lcm');
      return [Mat.broadcastBinary(args[0], args[1], (a, _ai, b) => {
        if (a === 0 || b === 0) return [0, 0];
        return [Math.abs(a * b) / gcd2(a, b), 0];
      })];
    },
  });

  // roots(p): eigenvalues of the companion matrix, as MATLAB does.
  reg.set('roots', {
    fn: (args, _n, ctx) => {
      const p = requireReal(args[0], 'roots');
      let c = vectorValues(p);
      while (c.length && c[0] === 0) c.shift();
      let zeros = 0;
      while (c.length && c[c.length - 1] === 0) { c.pop(); zeros++; }
      const n = c.length - 1;
      const extra = Array(zeros).fill(0);
      if (n < 1) return [rowOrColumn(true, extra)];
      const comp = Mat.zeros(n, n);
      for (let j = 0; j < n; j++) comp.re[j * n] = -c[j + 1] / c[0];
      for (let i = 1; i < n; i++) comp.re[(i - 1) * n + i] = 1;
      const [ev] = ctx.interp.builtins.get('eig').fn([comp], 1, ctx);
      if (zeros === 0) return [ev];
      const re = Float64Array.from([...ev.re, ...extra]);
      const im = ev.im ? Float64Array.from([...ev.im, ...extra]) : null;
      return [new Mat(re.length, 1, re, im)];
    },
  });

  // conv(u, v, shape) with shape 'full' (default), 'same' or 'valid'.
  reg.set('conv', {
    fn: (args) => {
      const [u, v] = args;
      const shape = args.length >= 3 ? args[2].toJSString().toLowerCase() : 'full';
      const m = u.numel, n = v.numel;
      const full = m === 0 || n === 0 ? 0 : m + n - 1;
      const re = new Float64Array(full), im = (u.isComplex || v.isComplex) ? new Float64Array(full) : null;
      for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
        const [pr, pi] = C.cmul(u.re[i], u.isComplex ? u.im[i] : 0, v.re[j], v.isComplex ? v.im[j] : 0);
        re[i + j] += pr;
        if (im) im[i + j] += pi;
      }
      let start = 0, len = full;
      if (shape === 'same') { start = Math.floor(n / 2); len = m; }
      else if (shape === 'valid') { start = n - 1; len = Math.max(m - n + 1, 0); }
      else if (shape !== 'full') throw new MatlabError("conv: shape must be 'full', 'same' or 'valid'");
      const pr = re.slice(start, start + len), pi = im ? im.slice(start, start + len) : null;
      const column = u.cols === 1 && u.rows > 1 || (u.numel === 1 && v.cols === 1 && v.rows > 1);
      return [new Mat(column ? pr.length : 1, column ? 1 : pr.length, pr, pi)];
    },
  });

  // conv2(A, B) | conv2(A, B, shape) | conv2(u, v, A) | conv2(u, v, A, shape):
  // 2-D convolution ('full', 'same' or 'valid'); with two vectors first,
  // the columns of A are convolved with u and then the rows with v.
  const conv2 = (A, B, shape) => {
    const ma = A.rows, na = A.cols, mb = B.rows, nb = B.cols;
    const fr = ma && mb ? ma + mb - 1 : 0, fc = na && nb ? na + nb - 1 : 0;
    const complex = A.isComplex || B.isComplex;
    const re = new Float64Array(fr * fc), im = complex ? new Float64Array(fr * fc) : null;
    for (let qa = 0; qa < na; qa++) for (let pa = 0; pa < ma; pa++) {
      const ar = A.re[qa * ma + pa], ai = A.isComplex ? A.im[qa * ma + pa] : 0;
      if (ar === 0 && ai === 0) continue;
      for (let qb = 0; qb < nb; qb++) for (let pb = 0; pb < mb; pb++) {
        const k = (qa + qb) * fr + pa + pb;
        if (!complex) { re[k] += ar * B.re[qb * mb + pb]; continue; }
        const [pr, pi] = C.cmul(ar, ai, B.re[qb * mb + pb], B.isComplex ? B.im[qb * mb + pb] : 0);
        re[k] += pr; im[k] += pi;
      }
    }
    let r0 = 0, c0 = 0, rows = fr, cols = fc;
    if (shape === 'same') { r0 = Math.floor(mb / 2); c0 = Math.floor(nb / 2); rows = ma; cols = na; }
    else if (shape === 'valid') { r0 = mb - 1; c0 = nb - 1; rows = Math.max(ma - mb + 1, 0); cols = Math.max(na - nb + 1, 0); }
    else if (shape !== 'full') throw new MatlabError("conv2: shape must be 'full', 'same' or 'valid'");
    const out = new Mat(rows, cols, new Float64Array(rows * cols), complex ? new Float64Array(rows * cols) : null);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      out.re[c * rows + r] = re[(c + c0) * fr + r + r0];
      if (complex) out.im[c * rows + r] = im[(c + c0) * fr + r + r0];
    }
    return out;
  };
  const shapeOf = (v, dflt) => (v ? v.toJSString().toLowerCase() : dflt);
  reg.set('conv2', {
    fn: (args) => {
      const isText = (v) => v && v.isChar;
      if (args.length >= 3 && !isText(args[2])) {
        const [u, v, A] = args;
        const col = new Mat(u.numel, 1, Float64Array.from(u.re), u.im ? Float64Array.from(u.im) : null);
        const row = new Mat(1, v.numel, Float64Array.from(v.re), v.im ? Float64Array.from(v.im) : null);
        const shape = shapeOf(args[3], 'full');
        if (shape === 'full') return [conv2(conv2(A, col, 'full'), row, 'full')];
        return [conv2(A, Mat.fromRows(Array.from({ length: col.numel }, (_, i) => Array.from({ length: row.numel }, (_, j) => col.re[i] * row.re[j]))), shape)];
      }
      if (args.length < 2) throw new MatlabError('conv2: expected conv2(A, B)');
      return [conv2(args[0], args[1], shapeOf(args[2], 'full'))];
    },
  });
  // filter2(h, X) | filter2(h, X, shape): correlation, conv2(X, rot90(h, 2), shape), default 'same'.
  reg.set('filter2', {
    fn: (args) => {
      if (args.length < 2) throw new MatlabError('filter2: expected filter2(h, X)');
      const [h, X] = args;
      const n = h.numel;
      const rot = new Mat(h.rows, h.cols, Float64Array.from({ length: n }, (_, k) => h.re[n - 1 - k]), h.im ? Float64Array.from({ length: n }, (_, k) => h.im[n - 1 - k]) : null);
      return [conv2(X, rot, shapeOf(args[2], 'same'))];
    },
  });

  // factor(n): the prime factors of n, in ascending order.
  reg.set('factor', {
    fn: (args) => {
      if (args[0].numel !== 1) throw new MatlabError('factor: N must be a scalar');
      let n = args[0].re[0];
      if (!Number.isInteger(n) || n < 0) throw new MatlabError('factor: N must be a nonnegative integer');
      if (n > Number.MAX_SAFE_INTEGER) throw new MatlabError('factor: N is too large (the maximum is flintmax)');
      if (n < 4) return [Mat.scalar(n)];
      const f = [];
      for (const p of [2, 3]) while (n % p === 0) { f.push(p); n /= p; }
      for (let p = 5; p * p <= n; p += 6) {
        while (n % p === 0) { f.push(p); n /= p; }
        while (n % (p + 2) === 0) { f.push(p + 2); n /= p + 2; }
      }
      if (n > 1) f.push(n);
      return [new Mat(1, f.length, Float64Array.from(f))];
    },
  });

  // perms(v): all permutations of v's elements, one per row, in reverse
  // lexicographic order of positions (MATLAB's order).
  reg.set('perms', {
    fn: (args) => {
      const v = args[0];
      const n = v.numel;
      if (n > 11) throw new MatlabError('perms: too many elements (the result would have more than 11! rows)');
      // MATLAB's order: perms(1:n) = [n perms(1:n-1)] followed, for
      // i = n-1 down to 1, by [i perms(1:n-1) with i replaced by n].
      const indexPerms = (k) => {
        if (k <= 1) return [Array.from({ length: k }, (_, i) => i + 1)];
        const q = indexPerms(k - 1);
        const out = q.map(row => [k, ...row]);
        for (let i = k - 1; i >= 1; i--) out.push(...q.map(row => [i, ...row.map(x => (x === i ? k : x))]));
        return out;
      };
      const rows = n === 0 ? [[]] : indexPerms(n).map(row => row.map(x => x - 1));
      const R = rows.length;
      return [selectElements(v, R, n, Array.from({ length: R * n }, (_, k) => rows[k % R][Math.floor(k / R)]))];
    },
  });

  // [N, D] = rat(X) | rat(X, tol) | S = rat(X): continued-fraction rational
  // approximation within tol (default 1e-6*norm(X(:), 1)).
  const ratTerms = (x, tol) => {
    if (!Number.isFinite(x)) return { N: Number.isNaN(x) ? 0 : Math.sign(x), D: 0, terms: [x] };
    let y = x, n0 = 1, n1 = 0, d0 = 0, d1 = 1;
    const terms = [];
    for (let k = 0; k < 64; k++) {
      const d = Math.round(y);
      terms.push(d);
      [n0, n1] = [d * n0 + n1, n0];
      [d0, d1] = [d * d0 + d1, d0];
      const frac = y - d;
      if (frac === 0 || Math.abs(x - n0 / d0) < Math.max(tol, Math.abs(x) * Number.EPSILON)) break;
      y = 1 / frac;
    }
    return { N: n0 * Math.sign(d0), D: Math.abs(d0), terms };
  };
  const ratTol = (X, args) => (args.length >= 2 ? args[1].toScalarNumber() : 1e-6 * Array.from(X.re).filter(Number.isFinite).reduce((s, v) => s + Math.abs(v), 0));
  reg.set('rat', {
    fn: (args, nargout) => {
      const X = requireReal(args[0], 'rat');
      const tol = ratTol(X, args);
      const results = Array.from(X.re, (x) => ratTerms(x, tol));
      if (nargout >= 2) {
        return [new Mat(X.rows, X.cols, Float64Array.from(results, r => r.N)), new Mat(X.rows, X.cols, Float64Array.from(results, r => r.D))];
      }
      if (X.isEmpty) return [Mat.empty()];
      // The expansion as text, one row per element (column order), as
      // MATLAB writes it: 3 + 1/(7 + 1/(16)).
      const lines = results.map(({ terms }) => {
        if (!Number.isFinite(terms[0])) return Number.isNaN(terms[0]) ? 'NaN' : terms[0] > 0 ? 'Inf' : '-Inf';
        return String(terms[0]) + terms.slice(1).map(t => ` + 1/(${t}`).join('') + ')'.repeat(terms.length - 1);
      });
      const width = Math.max(0, ...lines.map(l => l.length));
      const m = new Mat(lines.length, width, new Float64Array(lines.length * width).fill(32), null, { isChar: true });
      lines.forEach((l, r) => { for (let c = 0; c < l.length; c++) m.re[c * lines.length + r] = l.charCodeAt(c); });
      return [m];
    },
  });
  // rats(X) | rats(X, strlen): 'N/D' text for each element, centered in
  // fields of strlen + 1 characters (strlen defaults to 13).
  reg.set('rats', {
    fn: (args) => {
      const X = requireReal(args[0], 'rats');
      if (X.isEmpty) return [new Mat(0, 0, new Float64Array(0), null, { isChar: true })];
      const strlen = args.length >= 2 ? Math.max(1, Math.round(args[1].toScalarNumber()) || 1) : 13;
      const tol = 1e-6 * Array.from(X.re).filter(Number.isFinite).reduce((s, v) => s + Math.abs(v), 0);
      const fmt = (x) => {
        if (Number.isNaN(x)) return '0/0';
        if (!Number.isFinite(x)) return x > 0 ? '1/0' : '-1/0';
        const { N, D } = ratTerms(x, Math.max(tol / Math.max(X.numel, 1), Math.abs(x) * 1e-10));
        const s = D === 1 ? String(N) : `${N}/${D}`;
        return s.length > strlen ? '*' : s;
      };
      // Each value centered in a field of strlen + 1 characters, the odd
      // blank on the left, as MATLAB's rats does.
      const field = (s) => {
        const pad = strlen + 1 - s.length;
        return ' '.repeat(Math.max(0, Math.ceil(pad / 2))) + s + ' '.repeat(Math.max(0, Math.floor(pad / 2)));
      };
      const lines = [];
      for (let r = 0; r < X.rows; r++) {
        let line = '';
        for (let c = 0; c < X.cols; c++) line += field(fmt(X.re[c * X.rows + r]));
        lines.push(line);
      }
      const width = Math.max(0, ...lines.map(l => l.length));
      const m = new Mat(lines.length, width, new Float64Array(lines.length * width).fill(32), null, { isChar: true });
      lines.forEach((l, r) => { for (let c = 0; c < l.length; c++) m.re[c * lines.length + r] = l.charCodeAt(c); });
      return [m];
    },
  });

  // [q, r] = deconv(y, a): polynomial division, y = conv(a, q) + r.
  reg.set('deconv', {
    fn: (args, nargout) => {
      const y = vectorValues(requireReal(args[0], 'deconv')), a = vectorValues(requireReal(args[1], 'deconv'));
      if (!a.length || a[0] === 0) throw new MatlabError('deconv: first coefficient of the divisor must be nonzero');
      const nq = y.length - a.length + 1;
      if (nq < 1) return nargout >= 2 ? [Mat.scalar(0), rowOrColumn(args[0].cols === 1 && args[0].rows > 1, y)] : [Mat.scalar(0)];
      const r = y.slice(), q = new Array(nq).fill(0);
      for (let i = 0; i < nq; i++) {
        q[i] = r[i] / a[0];
        for (let j = 0; j < a.length; j++) r[i + j] -= q[i] * a[j];
      }
      for (let i = 0; i < nq; i++) r[i] = 0;
      const col = args[0].cols === 1 && args[0].rows > 1;
      return nargout >= 2 ? [rowOrColumn(col, q), rowOrColumn(col, r)] : [rowOrColumn(col, q)];
    },
  });

  // y = filter(b, a, x): rational transfer function b(z)/a(z) applied to x
  // (along the first non-singleton dimension, or dim).
  reg.set('filter', {
    fn: (args) => {
      const b = vectorValues(requireReal(args[0], 'filter')), a = vectorValues(requireReal(args[1], 'filter'));
      const x = requireReal(args[2], 'filter');
      if (args.length >= 4 && !args[3].isEmpty) throw new MatlabError('filter: initial conditions are not supported');
      const dim = args.length >= 5 ? dimArg(args[4]) : firstDim(x);
      if (!a.length || a[0] === 0) throw new MatlabError('filter: first denominator coefficient must be nonzero');
      const a0 = a[0];
      const bn = b.map(v => v / a0), an = a.map(v => v / a0);
      const len = dim === 1 ? x.rows : dim === 2 ? x.cols : 1;
      return [forEachLine(x, dim, len, (get, set, n) => {
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (let k = 0; k < bn.length && k <= i; k++) s += bn[k] * get(i - k);
          for (let k = 1; k < an.length && k <= i; k++) s -= an[k] * y[i - k];
          y[i] = s;
          set(i, s);
        }
      })];
    },
  });
}
