// linalg.js — size/shape utilities plus linear algebra, backed by math.js
// where it has the needed routine, and hand-implemented where it doesn't.
//
// Confirmed by direct probing of math.js 15.2.0: there is no top-level
// `svd` and no `rank`. Both are implemented here from scratch (one-sided
// Jacobi rotation SVD; Gaussian-elimination rank with a size-scaled
// tolerance) and cross-checked against NumPy during development — see
// README's "math.js limitations" section.

import * as math from 'mathjs';
import { Mat, Cell, StructArray, MatlabError, shape2D } from '../core/values.js';
import { _registerLinalgHooks, transposeContainer } from '../core/interpreter.js';

function toRowMajor(mat) {
  const rows = [];
  for (let r = 0; r < mat.rows; r++) {
    const row = [];
    for (let c = 0; c < mat.cols; c++) {
      const k = c * mat.rows + r;
      if (mat.isComplex && mat.im[k] !== 0) row.push(math.complex(mat.re[k], mat.im[k]));
      else row.push(mat.re[k]);
    }
    rows.push(row);
  }
  return rows;
}
function fromRowMajor(arr) {
  if (typeof arr === 'number') return Mat.scalar(arr);
  if (arr && arr.isComplex !== undefined && 're' in arr) return Mat.complexScalar(arr.re, arr.im);
  const rows = arr.length;
  const cols = rows > 0 && Array.isArray(arr[0]) ? arr[0].length : 1;
  const re = new Float64Array(rows * cols);
  let im = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = Array.isArray(arr[r]) ? arr[r][c] : arr[r];
      const k = c * rows + r;
      if (v && typeof v === 'object' && 're' in v) {
        re[k] = v.re;
        if (v.im !== 0) { if (!im) im = new Float64Array(rows * cols); im[k] = v.im; }
      } else {
        re[k] = v;
      }
    }
  }
  return new Mat(rows, cols, re, im);
}
function asComplexPair(v) {
  if (v && typeof v === 'object' && 're' in v) return [v.re, v.im];
  return [v, 0];
}

function requireSquare(mat, fname) {
  if (mat.rows !== mat.cols) throw new MatlabError(`${fname}: expected a square matrix, got ${mat.sizeStr()}`);
}

