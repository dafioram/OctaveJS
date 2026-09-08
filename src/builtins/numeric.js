// numeric.js — polyfit/polyval/interp1. polyfit reuses the same
// normal-equations least-squares approach as the `\` operator's
// non-square case (see linalg.js and the README's math.js-limitations
// section for the numerical-stability caveat that implies).

import * as math from 'mathjs';
import { Mat, MatlabError } from '../core/values.js';
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
    fn: (args) => {
      const x = args[0], y = args[1];
      const n = Math.round(args[2].toScalarNumber());
      const m = x.numel;
      if (y.numel !== m) throw new MatlabError('polyfit: x and y must have the same number of elements');
      const V = [];
      for (let i = 0; i < m; i++) {
        const row = [];
        const xi = x.re[i];
        for (let k = 0; k <= n; k++) row.push(Math.pow(xi, n - k));
        V.push(row);
      }
      const yArr = Array.from(y.re);
      const Vt = math.transpose(V);
      const VtV = math.multiply(Vt, V);
      const Vty = math.multiply(Vt, yArr);
      let coeffs;
      try {
        coeffs = math.lusolve(VtV, Vty);
      } catch (e) {
        throw new MatlabError(`polyfit: fit failed (degree ${n} may be too high for ${m} points, or points may be degenerate): ${e.message}`);
      }
      const flat = (coeffs.valueOf ? coeffs.valueOf() : coeffs).map(row => Array.isArray(row) ? row[0] : row);
      return [Mat.fromRows([flat])];
    },
  });

  reg.set('interp1', {
    fn: (args) => {
      const x = args[0], y = args[1], xi = args[2];
      if (x.numel !== y.numel) throw new MatlabError('interp1: x and y must have the same number of elements');
      const pairs = Array.from(x.re).map((v, i) => [v, y.re[i]]).sort((a, b) => a[0] - b[0]);
      const sx = pairs.map(p => p[0]), sy = pairs.map(p => p[1]);
      const out = Mat.mapElementwise(xi, (xr) => {
        if (xr < sx[0] || xr > sx[sx.length - 1]) return [NaN, 0]; // out-of-range -> NaN, matching MATLAB's default
        if (xr === sx[0]) return [sy[0], 0];
        if (xr === sx[sx.length - 1]) return [sy[sy.length - 1], 0];
        let i = 0;
        while (i < sx.length - 1 && sx[i + 1] < xr) i++;
        const t = (xr - sx[i]) / (sx[i + 1] - sx[i]);
        return [sy[i] + t * (sy[i + 1] - sy[i]), 0];
      });
      return [out];
    },
  });
}
