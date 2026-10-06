// extended-cases.mjs — the second round of reference cases: the language
// itself (indexing, assignment, deletion, growth, operators, precedence,
// cells and structs), multi-output forms, options, formatted text, and
// more error messages. Value cases use the contract syntax: an expression,
// or a statement ending in `@name` naming the variable to record. The
// matching display scripts are test/display/*2.m.
// Everything here must be valid in MATLAB R2015a (no implicit expansion
// needed for the answer, no string type).

export const EXTENDED = [
  // ---- indexing ----
  'A = magic(4); r = A(2, 3); @r', 'A = magic(4); r = A(7); @r', 'A = magic(4); r = A(end, 1); @r', 'A = magic(4); r = A(end); @r',
  'A = magic(4); r = A([1 3], [2 4]); @r', 'A = magic(4); r = A(:, 2); @r', 'A = magic(4); r = A(2, :); @r', 'A = magic(4); r = A(:); @r',
  'A = magic(4); r = A(:)\'; @r', 'A = magic(4); r = A(A > 10); @r', 'A = magic(4); r = A(logical([1 0 1 0]), :); @r', 'A = magic(4); r = A([]); @r',
  'A = magic(4); r = A([], 1); @r', 'A = magic(4); r = A(:, []); @r', 'v = 1:5; r = v([true false true]); @r', 'v = (1:5)\'; r = v([2 4]); @r',
  'v = 1:5; r = v([2; 4]); @r', 'v = (1:5)\'; r = v([2 4; 1 3]); @r', 'A = magic(3); r = A([1 2; 3 4]); @r', 'A = magic(3); r = A(end:-1:1, :); @r',
  'A = magic(3); r = A(end, end); @r', 'v = 1:5; r = v(end-1:end); @r', 'v = 1:5; r = v(logical([0 0 0 0 0])); @r', 'x = 5; r = x(1, 1, 1); @r',
  's = \'hello\'; r = s([1 end]); @r', 's = \'hello\'; r = s(end:-1:1); @r', 'c = {1, \'a\', [2 3]}; r = c(2); @r', 'c = {1, \'a\', [2 3]}; r = c{3}(2); @r',
  // ---- assignment, growth, deletion ----
  'x = []; x(3) = 5; @x', 'x = 1:3; x(6) = 9; @x', 'x = (1:3)\'; x(5) = 9; @x', 'A = eye(2); A(3, 3) = 7; @A',
  'A = magic(3); A(2, :) = []; @A', 'A = magic(3); A(:, [1 3]) = []; @A', 'v = 1:5; v([2 4]) = []; @v', 'v = (1:5)\'; v(2) = []; @v',
  'A = magic(3); A(5) = []; @A', 'A = zeros(2); A(:) = 1:4; @A', 'A = zeros(2, 3); A(2, :) = 7; @A', 'A = magic(3); A(A > 5) = 0; @A',
  's = \'abc\'; s(5) = \'e\'; r = double(s); @r', 's = \'abc\'; s(2) = []; @s', 'c = {}; c{3} = 1; @c', 'c = {1, 2}; c(2) = []; @c',
  'x = 1; x(2, 3) = 4; @x', 'A = 1:3; A(:, end+1) = 4; @A', 'A = [1 2; 3 4]; A(end+1, :) = [5 6]; @A', 'v = []; v(end+1) = 3; v(end+1) = 4; @v',
  'x = true(1, 2); x(4) = true; @x', 'x = true(1, 2); x(2) = 5; @x', 'x = \'ab\'; x(1) = 66; @x', 'x = 1:3; x(2) = true; @x',
  // ---- structs and cells ----
  's.a = 1; s.b.c = \'x\'; r = s.b.c; @r', 's(2).a = 5; r = size(s); @r', 's(2).a = 5; r = s(1).a; @r', 's = struct(\'a\', {1, 2, 3}); r = [s.a]; @r',
  's = struct(\'a\', {1, 2, 3}); r = {s.a}; @r', 's = struct(\'a\', {}); r = size(s); @r', 's = struct(\'a\', {{1, 2}}); r = s.a; @r', 's.x = 1; f = \'x\'; r = s.(f); @r',
  'c = {1, 2; 3, 4}; r = [c{:, 1}]; @r', 'c = {1, \'ab\'}; r = class(c{2}); @r', 'c = cell(2, 3); r = size(c{1}); @r', 'c = num2cell(magic(2)); r = c{2, 1}; @r',
  's = struct(); r = isempty(fieldnames(s)); @r', 's = struct(\'a\', 1, \'b\', 2); s = rmfield(s, \'a\'); r = fieldnames(s); @r', 's = struct(\'b\', 1, \'a\', 2); r = fieldnames(orderfields(s)); @r',
  'x = struct(\'a\', 1); y = x; y.a = 2; r = x.a; @r', 'c = {1}; d = c; d{1} = 2; r = c{1}; @r', 'A = 1:3; B = A; B(1) = 9; r = A; @r',
  // ---- operators, classes, precedence ----
  '-2^2', '2^-1', '-2^-2', '2^3^2', '~1 == 0', '1:3 + 1', '(1:3)\'', '[1 2 3]\' * [1 2]', '[1+2i 3]\'', '[1+2i 3].\'',
  '1:0.5:3', '3:-1:1', '1:-1:3', '0:0.1:0.5', '-1:1', '5:5', '1.5:3', 'size(1:0)', 'size(zeros(1, 0) + 1)',
  '\'a\' + \'b\'', '\'abc\' == \'abc\'', '\'abc\' == \'a\'', 'true + true', 'true * 3', 'class(true & true)', 'class(1 & 2)', 'class(\'a\' == \'a\')',
  'xor(true, [true false])', '~[1 0 2]', '3 > 2 > 1', '1 < 2 < 3', '[] == []', 'isempty([] == 1)', '1 / 0 - 1 / 0', '0 * Inf', 'Inf - Inf',
  'mod(-7, 3)', 'rem(-7, 3)', 'mod(7, -3)', 'rem(7, -3)', 'mod(5.5, -2)', 'mod(-1, 1)', 'fix(-7 / 2)', 'round(-7 / 2)',
  '[1 2; 3 4] * [5; 6]', '[1 2; 3 4] .* [5 6; 7 8]', '[1 2; 3 4] ^ 2', '[1 2; 3 4] .^ 2', '2 .^ [1 2; 3 4]', '[1 2; 3 4] \\ [5; 6]', '[5 6] / [1 2; 3 4]',
  '[1 2; 3 4] ^ -1', '[4 1; 1 3] ^ 0.5', '2 ^ [1 2; 3 4]', '(-8) ^ (1/3)', '[1 2 3] * 2', '[1 2 3] / 2', '2 ./ [1 2 4]', '[2 4] .\\ [8 8]',
  'true | false', '[1 0 1] & [1 1 0]', 'any([0 0 1])', 'all([1 1 0])', '1e308 * 10', '-1e308 * 10', 'realmax', 'realmin', 
  // ---- multi-output forms ----
  '[m, i] = max([3 7 7 1]) @i', '[m, i] = min([4 2 2 9]) @i', '[m, i] = max([1 NaN 3]) @i', '[m, i] = max([NaN NaN]) @i', '[m, i] = max(magic(3)) @i',
  '[m, i] = max(magic(3), [], 2) @i', '[s, i] = sort([3 1 2; 9 7 8], 2) @i', '[s, i] = sort([2 1 2 1]) @i', '[s, i] = sort([2 1 2 1], \'descend\') @i',
  '[u, i, j] = unique([3 1 3 2]) @i', '[u, i, j] = unique([3 1 3 2]) @j', '[u, i, j] = unique([3 1 3 2], \'stable\') @u', '[u, i] = unique([3 1 3 2], \'last\') @i',
  '[u, i, j] = unique([1 2; 1 2; 3 4], \'rows\') @u', '[tf, loc] = ismember([1 5 3], [3 1 1]) @loc', '[tf, loc] = ismember({\'a\', \'z\'}, {\'z\', \'a\'}) @loc',
  '[r, c] = find([0 1; 1 0]) @c', '[r, c, v] = find([0 2; 3 0]) @v', '[q, r] = deconv([1 5 6], [1 2]) @r', '[n, x] = hist([1 2 2 3 3 3]) @x',
  '[n, x] = hist([1 2 2 3 3 3], 3) @n', '[r, c] = size(ones(2, 3, 1)) @c', '[a, b, c] = size(ones(2, 3)) @c', 'n = size(ones(2, 3), 3)', '[q, r] = qr([1 2; 3 4], 0) @q',
  '[f, e] = log2([1 0.5 10]) @e', '[n, d] = rat([0.5 0.333]) @d', '[c, ia, ib] = intersect([1 2 3], [3 1]) @ib', '[c, ia] = setdiff([5 4 3], 4) @ia',
  // ---- options and text ----
  'sort([3 1 2], 2, \'descend\')', 'sort({\'b\', \'a\', \'C\'})', 'sort(\'hello\')', 'unique({\'b\', \'a\', \'b\'})', 'unique([1 NaN NaN])', 'max([1 2; 3 4], [], 1)',
  'sum([1 2; 3 4], 2)', 'cumsum([1 2 3], 2)', 'mean([1 2; 3 4], 1)', 'any([0 0; 0 1], 2)', 'prod([1 2; 3 4], 2)',
  'strsplit(\'a b  c\')', 'strsplit(\'a-b_c\', {\'-\', \'_\'})', 'strjoin({\'a\', \'b\'})', 'regexp(\'abc123def\', \'\\d+\', \'match\')', 'regexp(\'abc123\', \'(\\w)(\\d)\', \'tokens\')',
  'regexp(\'key=val\', \'(?<k>\\w+)=(?<v>\\w+)\', \'names\')', 'regexp(\'a1b2\', \'\\d\', \'split\')', 'regexp(\'aaa\', \'a\', \'once\')', 'regexprep(\'hello world\', \'(\\w+) (\\w+)\', \'$2 $1\')',
  'regexprep(\'abc\', \'(.)\', \'$1$1\')', 'regexpi(\'ABC\', \'b\', \'match\')', 'strtrim({\' a \', \'b \'})', 'upper(\'mixed Case 1\')', 'fliplr(\'abc\')', 'strcat(\'a \', \'b \')',
  'strcat({\'a \'}, \'b \')', '[\'a \', \'b \']', 'char(\'a\', \'\', \'bcd\')', 'num2str([1.5 2; 3 4.25])', 'num2str(-0.000123)', 'num2str(123456.789)',
  'num2str(1e15)', 'num2str(1e16)', 'num2str(0.1)', 'num2str([0.1 0.22 0.333])', 'num2str(pi, 10)', 'num2str(true)', 'num2str([1 2 3]\')',
  'mat2str([1 -2.5; NaN Inf])', 'mat2str(pi, 4)', 'mat2str([true false])', 'mat2str(\'it\'\'s\')', 'mat2str(magic(3) > 4)', 'int2str(-0.5)', 'int2str(0.5)', 'int2str(1.5)',
  'sprintf(\'%d\', [1 2 3])', 'sprintf(\'%d-%d\\n\', [1 2; 3 4])', 'sprintf(\'%5.2f|\', pi)', 'sprintf(\'%-8s|\', \'ab\')', 'sprintf(\'%08.3f\', -pi)', 'sprintf(\'%+d %+d\', 5, -5)',
  'sprintf(\'%e\', 12345.6789)', 'sprintf(\'%E\', 0.000123)', 'sprintf(\'%g %g %g\', 1e-5, 1e5, 123456789)', 'sprintf(\'%G\', 1e-10)', 'sprintf(\'%x %X %o\', 255, 255, 8)',
  'sprintf(\'%c%c%c\', 72, 105, 33)', 'sprintf(\'%s\', \'abc\', \'def\')', 'sprintf(\'%s=%d \', \'a\', 1, \'b\', 2)', 'sprintf(\'%d %s\', 1, \'x\', 2)', 'sprintf(\'%5s|%-5s|\', \'a\', \'b\')',
  'sprintf(\'%.3s\', \'abcdef\')', 'sprintf(\'%d\', 1.5)', 'sprintf(\'%i\', -3)', 'sprintf(\'%u\', 7)', 'sprintf(\'%f\', NaN)', 'sprintf(\'%d\', Inf)', 'sprintf(\'%5.1f\', -Inf)',
  'sprintf(\'%d %%\', 50)', 'sprintf(\'a\\tb\')', 'sprintf(\'%*d\', 5, 3)', 'sprintf(\'%.*f\', 2, pi)', 'sprintf(\'%#o %#x\', 8, 255)', 'sprintf(\'% d\', 5)', 'sprintf(\'%s\', 65)',
  'sprintf(\'%d\', \'a\')', 'sprintf(\'%f\', true)', 'sprintf(\'\')', 'sprintf(\'%d\', [])', 'sprintf(\'%.0f %.0f %.0f\', 0.5, 1.5, 2.5)',
  'sprintf(\'%.2f\', 2.675)', 'sprintf(\'%.1f\', 0.05)', 'sprintf(\'%10.4e\', 1)', 'sprintf(\'%g\', 100000)', 'sprintf(\'%g\', 1000000)', 'sprintf(\'%g\', 0.0001)', 'sprintf(\'%g\', 0.00001)',
  'str2num(\'[1 2; 3 4]\')', 'str2num(\'3+4\')', 'str2double(\'1e-3\')', 'str2double(\' 42 \')', 'str2double(\'1 2\')', 'str2double(\'.5\')', 'str2double(\'-.5e2\')', 'num2str(str2double(\'7\'))',
  'strcmp({\'a\', \'b\'}, {\'a\', \'c\'})', 'strncmp(\'abcdef\', \'abcxyz\', 3)', 'strncmpi(\'ABCdef\', \'abcxyz\', 3)', 'isspace(\'a b\')', 'isletter(\'a1B\')', 'isstrprop(\'a1 \', \'digit\')',
  'lower({\'AB\', \'Cd\'})', 'blanks(3)', 'deblank(\'ab   \')', 'fliplr(\'\')', 'double(\'é\')', 'char(233)', 'dec2bin(10)', 'bin2dec(\'1010\')', 'dec2hex(255)', 'hex2dec(\'FF\')',
  // ---- numeric details ----
  'floor(-0.5)', 'round(0.49999999999999994)', 'round(-2.5)', 'fix(-2.5)', 'abs(-0)', 'sign(-0)', '1 / -0', 'atan2(0, -0)', 'sqrt(-0)', 'max(NaN, 1)', 'min([NaN 1 NaN])',
  'sum([])', 'sum([], 1)', 'sum([], 2)', 'sum(zeros(0, 3), 2)', 'prod(zeros(0, 3))', 'mean(zeros(0, 3))', 'max(zeros(0, 3), [], 2)', 'cumsum(zeros(2, 0))', 'any(zeros(0, 3))',
  'eps(1e10)', 'eps(-1)', 'eps(Inf)', 'eps(NaN)', 'nextpow2(1000)', 'nextpow2(0)', 'factorial(171)', 'factorial(170)', 'nchoosek(30, 15)', 'gamma(171.5)',
  'exp(710)', 'log(0)', 'log(-0)', 'log10(-10)', 'sqrt(-4) * 1i', '(1+2i) * (3-4i)', '(1+2i) / (3-4i)', 'abs(3+4i)', 'angle(-1-0i)', 'conj([1+2i 3])', 'real(\'a\')', 'imag(5)',
  'complex(1, 0) == 1', 'isreal(complex(1, 0) + 0)', 'isreal([1+0i 2])', 'isreal(sqrt(-1) * 0)', '1i^2', 'exp(1i * pi)', 'linspace(0, 1, 3)\'', 'linspace(1, 0, 3)', 'colon(1, 3)',
  'det([1 2; 3 4])', 'inv([1 2; 3 4])', 'rank([1 2; 2 4])', 'trace([1 2; 3 4])', 'norm([1 2; 3 4])', 'norm([1 2 3], 1)', 'norm([1 2 3], Inf)', 'norm([1 2 3], -Inf)', 'cond([1 2; 3 4])',
  'kron(eye(2), [1 2])', 'cross([1 2 3], [4 5 6])', 'dot([1 2; 3 4], [1 2; 3 4])', 'triu(magic(4), -1)', 'tril(magic(4), 1)', 'diag(magic(3), -1)', 'trace(magic(4))', 'expm(zeros(2))',
  'polyfit(1:5, [2 4 6 8 10], 1)', 'polyval([1 2 3], 2)', 'roots([1 -3 2])', 'conv([1 2], [1 3])', 'filter([1 1], 1, [1 2 3])', 'filter(1, [1 -0.5], [1 0 0])', 'interp1([1 2 3], [4 5 6], 1.5)',
  'cumprod([1 2 3 4])', 'diff([1 4 9], 1, 2)', 'trapz([0 1 2], [0 1 4])', 'histc([1 2 2 3 5], 1:5)', 'accumarray([1; 2; 1], [10; 20; 30])', 'median([3 1 2; 6 5 4])', 'mode([1 1 2 2])',
  'var([1 2 3 4], 1)', 'std([1 2; 3 4])', 'var([2 4 4 4 5 5 7 9], [], 2)', 'cov([1 2 3], [1 2 4])', 'corrcoef([1 2 3], [3 2 1])', 'primes(30)', 'isprime([2 4 97])', 'factor(84)', 'gcd([12 15], 9)',
];