// ---------------- rank (Gaussian elimination, real matrices) ----------------
export function computeRank(mat) {
  if (mat.isComplex) throw new MatlabError('rank() of a complex matrix is not supported in this app; try rank(real(A)) or rank(abs(A)) as an approximation');
  const m = mat.rows, n = mat.cols;
  const a = [];
  for (let r = 0; r < m; r++) { const row = []; for (let c = 0; c < n; c++) row.push(mat.get2(r, c)); a.push(row); }
  let maxAbs = 0;
  for (const row of a) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  const tol = Math.max(m, n) * Number.EPSILON * (maxAbs || 1);
  let rank = 0;
  for (let col = 0; col < n && rank < m; col++) {
    let pivotRow = -1, pivotVal = tol;
    for (let r = rank; r < m; r++) if (Math.abs(a[r][col]) > pivotVal) { pivotVal = Math.abs(a[r][col]); pivotRow = r; }
    if (pivotRow === -1) continue;
    [a[rank], a[pivotRow]] = [a[pivotRow], a[rank]];
    for (let r = 0; r < m; r++) {
      if (r === rank) continue;
      const factor = a[r][col] / a[rank][col];
      if (factor === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= factor * a[rank][c];
    }
    rank++;
  }
  return rank;
}

// ---------------- SVD (one-sided Jacobi rotation, real matrices) ----------------
// Classic one-sided Jacobi SVD: iteratively rotate pairs of columns of a
// working copy of A until they're numerically orthogonal; singular values
// are the resulting column norms, left singular vectors are the
// normalized columns, right singular vectors accumulate in V.
export function computeSVD(mat) {
  if (mat.isComplex) throw new MatlabError('svd() of a complex matrix is not supported in this app');
  const m = mat.rows, n = mat.cols;
  const transposed = m < n;
  let rows = transposed ? n : m, cols = transposed ? m : n;
  // work in column-major flat arrays for speed
  const U = new Float64Array(rows * cols);
  if (!transposed) {
    for (let c = 0; c < n; c++) for (let r = 0; r < m; r++) U[c * m + r] = mat.get2(r, c);
  } else {
    for (let c = 0; c < m; c++) for (let r = 0; r < n; r++) U[c * n + r] = mat.get2(c, r); // A^T
  }
  const V = new Float64Array(cols * cols);
  for (let k = 0; k < cols; k++) V[k * cols + k] = 1;

  const colDot = (a, i, j) => { let s = 0; for (let r = 0; r < rows; r++) s += a[i * rows + r] * a[j * rows + r]; return s; };
  const rotateCols = (a, nrows, i, j, c, s) => {
    for (let r = 0; r < nrows; r++) {
      const ai = a[i * nrows + r], aj = a[j * nrows + r];
      a[i * nrows + r] = c * ai - s * aj;
      a[j * nrows + r] = s * ai + c * aj;
    }
  };

  const maxSweeps = 60;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let offDiag = 0;
    for (let i = 0; i < cols - 1; i++) {
      for (let j = i + 1; j < cols; j++) {
        const alpha = colDot(U, i, i), beta = colDot(U, j, j), gamma = colDot(U, i, j);
        offDiag += gamma * gamma;
        if (Math.abs(gamma) < 1e-15 * Math.sqrt(alpha * beta || 1)) continue;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t), s = c * t;
        rotateCols(U, rows, i, j, c, s);
        rotateCols(V, cols, i, j, c, s);
      }
    }
    if (offDiag < 1e-30) break;
  }

  const sVals = [];
  for (let k = 0; k < cols; k++) {
    let norm = 0;
    for (let r = 0; r < rows; r++) norm += U[k * rows + r] * U[k * rows + r];
    sVals.push(Math.sqrt(norm));
  }
  // normalize U columns (guard against zero singular values)
  for (let k = 0; k < cols; k++) {
    const nrm = sVals[k] || 1;
    for (let r = 0; r < rows; r++) U[k * rows + r] /= nrm;
  }
  // sort descending
  const order = sVals.map((v, i) => i).sort((a, b) => sVals[b] - sVals[a]);
  const sSorted = order.map(i => sVals[i]);
  const Usorted = new Float64Array(rows * cols);
  const Vsorted = new Float64Array(cols * cols);
  order.forEach((srcCol, dstCol) => {
    for (let r = 0; r < rows; r++) Usorted[dstCol * rows + r] = U[srcCol * rows + r];
    for (let r = 0; r < cols; r++) Vsorted[dstCol * cols + r] = V[srcCol * cols + r];
  });

  let Umat = new Mat(rows, cols, Usorted);
  let Vmat = new Mat(cols, cols, Vsorted);
  if (transposed) { const tmp = Umat; Umat = Vmat; Vmat = tmp; }
  const Smat = Mat.zeros(transposed ? n : m, transposed ? m : n);
  for (let k = 0; k < sSorted.length; k++) Smat.set2(k, k, sSorted[k]);
  return { U: Umat, S: Smat, V: Vmat, singularValues: sSorted };
}

// ---------------- LU factorization (real, square) ----------------
// Gaussian elimination with partial pivoting, as LAPACK's dgetrf does: a
// zero pivot column is skipped (the factor is then singular), and the
// triangular solves skip zero entries the way BLAS's dtrsv does, so
// NaN/Inf propagate like MATLAB's.
function luFactor(a) {
  const n = a.rows;
  const LU = Float64Array.from(a.re); // column-major
  const piv = Array.from({ length: n }, (_, i) => i);
  let singular = false;
  for (let k = 0; k < n; k++) {
    let p = k, best = -1;
    for (let i = k; i < n; i++) {
      const v = Math.abs(LU[k * n + i]);
      if (v > best) { best = v; p = i; }
      else if (Number.isNaN(v) && best < 0) p = i;
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) { const t = LU[j * n + k]; LU[j * n + k] = LU[j * n + p]; LU[j * n + p] = t; }
      [piv[k], piv[p]] = [piv[p], piv[k]];
    }
    const pivot = LU[k * n + k];
    if (pivot === 0) { singular = true; continue; }
    for (let i = k + 1; i < n; i++) {
      const l = LU[k * n + i] / pivot;
      LU[k * n + i] = l;
      if (l !== 0) for (let j = k + 1; j < n; j++) LU[j * n + i] -= l * LU[j * n + k];
    }
  }
  return { n, LU, piv, singular };
}

