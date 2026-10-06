// make-reference.mjs — writes tools/matlab/matweb_reference.m, a MATLAB
// function that records what real MATLAB returns for MatWeb's test cases:
//   - every behavior contract (test/contracts-data.mjs) and error case,
//   - the display snapshot scripts (test/display/*.m), via evalc,
//   - PROBES below: behaviors we are unsure of,
//   - a sweep of the pure library functions over awkward arguments
//     (the same battery as test/run_tests12.mjs).
// Running it in MATLAB writes matweb_reference.txt; compare-reference.mjs
// then diffs MatWeb against it.
//
//   node tools/matlab/make-reference.mjs
//
// The generated file uses only long-standing MATLAB features (a function
// file with subfunctions, eval/evalc, try/catch, fprintf), so it runs on
// old releases too.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROWS, ERRORS } from '../../test/contracts-data.mjs';
import { makeInterp } from '../../test/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

// Behaviors where we are not sure what MATLAB does; the reference run
// settles them.
export const PROBES = [
  'diff(5)', 'unique([])', 'find(0)', 'find(zeros(0, 3))', 'max(zeros(0, 3))', 'sort([])',
  "sprintf('%.1f', 0.25)", "sprintf('%.0f', 0.5)", "sprintf('%.0f', 2.5)", "sprintf('%.1f', 1.25)", "sprintf('%5.1f', [1.25 -2.5])",
  "sprintf('%g', 1e5)", "sprintf('%g', 123456)", "sprintf('%x', 255)", "sprintf('%5s|', 'ab')", "sprintf('%-5d|', 3)", "sprintf('%+.2e', -12345.678)",
  'num2str(123456789)', 'num2str(0.1 + 0.2)', 'num2str([1 2; 3 4])', 'num2str(-pi, 8)', "num2str(pi, '%10.5f')", 'num2str(1e-10)', 'num2str(1+2i)',
  'mat2str(pi)', 'mat2str(-0.5)', 'mat2str([1.5 -2])', 'mat2str(1+2i)', "mat2str('abc')", 'mat2str(zeros(0, 3))',
  'int2str([1.5 -2.5])', 'null(magic(4))', 'orth([1 1; 1 1])', '[Q, R] = qr([1 2; 3 4]) @Q', '[Q, R] = qr([1 2; 3 4]) @R',
  '[V, D] = eig([2 1; 1 2]) @V', '[V, D] = eig([1 2; 3 4]) @V', 'eig([0 1; -1 0])', 'roots([1 0 1])', 'roots(reshape(magic(4), 1, []))',
  'svd(magic(4))', '[U, S, V] = svd([1 2; 3 4; 5 6]) @U', 'pinv(magic(4))', 'expm([0 1; -1 0])', 'sqrtm([4 1; 1 3])', 'sqrtm([1 2; 3 4])',
  'cellfun(@isempty, {})', "cellfun('isempty', {})", 'iscellstr({})', 'isvector(zeros(1, 0))', 'logspace(0, pi, 3)',
  "strsplit('a,b,,c', ',')", "strjoin({'a', 'b', 'c'})", "regexp('ab12cd', '\\d+', 'match')", "regexprep('aaa', 'a', 'b', 'once')",
  "strtrim(sprintf(' \\t a b \\n'))", "upper({'ab', 'c'})", "strrep({'aa', 'ba'}, 'a', 'x')", "fliplr({1, 'a', 3})", 'fftshift({1, 2, 3})',
  'mean(int8([1 2]))', 'class(true + true)', "class(['a' 66])", 'class([true; 2])', 'class({} == {})', 'isequal({1, 2}, {1, 2})',
  'mod(-1, Inf)', 'mod(1, -Inf)', 'rem(-1, Inf)', 'atan2(-0, -1)', 'round(2.5)', 'round(-0.5)', 'sign(-0)', '1/-0', 'max(-0, 0)', 'min([NaN 1], [], 2)',
  'cumsum([1 NaN 2])', 'cummax([1 NaN 3 2])', "median([1 NaN 3])", "median([1 NaN 3], 'omitnan')", 'mode([])', 'var(5)', 'std([])', 'var([1 2; 3 4], [], 2)',
  'histcounts([1 2 2 3 10])', 'histcounts(randn(0, 1))', 'discretize([1 5 10], [0 5 10])', 'accumarray([1; 3], [10; 20])', 'prctile([1 2 3 4], [25 50 75])',
  'interp1([1 2 3], [4 5 6], [0 1.5 4], \'linear\', \'extrap\')', 'interp1([1 2 3], [4 5 6], 2.5, \'nearest\')', 'spline([0 1 2 3], [0 1 8 27], 1.5)', 'pchip([0 1 2 3], [0 1 8 27], 1.5)',
  'polyfit([1 2 3 4], [1 4 9 16], 2)', 'polyval([1 2 3], [1 2; 3 4])', 'conv([1 2 3], [1 1], \'same\')', 'filter(1, [1 -0.5], [1 1 1])', 'deconv([1 3 3 1], [1 1])',
  'trapz([1 2; 3 4])', 'cumtrapz([1 2; 3 4], 2)', 'nchoosek(1:4, 3)', 'perms([1 2 3])', 'factor(360)', 'primes(1)', 'isprime(0:3)',
  '[n, d] = rat(0.75) @d', 'rat(pi)', 'rats(0.75)', 'gcd([12 18], 8)', 'lcm(int8(4), 6)',
  'erf(0.5)', 'gamma(0.5)', 'gamma(-1)', 'gammaln(0.5)', 'psi(1)', 'beta(2, 3)', 'betainc(0.5, 2, 3)', 'gammainc(1, 2)', 'erfinv(0.5)',
  'fft([1 2 3])', 'ifft([1 2 3])', 'fft([1 0 0 0])', 'fft2([1 2; 3 4])', 'fftshift([1 2 3 4 5])', 'ifftshift([1 2 3 4 5])',
  'intersect([3 1 2], [2 3 4])', "union({'b', 'a'}, {'c', 'a'})", 'setdiff([5 1 3 1], 1)', "unique({'b', 'a', 'b'})", 'sortrows([3 1; 1 2; 3 0])', 'issorted([1 2 2 3])',
  'movmean(1:5, 2)', 'movmedian([4 1 3 2], 3)', 'normalize([1 2 3])', 'rescale([1 2 3])', 'bounds([3 1 2])', 'vecnorm([3 4; 6 8])',
  'cov([1 2 3; 4 6 5])', 'corrcoef([1 2 3], [2 4 7])', 'quantile([1 2 3 4], 0.5)',
  'zeros(2, 0) * zeros(0, 3)', 'ones(0, 3) * ones(3, 2)', 'sum(zeros(2, 0), 2)', '[] + 1', '[] == []', 'isempty([] + [])',
  "['abc'] == 'abc'", "'abc' < 'b'", '~[]', 'any(zeros(0, 3))', 'all(zeros(0, 3))', 'xor([1 0], [1 1])',
];

