// qr.js — Householder QR factorization following LAPACK's conventions
// (xGEQRF, with column pivoting as xGEQP3), for real and complex matrices,
// so the signs of Q and R match MATLAB's. Used by qr and by the
// least-squares / basic solutions of A\b for non-square A.
//
// The factorization is kept in packed form: R in the upper triangle of
// (qr, qi), the Householder vectors below it (with an implicit 1 on the
// diagonal) and the scalars tau, so that A(:, perm) = Q*R with
// Q = H(1)*H(2)*...*H(k), H(i) = I - tau(i)*v(i)*v(i)'.

import { Mat } from '../core/values.js';

export function householderQR(a, pivot = false) {
  const m = a.rows, n = a.cols, k = Math.min(m, n);
  const qr = Float64Array.from(a.re), qi = a.isComplex ? Float64Array.from(a.im) : new Float64Array(m * n);
  const tauR = new Float64Array(k), tauI = new Float64Array(k);
  const perm = Array.from({ length: n }, (_, j) => j);
  const at = (r, c) => c * m + r;
  const colNorm2 = (j, from) => { let s = 0; for (let r = from; r < m; r++) s += qr[at(r, j)] ** 2 + qi[at(r, j)] ** 2; return s; };
  for (let j = 0; j < k; j++) {
    if (pivot) {
      // Column with the largest remaining norm (first one on ties), as xGEQP3.
      let best = j, bestNorm = -1;
      for (let c = j; c < n; c++) { const s = colNorm2(c, j); if (s > bestNorm) { bestNorm = s; best = c; } }
      if (best !== j) {
        for (let r = 0; r < m; r++) {
          let t = qr[at(r, j)]; qr[at(r, j)] = qr[at(r, best)]; qr[at(r, best)] = t;
          t = qi[at(r, j)]; qi[at(r, j)] = qi[at(r, best)]; qi[at(r, best)] = t;
        }
        [perm[j], perm[best]] = [perm[best], perm[j]];
      }
    }
    // xLARFG: the reflector that maps column j's tail onto beta * e1.
    const ar = qr[at(j, j)], ai = qi[at(j, j)];
    const xnorm = Math.sqrt(colNorm2(j, j + 1));
    if (xnorm === 0 && ai === 0) { tauR[j] = 0; tauI[j] = 0; continue; }
    const beta = -(ar >= 0 ? 1 : -1) * Math.hypot(ar, ai, xnorm);
    tauR[j] = (beta - ar) / beta; tauI[j] = -ai / beta;
    // v = x / (alpha - beta), v(1) = 1
    const dr = ar - beta, di = ai, dd = dr * dr + di * di;
    for (let r = j + 1; r < m; r++) {
      const xr = qr[at(r, j)], xi = qi[at(r, j)];
      qr[at(r, j)] = (xr * dr + xi * di) / dd;
      qi[at(r, j)] = (xi * dr - xr * di) / dd;
    }
    qr[at(j, j)] = beta; qi[at(j, j)] = 0;
    // Apply H(j)' = I - conj(tau) v v' to the remaining columns.
    for (let c = j + 1; c < n; c++) {
      let sr = qr[at(j, c)], si = qi[at(j, c)]; // v(1) = 1
      for (let r = j + 1; r < m; r++) { // s = v' * A(:, c)
        const vr = qr[at(r, j)], vi = qi[at(r, j)], xr = qr[at(r, c)], xi = qi[at(r, c)];
        sr += vr * xr + vi * xi; si += vr * xi - vi * xr;
      }
      const tr = tauR[j] * sr + tauI[j] * si, ti = tauR[j] * si - tauI[j] * sr; // conj(tau) * s
      qr[at(j, c)] -= tr; qi[at(j, c)] -= ti;
      for (let r = j + 1; r < m; r++) {
        const vr = qr[at(r, j)], vi = qi[at(r, j)];
        qr[at(r, c)] -= vr * tr - vi * ti; qi[at(r, c)] -= vr * ti + vi * tr;
      }
    }
  }
  return { m, n, k, qr, qi, tauR, tauI, perm, complex: !!a.isComplex };
}

