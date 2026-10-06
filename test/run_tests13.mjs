// Behavior contracts: checks every row of contracts-data.mjs (class, size
// and value of a call, as MATLAB gives them) and MATLAB's exact error
// messages, plus a few properties where MATLAB's exact numbers depend on
// LAPACK conventions.
import { makeInterp } from './harness.js';
import { Mat, valueClassName } from '../src/core/values.js';
import { ROWS, ERRORS } from './contracts-data.mjs';

let pass = 0, fail = 0;
const fmt = (v) => JSON.stringify(v, (_, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
function sameNumber(a, b) {
  if (Number.isNaN(b)) return Number.isNaN(a);
  if (!Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
}

for (const [expr, cls, size, value] of ROWS) {
  const h = makeInterp();
  let code = expr, name = 'r__';
  const at = expr.lastIndexOf(' @');
  if (at >= 0) { code = expr.slice(0, at); name = expr.slice(at + 2); if (!code.trim().endsWith(';')) code += ';'; }
  else code = `r__ = ${expr};`;
  let v;
  try {
    h.run(code);
    v = h.interp.workspace.get(name);
  } catch (e) {
    fail++; console.log(`FAIL: ${expr}\n  threw: ${e.message}`); continue;
  }
  const problems = [];
  if (valueClassName(v) !== cls) problems.push(`class ${valueClassName(v)}, expected ${cls}`);
  if (v.rows !== size[0] || v.cols !== size[1]) problems.push(`size ${v.rows}x${v.cols}, expected ${size.join('x')}`);
  if (value !== null && v instanceof Mat) {
    if (typeof value === 'string') {
      const got = String.fromCharCode(...v.re);
      if (got !== value) problems.push(`value '${got}', expected '${value}'`);
    } else {
      const re = Array.isArray(value) ? value : value.re, im = Array.isArray(value) ? null : value.im;
      const gotIm = v.im ? Array.from(v.im) : null;
      const okRe = re.length === v.re.length && re.every((x, k) => sameNumber(v.re[k], x));
      const okIm = im === null ? gotIm === null : gotIm !== null && im.every((x, k) => sameNumber(gotIm[k], x));
      if (!okRe || !okIm) problems.push(`value ${fmt({ re: Array.from(v.re), im: gotIm })}, expected ${fmt({ re, im })}`);
    }
  } else if (value !== null && !(v instanceof Mat)) problems.push('expected a numeric or char value');
  if (problems.length) { fail++; console.log(`FAIL: ${expr}\n  ${problems.join('\n  ')}`); } else pass++;
}

// Cell and struct contents for the rows above that only checked class/size.
{
  const h = makeInterp();
  const cellText = (name) => h.interp.workspace.get(name).data.map(x => x.toJSString());
  h.run("c1 = strsplit('a,b,,c', ',', 'CollapseDelimiters', false); c2 = fieldnames(struct('b', 1, 'a', 2)); c3 = struct2cell(struct('a', 1, 'b', 'x')); c4 = num2cell([1 2]);");
  const checks = [
    ["strsplit 'CollapseDelimiters' false keeps empty fields", cellText('c1'), ['a', 'b', '', 'c']],
    ['fieldnames keeps definition order', cellText('c2'), ['b', 'a']],
    ['struct2cell', [h.interp.workspace.get('c3').data[0].re[0], h.interp.workspace.get('c3').data[1].toJSString()], [1, 'x']],
    ['num2cell', h.interp.workspace.get('c4').data.map(x => x.re[0]), [1, 2]],
  ];
  for (const [label, got, want] of checks) {
    if (fmt(got) === fmt(want)) pass++; else { fail++; console.log(`FAIL: ${label}\n  got ${fmt(got)}, expected ${fmt(want)}`); }
  }
}

// Properties rather than values where MATLAB's exact numbers depend on
// LAPACK conventions (signs of Q and R): A = Q*R with Q orthogonal and R
// upper triangular.
{
  const h = makeInterp();
  h.run("A = [1 2; 3 4; 5 6]; [Q, R] = qr(A); e1 = norm(Q*R - A) < 1e-12; e2 = norm(Q'*Q - eye(3)) < 1e-12; e3 = all(all(tril(R, -1) == 0)); sq = size(Q); sr = size(R);");
  const got = ['e1', 'e2', 'e3'].map(n => h.interp.workspace.get(n).re[0]).concat([Array.from(h.interp.workspace.get('sq').re), Array.from(h.interp.workspace.get('sr').re)]);
  const want = [1, 1, 1, [3, 3], [3, 2]];
  if (fmt(got) === fmt(want)) pass++; else { fail++; console.log(`FAIL: qr properties\n  got ${fmt(got)}, expected ${fmt(want)}`); }
}

// who / whos list the workspace variables (sorted, as MATLAB).
{
  const h = makeInterp();
  h.run('zeta = 1; alpha = 2; w = who;');
  const names = h.interp.workspace.get('w').data.map(x => x.toJSString());
  const want = ['alpha', 'zeta'];
  if (fmt(names.filter(n => n !== 'w')) === fmt(want) && h.interp.workspace.get('w').cols === 1) pass++;
  else { fail++; console.log(`FAIL: who\n  got ${fmt(names)}`); }
  h.clearOutput();
  h.run('whos');
  const out = h.getOutput();
  if (/alpha\s+1x1\s+8\s+double/.test(out) && /Name\s+Size\s+Bytes\s+Class/.test(out)) pass++;
  else { fail++; console.log(`FAIL: whos output\n${out}`); }
}

for (const [code, message] of ERRORS) {
  const h = makeInterp();
  let got = null;
  try { h.run(code); } catch (e) { got = e.message; }
  if (got === message) pass++;
  else { fail++; console.log(`FAIL (error message): ${code}\n  expected: ${message}\n  got:      ${got}`); }
}
// Chained () indexing is MATLAB syntax error (an Octave extension).
{
  const h = makeInterp();
  let got = null;
  try { h.run('x = ones(2)(1);'); } catch (e) { got = e.message; }
  if (got && got.startsWith("Indexing with parentheses '()' must appear as the last operation of a valid indexing expression.")) pass++;
  else { fail++; console.log(`FAIL (error message): ones(2)(1)\n  got: ${got}`); }
}

// tools/matlab/matweb_reference.m is generated from these contracts; it
// must be regenerated when they change.
{
  const { referenceCases, matlabSource } = await import('../tools/matlab/make-reference.mjs');
  const fs = await import('fs');
  const current = fs.readFileSync(new URL('../tools/matlab/matweb_reference.m', import.meta.url), 'utf8');
  if (current === matlabSource(await referenceCases())) pass++;
  else { fail++; console.log('FAIL: tools/matlab/matweb_reference.m is out of date; run node tools/matlab/make-reference.mjs'); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
