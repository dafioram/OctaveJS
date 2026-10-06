// numeric.js — polyfit/polyval (interp1 lives in interp.js). polyfit solves
// the Vandermonde least-squares problem by QR, as MATLAB does.

import { Mat, MatlabError } from '../core/values.js';
import { qrSolve } from './qr.js';
import * as C from '../core/cmath.js';

export function registerNumeric(reg) {
  reg.set('polyval', {
    fn: (args) => {
      const p = args[0], x = args[1];
      const cre = Array.from(p.re);
      const cim = p.isComplex ? Array.from(p.im) : cre.map(() => 0);
      const out = Mat.mapElementwise(x, (xr, xi) => {
        let rr = 0, ri = 0;
        for (let k = 0; k < cre.length; k++) {
          const [mr, mi] = C.cmul(rr, ri, xr, xi);
          rr = mr + cre[k]; ri = mi + cim[k];
        }
        return [rr, ri];
      });
      return [out];
    },
  });

  reg.set('polyfit', {
    fn: (args, _n, ctx) => {
      const x = args[0], y = args[1];
      const n = Math.round(args[2].toScalarNumber());
      const m = x.numel;
      if (y.numel !== m) throw new MatlabError('polyfit: x and y must have the same number of elements');
      // Vandermonde matrix: column k holds x.^(n-k).
      const V = new Mat(m, n + 1, new Float64Array(m * (n + 1)), x.isComplex ? new Float64Array(m * (n + 1)) : null);
      for (let r = 0; r < m; r++) {
        let pr = 1, pi = 0;
        for (let k = n; k >= 0; k--) {
          V.re[k * m + r] = pr; if (V.im) V.im[k * m + r] = pi;
          [pr, pi] = C.cmul(pr, pi, x.re[r], x.isComplex ? x.im[r] : 0);
        }
      }
      const Y = new Mat(m, 1, Float64Array.from(y.re), y.isComplex ? Float64Array.from(y.im) : null);
      const { x: p, rank } = qrSolve(V, Y);
      const out = new Mat(1, n + 1, p.re, p.im);
      if (rank < n + 1) out.warnings = [{ message: 'Polynomial is not unique; degree >= number of data points.', identifier: 'MATLAB:polyfit:PolyNotUnique' }];
      return [ctx.interp.reportWarnings(out)];
    },
  });
}
