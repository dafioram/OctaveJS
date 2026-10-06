// Tests for the math and data library: more elementary functions
// (elementwise.js), special functions (specfun.js), sets and sorting
// (sets.js), statistics (stats.js), signal processing (fft.js, conv2 /
// filter2) and number theory (factor, perms, rat). Reference values are
// closed forms, identities, or MATLAB documentation examples.
import { makeInterp, fmtVar } from './harness.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkClose(label, actual, expected, tol = 1e-12) {
  const a = [actual].flat(Infinity), e = [expected].flat(Infinity);
  const ok = a.length === e.length && a.every((v, k) => (Number.isNaN(e[k]) ? Number.isNaN(v) : v === e[k] || Math.abs(v - e[k]) <= tol * Math.max(1, Math.abs(e[k]))));
  if (ok) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function checkThrows(label, fn, pattern) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { fail++; console.log(`FAIL(wrong error): ${label}\n  got: ${e.message}`); }
    else pass++;
  }
}
function setup() {
  const h = makeInterp();
  h.v = (name) => fmtVar(h.interp, name);
  h.re = (name) => Array.from(h.interp.workspace.get(name).re);
  h.im = (name) => { const x = h.interp.workspace.get(name); return x.im ? Array.from(x.im) : null; };
  h.size = (name) => { const x = h.interp.workspace.get(name); return [x.rows, x.cols]; };
  h.lines = (name) => { const x = h.interp.workspace.get(name); return Array.from({ length: x.rows }, (_, r) => Array.from({ length: x.cols }, (_, c) => String.fromCharCode(x.re[c * x.rows + r])).join('')); };
  return h;
}
const D = Math.PI / 180;

// ---------------- elementary functions ----------------
{
  const h = setup();
  h.run('a = [sind(180), sind(-180), sind(270), cosd(90), cosd(180), sind(30)]; t = tand([0 45 90 180 270 -90]);');
  check('sind/cosd exact at multiples of 90', h.re('a').slice(0, 5), [0, -0, -1, 0, -1]);
  checkClose('sind(30)', h.re('a')[5], 0.5, 1e-15);
  checkClose('tand at 0, 45, 90, 180, 270, -90', h.re('t'), [0, 1, Infinity, 0, -Infinity, -Infinity], 1e-15);
  h.run('b = [asind(1), acosd(0), atand(1), atan2d(1, -1), secd(60), cscd(30), cotd(45), asecd(2), acscd(2), acotd(1)];');
  checkClose('inverse and reciprocal degree functions', h.re('b'), [90, 90, 45, 135, 2, 2, 1, 60, 30, 45], 1e-13);
  h.run('c = [sec(0), csc(pi/2), cot(pi/4), cot(0), asec(2), acsc(2), acot(1), acot(0), sech(0), csch(1), coth(1)];');
  checkClose('reciprocal trig and hyperbolic', h.re('c'), [1, 1, 1, Infinity, Math.PI / 3, Math.PI / 6, Math.PI / 4, Math.PI / 2, 1, 1 / Math.sinh(1), 1 / Math.tanh(1)], 1e-14);
  h.run('d = [asinh(1), acosh(2), atanh(0.5), atanh(1), asech(0.5), acsch(1), acoth(2)];');
  checkClose('inverse hyperbolic', h.re('d'), [Math.asinh(1), Math.acosh(2), Math.atanh(0.5), Infinity, Math.acosh(2), Math.asinh(1), Math.atanh(0.5)], 1e-14);
  h.run('e1 = acosh(-2); e2 = atanh(2); e3 = asec(0.5); e4 = asind(2);');
  checkClose("MATLAB's branches outside the real domain", [h.re('e1'), h.im('e1'), h.re('e2'), h.im('e2'), h.re('e3'), h.im('e3'), h.re('e4'), h.im('e4')],
    [Math.acosh(2), Math.PI, Math.atanh(0.5), Math.PI / 2, 0, Math.acosh(2), 90, -Math.acosh(2) / D], 1e-13);
  h.run('f = [deg2rad(180), rad2deg(pi), log1p(1e-20), expm1(1e-20), log1p(-1), pow2(3), pow2(3, 2)];');
  checkClose('deg2rad, rad2deg, log1p, expm1, pow2', h.re('f'), [Math.PI, 180, 1e-20, 1e-20, -Infinity, 8, 12], 1e-15);
  h.run('g = nextpow2([0 1 2 3 1024 1025 0.3 -5]); r = [nthroot(27, 3), nthroot(-8, 3), nthroot(16, 4)];');
  check('nextpow2', h.re('g'), [0, 0, 1, 2, 10, 11, -1, 3]);
  check('nthroot is exact on exact roots', h.re('r'), [3, -2, 2]);
  checkThrows('nthroot of a negative with even n', () => h.run('nthroot(-8, 2)'), /odd integer/);
  h.run('k = [realsqrt(4), reallog(1), realpow(2, 3)];');
  check('realsqrt / reallog / realpow', h.re('k'), [2, 0, 8]);
  checkThrows('realsqrt of a negative', () => h.run('realsqrt(-1)'), /produced complex result/);
}