// Argument battery for the library sweep (a subset of run_tests12's).
const SINGLE = [
  '[]', 'zeros(1, 0)', 'zeros(0, 3)', 'NaN', 'Inf', '-2', '0', '3', '2.5', '[1 NaN 3]', '1:5', '(1:5)\'',
  '[4 -2; 1 3]', 'magic(4)', '[1+2i 3-1i]', '1i', "'ab'", "''", "['ab'; 'cd']", 'true', '[true false]',
  "{1, 'a'}", "{'ab', 'c'}", '{}', "struct('a', 1)", 'struct([])', '@sin', '@(x) x + 1',
];
const FIRSTS = ['[4 -2; 1 3]', '1:5', '[]', "'ab'", "{'ab', 'c'}", '[1+2i 3-1i]', 'NaN'];
const SECONDS = ['[]', '1', '2', '0', '-1', '0.5', 'NaN', "'all'", "'ab'", '{1}'];

// Pure functions to sweep: everything except plotting, I/O, randomness,
// the session (clc, clear, format, who, ...) and solvers that call back
// into user functions.
const SWEEP_MODULES = ['elementwise', 'reduction', 'linalg', 'fft', 'arrayops', 'numeric', 'containers', 'logic', 'mathext', 'strings', 'interp', 'missing', 'specfun', 'sets', 'stats'];
const SWEEP_SYSTEM = ['zeros', 'ones', 'eye', 'linspace', 'logspace', 'colon', 'class', 'isa', 'isnumeric', 'ischar', 'islogical', 'isreal', 'iscomplex',
  'double', 'logical', 'char', 'sprintf', 'num2str', 'mat2str', 'func2str', 'strcmp', 'strcmpi', 'upper', 'lower', 'strtrim', 'strrep', 'str2double'];