function luSolve({ n, LU, piv }, b) {
  const m = b.cols;
  const x = new Float64Array(n * m);
  for (let c = 0; c < m; c++) {
    const y = piv.map(i => b.re[c * n + i]);
    for (let j = 0; j < n; j++) { // unit lower triangle
      if (y[j] === 0) continue;
      for (let i = j + 1; i < n; i++) y[i] -= y[j] * LU[j * n + i];
    }
    for (let j = n - 1; j >= 0; j--) { // upper triangle
      if (y[j] === 0) continue;
      y[j] /= LU[j * n + j];
      for (let i = 0; i < j; i++) y[i] -= y[j] * LU[j * n + i];
    }
    x.set(y, c * n);
  }
  return new Mat(n, m, x);
}

// MATLAB's "close to singular" warning: the reciprocal condition number
// (in the 1-norm) below eps. invA is A's inverse when already known.
function conditionWarning(a, lu, invA) {
  const n = a.rows;
  if (n === 0 || n > 400 || !Array.from(a.re).every(Number.isFinite)) return null;
  const norm1 = (M) => {
    let best = 0;
    for (let c = 0; c < M.cols; c++) { let s = 0; for (let r = 0; r < M.rows; r++) s += Math.abs(M.re[c * M.rows + r]); best = Math.max(best, s); }
    return best;
  };
  let inv = invA;
  if (!inv) {
    const I = new Mat(n, n, new Float64Array(n * n));
    for (let k = 0; k < n; k++) I.re[k * n + k] = 1;
    inv = luSolve(lu, I);
  }
  const rcond = 1 / (norm1(a) * norm1(inv));
  if (!(rcond < Number.EPSILON)) return null;
  const r = rcond.toExponential(6).replace(/e([+-])(\d)$/, 'e$10$2');
  return { message: `Matrix is close to singular or badly scaled. Results may be inaccurate. RCOND = ${r}.`, identifier: 'MATLAB:nearlySingularMatrix' };
}