// ---------------- special functions ----------------
{
  const h = setup();
  h.run('e = erf([0 0.5 1 2 3 -0.1]); c = erfc([3 5 10 -1]); x = erfcx([1 30]);');
  checkClose('erf', h.re('e'), [0, 0.5204998778130465, 0.8427007929497149, 0.9953222650189527, 0.9999779095030014, -0.1124629160182849], 1e-14);
  checkClose('erfc in the tail', h.re('c'), [2.209049699858544e-05, 1.5374597944280349e-12, 2.088487583762545e-45, 1.8427007929497148], 1e-13);
  checkClose('erfcx', h.re('x'), [0.42758357615580705, 0.018795888861416751], 1e-13);
  h.run('y = [-0.9 -0.3 0 0.5 0.999]; round1 = max(abs(erf(erfinv(y)) - y)); z = [1e-10 0.2 1 1.5]; round2 = max(abs(erfc(erfcinv(z)) - z) ./ z); ends = [erfinv(1), erfinv(-1), erfcinv(0), erfinv(2)];');
  checkClose('erf(erfinv(y)) = y and erfc(erfcinv(z)) = z', [h.v('round1'), h.v('round2')], [0, 0], 1e-14);
  checkClose('erfinv(0.5)', h.interp.workspace.get('y') && (h.run('q = erfinv(0.5);'), h.v('q')), 0.4769362762044699, 1e-14);
  checkClose('erfinv/erfcinv at the ends', h.re('ends'), [Infinity, -Infinity, Infinity, NaN]);
  h.run('g = gamma([5 0.5 -0.5 1 0 -2 10.5]); l = gammaln([100 0.5 1e5 1 2]); p = psi([1 0.5 10 -0.5]);');
  checkClose('gamma', h.re('g'), [24, Math.sqrt(Math.PI), -2 * Math.sqrt(Math.PI), 1, Infinity, Infinity, 1133278.3889487855], 1e-14);
  check('gamma(n) is exactly factorial(n-1)', (h.run('fe = isequal(gamma(1:20), factorial(0:19));'), h.v('fe')), 1);
  h.run('rec = max(abs(gamma(2.5:1:30) ./ ((1.5:1:29) .* gamma(1.5:1:29)) - 1));');
  checkClose('gamma(x+1) = x*gamma(x)', h.v('rec'), 0, 1e-13);
  checkClose('gammaln', h.re('l'), [359.1342053695754, 0.5723649429247001, 1051287.7089736568, 0, 0], 1e-14);
  checkClose('psi (digamma)', h.re('p'), [-0.5772156649015329, -1.9635100260214235, 2.251752589066721, 0.03648997397857652], 1e-13);
  h.run('b = [beta(2, 3), beta(0.5, 0.5)]; bl = betaln(100, 200) - (gammaln(100) + gammaln(200) - gammaln(300));');
  checkClose('beta / betaln', [...h.re('b'), h.v('bl')], [1 / 12, Math.PI, 0], 1e-13);
  h.run("gi = [gammainc(1, 1), gammainc(10, 3), gammainc(2, 5, 'upper'), gammainc(0, 2), gammainc(0.5, 0.5)];");
  checkClose('gammainc', h.re('gi'), [1 - Math.exp(-1), 1 - 61 * Math.exp(-10), 7 * Math.exp(-2), 0, 0.6826894921370859], 1e-13);
  h.run("bi = [betainc(0.5, 2, 3), betainc(0.2, 1, 1), betainc(0.9, 50, 3), betainc(0.3, 2, 5) + betainc(0.3, 2, 5, 'upper')];");
  const binomTail = 1 - (0.9 ** 52 + 52 * 0.1 * 0.9 ** 51 + 1326 * 0.01 * 0.9 ** 50); // P(Bin(52, 0.1) >= 3)
  checkClose('betainc', h.re('bi'), [0.6875, 0.2, 1 - binomTail, 1], 1e-12);
  checkThrows('gammaln of a negative', () => h.run('gammaln(-1)'), /nonnegative/);
  checkThrows('special functions are real-only', () => h.run('erf(1i)'), /must be real/);
}

