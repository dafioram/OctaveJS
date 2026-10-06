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
import { finiteScalarArg } from './numutil.js';
import { householderQR, formQ, formR, qrSolve } from './qr.js';
import { doSprintf } from './format.js';

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

// ---------------- SVD (one-sided Jacobi rotation, real matrices) ----------------
// Classic one-sided Jacobi SVD: iteratively rotate pairs of columns of a
// working copy of A until they're numerically orthogonal; singular values
// are the resulting column norms, left singular vectors are the
// normalized columns, right singular vectors accumulate in V.
// Extends orthonormal vectors (arrays of length n) to `count` orthonormal
// vectors by Gram-Schmidt (twice, for accuracy) on the standard basis.
function completeBasis(vectors, n, count) {
  const basis = vectors.map(v => Array.from(v));
  for (let j = 0; j < n && basis.length < count; j++) {
    let v = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    for (let pass = 0; pass < 2; pass++) {
      for (const b of basis) {
        const d = b.reduce((acc, bi, i) => acc + bi * v[i], 0);
        v = v.map((vi, i) => vi - d * b[i]);
      }
    }
    const len = Math.hypot(...v);
    if (len > 1e-6) basis.push(v.map(x => x / len));
  }
  return basis;
}

function identity(n) {
  const I = Mat.zeros(n, n);
  for (let k = 0; k < n; k++) I.re[k * n + k] = 1;
  return I;
}

// Singular values of any matrix. A complex A = B + iC has the singular
// values of the real [B -C; C B], each appearing twice.
export function singularValues(mat) {
  if (!mat.isComplex) return computeSVD(mat).singularValues;
  const m = mat.rows, n = mat.cols;
  const E = Mat.zeros(2 * m, 2 * n);
  for (let c = 0; c < n; c++) for (let r = 0; r < m; r++) {
    const re = mat.re[c * m + r], im = mat.im[c * m + r];
    E.set2(r, c, re); E.set2(r + m, c + n, re);
    E.set2(r + m, c, im); E.set2(r, c + n, -im);
  }
  return computeSVD(E).singularValues.filter((_, k) => k % 2 === 0);
}

// The Moore-Penrose pseudoinverse of a real matrix from its SVD; tolArg is
// pinv's optional tolerance (an empty or NaN tolerance keeps nothing).
function pseudoInverse(a, tolArg) {
  const { U, V, singularValues: s } = computeSVD(a, true);
  const m = a.rows, n = a.cols;
  let tol;
  if (tolArg === undefined) tol = Math.max(m, n) * (s[0] > 0 ? 2 ** (Math.floor(Math.log2(s[0])) - 52) : 0);
  else tol = tolArg.isEmpty ? Infinity : tolArg.toScalarNumber();
  const out = Mat.zeros(n, m);
  s.forEach((sv, k) => {
    if (!(sv > tol)) return;
    for (let c = 0; c < m; c++) {
      const u = U.re[k * m + c] / sv;
      if (u === 0) continue;
      for (let r = 0; r < n; r++) out.re[c * n + r] += V.re[k * n + r] * u;
    }
  });
  return out;
}

// One-sided Jacobi SVD. U and V are full square orthonormal matrices
// (columns for zero singular values completed to an orthonormal basis) and
// S is m-by-n, as MATLAB's [U, S, V] = svd(A); with `econ`, MATLAB's
// economy size (U m-by-k, S k-by-k, V n-by-k for k = min(m, n)).
export function computeSVD(mat, econ = false) {
  if (mat.isComplex) throw new MatlabError('[U, S, V] = svd(A) of a complex matrix is not supported in this app (svd(A), norm and cond are)');
  const m = mat.rows, n = mat.cols;
  if (m === 0 || n === 0) {
    return econ ? { U: Mat.zeros(m, 0), S: Mat.zeros(0, 0), V: Mat.zeros(n, 0), singularValues: [] }
      : { U: identity(m), S: Mat.zeros(m, n), V: identity(n), singularValues: [] };
  }
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

  // Columns of U for (numerically) zero singular values are not
  // meaningful; replace them, and extend U to a square basis.
  const tol = Math.max(rows, cols) * Number.EPSILON * (sSorted[0] || 0);
  const kept = [];
  for (let k = 0; k < cols && sSorted[k] > tol; k++) kept.push(Usorted.subarray(k * rows, (k + 1) * rows));
  const full = completeBasis(kept, rows, econ ? cols : rows);
  const Ufull = Mat.zeros(rows, full.length);
  full.forEach((v, c) => Ufull.re.set(v, c * rows));
  let Umat = Ufull;
  let Vmat = new Mat(cols, cols, Vsorted);
  if (transposed) { const tmp = Umat; Umat = Vmat; Vmat = tmp; }
  const k = sSorted.length;
  const Smat = econ ? Mat.zeros(k, k) : Mat.zeros(m, n);
  for (let i = 0; i < k; i++) Smat.set2(i, i, sSorted[i]);
  return { U: Umat, S: Smat, V: Vmat, singularValues: sSorted };
}