async function sweepFunctions() {
  const names = [];
  for (const m of SWEEP_MODULES) {
    const mod = await import(`../../src/builtins/${m}.js`);
    const register = Object.entries(mod).find(([k]) => k.startsWith('register'))[1];
    register({ set: (n) => names.push(n) });
  }
  return [...names, ...SWEEP_SYSTEM].sort();
}

const PAIRS = FIRSTS.flatMap(a => SECONDS.map(b => [a, b]));
// Whether to sweep a function with two arguments: not when it takes only
// one (every two-argument call errors with "Too many input arguments." in
// MatWeb), which keeps the reference file small.
function takesTwo(name) {
  const h = makeInterp();
  return [['1:5', '2'], ['[4 -2; 1 3]', '1'], ["'ab'", "'ab'"], ['[]', '[]']].some(([a, b]) => {
    try { h.run(`r__ = ${name}(${a}, ${b});`); return true; } catch (e) { return e.message !== 'Too many input arguments.'; }
  });
}
// The sweep calls for one function, in the order matweb_reference.m makes
// them: no arguments, each single argument, then each pair.
const sweepCalls = (name, two) => [[], ...SINGLE.map(a => [a]), ...(two ? PAIRS : [])].map(args => `${name}(${args.join(', ')})`);

const quote = (s) => `'${s.replace(/'/g, "''")}'`;
// A case: kind, id, code to run, variable holding the result.
function valueCase(kind, id, expr) {
  const at = expr.lastIndexOf(' @');
  if (at >= 0) {
    let code = expr.slice(0, at);
    if (!code.trim().endsWith(';')) code += ';';
    return [kind, id, code, expr.slice(at + 2)];
  }
  return [kind, id, `r__ = ${expr};`, 'r__'];
}

export async function referenceCases() {
  const cases = [];
  ROWS.forEach(([expr], k) => cases.push(valueCase('contract', `c${k + 1}`, expr)));
  ERRORS.forEach(([code], k) => cases.push(['error', `e${k + 1}`, code.endsWith(';') ? code : `${code};`, '']));
  PROBES.forEach((expr, k) => cases.push(valueCase('probe', `p${k + 1}`, expr)));
  const sweep = (await sweepFunctions()).map(name => [name, takesTwo(name)]);
  let s = 0;
  for (const [name, two] of sweep) for (const call of sweepCalls(name, two)) cases.push(valueCase('sweep', `s${++s}`, call));
  const displays = fs.readdirSync(path.join(root, 'test', 'display')).filter(f => f.endsWith('.m')).sort()
    .map(f => [f, fs.readFileSync(path.join(root, 'test', 'display', f), 'utf8').split('\n').filter(l => l.trim() && !l.trim().startsWith('%'))]);
  return { cases, displays, sweep };
}