// ---------------- sets and sorting ----------------
{
  const h = setup();
  h.run('[c, ia, ib] = intersect([5 1 3 3 7], [3 5 9 5]);');
  check('intersect (MATLAB doc example)', [h.re('c'), h.re('ia'), h.re('ib'), h.size('ia')], [[3, 5], [3, 1], [1, 2], [2, 1]]);
  h.run('[c, ia, ib] = union([3 1 2], [5 2 4]); [d, ja] = setdiff([5 4 3 2 1], [2 4]); [x, xa, xb] = setxor([1 2 3], [3 4]);');
  check('union / setdiff / setxor with indices', [h.re('c'), h.re('ia'), h.re('ib'), h.re('d'), h.re('ja'), h.re('x'), h.re('xa'), h.re('xb')],
    [[1, 2, 3, 4, 5], [2, 3, 1], [3, 1], [1, 3, 5], [5, 3, 1], [1, 2, 4], [1, 2], [2]]);
  h.run("s1 = intersect([5 1 3], [3 5], 'stable'); s2 = union([3 1 2], [5 2], 'stable'); col = union([1; 2], [3 4]);");
  check("'stable', and column output unless both are rows", [h.re('s1'), h.re('s2'), h.size('col')], [[5, 3], [3, 1, 2, 5], [4, 1]]);
  h.run('n1 = union([1 NaN], [NaN 2]); n2 = intersect([1 NaN], [NaN 1]); n3 = setdiff([NaN 1], NaN);');
  checkClose('each NaN is distinct', [h.re('n1'), h.re('n2'), h.re('n3')], [[1, 2, NaN, NaN], [1], [1, NaN]]);
  h.run("t = union({'b', 'a'}, {'c', 'a'}); [u, ua, ub] = intersect({'x', 'y', 'z'}, {'z', 'x'}); w = setdiff('hello', 'lo');");
  check('cell arrays of text and char', [h.interp.workspace.get('t').data.map(x => x.toJSString()), h.re('ua'), h.re('ub'), h.v('w')], [['a', 'b', 'c'], [1, 3], [2, 1], 'eh']);
  h.run("[r, ra, rb] = intersect([1 2; 3 4; 5 6], [3 4; 1 2], 'rows'); q = union([1 2; 3 4], [1 2; 0 0], 'rows');");
  check("'rows'", [h.re('r'), h.re('ra'), h.re('rb'), h.re('q')], [[1, 3, 2, 4], [1, 2], [2, 1], [0, 1, 3, 0, 2, 4]]);
  h.run('[b, i] = sortrows([3 1; 1 2; 3 0; 2 5]); b2 = sortrows([3 1; 1 2; 3 0; 2 5], -1); b3 = sortrows([3 1; 1 2; 3 0], [1 -2]); b4 = sortrows([1 NaN; 1 2; 0 5], 2);');
  check('sortrows', [h.re('b'), h.re('i'), h.re('b2'), h.re('b3')], [[1, 2, 3, 3, 2, 5, 0, 1], [2, 4, 3, 1], [3, 3, 2, 1, 1, 0, 5, 2], [1, 3, 3, 2, 1, 0]]);
  checkClose('sortrows puts NaN last', h.re('b4'), [1, 0, 1, 2, 5, NaN]);
  h.run("sc = sortrows({'pear'; 'apple'; 'fig'}); sd = sortrows([2 1; 1 1; 3 0], 'descend');");
  check('sortrows of text and descending', [h.interp.workspace.get('sc').data.map(x => x.toJSString()), h.re('sd')], [['apple', 'fig', 'pear'], [3, 2, 1, 0, 1, 1]]);
  h.run("s = [issorted([1 2 2 3]), issorted([3 2 1]), issorted([3 2 1], 'descend'), issorted([1 2 2], 'strictascend'), issorted([1 2 NaN]), issorted([1 3; 2 4]), issorted([3 1 2], 'monotonic')];");
  check('issorted', h.re('s'), [1, 0, 1, 0, 1, 1, 0]);
  h.run('r1 = rot90([1 2; 3 4]); r2 = rot90([1 2 3; 4 5 6], 2); r3 = rot90([1 2 3; 4 5 6], -1); r4 = rot90({1, 2});');
  check('rot90', [h.re('r1'), h.re('r2'), h.re('r3'), h.size('r3'), h.size('r4')], [[2, 1, 4, 3], [6, 3, 5, 2, 4, 1], [4, 5, 6, 1, 2, 3], [3, 2], [2, 1]]);
}