// ---------------- eigenvalues of a real general matrix ----------------
// Balancing (Parlett-Reinsch, as LAPACK's dgebal), reduction to upper
// Hessenberg form by Householder reflections and the Francis double-shift
// QR iteration, with back-substitution for the eigenvectors: EISPACK's
// orthes/hqr2 as ported in JAMA. Used for nonsymmetric matrices, where
// math.js's eigs can fail to converge (e.g. on the companion matrices built
// by roots) and starts its eigenvector iteration from random vectors.
// Returns the eigenvalues { re, im } and, with `vectors`, the eigenvectors
// as { Vre, Vim } (column-major n-by-n), each of unit 2-norm with its
// largest component real, as LAPACK's dgeev normalizes them.
function realEigen(a, vectors = false) {
  const nn = a.rows;
  const H = Array.from({ length: nn }, (_, i) => Array.from({ length: nn }, (_, j) => a.re[j * nn + i]));
  // balance: H = D^-1 * A * D
  const scale = new Float64Array(nn).fill(1);
  for (let done = false; !done;) {
    done = true;
    for (let i = 0; i < nn; i++) {
      let c = 0, r = 0;
      for (let j = 0; j < nn; j++) if (j !== i) { c += Math.abs(H[j][i]); r += Math.abs(H[i][j]); }
      if (c === 0 || r === 0) continue;
      const s = c + r;
      let f = 1, g = r / 2;
      while (c < g) { f *= 2; c *= 4; }
      g = r * 2;
      while (c > g) { f /= 2; c /= 4; }
      if ((c + r) / f < 0.95 * s) {
        done = false;
        scale[i] *= f;
        for (let j = 0; j < nn; j++) { H[i][j] /= f; H[j][i] *= f; }
      }
    }
  }
  // orthes: Householder reduction to Hessenberg form
  const ort = new Float64Array(nn);
  for (let m = 1; m < nn - 1; m++) {
    let sc = 0;
    for (let i = m; i < nn; i++) sc += Math.abs(H[i][m - 1]);
    if (sc === 0) continue;
    let h = 0;
    for (let i = nn - 1; i >= m; i--) { ort[i] = H[i][m - 1] / sc; h += ort[i] * ort[i]; }
    let g = Math.sqrt(h);
    if (ort[m] > 0) g = -g;
    h -= ort[m] * g;
    ort[m] -= g;
    for (let j = m; j < nn; j++) {
      let f = 0;
      for (let i = nn - 1; i >= m; i--) f += ort[i] * H[i][j];
      f /= h;
      for (let i = m; i < nn; i++) H[i][j] -= f * ort[i];
    }
    for (let i = 0; i < nn; i++) {
      let f = 0;
      for (let j = nn - 1; j >= m; j--) f += ort[j] * H[i][j];
      f /= h;
      for (let j = m; j < nn; j++) H[i][j] -= f * ort[j];
    }
    ort[m] *= sc;
    H[m][m - 1] = sc * g;
  }
  // accumulate the transformations (ortran)
  const V = Array.from({ length: nn }, (_, i) => Array.from({ length: nn }, (_, j) => (i === j ? 1 : 0)));
  for (let m = nn - 2; m >= 1; m--) {
    if (H[m][m - 1] === 0) continue;
    for (let i = m + 1; i < nn; i++) ort[i] = H[i][m - 1];
    for (let j = m; j < nn; j++) {
      let g = 0;
      for (let i = m; i < nn; i++) g += ort[i] * V[i][j];
      g = (g / ort[m]) / H[m][m - 1];
      for (let i = m; i < nn; i++) V[i][j] += g * ort[i];
    }
  }
  // hqr2: shifted QR iteration on the Hessenberg matrix
  const d = new Float64Array(nn), e = new Float64Array(nn);
  const eps = Number.EPSILON;
  let n = nn - 1, exshift = 0, iter = 0, totalIter = 0;
  let p = 0, q = 0, r = 0, s = 0, z = 0, t, w, x, y;
  let norm = 0;
  for (let i = 0; i < nn; i++) for (let j = Math.max(i - 1, 0); j < nn; j++) norm += Math.abs(H[i][j]);
  while (n >= 0) {
    let l = n;
    while (l > 0) {
      s = Math.abs(H[l - 1][l - 1]) + Math.abs(H[l][l]);
      if (s === 0) s = norm;
      if (Math.abs(H[l][l - 1]) < eps * s) break;
      l--;
    }
    if (l === n) { // one root
      H[n][n] += exshift;
      d[n] = H[n][n]; e[n] = 0;
      n--; iter = 0;
    } else if (l === n - 1) { // two roots
      w = H[n][n - 1] * H[n - 1][n];
      p = (H[n - 1][n - 1] - H[n][n]) / 2;
      q = p * p + w;
      z = Math.sqrt(Math.abs(q));
      H[n][n] += exshift;
      H[n - 1][n - 1] += exshift;
      x = H[n][n];
      if (q >= 0) { // real pair
        z = p >= 0 ? p + z : p - z;
        d[n - 1] = x + z;
        d[n] = z !== 0 ? x - w / z : d[n - 1];
        e[n - 1] = 0; e[n] = 0;
        x = H[n][n - 1];
        s = Math.abs(x) + Math.abs(z);
        p = x / s; q = z / s;
        r = Math.sqrt(p * p + q * q);
        p /= r; q /= r;
        for (let j = n - 1; j < nn; j++) {
          z = H[n - 1][j];
          H[n - 1][j] = q * z + p * H[n][j];
          H[n][j] = q * H[n][j] - p * z;
        }
        for (let i = 0; i <= n; i++) {
          z = H[i][n - 1];
          H[i][n - 1] = q * z + p * H[i][n];
          H[i][n] = q * H[i][n] - p * z;
        }
        for (let i = 0; i < nn; i++) {
          z = V[i][n - 1];
          V[i][n - 1] = q * z + p * V[i][n];
          V[i][n] = q * V[i][n] - p * z;
        }
      } else { // complex pair
        d[n - 1] = x + p; d[n] = x + p;
        e[n - 1] = z; e[n] = -z;
      }
      n -= 2; iter = 0;
    } else { // no convergence yet
      x = H[n][n]; y = 0; w = 0;
      if (l < n) { y = H[n - 1][n - 1]; w = H[n][n - 1] * H[n - 1][n]; }
      if (iter === 10) { // Wilkinson's ad hoc shift
        exshift += x;
        for (let i = 0; i <= n; i++) H[i][i] -= x;
        s = Math.abs(H[n][n - 1]) + Math.abs(H[n - 1][n - 2]);
        x = y = 0.75 * s;
        w = -0.4375 * s * s;
      }
      if (iter === 30) { // MATLAB's ad hoc shift
        s = (y - x) / 2;
        s = s * s + w;
        if (s > 0) {
          s = Math.sqrt(s);
          if (y < x) s = -s;
          s = x - w / ((y - x) / 2 + s);
          for (let i = 0; i <= n; i++) H[i][i] -= s;
          exshift += s;
          x = y = w = 0.964;
        }
      }
      iter++;
      if (++totalIter > 100 * nn) throw new MatlabError('eig: the QR algorithm failed to converge');
      let m = n - 2;
      while (m >= l) {
        z = H[m][m];
        r = x - z; s = y - z;
        p = (r * s - w) / H[m + 1][m] + H[m][m + 1];
        q = H[m + 1][m + 1] - z - r - s;
        r = H[m + 2][m + 1];
        s = Math.abs(p) + Math.abs(q) + Math.abs(r);
        p /= s; q /= s; r /= s;
        if (m === l) break;
        if (Math.abs(H[m][m - 1]) * (Math.abs(q) + Math.abs(r)) < eps * (Math.abs(p) * (Math.abs(H[m - 1][m - 1]) + Math.abs(z) + Math.abs(H[m + 1][m + 1])))) break;
        m--;
      }
      for (let i = m + 2; i <= n; i++) {
        H[i][i - 2] = 0;
        if (i > m + 2) H[i][i - 3] = 0;
      }
      for (let k = m; k <= n - 1; k++) {
        const notlast = k !== n - 1;
        if (k !== m) {
          p = H[k][k - 1]; q = H[k + 1][k - 1]; r = notlast ? H[k + 2][k - 1] : 0;
          x = Math.abs(p) + Math.abs(q) + Math.abs(r);
          if (x === 0) continue;
          p /= x; q /= x; r /= x;
        }
        s = Math.sqrt(p * p + q * q + r * r);
        if (p < 0) s = -s;
        if (s === 0) continue;
        if (k !== m) H[k][k - 1] = -s * x;
        else if (l !== m) H[k][k - 1] = -H[k][k - 1];
        p += s; x = p / s; y = q / s; z = r / s; q /= p; r /= p;
        for (let j = k; j < nn; j++) {
          p = H[k][j] + q * H[k + 1][j];
          if (notlast) { p += r * H[k + 2][j]; H[k + 2][j] -= p * z; }
          H[k][j] -= p * x; H[k + 1][j] -= p * y;
        }
        for (let i = 0; i <= Math.min(n, k + 3); i++) {
          p = x * H[i][k] + y * H[i][k + 1];
          if (notlast) { p += z * H[i][k + 2]; H[i][k + 2] -= p * r; }
          H[i][k] -= p; H[i][k + 1] -= p * q;
        }
        for (let i = 0; i < nn; i++) {
          p = x * V[i][k] + y * V[i][k + 1];
          if (notlast) { p += z * V[i][k + 2]; V[i][k + 2] -= p * r; }
          V[i][k] -= p; V[i][k + 1] -= p * q;
        }
      }
    }
  }
  if (!vectors) return { re: d, im: e };

  // Back-substitute to find the vectors of the upper triangular form.
  const cdiv = (xr, xi, yr, yi) => {
    if (Math.abs(yr) > Math.abs(yi)) {
      const rr = yi / yr, dd = yr + rr * yi;
      return [(xr + rr * xi) / dd, (xi - rr * xr) / dd];
    }
    const rr = yr / yi, dd = yi + rr * yr;
    return [(rr * xr + xi) / dd, (rr * xi - xr) / dd];
  };
  if (norm !== 0) {
    for (n = nn - 1; n >= 0; n--) {
      p = d[n]; q = e[n];
      if (q === 0) { // real vector
        let l = n;
        H[n][n] = 1;
        for (let i = n - 1; i >= 0; i--) {
          w = H[i][i] - p;
          r = 0;
          for (let j = l; j <= n; j++) r += H[i][j] * H[j][n];
          if (e[i] < 0) { z = w; s = r; continue; }
          l = i;
          if (e[i] === 0) H[i][n] = w !== 0 ? -r / w : -r / (eps * norm);
          else {
            x = H[i][i + 1]; y = H[i + 1][i];
            q = (d[i] - p) * (d[i] - p) + e[i] * e[i];
            t = (x * s - z * r) / q;
            H[i][n] = t;
            H[i + 1][n] = Math.abs(x) > Math.abs(z) ? (-r - w * t) / x : (-s - y * t) / z;
          }
          t = Math.abs(H[i][n]);
          if ((eps * t) * t > 1) for (let j = i; j <= n; j++) H[j][n] /= t;
        }
      } else if (q < 0) { // complex vector (columns n-1 and n)
        let l = n - 1;
        if (Math.abs(H[n][n - 1]) > Math.abs(H[n - 1][n])) {
          H[n - 1][n - 1] = q / H[n][n - 1];
          H[n - 1][n] = -(H[n][n] - p) / H[n][n - 1];
        } else {
          [H[n - 1][n - 1], H[n - 1][n]] = cdiv(0, -H[n - 1][n], H[n - 1][n - 1] - p, q);
        }
        H[n][n - 1] = 0; H[n][n] = 1;
        for (let i = n - 2; i >= 0; i--) {
          let ra = 0, sa = 0;
          for (let j = l; j <= n; j++) { ra += H[i][j] * H[j][n - 1]; sa += H[i][j] * H[j][n]; }
          w = H[i][i] - p;
          if (e[i] < 0) { z = w; r = ra; s = sa; continue; }
          l = i;
          if (e[i] === 0) {
            [H[i][n - 1], H[i][n]] = cdiv(-ra, -sa, w, q);
          } else {
            x = H[i][i + 1]; y = H[i + 1][i];
            let vr = (d[i] - p) * (d[i] - p) + e[i] * e[i] - q * q;
            const vi = (d[i] - p) * 2 * q;
            if (vr === 0 && vi === 0) vr = eps * norm * (Math.abs(w) + Math.abs(q) + Math.abs(x) + Math.abs(y) + Math.abs(z));
            [H[i][n - 1], H[i][n]] = cdiv(x * r - z * ra + q * sa, x * s - z * sa - q * ra, vr, vi);
            if (Math.abs(x) > Math.abs(z) + Math.abs(q)) {
              H[i + 1][n - 1] = (-ra - w * H[i][n - 1] + q * H[i][n]) / x;
              H[i + 1][n] = (-sa - w * H[i][n] - q * H[i][n - 1]) / x;
            } else {
              [H[i + 1][n - 1], H[i + 1][n]] = cdiv(-r - y * H[i][n - 1], -s - y * H[i][n], z, q);
            }
          }
          t = Math.max(Math.abs(H[i][n - 1]), Math.abs(H[i][n]));
          if ((eps * t) * t > 1) for (let j = i; j <= n; j++) { H[j][n - 1] /= t; H[j][n] /= t; }
        }
      }
    }
    // back-transform to the eigenvectors of the balanced matrix
    for (let j = nn - 1; j >= 0; j--) {
      for (let i = 0; i < nn; i++) {
        z = 0;
        for (let k = 0; k <= j; k++) z += V[i][k] * H[k][j];
        V[i][j] = z;
      }
    }
  }
  // Undo the balancing, then normalize: unit 2-norm, largest component real.
  const Vre = new Float64Array(nn * nn), Vim = new Float64Array(nn * nn);
  for (let j = 0; j < nn; j++) {
    if (e[j] === 0) {
      for (let i = 0; i < nn; i++) Vre[j * nn + i] = scale[i] * V[i][j];
    } else if (e[j] > 0) { // pair: v = V(:, j) +/- i*V(:, j+1)
      for (let i = 0; i < nn; i++) {
        Vre[j * nn + i] = Vre[(j + 1) * nn + i] = scale[i] * V[i][j];
        Vim[j * nn + i] = scale[i] * V[i][j + 1];
        Vim[(j + 1) * nn + i] = -scale[i] * V[i][j + 1];
      }
    }
  }
  for (let j = 0; j < nn; j++) {
    let len = 0, big = -1, br = 1, bi = 0;
    for (let i = 0; i < nn; i++) {
      const vr = Vre[j * nn + i], vi = Vim[j * nn + i], m2 = vr * vr + vi * vi;
      len += m2;
      if (m2 > big) { big = m2; br = vr; bi = vi; }
    }
    len = Math.sqrt(len);
    if (len === 0) continue;
    // Divide by len * (largest component's phase) when complex.
    let pr = 1, pi = 0;
    if (e[j] !== 0 && big > 0) { const bm = Math.sqrt(big); pr = br / bm; pi = -bi / bm; }
    for (let i = 0; i < nn; i++) {
      const vr = Vre[j * nn + i], vi = Vim[j * nn + i];
      Vre[j * nn + i] = (vr * pr - vi * pi) / len;
      Vim[j * nn + i] = (vr * pi + vi * pr) / len;
    }
  }
  return { re: d, im: e, Vre, Vim };
}
const realEigenvalues = (a) => realEigen(a, false);

