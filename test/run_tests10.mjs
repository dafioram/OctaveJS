// Tests for random numbers (src/builtins/random.js): seeding and
// restoring with rng, the statistics of rand/randn/randi/randperm, the
// legacy rand('seed', ...) syntaxes, and generator state across Stop.
import { makeInterp, fmtVar } from './harness.js';
import { createSession } from '../src/worker/session.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkClose(label, actual, expected, tol) {
  const a = [actual].flat(), e = [expected].flat();
  if (a.length === e.length && a.every((v, k) => Math.abs(v - e[k]) <= tol)) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)} (±${tol})\n  actual:   ${JSON.stringify(actual)}`); }
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
  h.size = (name) => { const x = h.interp.workspace.get(name); return [x.rows, x.cols]; };
  return h;
}
const round4 = (xs) => xs.map(x => Math.round(x * 1e4) / 1e4);

// ---------------- seeding and restoring ----------------
{
  const h = setup();
  // The generator is MATLAB's default Mersenne Twister, seeded the same way.
  h.run('a = rand(1, 5);');
  check('a new session starts in the default state', round4(h.re('a')), [0.8147, 0.9058, 0.127, 0.9134, 0.6324]);
  h.run('rng(1); b = rand; rng default; c = rand(1, 2); rng(0); d = rand;');
  check('rng(seed) and rng default', round4([h.v('b'), ...h.re('c'), h.v('d')]), [0.417, 0.8147, 0.9058, 0.8147]);
  h.run('rng(42); x = rand(3); y = randn(2); z = randi(9, 1, 4); p = randperm(6); rng(42); x2 = rand(3); y2 = randn(2); z2 = randi(9, 1, 4); p2 = randperm(6); same = isequal(x, x2) && isequal(y, y2) && isequal(z, z2) && isequal(p, p2);');
  check('the same seed repeats every function', h.v('same'), 1);
  h.run('rng(3); s = rng; x = rand(1, 4); rng(s); y = rand(1, 4); t = s.Type; sd = s.Seed; n = numel(s.State);');
  check('s = rng; ... rng(s) restores the state', [h.re('x').join(), h.v('t'), h.v('sd'), h.v('n')], [h.re('y').join(), 'twister', 3, 625]);
  h.run('rng(5); old = rng(9); r1 = rand; rng(old); r2 = rand; rng(5); r3 = rand; isst = isstruct(old); os = old.Seed;');
  check('old = rng(seed) returns the settings before the call', [h.v('isst'), h.v('os'), h.v('r2') === h.v('r3'), h.v('r1') !== h.v('r2')], [1, 5, true, true]);
  h.run('rng 12'); h.run('e1 = rand; rng(12); e2 = rand;');
  check('rng 12 (command syntax)', h.v('e1'), h.v('e2'));
  h.run("rng(7, 'twister'); a = rand; rng(7); b = rand;");
  check("rng(seed, 'twister')", h.v('a'), h.v('b'));
  h.run("rng('shuffle'); s1 = rng; a = rand; rng('shuffle'); b = rand;");
  check("rng('shuffle') picks a new seed", [h.v('a') !== h.v('b'), Number.isInteger(h.interp.workspace.get('s1').data[0].get('Seed').re[0])], [true, true]);
  h.clearOutput();
  h.run('rng');
  check('rng alone shows the settings', /Type/.test(h.getOutput()) && /twister/.test(h.getOutput()), true);
  checkThrows('negative seed', () => h.run('rng(-1)'), /seed must be an integer/);
  checkThrows('fractional seed', () => h.run('rng(1.5)'), /seed must be an integer/);
  checkThrows('seed too large', () => h.run('rng(2^32)'), /seed must be an integer/);
  checkThrows('other generators', () => h.run("rng(1, 'philox')"), /only the 'twister' generator/);
  checkThrows('unknown option', () => h.run("rng('fast')"), /unknown option/);
}

// ---------------- statistics ----------------
{
  const h = setup();
  h.run('rng(11); u = rand(1, 100000); mu = mean(u); v = var(u); lo = min(u); hi = max(u);');
  checkClose('rand: mean 1/2', h.v('mu'), 0.5, 0.005);
  checkClose('rand: variance 1/12', h.v('v'), 1 / 12, 0.002);
  check('rand: inside (0, 1)', [h.v('lo') > 0, h.v('hi') < 1], [true, true]);
  h.run('bins = zeros(1, 10); for k = 1:10, bins(k) = sum(u >= (k-1)/10 & u < k/10); end');
  check('rand: every tenth of (0, 1) gets about 10%', h.re('bins').every(b => Math.abs(b - 10000) < 500), true);
  h.run('x = randn(1, 100000); m = mean(x); s = std(x); in1 = mean(abs(x) < 1); in2 = mean(abs(x) < 2); sk = mean(x.^3);');
  checkClose('randn: mean 0', h.v('m'), 0, 0.02);
  checkClose('randn: standard deviation 1', h.v('s'), 1, 0.02);
  checkClose('randn: 68.3% within 1 sigma', h.v('in1'), 0.6827, 0.01);
  checkClose('randn: 95.4% within 2 sigma', h.v('in2'), 0.9545, 0.005);
  checkClose('randn: symmetric', h.v('sk'), 0, 0.05);
  h.run('r = randi(6, 1, 60000); counts = zeros(1, 6); for k = 1:6, counts(k) = sum(r == k); end; ints = all(r == round(r));');
  check('randi(6): integers 1..6, each about 1/6', [h.v('ints'), h.re('counts').every(c => Math.abs(c - 10000) < 500)], [1, true]);
  h.run('r = randi([-3 3], 1, 7000); lo = min(r); hi = max(r); m = mean(r);');
  check('randi([lo hi]) covers the range', [h.v('lo'), h.v('hi')], [-3, 3]);
  checkClose('randi([lo hi]) is centered', h.v('m'), 0, 0.1);
  h.run('first = zeros(1, 5); for k = 1:5000, p = randperm(5); first(p(1)) = first(p(1)) + 1; end; p = randperm(10); ok = isequal(sort(p), 1:10);');
  check('randperm(n) is a permutation', h.v('ok'), 1);
  check('randperm: each value first about 1/5 of the time', h.re('first').every(c => Math.abs(c - 1000) < 150), true);
  h.run('q = randperm(1e9, 4); d = numel(unique(q)); inr = all(q >= 1 & q <= 1e9 & q == round(q)); e = randperm(5, 0); z = randperm(0);');
  check('randperm(n, k): k distinct values, without allocating n', [h.v('d'), h.v('inr'), h.size('q')], [4, 1, [1, 4]]);
  check('randperm(5, 0) and randperm(0) are empty rows', [h.size('e'), h.size('z')], [[1, 0], [1, 0]]);
}

// ---------------- sizes and argument checks ----------------
{
  const h = setup();
  h.run("a = rand(2, 3); b = rand([3 1]); c = randn(2, 'double'); d = rand(2, 'like', 1); e = randi(5, [2 2]); f = randi(5, 3); g = rand(0, 3); k = randn;");
  check('sizes', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'k'].map(h.size), [[2, 3], [3, 1], [2, 2], [2, 2], [2, 2], [3, 3], [0, 3], [1, 1]]);
  checkThrows('N-D sizes', () => h.run('rand(2, 2, 2)'), /N-D/);
  checkThrows('unsupported class', () => h.run("rand(2, 'int8')"), /unsupported class/);
  checkThrows('randi imax', () => h.run('randi(0)'), /positive integer/);
  checkThrows('randi limits', () => h.run('randi([5 1])'), /less than or equal/);
  checkThrows('randi non-integer', () => h.run('randi(2.5)'), /integers/);
  checkThrows('randperm k > n', () => h.run('randperm(3, 4)'), /between 0 and n/);
  checkThrows('randperm negative n', () => h.run('randperm(-1)'), /nonnegative integer/);
}

// ---------------- legacy syntaxes ----------------
{
  const h = setup();
  h.clearOutput();
  h.run("rand('seed', 3); a = rand; rng(3); b = rand;");
  check("rand('seed', s) seeds the generator, with a warning", [h.v('a') === h.v('b'), /discouraged syntax/.test(h.getOutput())], [true, true]);
  h.clearOutput();
  h.run("randn('state', 3); rand('twister', 5); c = rand; rng(5); d = rand;");
  check('the warning is shown once', [h.getOutput(), h.v('c') === h.v('d')], ['', true]);
  h.run("st = rand('state'); x = rand(1, 3); rand('state', st); y = rand(1, 3); sd = rand('seed');");
  check("rand('state') queries and restores the full state", [h.size('st'), h.re('x').join() === h.re('y').join()], [[625, 1], true]);
}

// ---------------- Stop restores the generator ----------------
{
  const msgs = [];
  const s1 = createSession((m) => msgs.push(m));
  s1.handle({ type: 'init', files: [] });
  s1.handle({ type: 'run', id: 1, src: 'rng(8); burn = rand(1, 3);' });
  const done = msgs.find(m => m.type === 'done');
  // The page restarts a stopped session from its mirror: here, the state after command 1.
  const out = [];
  const s2 = createSession((m) => out.push(m));
  s2.handle({ type: 'init', files: [], snapshot: { vars: done.delta.vars, settings: done.delta.settings } });
  s2.handle({ type: 'run', id: 2, src: 'x = rand; rng(8); tmp = rand(1, 3); y = rand; same = x == y;' });
  const d2 = out.find(m => m.type === 'done');
  const v = d2.delta.vars.find(([n]) => n === 'same');
  check('a restarted session continues the generator where it was', v && v[1].re[0], 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