// ---------------- statistics ----------------
{
  const h = setup();
  h.run("c1 = cov([1 2 3 4]); c2 = cov([1 2; 3 4; 5 7]); c3 = cov([1 2 3], [1 2 4]); c4 = cov([1 2 3 4], 1); c5 = cov([1 NaN; 2 3; 4 5], 'omitrows');");
  checkClose('cov', [h.v('c1'), h.re('c2'), h.re('c3'), h.v('c4'), h.re('c5')], [5 / 3, [4, 5, 5, 19 / 3], [1, 1.5, 1.5, 7 / 3], 1.25, [2, 2, 2, 2]], 1e-14);
  h.run('[r, p] = corrcoef([1 2 3 4 5], [2 4 5 4 5]);');
  checkClose('corrcoef and its p-value', [h.re('r')[1], h.re('p')[1], h.re('r')[0]], [Math.sqrt(0.6), 0.12402706265, 1], 1e-9);
  h.run("p = prctile([1 2 3 4 5], [25 50 75]); q = quantile(1:10, 0.3); q2 = quantile([3 1 2 NaN], 2); pm = prctile([1 2; 3 4; 5 6], 50); same = median([1 2 3 4]) == prctile([1 2 3 4], 50);");
  checkClose('prctile / quantile', [h.re('p'), h.v('q'), h.re('q2'), h.re('pm'), h.v('same')], [[1.75, 3, 4.25], 3.5, [1.5, 2.5], [3, 4], 1], 1e-14);
  h.run("[n, e] = histcounts([1 2 2 3 5]); [n2, e2, bin] = histcounts([1 2 2 3 5 NaN], [0 2 4 6]); n3 = histcounts([1 2 2 3 5], [0 2 4 6], 'Normalization', 'probability'); n4 = histcounts([1 2 2 3 9], 'BinLimits', [0 4], 'NumBins', 2);");
  check("histcounts: MATLAB's integer bins, edges, bin index", [h.re('n'), h.re('e'), h.re('n2'), h.re('bin')], [[1, 2, 1, 0, 1], [0.5, 1.5, 2.5, 3.5, 4.5, 5.5], [1, 3, 1], [1, 2, 2, 2, 3, 0]]);
  checkClose('histcounts Normalization and BinLimits', [h.re('n3'), h.re('n4')], [[0.2, 0.6, 0.2], [1, 3]], 1e-15);
  h.run('[hn, hi] = histc([1 2 2 3 5], [0 2 4 5]); d1 = discretize([1 2.5 4 7 0], [1 2 3 4]); d2 = discretize([1 2 3], [1 2 3], \'IncludedEdge\', \'right\'); d3 = discretize([1.5 2.5], [1 2 3], [10 20]);');
  checkClose('histc / discretize', [h.re('hn'), h.re('hi'), h.re('d1'), h.re('d2'), h.re('d3')], [[1, 3, 0, 1], [1, 2, 2, 2, 4], [1, 2, 3, NaN, NaN], [1, 1, 2], [10, 20]]);
  h.run('a1 = accumarray([1; 2; 1; 3], [10; 20; 30; 40]); a2 = accumarray([1 1; 2 2; 1 1], [1 2 3]); a3 = accumarray([1; 2; 1], [5; 6; 7], [], @max); a4 = accumarray([1; 3], 1, [4 1], [], -1); a5 = accumarray([1; 2; 2], 1);');
  check('accumarray', [h.re('a1'), h.re('a2'), h.re('a3'), h.re('a4'), h.re('a5')], [[40, 20, 40], [4, 0, 0, 2], [7, 6], [1, -1, 1, -1], [1, 2]]);
  h.run("m1 = cummax([1 3 2 5 4]); m2 = cummin([NaN 3 1 2]); m3 = cummax([1 3 2], 'reverse'); m4 = cummax([1 4; 3 2]);");
  checkClose('cummax / cummin', [h.re('m1'), h.re('m2'), h.re('m3'), h.re('m4')], [[1, 3, 3, 5, 5], [NaN, 3, 1, 1], [3, 3, 2], [1, 3, 4, 4]]);
  h.run("w1 = movmean([1 2 3 4 5], 3); w2 = movmean([1 2 3 4 5], 2); w3 = movsum([1 2 3 4 5], [1 0]); w4 = movmean([1 2 3 4 5], 3, 'Endpoints', 'discard'); w5 = movmedian([4 1 3 2 5], 3); w6 = movmax([1 3 2 5 4], 3); w7 = movstd([1 2 4 8], 3); w8 = movmean([1 NaN 3], 3, 'omitnan'); w9 = movmean([1 2 3 4], 3, 'Endpoints', 'fill'); w10 = movmean([1 2; 3 4; 5 6], 2);");
  checkClose('moving statistics', [h.re('w1'), h.re('w2'), h.re('w3'), h.re('w4'), h.re('w5'), h.re('w6'), h.re('w7'), h.re('w8'), h.re('w9'), h.re('w10')],
    [[1.5, 2, 3, 4, 4.5], [1, 1.5, 2.5, 3.5, 4.5], [1, 3, 5, 7, 9], [2, 3, 4], [2.5, 3, 2, 3, 3.5], [3, 3, 5, 5, 5], [Math.SQRT1_2, Math.sqrt(7 / 3), Math.sqrt(28 / 3), Math.sqrt(8)], [1, 2, 3], [NaN, 2, 3, NaN], [1, 2, 4, 2, 3, 5]], 1e-14);
  h.run("z1 = normalize([1 2 3]); z2 = normalize([1 2 3], 'range'); z3 = normalize([1 2 3], 'range', [-1 1]); z4 = normalize([2 4 6], 'norm'); [z5, zc, zs] = normalize([1 2 3], 'center'); z6 = normalize([1 2 3 100], 'zscore', 'robust'); z7 = normalize([1 NaN 3]);");
  checkClose('normalize', [h.re('z1'), h.re('z2'), h.re('z3'), h.re('z4'), h.re('z5'), h.v('zc'), h.v('zs'), h.re('z6'), h.re('z7')],
    [[-1, 0, 1], [0, 0.5, 1], [-1, 0, 1], [2, 4, 6].map(v => v / Math.sqrt(56)), [-1, 0, 1], 2, 1, [-1.5, -0.5, 0.5, 97.5], [-Math.SQRT1_2, NaN, Math.SQRT1_2]], 1e-14);
  h.run("s1 = rescale([1 2 3]); s2 = rescale([1 2 3], -1, 1); s3 = rescale([1 2 3], 'InputMin', 0); [lo, hi] = bounds([3 1 4 1 5]); [lo2, hi2] = bounds([1 5; 3 2]);");
  checkClose('rescale / bounds', [h.re('s1'), h.re('s2'), h.re('s3'), h.v('lo'), h.v('hi'), h.re('lo2'), h.re('hi2')], [[0, 0.5, 1], [-1, 0, 1], [1 / 3, 2 / 3, 1], 1, 5, [1, 2], [3, 5]], 1e-15);
  h.run('v1 = vecnorm([3 4; 0 0]); v2 = vecnorm([3 4; 0 0], 2, 2); v3 = vecnorm([1 -2 3], 1); v4 = vecnorm([1 -2 3], Inf); v5 = vecnorm([3 4i]);');
  check('vecnorm', [h.re('v1'), h.re('v2'), h.v('v3'), h.v('v4'), h.v('v5')], [[3, 4], [5, 0], 6, 3, 5]);
}