// Statements whose error messages are recorded.
export const EXTENDED_ERRORS = [
  'x = [1 2 3]; x(1.5) = 1;', 'x = [1 2 3]; x(-1)', 'x = [1 2 3]; x(0) = 1;', 'A = magic(3); A(:, 4)', 'A = magic(3); A(4, :)', 'A = magic(3); A(1, 2, 3)',
  'A = magic(3); A([1 2], :) = [1 2 3];', 'x = 1:3; x(5) = [];', 'A = magic(3); A(2, 2) = [];', 'c = {1}; c{2}', 'c = {1, 2}; x = c{:};', 's.a = 1; s(3).b',
  's = struct(\'a\', {1, 2}); s.a', 's = 5; s.a = 1;', 'x = \'abc\'; x.y', 'f = @(x) x; f.a', 'x = {1} + 1;', 'x = struct(\'a\', 1) + 1;', 'x = @sin + 1;',
  '[1 2 3] * [4 5 6]', '[1 2] + [1 2 3]\'', 'ones(2, 3) \\ ones(3, 1)', '[1 2; 3 4] ^ [1 2]', 'x = [1, 2; 3]', 'x = [[1 2]; [3 4 5]]', 'x = {1, 2; 3}',
  'undefined_thing + 1', 'sin', 'sin()', 'sin(1, 2, 3)', 'zeros(-1)', 'ones(2, \'foo\')', 'cell(\'a\')', 'magic(\'a\', 2)', 'str2func(5)', 'feval(\'nonexistent_fn\')',
  'error(\'Custom message\')', 'error(\'a:b\', \'With id %d\', 3)', 'error(\'%s\', \'percent\')', 'error(struct(\'message\', \'from struct\', \'identifier\', \'x:y\'))', 'assert(false)', 'assert(false, \'fail %d\', 2)',
  'x = 1; x{1} = 2;', 'x = [1 2 3]; x(4)', 'x = 5; x(2, 2)', 'q = zeros(2); q(5)', 'n = numel(1, 2, 3, 4)', 'strcat(1, {2})', 'cell2mat({1, \'a\'})', 'fieldnames(5)',
  'if [1 0], end', 'while [], end, x = 1', 'switch {1}, case 1, end', 'for k = {1, 2}, end, x = k', 'x = 1; x(:, :, 2)',
];
