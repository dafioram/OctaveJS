// Property tests: identities that must hold for any input, checked on
// seeded random inputs (rng(seed) for several seeds and sizes). They catch
// bugs no hand-picked example would, such as an FFT that is only accurate
// for power-of-two lengths or a decomposition that breaks for rank-deficient
// matrices. Each property is MATLAB code that sets `ok` (true when it
// holds) from the variables `seed` and `n`.
import { makeInterp } from './harness.js';

const SEEDS = 20;
const PROPERTIES = [
  // ---- FFT ----
  ['ifft(fft(x)) == x (any length)', 'x = randn(1, n) + 1i*randn(1, n); ok = norm(ifft(fft(x)) - x) <= 1e-12 * max(1, norm(x));'],
  ['ifft(fft(x)) of real x is real', 'x = randn(n, 1); y = ifft(fft(x)); ok = isreal(y) && norm(y - x) <= 1e-12 * max(1, norm(x));'],
  ["Parseval's theorem", 'x = randn(1, n); X = fft(x); ok = abs(sum(abs(x).^2) - sum(abs(X).^2)/n) <= 1e-10 * max(1, sum(abs(x).^2));'],
  ['fft equals the DFT matrix product', 'm = mod(n, 17) + 1; x = randn(m, 1); k = (0:m-1)\'; W = exp(-2i*pi*mod(k*k\', m)/m); ok = norm(fft(x) - W*x) <= 1e-10 * max(1, norm(x));'],
  ['fft2 is fft along both dimensions', 'A = randn(3, mod(n, 7) + 2); ok = norm(fft2(A) - fft(fft(A).\').\', \'fro\') <= 1e-10 * max(1, norm(A, \'fro\'));'],

  // ---- linear algebra ----
  ['A*inv(A) == I', 'm = mod(n, 8) + 1; A = randn(m) + m*eye(m); ok = norm(A*inv(A) - eye(m)) <= 1e-10;'],
  ['A\\b solves the system', 'm = mod(n, 8) + 1; A = randn(m) + m*eye(m); b = randn(m, 2); x = A \\ b; ok = norm(A*x - b) <= 1e-10 * norm(b);'],
  ['[L, U, P] = lu(A): P*A == L*U', 'm = mod(n, 6) + 1; A = randn(m); [L, U, P] = lu(A); ok = norm(P*A - L*U) <= 1e-12 * max(1, norm(A)) && isequal(triu(U), U) && all(abs(diag(L) - 1) < 1e-15);'],
  ['lu of rectangular and complex matrices', "m = mod(n, 5) + 1; k = mod(seed, 4) + 1; A = randn(m, k) + 1i*randn(m, k); [L, U, P] = lu(A); [L2, U2] = lu(A); [L3, U3, p] = lu(A, 'vector'); ok = norm(P*A - L*U, 'fro') <= 1e-12 * max(1, norm(A, 'fro')) && norm(L2*U2 - A, 'fro') <= 1e-12 * max(1, norm(A, 'fro')) && norm(A(p, :) - L3*U3, 'fro') <= 1e-12 * max(1, norm(A, 'fro')) && isequal(size(L), [m min(m, k)]) && isequal(size(U), [min(m, k) k]);"],
  ['[Q, R] = qr(A): Q*R == A, Q orthogonal', 'm = mod(n, 6) + 1; k = mod(seed, 5) + 1; A = randn(m, k); [Q, R] = qr(A); ok = norm(Q*R - A) <= 1e-12 * max(1, norm(A)) && norm(Q\'*Q - eye(m)) <= 1e-12 && isequal(triu(R), R);'],
  ['[U, S, V] = svd(A): U*S*V\' == A', 'm = mod(n, 6) + 1; k = mod(seed, 5) + 1; A = randn(m, k); [U, S, V] = svd(A); ok = norm(U*S*V\' - A) <= 1e-12 * max(1, norm(A)) && norm(U\'*U - eye(m)) <= 1e-12 && norm(V\'*V - eye(k)) <= 1e-12;'],
  ['svd of a rank-deficient matrix', 'm = mod(n, 5) + 2; A = randn(m, 1) * randn(1, m); [U, S, V] = svd(A); ok = norm(U*S*V\' - A) <= 1e-12 * max(1, norm(A)) && norm(U\'*U - eye(m)) <= 1e-12 && rank(A) == 1;'],
  ['singular values are sqrt(eig(A\'*A))', 'm = mod(n, 6) + 1; A = randn(m); ok = norm(sort(svd(A)) - sqrt(abs(eig(A\'*A)))) <= 1e-8 * max(1, norm(A));'],
  ['symmetric eig: A*V == V*D', 'm = mod(n, 6) + 1; B = randn(m); A = B + B\'; [V, D] = eig(A); ok = norm(A*V - V*D) <= 1e-10 * max(1, norm(A));'],
  ['nonsymmetric eig: A*V == V*D, unit columns, deterministic', "m = mod(n, 7) + 1; A = randn(m); [V, D] = eig(A); [V2, D2] = eig(A); ok = norm(A*V - V*D, 'fro') <= 1e-10 * max(1, norm(A, 'fro')) && all(abs(sqrt(sum(abs(V).^2)) - 1) < 1e-12) && isequal(V, V2) && isequal(D, D2);"],
  ['eig: sum is the trace, product the determinant', 'm = mod(n, 7) + 1; A = randn(m); e = eig(A); ok = abs(sum(e) - trace(A)) <= 1e-10 * max(1, norm(A)) && abs(prod(e) - det(A)) <= 1e-8 * max(1, abs(det(A)) + norm(A)^m);'],
  ['roots are zeros of the polynomial', 'p = [1 randn(1, mod(n, 9) + 1)]; r = roots(p); ok = numel(r) == numel(p) - 1 && max(abs(polyval(p, r))) <= 1e-8 * max(1, max(abs(r)))^numel(p);'],
  ['pinv: A*pinv(A)*A == A', 'm = mod(n, 5) + 2; A = randn(m, 1) * randn(1, m + 1); ok = norm(A*pinv(A)*A - A) <= 1e-10 * max(1, norm(A));'],
  ['null(A) spans the null space', 'm = mod(n, 5) + 2; A = randn(m - 1, m); N = null(A); ok = size(N, 2) == 1 && norm(A*N) <= 1e-10 * norm(A) && abs(norm(N) - 1) < 1e-12;'],
  ['expm(A)*expm(-A) == I', 'm = mod(n, 5) + 1; A = randn(m) / m; ok = norm(expm(A)*expm(-A) - eye(m)) <= 1e-10;'],
  ['sqrtm(A)^2 == A (SPD A)', 'm = mod(n, 5) + 1; B = randn(m); A = B*B\' + eye(m); X = sqrtm(A); ok = norm(X*X - A) <= 1e-10 * norm(A);'],
  ['trace(kron(A, B)) == trace(A)*trace(B)', 'A = randn(mod(n, 4) + 1); B = randn(mod(seed, 3) + 1); ok = abs(trace(kron(A, B)) - trace(A)*trace(B)) <= 1e-12 * max(1, abs(trace(A)*trace(B)));'],

  // ---- sorting and sets ----
  ['sort: ordered permutation', 'x = randi(10, 1, n); [s, i] = sort(x); ok = all(diff(s) >= 0) && isequal(x(i), s) && isequal(sort(i), 1:n);'],
  ["sort 'descend' reverses a stable ascending sort of distinct values", 'x = randperm(n); ok = isequal(sort(x, \'descend\'), fliplr(sort(x)));'],
  ['unique: u == x(i), x == u(j)', 'x = randi(5, 1, n); [u, i, j] = unique(x); ok = isequal(u, x(i)) && isequal(x, u(j)) && all(diff(u) > 0);'],
  ['set identities', 'a = randi(8, 1, n); b = randi(8, 1, mod(seed, 6) + 1); ok = numel(union(a, b)) == numel(unique(a)) + numel(unique(b)) - numel(intersect(a, b)) && isempty(intersect(setdiff(a, b), b)) && isequal(setxor(a, b), union(setdiff(a, b), setdiff(b, a)));'],
  ['sortrows sorts rows lexicographically', 'A = randi(3, n, 3); [B, i] = sortrows(A); d = diff(B); ok = isequal(A(i, :), B) && all(arrayfun(@(r) isempty(find(d(r, :), 1)) || d(r, find(d(r, :), 1)) > 0, 1:size(d, 1)));'],
  ['ismember agrees with any(x == s)', 'x = randi(6, 1, n); s = randi(6, 1, 3); ok = isequal(ismember(x, s), arrayfun(@(v) any(v == s), x));'],

  // ---- array manipulation ----
  ['reshape round trip', 'A = randn(n, 3); ok = isequal(reshape(reshape(A, 3, n), n, 3), A);'],
  ['circshift and back', 'x = randn(1, n); k = mod(seed, 7) - 3; ok = isequal(circshift(circshift(x, k), -k), x);'],
  ['flip twice, rot90 four times', 'A = randn(n, 2); ok = isequal(fliplr(fliplr(A)), A) && isequal(rot90(A, 4), A) && isequal(rot90(A, 2), flipud(fliplr(A)));'],
  ["transpose twice, ctranspose of real is transpose", "A = randn(2, n) + 1i*randn(2, n); ok = isequal(A.'.', A) && isequal(A'', A) && isequal(real(A)', real(A).');"],
  ['cat matches [ , ] and [ ; ]', 'A = randn(2, n); B = randn(2, 3); C = randn(1, n); ok = isequal(cat(2, A, B), [A, B]) && isequal(cat(1, A, C), [A; C]);'],

  // ---- reductions and calculus ----
  ['diff(cumsum(x)) == x(2:end)', 'x = randn(1, n); y = diff(cumsum(x)); ok = norm(y - x(2:end)) <= 1e-12 * max(1, norm(x));'],
  ['mean*numel == sum', 'x = randn(n, 3); ok = norm(mean(x)*n - sum(x)) <= 1e-12 * max(1, norm(sum(abs(x))));'],
  ['var == mean of squared deviations', 'x = randn(1, n + 1); ok = abs(var(x, 1) - mean((x - mean(x)).^2)) <= 1e-12;'],
  ['cov(x) == var(x) for a vector', 'x = randn(1, n + 1); ok = abs(cov(x) - var(x)) <= 1e-12;'],
  ['median == prctile(x, 50)', 'x = randn(1, n); ok = abs(median(x) - prctile(x, 50)) <= 1e-12;'],
  ['max/min agree with sort', 'x = randn(1, n); s = sort(x); ok = max(x) == s(end) && min(x) == s(1);'],
  ['trapz of a line is exact', 'x = sort(rand(1, n + 1)); a = randn; b = randn; ok = abs(trapz(x, a*x + b) - (a/2*(x(end)^2 - x(1)^2) + b*(x(end) - x(1)))) <= 1e-12;'],
  ['accumarray sums agree with a loop', 'subs = randi(4, n, 1); vals = randn(n, 1); A = accumarray(subs, vals); B = zeros(max(subs), 1); for k = 1:n, B(subs(k)) = B(subs(k)) + vals(k); end; ok = norm(A - B) <= 1e-12;'],

  // ---- polynomials, convolution, interpolation ----
  ['conv multiplies polynomials', 'p = randn(1, mod(n, 5) + 1); q = randn(1, mod(seed, 4) + 1); t = randn; ok = abs(polyval(conv(p, q), t) - polyval(p, t)*polyval(q, t)) <= 1e-10 * max(1, abs(polyval(p, t)*polyval(q, t)));'],
  ['deconv undoes conv', 'p = randn(1, mod(n, 5) + 1); q = [1 randn(1, mod(seed, 3))]; [d, r] = deconv(conv(p, q), q); ok = norm(d - p) <= 1e-10 * max(1, norm(p)) && norm(r) <= 1e-10 * max(1, norm(p));'],
  ['conv2(u, v, A) == conv2(A, u(:)*v(:).\')', "u = randn(1, 3); v = randn(1, 2); A = randn(n, 4); ok = norm(conv2(u, v, A) - conv2(A, u(:)*v(:).'), 'fro') <= 1e-12 * max(1, norm(A, 'fro'));"],
  ['polyfit recovers an exact polynomial', 'p = randn(1, 3); x = linspace(-1, 1, n + 3); ok = norm(polyfit(x, polyval(p, x), 2) - p) <= 1e-8 * max(1, norm(p));'],
  ['interp1 reproduces the data at the nodes', "x = cumsum(rand(1, n + 1)); y = randn(1, n + 1); ok = norm(interp1(x, y, x) - y) <= 1e-12 && norm(interp1(x, y, x, 'spline') - y) <= 1e-10 && norm(interp1(x, y, x, 'pchip') - y) <= 1e-12;"],

  // ---- text round trips ----
  ['mat2str / str2num round trip', 'A = randn(2, mod(n, 4) + 1); ok = isequal(str2num(mat2str(A, 17)), A);'],
  ["sprintf('%.17g') / str2double round trip", "x = randn * 10^randi([-20 20]); ok = str2double(sprintf('%.17g', x)) == x;"],
  ['num2str of integers / str2double', "x = randi(1e6) - 5e5; ok = str2double(num2str(x)) == x;"],
];

let pass = 0, fail = 0;
for (const [label, code] of PROPERTIES) {
  const failures = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const h = makeInterp();
    const n = 1 + ((seed * 37) % 64); // sizes 1..64, including odd and prime lengths
    try {
      h.run(`seed = ${seed}; n = ${n}; rng(seed); ${code}`);
      const ok = h.interp.workspace.get('ok');
      if (!ok || ok.numel !== 1 || ok.re[0] !== 1) failures.push(`seed ${seed}, n ${n}`);
    } catch (e) {
      failures.push(`seed ${seed}, n ${n}: ${e.message}`);
    }
  }
  if (failures.length === 0) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  ${failures.slice(0, 3).join('\n  ')}${failures.length > 3 ? `\n  ... ${failures.length - 3} more` : ''}`); }
}
console.log(`\n${pass} passed, ${fail} failed (${PROPERTIES.length} properties x ${SEEDS} seeds)`);
process.exit(fail ? 1 : 0);