// ---------------- signal processing ----------------
{
  const h = setup();
  h.run('a = fftshift([1 2 3 4 5]); b = ifftshift(fftshift([1 2 3 4 5])); c = fftshift([1 2; 3 4]); d = fftshift([1 2 3 4; 5 6 7 8], 2); e = ifftshift([1 2 3 4 5]);');
  check('fftshift / ifftshift', [h.re('a'), h.re('b'), h.re('c'), h.re('d'), h.re('e')], [[4, 5, 1, 2, 3], [1, 2, 3, 4, 5], [4, 2, 3, 1], [3, 7, 4, 8, 1, 5, 2, 6], [3, 4, 5, 1, 2]]);
  h.run('F = fft2([1 2; 3 4]); back = ifft2(fft2(magic(4))); err = max(abs(back(:) - reshape(magic(4), [], 1))); P = fft2([1 2; 3 4], 3, 3);');
  checkClose('fft2 / ifft2', [h.re('F'), h.v('err'), h.size('P')], [[10, -4, -2, 0], 0, [3, 3]], 1e-12);
  h.run("k1 = conv2([1 2; 3 4], [1 1; 1 1]); k2 = conv2(magic(4), ones(2), 'valid'); k3 = conv2(magic(3), ones(3), 'same'); k4 = conv2([1 2], [1; 1], [1 2; 3 4]); k5 = conv2([1 2; 3 4], [1 2], [1; 1]);");
  check('conv2 full / valid / same', [h.re('k1'), h.re('k2'), h.re('k3')], [[1, 4, 3, 3, 10, 7, 2, 6, 4], [34, 32, 34, 26, 34, 42, 34, 36, 34], [17, 30, 21, 30, 45, 30, 19, 30, 23]]);
  check('conv2(u, v, A) is conv2 with u*v', h.re('k4'), [1, 5, 6, 3, 13, 14, 2, 8, 8]);
  h.run('f = filter2([1 2], [1 2 3; 4 5 6]);');
  check('filter2 (correlation)', h.re('f'), [5, 14, 8, 17, 3, 6]);
}