// Applies Q' (adjoint) to the columns of b (m-by-p, re/im arrays), in place.
function applyQt(f, br, bi, p) {
  const { m, k, qr, qi, tauR, tauI } = f;
  for (let j = 0; j < k; j++) {
    if (tauR[j] === 0 && tauI[j] === 0) continue;
    for (let c = 0; c < p; c++) {
      let sr = br[c * m + j], si = bi[c * m + j];
      for (let r = j + 1; r < m; r++) {
        const vr = qr[j * m + r], vi = qi[j * m + r], xr = br[c * m + r], xi = bi[c * m + r];
        sr += vr * xr + vi * xi; si += vr * xi - vi * xr;
      }
      const tr = tauR[j] * sr + tauI[j] * si, ti = tauR[j] * si - tauI[j] * sr;
      br[c * m + j] -= tr; bi[c * m + j] -= ti;
      for (let r = j + 1; r < m; r++) {
        const vr = qr[j * m + r], vi = qi[j * m + r];
        br[c * m + r] -= vr * tr - vi * ti; bi[c * m + r] -= vr * ti + vi * tr;
      }
    }
  }
}

// The first `cols` columns of Q (m-by-cols).
export function formQ(f, cols) {
  const { m, k, qr, qi, tauR, tauI } = f;
  const Qr = new Float64Array(m * cols), Qi = new Float64Array(m * cols);
  for (let c = 0; c < cols; c++) Qr[c * m + c] = 1;
  // Q = H(1)...H(k): apply H(j) = I - tau v v' from the last to the first.
  for (let j = k - 1; j >= 0; j--) {
    if (tauR[j] === 0 && tauI[j] === 0) continue;
    for (let c = 0; c < cols; c++) {
      let sr = Qr[c * m + j], si = Qi[c * m + j];
      for (let r = j + 1; r < m; r++) {
        const vr = qr[j * m + r], vi = qi[j * m + r], xr = Qr[c * m + r], xi = Qi[c * m + r];
        sr += vr * xr + vi * xi; si += vr * xi - vi * xr;
      }
      const tr = tauR[j] * sr - tauI[j] * si, ti = tauR[j] * si + tauI[j] * sr; // tau * s
      Qr[c * m + j] -= tr; Qi[c * m + j] -= ti;
      for (let r = j + 1; r < m; r++) {
        const vr = qr[j * m + r], vi = qi[j * m + r];
        Qr[c * m + r] -= vr * tr - vi * ti; Qi[c * m + r] -= vr * ti + vi * tr;
      }
    }
  }
  return complexMat(m, cols, Qr, Qi, f.complex);
}

// The rows-by-n upper triangle R.
export function formR(f, rows) {
  const { m, n, qr, qi } = f;
  const Rr = new Float64Array(rows * n), Ri = new Float64Array(rows * n);
  for (let c = 0; c < n; c++) for (let r = 0; r <= Math.min(c, rows - 1); r++) { Rr[c * rows + r] = qr[c * m + r]; Ri[c * rows + r] = qi[c * m + r]; }
  return complexMat(rows, n, Rr, Ri, f.complex);
}

function complexMat(rows, cols, re, im, complex) {
  return new Mat(rows, cols, re, complex && im.some(x => x !== 0) ? im : null);
}

// x = A\B for non-square A by QR with column pivoting, as MATLAB: the
// least-squares solution when A is tall, a basic solution (at most rank(A)
// nonzero entries) when A is wide or rank deficient. Returns { x, rank, tol }.
export function qrSolve(a, b) {
  const f = householderQR(a, true);
  const { m, n, k, qr, qi, perm } = f;
  const p = b.cols;
  const br = Float64Array.from(b.re), bi = b.isComplex ? Float64Array.from(b.im) : new Float64Array(b.numel);
  applyQt(f, br, bi, p);
  const tol = Math.max(m, n) * Number.EPSILON * Math.hypot(qr[0] || 0, qi[0] || 0);
  let rank = 0;
  while (rank < k && Math.hypot(qr[rank * m + rank], qi[rank * m + rank]) > tol) rank++;
  const xr = new Float64Array(n * p), xi = new Float64Array(n * p);
  for (let c = 0; c < p; c++) {
    // Back-substitute R(1:rank, 1:rank) y = (Q'b)(1:rank); x(perm) = [y; 0].
    const yr = new Float64Array(rank), yi = new Float64Array(rank);
    for (let r = rank - 1; r >= 0; r--) {
      let sr = br[c * m + r], si = bi[c * m + r];
      for (let j = r + 1; j < rank; j++) {
        const ur = qr[j * m + r], ui = qi[j * m + r];
        sr -= ur * yr[j] - ui * yi[j]; si -= ur * yi[j] + ui * yr[j];
      }
      const dr = qr[r * m + r], di = qi[r * m + r], dd = dr * dr + di * di;
      yr[r] = (sr * dr + si * di) / dd; yi[r] = (si * dr - sr * di) / dd;
    }
    for (let r = 0; r < rank; r++) { xr[c * n + perm[r]] = yr[r]; xi[c * n + perm[r]] = yi[r]; }
  }
  return { x: complexMat(n, p, xr, xi, a.isComplex || b.isComplex), rank, tol };
}
