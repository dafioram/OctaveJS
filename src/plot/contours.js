// contours.js — The contour levels of a contour object, shared by the
// LevelList property (plotting.js) and the Plotly converter so both agree.
//   levels === null    automatic: about 10 levels at "nice" round steps
//   levels === n       n evenly spaced levels strictly inside the data range
//   levels === [...]   the given levels
export function contourLevelValues(z, levels) {
  if (Array.isArray(levels)) return levels.slice().sort((a, b) => a - b);
  let mn = Infinity, mx = -Infinity;
  for (const v of z.flat()) if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  if (mn === Infinity) return [];
  if (mn === mx) return [mn];
  if (typeof levels === 'number') {
    const step = (mx - mn) / (levels + 1);
    return Array.from({ length: Math.max(levels, 0) }, (_, k) => mn + step * (k + 1));
  }
  const raw = (mx - mn) / 10;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw * 0.999);
  const out = [];
  for (let v = Math.ceil(mn / step) * step; v <= mx + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