export function matlabSource({ cases, displays, sweep }) {
  const lines = [];
  const add = (s = '') => lines.push(s);
  add('function matweb_reference(outfile)');
  add('%MATWEB_REFERENCE Record MATLAB\'s results for MatWeb\'s test cases.');
  add('%   matweb_reference writes matweb_reference.txt in the current folder;');
  add('%   matweb_reference(FILE) writes FILE. It takes a minute or two and');
  add('%   prints some warnings while it runs; that is expected.');
  add('%');
  add('%   Generated by tools/matlab/make-reference.mjs in the MatWeb repository;');
  add('%   do not edit by hand.');
  add('if nargin < 1, outfile = \'matweb_reference.txt\'; end');
  add('fid = fopen(outfile, \'w\');');
  add('if fid < 0, error(\'matweb_reference:open\', \'Cannot open %s for writing.\', outfile); end');
  add('closer = onCleanup(@() fclose(fid));');
  add('try, feature(\'hotlinks\', 0); catch, end % plain text from evalc');
  add('fprintf(fid, \'#MATWEB-REFERENCE 1\\n\');');
  add('fprintf(fid, \'#VERSION %s\\n\', version);');
  add('fprintf(fid, \'#COMPUTER %s\\n\', computer);');
  add('fprintf(fid, \'#DATE %s\\n\', datestr(now, 31));');
  add('% Installed products, so functions from a missing toolbox can be told apart.');
  add('try');
  add('  products = ver;');
  add('  for k = 1:numel(products), fprintf(fid, \'#PRODUCT %s %s\\n\', products(k).Name, products(k).Version); end');
  add('catch');
  add('end');
  add('fprintf(\'Recording MATLAB results for MatWeb in %s ...\\n\', outfile);');
  add('cases = {');
  for (const [kind, id, code, name] of cases.filter(c => c[0] !== 'sweep')) add(`  ${quote(kind)}, ${quote(id)}, ${quote(code)}, ${quote(name)}`);
  add('};');
  add('for k = 1:size(cases, 1)');
  add('  writeCase(fid, cases{k, 1}, cases{k, 2}, cases{k, 3}, cases{k, 4});');
  add('end');
  add('% The library sweep: each function with no arguments, each single');
  add('% argument and (when it takes two) each pair.');
  add('sweep = {');
  for (const [name, two] of sweep) add(`  ${quote(name)}, ${two ? 'true' : 'false'}`);
  add('};');
  add('singles = {');
  for (const a of SINGLE) add(`  ${quote(a)}`);
  add('};');
  add('pairs = {');
  for (const [a, b] of PAIRS) add(`  ${quote(a)}, ${quote(b)}`);
  add('};');
  add('state = warning;');
  add('warning(\'off\', \'all\');');
  add('s = 0;');
  add('for f = 1:size(sweep, 1)');
  add('  arglists = [{\'\'}; singles];');
  add('  if sweep{f, 2}, arglists = [arglists; strcat(pairs(:, 1), {\', \'}, pairs(:, 2))]; end');
  add('  for a = 1:numel(arglists)');
  add('    s = s + 1;');
  add('    writeCase(fid, \'sweep\', sprintf(\'s%d\', s), sprintf(\'r__ = %s(%s);\', sweep{f, 1}, arglists{a}), \'r__\');');
  add('  end');
  add('  if mod(f, 25) == 0, fprintf(\'  swept %d of %d functions\\n\', f, size(sweep, 1)); end');
  add('end');
  add('warning(state);');
  for (const [file, body] of displays) {
    add(`writeDisplay(fid, ${quote(file)}, {`);
    for (const l of body) add(`  ${quote(l)}`);
    add('});');
  }
  add('format short');
  add('format loose');
  add('fprintf(fid, \'#END\\n\');');
  add('fprintf(\'Done: %d cases written to %s\\n\', size(cases, 1) + s, outfile);');
  add('end');
  add('');
  add('function writeCase(fid, kind, id, code, name)');
  add('fprintf(fid, \'@@ %s %s\\n\', kind, id);');
  add('fprintf(fid, \'code: %s\\n\', code);');
  add('lastwarn(\'\');');
  add('try');
  add('  if isempty(name)');
  add('    runCode(code);');
  add('    fprintf(fid, \'noerror\\n\');');
  add('  else');
  add('    v = runCode(code, name);');
  add('    writeValue(fid, v, 0);');
  add('  end');
  add('catch err');
  add('  fprintf(fid, \'error: %s\\n\', oneLine(err.identifier));');
  add('  fprintf(fid, \'message: %s\\n\', oneLine(err.message));');
  add('end');
  add('[msg, wid] = lastwarn;');
  add('if ~isempty(msg), fprintf(fid, \'warning: %s | %s\\n\', wid, oneLine(msg)); end');
  add('end');
  add('');
  add('function value__ = runCode(code__, name__)');
  add('eval(code__);');
  add('if nargin > 1, value__ = eval(name__); end');
  add('end');
  add('');
  add('function writeValue(fid, v, depth)');
  add('pad = repmat(\' \', 1, 2 * depth);');
  add('fprintf(fid, \'%sclass: %s\\n\', pad, class(v));');
  add('fprintf(fid, \'%ssize:%s\\n\', pad, sprintf(\' %d\', size(v)));');
  add('if isnumeric(v) || islogical(v) || ischar(v)');
  add('  x = double(v(:)).\';');
  add('  n = min(numel(x), 60);');
  add('  fprintf(fid, \'%sre:%s\\n\', pad, sprintf(\' %.17g\', real(x(1:n))));');
  add('  if ~isreal(v), fprintf(fid, \'%sim:%s\\n\', pad, sprintf(\' %.17g\', imag(x(1:n)))); end');
  add('  if numel(x) > n, fprintf(fid, \'%struncated: %d\\n\', pad, numel(x)); end');
  add('elseif iscell(v) && depth < 2');
  add('  for k = 1:min(numel(v), 20)');
  add('    fprintf(fid, \'%scell %d\\n\', pad, k);');
  add('    writeValue(fid, v{k}, depth + 1);');
  add('  end');
  add('elseif isstruct(v)');
  add('  f = fieldnames(v);');
  add('  fprintf(fid, \'%sfields:%s\\n\', pad, sprintf(\' %s\', f{:}));');
  add('elseif isa(v, \'function_handle\')');
  add('  fprintf(fid, \'%sfunc: %s\\n\', pad, func2str(v));');
  add('end');
  add('end');
  add('');
  add('function writeDisplay(mw_fid, mw_file, mw_lines)');
  add('% Runs a display script line by line in one workspace, recording');
  add('% exactly what each line prints (format compact, as MatWeb shows).');
  add('format short');
  add('format compact');
  add('for mw_k = 1:numel(mw_lines)');
  add('  fprintf(mw_fid, \'@@ display %s %d\\n\', mw_file, mw_k);');
  add('  fprintf(mw_fid, \'>> %s\\n\', mw_lines{mw_k});');
  add('  try');
  add('    mw_out = evalc(mw_lines{mw_k});');
  add('  catch mw_err');
  add('    mw_out = sprintf(\'Error: %s\\n\', mw_err.message);');
  add('  end');
  add('  fprintf(mw_fid, \'%s\', mw_out);');
  add('  fprintf(mw_fid, \'@@ enddisplay\\n\');');
  add('end');
  add('end');
  add('');
  add('function s = oneLine(s)');
  add('s = strrep(strrep(s, char(13), \'\'), char(10), \'\\n\');');
  add('end');
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await referenceCases();
  const out = path.join(here, 'matweb_reference.m');
  fs.writeFileSync(out, matlabSource(data));
  const counts = {};
  for (const [kind] of data.cases) counts[kind] = (counts[kind] || 0) + 1;
  console.log(`wrote ${path.relative(root, out)}: ${data.cases.length} cases (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}), ${data.displays.length} display scripts`);
}