function isSymmetric(a) {
  if (a.isComplex) return false;
  const n = a.rows;
  for (let c = 0; c < n; c++) for (let r = c + 1; r < n; r++) if (a.re[c * n + r] !== a.re[r * n + c]) return false;
  return true;
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
  // numel(A) | numel(A, i1, i2, ...): the number of elements A(i1, i2, ...)
  // would have (each index's count; ':' is the whole dimension).
  reg.set('numel', {
    fn: (args) => {
      if (args.length === 1) return [Mat.scalar(args[0].numel)];
      const a = args[0], idx = args.slice(1);
      const dimLen = (k) => (idx.length === 1 ? a.numel : k === 0 ? a.rows : k === 1 ? a.cols : 1);
      return [Mat.scalar(idx.reduce((n, v, k) => n * (v instanceof Mat && v.isChar && v.numel === 1 && v.re[0] === 58 ? dimLen(k) : v.numel), 1))];
    },
  });
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
      const k = args.length >= 2 ? Math.round(finiteScalarArg(args[1], 'diag', 'K')) : 0;
      if (a.isEmpty) return [Mat.empty()];
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
        re[i] = a.re[c * a.rows + r];
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
      for (let k = 0; k < a.rows; k++) { re += a.re[k * a.rows + k]; if (a.isComplex) im += a.im[k * a.rows + k]; }
      return [im !== 0 ? Mat.complexScalar(re, im) : Mat.scalar(re)];
    },
  });
  // rank(A) | rank(A, tol): the singular values above tol (default
  // max(size(A))*eps(max(s))), as MATLAB.
  reg.set('rank', {
    fn: (args) => {
      const a = args[0];
      if (!(a instanceof Mat) || a.isChar) throw new MatlabError('rank: input must be numeric');
      const s = singularValues(a);
      const smax = s.length ? s[0] : 0;
      const tol = args.length >= 2 ? args[1].toScalarNumber() : Math.max(a.rows, a.cols) * (smax > 0 ? 2 ** (Math.floor(Math.log2(smax)) - 52) : 0);
      return [Mat.scalar(s.filter(v => v > tol).length)];
    },
  });
  reg.set('inv', { fn: (args, _n, ctx) => [ctx.interp.reportWarnings(inverse(args[0]))] });
  // pinv(A) | pinv(A, tol): V*diag(1./s)*U' over the singular values above
  // tol (default max(size(A))*eps(norm(A))). A complex A = B + iC goes
  // through the real [B -C; C B], whose pseudoinverse is the same
  // embedding of pinv(A).
  reg.set('pinv', {
    fn: (args) => {
      const a = args[0];
      if (!(a instanceof Mat) || a.isChar) throw new MatlabError('pinv: input must be numeric');
      const m = a.rows, n = a.cols;
      if (a.isEmpty) return [Mat.zeros(n, m)];
      if (a.isComplex) {
        const E = Mat.zeros(2 * m, 2 * n);
        for (let c = 0; c < n; c++) for (let r = 0; r < m; r++) {
          const re = a.re[c * m + r], im = a.im[c * m + r];
          E.set2(r, c, re); E.set2(r + m, c + n, re); E.set2(r + m, c, im); E.set2(r, c + n, -im);
        }
        const P = pseudoInverse(E, args[1]);
        const out = new Mat(n, m, new Float64Array(n * m), new Float64Array(n * m));
        for (let c = 0; c < m; c++) for (let r = 0; r < n; r++) { out.re[c * n + r] = P.get2(r, c); out.im[c * n + r] = P.get2(r + n, c); }
        return [out];
      }
      return [pseudoInverse(a, args[1])];
    },
  });

  reg.set('dot', {
    fn: (args) => {
      const a = args[0], b = args[1];
      if (a.numel !== b.numel) throw new MatlabError('dot: vectors must have the same length');
      let re = 0, im = 0;
      if (!a.isComplex && !b.isComplex) {
        for (let k = 0; k < a.numel; k++) re += a.re[k] * b.re[k];
        return [Mat.scalar(re)];
      }
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
      return [Mat.scalar(singularValues(a)[0] || 0)];
    },
  });

  reg.set('eig', {
    fn: (args, nargout) => {
      const a = args[0]; requireSquare(a, 'eig');
      if (a.isEmpty) return nargout < 2 ? [Mat.zeros(0, 1)] : [Mat.empty(), Mat.empty()];
      if (!a.isComplex && !isSymmetric(a)) {
        if (!a.re.every(Number.isFinite)) throw new MatlabError('Input to EIG must not contain NaN or Inf.', 'MATLAB:eig:matrixWithNaNInf');
        const n = a.rows;
        const { re, im, Vre, Vim } = realEigen(a, nargout >= 2);
        const complex = im.some(v => v !== 0);
        if (nargout < 2) return [new Mat(n, 1, re, complex ? im : null)];
        const D = Mat.zeros(n, n);
        if (complex) D.im = new Float64Array(n * n);
        for (let k = 0; k < n; k++) { D.re[k * n + k] = re[k]; if (complex) D.im[k * n + k] = im[k]; }
        return [new Mat(n, n, Vre, complex ? Vim : null), D];
      }
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
      const a = args[0];
      let econ = false;
      if (args.length >= 2) {
        const opt = args[1];
        if (opt.isChar && opt.toJSString().toLowerCase() === 'econ') econ = true;
        else if (!opt.isChar && opt.numel === 1 && opt.re[0] === 0) econ = a.rows > a.cols; // svd(A, 0)
        else throw new MatlabError("svd: the second argument must be 'econ' or 0");
      }
      if (nargout < 2) {
        const s = singularValues(a);
        return [new Mat(s.length, 1, Float64Array.from(s))];
      }
      const { U, S, V } = computeSVD(a, econ);
      return [U, S, V];
    },
  });

  // Y = lu(A) | [L, U] = lu(A) (L permuted so A = L*U) | [L, U, P] = lu(A)
  // (P*A = L*U) | [L, U, p] = lu(A, 'vector') (A(p, :) = L*U): Gaussian
  // elimination with partial pivoting, as LAPACK's getrf, for real or
  // complex and square or rectangular A.
  reg.set('lu', {
    fn: (args, nargout) => {
      const a = args[0];
      if (!(a instanceof Mat) || a.isChar) throw new MatlabError('lu: input must be numeric');
      let vector = false;
      if (args.length >= 2) {
        const opt = args[1].isChar ? args[1].toJSString().toLowerCase() : '';
        if (opt !== 'vector' && opt !== 'matrix') throw new MatlabError("lu: the option must be 'vector' or 'matrix'");
        vector = opt === 'vector';
      }
      const m = a.rows, n = a.cols, k = Math.min(m, n);
      const re = Float64Array.from(a.re), im = a.isComplex ? Float64Array.from(a.im) : null;
      const piv = Array.from({ length: m }, (_, i) => i);
      const at = (r, c) => c * m + r;
      for (let j = 0; j < k; j++) {
        let p = j, best = -1;
        for (let i = j; i < m; i++) {
          const v = Math.hypot(re[at(i, j)], im ? im[at(i, j)] : 0);
          if (v > best || (Number.isNaN(v) && best < 0)) { best = v; p = i; }
        }
        if (p !== j) {
          for (let c = 0; c < n; c++) {
            let t = re[at(j, c)]; re[at(j, c)] = re[at(p, c)]; re[at(p, c)] = t;
            if (im) { t = im[at(j, c)]; im[at(j, c)] = im[at(p, c)]; im[at(p, c)] = t; }
          }
          [piv[j], piv[p]] = [piv[p], piv[j]];
        }
        const pr = re[at(j, j)], pi = im ? im[at(j, j)] : 0;
        if (pr === 0 && pi === 0) continue;
        const d = pr * pr + pi * pi;
        for (let i = j + 1; i < m; i++) {
          const xr = re[at(i, j)], xi = im ? im[at(i, j)] : 0;
          const lr = (xr * pr + xi * pi) / d, li = (xi * pr - xr * pi) / d; // x / pivot
          re[at(i, j)] = lr; if (im) im[at(i, j)] = li;
          if (lr === 0 && li === 0) continue;
          for (let c = j + 1; c < n; c++) {
            const ur = re[at(j, c)], ui = im ? im[at(j, c)] : 0;
            re[at(i, c)] -= lr * ur - li * ui;
            if (im) im[at(i, c)] -= lr * ui + li * ur;
          }
        }
      }
      const pick = (rows, cols, f) => {
        const out = new Mat(rows, cols, new Float64Array(rows * cols), im ? new Float64Array(rows * cols) : null);
        for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
          const v = f(r, c);
          if (v === 1) out.re[c * rows + r] = 1;
          else if (v) { out.re[c * rows + r] = re[at(v[0], v[1])]; if (im) out.im[c * rows + r] = im[at(v[0], v[1])]; }
        }
        if (out.im && out.im.every(x => x === 0)) out.im = null;
        return out;
      };
      const U = pick(k, n, (r, c) => (r <= c ? [r, c] : 0));
      if (nargout <= 1) return [pick(m, n, (r, c) => [r, c])];
      const L = pick(m, k, (r, c) => (r === c ? 1 : r > c ? [r, c] : 0));
      if (nargout === 2) {
        // Row piv[r] of A is row r of L*U, so A = (P'*L)*U.
        const L2 = new Mat(m, k, new Float64Array(m * k), L.im ? new Float64Array(m * k) : null);
        for (let c = 0; c < k; c++) for (let r = 0; r < m; r++) {
          L2.re[c * m + piv[r]] = L.re[c * m + r];
          if (L.im) L2.im[c * m + piv[r]] = L.im[c * m + r];
        }
        return [L2, U];
      }
      if (vector) return [L, U, new Mat(1, m, Float64Array.from(piv, x => x + 1))];
      const P = Mat.zeros(m, m);
      piv.forEach((src, r) => { P.re[src * m + r] = 1; });
      return [L, U, P];
    },
  });

  // R = qr(A) | [Q, R] = qr(A) | [Q, R, E] = qr(A) (A*E = Q*R, columns
  // pivoted by decreasing norm) | qr(A, 0) / qr(A, 'econ') (economy size;
  // with three outputs E is a permutation vector) | qr(A, 'vector'):
  // Householder QR with LAPACK's sign conventions, as MATLAB.
  reg.set('qr', {
    fn: (args, nargout) => {
      const a = args[0];
      if (!(a instanceof Mat) || a.isChar) throw new MatlabError('qr: input must be numeric');
      let econ = false, vector = false;
      if (args.length >= 2) {
        const o = args[1];
        const t = o.isChar ? o.toJSString().toLowerCase() : null;
        if (t === 'econ') { econ = true; vector = true; }
        else if (t === 'vector') vector = true;
        else if (t === 'matrix') vector = false;
        else if (!o.isChar && o.numel === 1 && o.re[0] === 0) { econ = true; vector = true; }
        else throw new MatlabError("qr: the second argument must be 0, 'econ', 'vector' or 'matrix'");
      }
      const m = a.rows, n = a.cols;
      const f = householderQR(a, nargout >= 3);
      const k = econ ? Math.min(m, n) : m;
      const R = formR(f, econ ? Math.min(m, n) : m);
      if (nargout <= 1) return [R];
      const Q = formQ(f, k);
      if (nargout === 2) return [Q, R];
      if (vector) return [Q, R, new Mat(1, n, Float64Array.from(f.perm, p => p + 1))];
      const E = Mat.zeros(n, n);
      f.perm.forEach((src, c) => { E.re[c * n + src] = 1; });
      return [Q, R, E];
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
  // x = A\B.
  function solve(a, b) {
    if (a.rows !== b.rows) throw new MatlabError('Matrix dimensions must agree.', 'MATLAB:dimagree');
    if (a.rows === a.cols && !a.isComplex && !b.isComplex) {
      // Square and real: LU with partial pivoting (NaN and Inf propagate as
      // in MATLAB; a singular matrix gives Inf/NaN and a warning).
      const lu = luFactor(a);
      const x = luSolve(lu, b);
      const w = lu.singular ? { message: 'Matrix is singular to working precision.', identifier: 'MATLAB:singularMatrix' } : conditionWarning(a, lu, null);
      if (w) x.warnings = [w];
      return x;
    }
    // Non-square (or complex): QR with column pivoting, as MATLAB — the
    // least-squares solution for tall A, a basic solution for wide or
    // rank-deficient A (with MATLAB's warning).
    const { x, rank, tol } = qrSolve(a, b);
    if (rank < Math.min(a.rows, a.cols)) {
      x.warnings = [a.rows === a.cols
        ? { message: 'Matrix is singular to working precision.', identifier: 'MATLAB:singularMatrix' }
        : { message: `Rank deficient, rank = ${rank}, tol = ${doSprintf('%13.6e', [tol])}.`, identifier: 'MATLAB:rankDeficientMatrix' }];
    }
    return x;
  }
  // ---- matrix functions and decompositions ----
  reg.set('expm', {
    fn: (args) => {
      requireSquare(args[0], 'expm');
      if (args[0].isEmpty) return [Mat.empty()];
      if (!args[0].re.every(Number.isFinite)) return [new Mat(args[0].rows, args[0].cols, new Float64Array(args[0].numel).fill(NaN))];
      return [fromRowMajor(math.expm(math.matrix(toRowMajor(args[0]))).valueOf())];
    },
  });
  // sqrtm: math.js's Denman–Beavers iteration; matrices it can't handle
  // (e.g. negative eigenvalues, whose square root is complex) go through
  // the eigendecomposition V*sqrt(D)/V.
  reg.set('sqrtm', {
    fn: (args) => {
      const a = args[0]; requireSquare(a, 'sqrtm');
      if (a.isEmpty) return [Mat.empty()];
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
        const s = singularValues(a);
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
      // V's first r columns span the row space; the rest of V completes
      // them to an orthonormal basis of R^n: the null space.
      const out = V.cols === n ? Array.from({ length: n - r }, (_, j) => Array.from(V.re.subarray((r + j) * n, (r + j + 1) * n))) : [];
      const N = Mat.zeros(n, out.length);
      out.forEach((v, c) => v.forEach((x, i) => { N.re[c * n + i] = Math.abs(x) < 1e-15 ? 0 : x; }));
      return [N];
    },
  });

  _registerLinalgHooks({ inverse, solve });
}