// ---------------- number theory ----------------
{
  const h = setup();
  h.run('f1 = factor(360); f2 = factor(97); f3 = factor(1); f4 = factor(2^40 + 1);');
  check('factor', [h.re('f1'), h.re('f2'), h.re('f3'), h.re('f4')], [[2, 2, 2, 3, 3, 5], [97], [1], [257, 4278255361]]);
  checkThrows('factor of a negative', () => h.run('factor(-4)'), /nonnegative integer/);
  h.run("p = perms([1 2 3]); pc = perms('ab');");
  check("perms in MATLAB's order", [h.re('p'), h.lines('pc')], [[3, 3, 2, 2, 1, 1, 2, 1, 3, 1, 2, 3, 1, 2, 1, 3, 3, 2], ['ba', 'ab']]);
  h.run("[n, d] = rat(pi); [n2, d2] = rat(pi, 1e-2); [n3, d3] = rat([0.5 0.75 -0.2]); s1 = rat(pi); s2 = rat(0.75); s3 = rat(3); r = rats(0.75);");
  check('rat', [h.v('n'), h.v('d'), h.v('n2'), h.v('d2'), h.re('n3'), h.re('d3')], [355, 113, 22, 7, [1, 3, -1], [2, 4, 5]]);
  check('rat as text', [h.v('s1'), h.v('s2'), h.v('s3')], ['3 + 1/(7 + 1/(16))', '1 + 1/(-4)', '3']);
  check('rats', h.v('r').trim(), '3/4');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