export function registerLinalg(reg) {
  reg.set('size', {
    fn: (args, nargout) => {
      const a = args[0];
      const sizeOf = (d) => (d === 1 ? a.rows : d === 2 ? a.cols : 1); // dims 3+ are singletons
      if (args.length >= 2) {
        // size(A, dim) | size(A, [d1 d2 ...]) | size(A, d1, d2, ...)
        const dims = args.slice(1).flatMap(v => Array.from(v.re));
        for (const d of dims) if (!Number.isInteger(d) || d < 1) throw new MatlabError('size: dimension argument must be a positive integer');
        const sizes = dims.map(sizeOf);
        if (nargout >= 2) {
          if (nargout > sizes.length) throw new MatlabError('size: more outputs than requested dimensions');
          return sizes.map(n => Mat.scalar(n));
        }
        return [Mat.fromRows([sizes])];
      }
      // [r, c, p, ...] = size(A): outputs past the second are 1.
      if (nargout >= 2) return Array.from({ length: nargout }, (_, k) => Mat.scalar(sizeOf(k + 1)));
      return [Mat.fromRows([[a.rows, a.cols]])];
    },
  });
  reg.set('length', { fn: (args) => [Mat.scalar(args[0].isEmpty ? 0 : Math.max(args[0].rows, args[0].cols))] });
  reg.set('numel', { fn: (args) => [Mat.scalar(args[0].numel)] });
  reg.set('ndims', { fn: () => [Mat.scalar(2)] });
  reg.set('isrow', { fn: (args) => [Mat.logicalScalar(args[0].rows === 1)] });
  reg.set('iscolumn', { fn: (args) => [Mat.logicalScalar(args[0].cols === 1)] });
  reg.set('isvector', { fn: (args) => [Mat.logicalScalar(args[0].isVector)] });
  reg.set('isscalar', { fn: (args) => [Mat.logicalScalar(args[0].isScalar)] });
  reg.set('ismatrix', { fn: () => [Mat.logicalScalar(true)] });
  reg.set('isempty', { fn: (args) => [Mat.logicalScalar(args[0].isEmpty)] });

  reg.set('reshape', {
    fn: (args) => {
      const a = args[0];
      // reshape(A, [m n ...]) | reshape(A, m, n, ...), with at most one []
      // size worked out from the others.
      let dims;
      if (args.length === 2 && args[1].numel >= 2) dims = Array.from(args[1].re);
      else if (args.length >= 3) dims = args.slice(1).map(v => (v.isEmpty ? null : v.toScalarNumber()));
      else throw new MatlabError('reshape expects reshape(A, m, n) or reshape(A, [m n])');
      const free = dims.filter(d => d === null).length;
      if (free > 1) throw new MatlabError('reshape: only one size can be []');
      if (free === 1) {
        const known = dims.reduce((p, d) => (d === null ? p : p * d), 1);
        if (known === 0 || a.numel % known !== 0) throw new MatlabError(`reshape: ${a.numel} elements cannot be divided evenly by the given sizes`);
        dims = dims.map(d => (d === null ? a.numel / known : d));
      }
      const [r, c] = shape2D(dims, 'reshape');
      if (r * c !== a.numel) throw new MatlabError(`reshape: cannot reshape ${a.sizeStr()} (${a.numel} elements) to ${r}x${c}`);
      if (a instanceof Cell) return [new Cell(r, c, a.data.slice())];
      if (a instanceof StructArray) return [new StructArray(r, c, a.fieldNames, a.data.map(el => new Map(el)), a.classOverride)];
      // Copy the data: values are modified in place by indexed assignment
      // (copy-on-write), so two arrays must never share a buffer.
      const out = new Mat(r, c, Float64Array.from(a.re), a.im ? Float64Array.from(a.im) : null, { isChar: a.isChar, isLogical: a.isLogical });
      return [out];
    },
  });

  reg.set('diag', {
    fn: (args) => {
      const a = args[0];
      const k = args.length >= 2 ? Math.round(args[1].toScalarNumber()) : 0;
      if (a.isVector && a.numel > 1) {
        const n = a.numel + Math.abs(k);
        const out = Mat.zeros(n, n);
        for (let i = 0; i < a.numel; i++) {
          const r = k >= 0 ? i : i - k, c = k >= 0 ? i + k : i;
          out.set2(r, c, a.re[i], a.isComplex ? a.im[i] : 0);
        }
        return [out];
      }
      const len = Math.max(0, Math.min(a.rows - (k < 0 ? -k : 0), a.cols - (k > 0 ? k : 0)));
      const re = new Float64Array(len);
      const im = a.isComplex ? new Float64Array(len) : null;
      for (let i = 0; i < len; i++) {
        const r = k >= 0 ? i : i - k, c = k >= 0 ? i + k : i;
        re[i] = a.get2(r, c);
        if (im) im[i] = a.isComplex ? a.im[c * a.rows + r] : 0;
      }
      return [new Mat(len, 1, re, im)];
    },
  });

  function triFilter(mat, k, keepUpper) {
    const out = mat.clone();
    for (let c = 0; c < mat.cols; c++) {
      for (let r = 0; r < mat.rows; r++) {
        const keep = keepUpper ? (c - r >= k) : (c - r <= k);
        if (!keep) out.set2(r, c, 0, 0);
      }
    }
    return out;
  }
  reg.set('triu', { fn: (args) => [triFilter(args[0], args.length >= 2 ? Math.round(args[1].toScalarNumber()) : 0, true)] });
  reg.set('tril', { fn: (args) => [triFilter(args[0], args.length >= 2 ? Math.round(args[1].toScalarNumber()) : 0, false)] });

  function transposeGeneric(v, conjugate) {
    const re = new Float64Array(v.numel);
    const im = v.isComplex ? new Float64Array(v.numel) : null;
    for (let r = 0; r < v.rows; r++) for (let c = 0; c < v.cols; c++) {
      const src = c * v.rows + r, dst = r * v.cols + c;
      re[dst] = v.re[src];
      if (im) im[dst] = conjugate ? -v.im[src] : v.im[src];
    }
    return new Mat(v.cols, v.rows, re, im, { isChar: v.isChar, isLogical: v.isLogical });
  }
  const transposeAny = (v, conj) => (v instanceof Cell || v instanceof StructArray) ? transposeContainer(v) : transposeGeneric(v, conj);
  reg.set('transpose', { fn: (args) => [transposeAny(args[0], false)] });
  reg.set('ctranspose', { fn: (args) => [transposeAny(args[0], true)] });

  reg.set('det', { fn: (args) => { requireSquare(args[0], 'det'); return [fromRowMajor(math.det(toRowMajor(args[0])))]; } });
  reg.set('trace', {
    fn: (args) => {
      const a = args[0]; requireSquare(a, 'trace');
      let re = 0, im = 0;
      for (let k = 0; k < a.rows; k++) { re += a.get2(k, k) && a.re[k * a.rows + k]; }
      re = 0; im = 0;
      for (let k = 0; k < a.rows; k++) { re += a.re[k * a.rows + k]; if (a.isComplex) im += a.im[k * a.rows + k]; }
      return [im !== 0 ? Mat.complexScalar(re, im) : Mat.scalar(re)];
    },
  });
  reg.set('rank', { fn: (args) => [Mat.scalar(computeRank(args[0]))] });
  reg.set('inv', { fn: (args, _n, ctx) => [ctx.interp.reportWarnings(inverse(args[0]))] });
  reg.set('pinv', { fn: (args) => [fromRowMajor(math.pinv(toRowMajor(args[0])))] });

  reg.set('dot', {
    fn: (args) => {
      const a = args[0], b = args[1];
      if (a.numel !== b.numel) throw new MatlabError('dot: vectors must have the same length');
      let re = 0, im = 0;
      for (let k = 0; k < a.numel; k++) {
        const ar = a.re[k], ai = a.isComplex ? -a.im[k] : 0; // conj(a)
        const br = b.re[k], bi = b.isComplex ? b.im[k] : 0;
        re += ar * br - ai * bi;
        im += ar * bi + ai * br;
      }
      return [im !== 0 ? Mat.complexScalar(re, im) : Mat.scalar(re)];
    },
  });
  reg.set('cross', {
    fn: (args) => {
      const a = args[0], b = args[1];
      if (a.numel !== 3 || b.numel !== 3) throw new MatlabError('cross: both inputs must have 3 elements');
      const [a1, a2, a3] = [a.re[0], a.re[1], a.re[2]];
      const [b1, b2, b3] = [b.re[0], b.re[1], b.re[2]];
      const out = [a2 * b3 - a3 * b2, a3 * b1 - a1 * b3, a1 * b2 - a2 * b1];
      const isRow = a.rows === 1;
      return [isRow ? Mat.fromRows([out]) : new Mat(3, 1, Float64Array.from(out))];
    },
  });

  reg.set('norm', {
    fn: (args) => {
      const a = args[0];
      const pArg = args.length >= 2 ? args[1] : null;
      const isVec = a.isVector;
      let p = 2, frob = false, infNorm = false;
      if (pArg) {
        if (pArg.isChar && pArg.toJSString().toLowerCase() === 'fro') frob = true;
        else {
          const v = pArg.toScalarNumber();
          if (v === Infinity) infNorm = true; else p = v;
        }
      }
      if (isVec || frob) {
        let s = 0, mx = 0;
        for (let k = 0; k < a.numel; k++) {
          const r = a.re[k], i = a.isComplex ? a.im[k] : 0;
          const mag = Math.hypot(r, i);
          mx = Math.max(mx, mag);
          if (!infNorm && !frob) s += Math.pow(mag, p);
          if (frob) s += mag * mag;
        }
        if (infNorm) return [Mat.scalar(mx)];
        if (frob) return [Mat.scalar(Math.sqrt(s))];
        return [Mat.scalar(Math.pow(s, 1 / p))];
      }
      // matrix norms
      if (infNorm) {
        let mx = 0;
        for (let r = 0; r < a.rows; r++) { let s = 0; for (let c = 0; c < a.cols; c++) s += Math.abs(a.get2(r, c)); mx = Math.max(mx, s); }
        return [Mat.scalar(mx)];
      }
      if (p === 1) {
        let mx = 0;
        for (let c = 0; c < a.cols; c++) { let s = 0; for (let r = 0; r < a.rows; r++) s += Math.abs(a.get2(r, c)); mx = Math.max(mx, s); }
        return [Mat.scalar(mx)];
      }
      // default (p=2): largest singular value
      const { singularValues } = computeSVD(a);
      return [Mat.scalar(singularValues[0] || 0)];
    },
  });

  reg.set('eig', {
    fn: (args, nargout) => {
      const a = args[0]; requireSquare(a, 'eig');
      const result = math.eigs(toRowMajor(a), { eigenvectors: nargout >= 2 });
      const values = result.values;
      if (nargout < 2) {
        const n = values.length;
        const re = new Float64Array(n);
        let im = null;
        for (let k = 0; k < n; k++) {
          const [r, i] = asComplexPair(values.valueOf ? values.valueOf()[k] : values[k]);
          re[k] = r; if (i !== 0) { if (!im) im = new Float64Array(n); im[k] = i; }
        }
        return [new Mat(n, 1, re, im)];
      }
      const evecs = result.eigenvectors; // [{value, vector}]
      const n = evecs.length;
      const V = Mat.zeros(n, n); V.im = new Float64Array(n * n);
      const D = Mat.zeros(n, n); D.im = new Float64Array(n * n);
      evecs.forEach((ev, col) => {
        const [dr, di] = asComplexPair(ev.value);
        D.re[col * n + col] = dr; D.im[col * n + col] = di;
        const vec = ev.vector.valueOf ? ev.vector.valueOf() : ev.vector;
        vec.forEach((v, row) => { const [vr, vi] = asComplexPair(v); V.re[col * n + row] = vr; V.im[col * n + row] = vi; });
      });
      if (V.im.every(x => x === 0)) V.im = null;
      if (D.im.every(x => x === 0)) D.im = null;
      return [V, D];
    },
  });

  reg.set('svd', {
    fn: (args, nargout) => {
      const { U, S, V } = computeSVD(args[0]);
      if (nargout < 2) return [new Mat(S.rows, 1, (() => { const n = Math.min(S.rows, S.cols); const re = new Float64Array(n); for (let k = 0; k < n; k++) re[k] = S.re[k * S.rows + k]; return re; })())];
      return [U, S, V];
    },
  });

  reg.set('lu', {
    fn: (args, nargout) => {
      const a = args[0]; requireSquare(a, 'lu');
      const { L, U, p } = math.lup(toRowMajor(a));
      const n = a.rows;
      const Lmat = fromRowMajor(L.valueOf ? L.valueOf() : L);
      const Umat = fromRowMajor(U.valueOf ? U.valueOf() : U);
      const perm = p.valueOf ? p.valueOf() : p;
      if (nargout >= 3) {
        const P = Mat.zeros(n, n);
        perm.forEach((srcRow, dstRow) => { P.set2(dstRow, srcRow, 1); });
        return [Lmat, Umat, P];
      }
      // 2-output form: undo the permutation on L so that A = L*U directly
      const L2 = Mat.zeros(n, n);
      perm.forEach((srcRow, dstRow) => {
        for (let c = 0; c < n; c++) L2.set2(srcRow, c, Lmat.get2(dstRow, c));
      });
      return [L2, Umat];
    },
  });

  reg.set('qr', {
    fn: (args) => {
      const { Q, R } = math.qr(toRowMajor(args[0]));
      return [fromRowMajor(Q.valueOf ? Q.valueOf() : Q), fromRowMajor(R.valueOf ? R.valueOf() : R)];
    },
  });

  // ---- backend hooks used by the `\`, `/`, and `^` operators ----
  function inverse(a) {
    requireSquare(a, 'inv');
    if (a.isComplex) return fromRowMajor(math.inv(toRowMajor(a)));
    const n = a.rows;
    const lu = luFactor(a);
    if (lu.singular) {
      // MATLAB: an exactly singular matrix has an all-Inf inverse, with a warning.
      const out = new Mat(n, n, new Float64Array(n * n).fill(Infinity));
      out.warnings = [{ message: 'Matrix is singular to working precision.', identifier: 'MATLAB:singularMatrix' }];
      return out;
    }
    const I = new Mat(n, n, new Float64Array(n * n));
    for (let k = 0; k < n; k++) I.re[k * n + k] = 1;
    const out = luSolve(lu, I);
    const w = conditionWarning(a, lu, out);
    if (w) out.warnings = [w];
    return out;
  }
  // math.js's lusolve only accepts a single-column right-hand side (verified
  // directly: passing a multi-column matrix throws "Matrix columns must
  // match vector length"), so for A\B with a matrix B we solve column by
  // column and reassemble. Entries may be math.js Complex values, so the
  // result keeps imaginary parts rather than dropping them.
  function solve(a, b) {
    if (a.rows !== b.rows) throw new MatlabError(`Matrix dimensions must agree for A\\b (${a.sizeStr()} vs ${b.sizeStr()})`);
    if (a.rows === a.cols && !a.isComplex && !b.isComplex) {
      // Square and real: LU with partial pivoting (NaN and Inf propagate as
      // in MATLAB; a singular matrix gives Inf/NaN and a warning).
      const lu = luFactor(a);
      const x = luSolve(lu, b);
      const w = lu.singular ? { message: 'Matrix is singular to working precision.', identifier: 'MATLAB:singularMatrix' } : conditionWarning(a, lu, null);
      if (w) x.warnings = [w];
      return x;
    }
    let A = toRowMajor(a), B = toRowMajor(b);
    if (a.rows !== a.cols) {
      // Overdetermined/underdetermined: least-squares via the normal
      // equations A'A x = A'b, with A' the conjugate transpose. (Less
      // numerically stable than MATLAB's QR-based mldivide — see README.)
      const Ah = math.ctranspose(A);
      A = math.multiply(Ah, A);
      B = math.multiply(Ah, B);
    }
    const n = a.cols, m = b.cols;
    const re = new Float64Array(n * m);
    let im = null;
    for (let c = 0; c < m; c++) {
      let x;
      try {
        x = math.lusolve(A, B.map(row => row[c]));
      } catch (e) {
        throw new MatlabError(`A\\b failed to solve (matrix may be singular): ${e.message}`);
      }
      (x.valueOf ? x.valueOf() : x).forEach((row, r) => {
        const [vr, vi] = asComplexPair(Array.isArray(row) ? row[0] : row);
        re[c * n + r] = vr;
        if (vi !== 0) { if (!im) im = new Float64Array(n * m); im[c * n + r] = vi; }
      });
    }
    return new Mat(n, m, re, im);
  }
  // ---- matrix functions and decompositions ----
  reg.set('expm', {
    fn: (args) => { requireSquare(args[0], 'expm'); return [fromRowMajor(math.expm(math.matrix(toRowMajor(args[0]))).valueOf())]; },
  });
  // sqrtm: math.js's Denman–Beavers iteration; matrices it can't handle
  // (e.g. negative eigenvalues, whose square root is complex) go through
  // the eigendecomposition V*sqrt(D)/V.
  reg.set('sqrtm', {
    fn: (args) => {
      const a = args[0]; requireSquare(a, 'sqrtm');
      try {
        const r = fromRowMajor(math.sqrtm(math.matrix(toRowMajor(a))).valueOf());
        if (Array.from(r.re).every(Number.isFinite)) return [r];
      } catch (e) { /* fall through */ }
      const { eigenvectors } = math.eigs(toRowMajor(a), { eigenvectors: true });
      const n = a.rows;
      const V = math.matrix(Array.from({ length: n }, (_, r) => eigenvectors.map(ev => (ev.vector.valueOf ? ev.vector.valueOf() : ev.vector)[r])));
      const D = math.diag(eigenvectors.map(ev => math.sqrt(math.complex(ev.value))));
      const out = fromRowMajor(math.multiply(math.multiply(V, D), math.inv(V)).valueOf());
      if (out.im && out.im.every(x => Math.abs(x) <= 1e-12 * Math.max(1, ...Array.from(out.re, Math.abs)))) out.im = null;
      return [out];
    },
  });

  // R = chol(A) (upper, R'*R = A) | chol(A, 'lower') | [R, p] = chol(A)
  reg.set('chol', {
    fn: (args, nargout) => {
      const a = args[0]; requireSquare(a, 'chol');
      if (a.isComplex) throw new MatlabError('chol: complex matrices are not supported');
      const lower = args.length >= 2 && args[1].isChar && args[1].toJSString().toLowerCase() === 'lower';
      const n = a.rows;
      const R = Mat.zeros(n, n);
      let fail = 0;
      // Uses the upper triangle of A, as MATLAB does.
      for (let j = 0; j < n && !fail; j++) {
        let d = a.get2(j, j);
        for (let k = 0; k < j; k++) d -= R.get2(k, j) ** 2;
        if (!(d > 0)) { fail = j + 1; break; }
        const rjj = Math.sqrt(d);
        R.set2(j, j, rjj);
        for (let i = j + 1; i < n; i++) {
          let v = a.get2(j, i);
          for (let k = 0; k < j; k++) v -= R.get2(k, j) * R.get2(k, i);
          R.set2(j, i, v / rjj);
        }
      }
      if (fail && nargout < 2) throw new MatlabError('Matrix must be positive definite.');
      const q = fail ? fail - 1 : n; // the leading block that factored
      let out = R;
      if (fail) {
        out = Mat.zeros(q, q);
        for (let c = 0; c < q; c++) for (let r = 0; r <= c; r++) out.set2(r, c, R.get2(r, c));
      }
      if (lower) out = transposeAny(out, false);
      return nargout >= 2 ? [out, Mat.scalar(fail)] : [out];
    },
  });

  // cond(A) (2-norm, from the singular values) | cond(A, p) for p = 1, Inf, 'fro'
  reg.set('cond', {
    fn: (args, nargout, ctx) => {
      const a = args[0];
      if (a.isEmpty) return [Mat.scalar(0)];
      if (args.length < 2 || (!args[1].isChar && args[1].toScalarNumber() === 2)) {
        const s = computeSVD(a).singularValues;
        const smin = s[s.length - 1];
        return [Mat.scalar(smin === 0 ? Infinity : s[0] / smin)];
      }
      requireSquare(a, 'cond');
      const norm = ctx.interp.builtins.get('norm').fn;
      let inv;
      try { inv = fromRowMajor(math.inv(toRowMajor(a))); } catch (e) { return [Mat.scalar(Infinity)]; }
      return [Mat.scalar(norm([a, args[1]])[0].re[0] * norm([inv, args[1]])[0].re[0])];
    },
  });

  // Orthonormal bases from the SVD: orth(A) spans the range, null(A) the
  // null space. Rank uses MATLAB's tolerance max(size(A))*eps(max(s)).
  const rangeAndRank = (a) => {
    const { U, V, singularValues: s } = computeSVD(a);
    const smax = s.length ? s[0] : 0;
    const tol = Math.max(a.rows, a.cols) * (smax === 0 ? 0 : 2 ** (Math.floor(Math.log2(smax)) - 52));
    return { U, V, r: s.filter(v => v > tol).length };
  };
  const columnsOf = (M, count) => {
    const out = Mat.zeros(M.rows, count);
    out.re.set(M.re.subarray(0, M.rows * count));
    return out;
  };
  reg.set('orth', {
    fn: (args) => {
      if (args[0].isComplex) throw new MatlabError('orth: complex matrices are not supported');
      const { U, r } = rangeAndRank(args[0]);
      return [columnsOf(U, r)];
    },
  });
  reg.set('null', {
    fn: (args) => {
      const a = args[0];
      if (a.isComplex) throw new MatlabError('null: complex matrices are not supported');
      const n = a.cols;
      const { V, r } = rangeAndRank(a);
      // V's first r columns span the row space; complete them to an
      // orthonormal basis of R^n and keep the new vectors (the null space).
      const basis = [];
      for (let c = 0; c < r; c++) basis.push(Array.from(V.re.subarray(c * n, (c + 1) * n)));
      const out = [];
      for (let j = 0; j < n && basis.length < n; j++) {
        let v = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
        for (let pass = 0; pass < 2; pass++) {
          for (const b of basis) {
            const d = b.reduce((acc, bi, i) => acc + bi * v[i], 0);
            v = v.map((vi, i) => vi - d * b[i]);
          }
        }
        const len = Math.hypot(...v);
        if (len > 1e-6) { v = v.map(x => x / len); basis.push(v); out.push(v); }
      }
      const N = Mat.zeros(n, out.length);
      out.forEach((v, c) => v.forEach((x, i) => { N.re[c * n + i] = Math.abs(x) < 1e-15 ? 0 : x; }));
      return [N];
    },
  });

  _registerLinalgHooks({ inverse, solve });
}
