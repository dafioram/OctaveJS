import { makeInterp, fmtVar } from './harness.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkClose(label, actual, expected, tol = 1e-9) {
  const arrA = Array.isArray(actual) ? actual : [actual];
  const arrE = Array.isArray(expected) ? expected : [expected];
  let ok = arrA.length === arrE.length;
  if (ok) for (let i = 0; i < arrA.length; i++) if (Math.abs(arrA[i] - arrE[i]) > tol) ok = false;
  if (ok) pass++; else { fail++; console.log(`FAIL(close): ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function checkThrows(label, fn) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) { pass++; }
}

// ---------------- basic arithmetic & matrices ----------------
{
  const { interp, run } = makeInterp();
  run('a = 2 + 3;');
  check('scalar add', fmtVar(interp, 'a'), 5);
  run('A = [1 2; 3 4];');
  check('matrix literal', fmtVar(interp, 'A'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  run('B = A + 1;');
  check('matrix + scalar', fmtVar(interp, 'B'), { rows: 2, cols: 2, re: [2, 4, 3, 5], im: null });
  run('C = A * A;'); // [1 2;3 4]*[1 2;3 4] = [7 10; 15 22]
  check('matrix multiply', fmtVar(interp, 'C'), { rows: 2, cols: 2, re: [7, 15, 10, 22], im: null });
  run('D = A .* A;');
  check('elementwise multiply', fmtVar(interp, 'D'), { rows: 2, cols: 2, re: [1, 9, 4, 16], im: null });
  run('t = A(2,1);');
  check('2D index read', fmtVar(interp, 't'), 3);
  run("e = A(end,end);");
  check('end keyword', fmtVar(interp, 'e'), 4);
  run('v = A(:);');
  check('colon flatten', fmtVar(interp, 'v'), { rows: 4, cols: 1, re: [1, 3, 2, 4], im: null });
}

// ---------------- whitespace-sensitive matrix literal ----------------
{
  const { interp, run } = makeInterp();
  run('x = [1 -1 2 -2];');
  check('unary minus in matrix literal', fmtVar(interp, 'x'), { rows: 1, cols: 4, re: [1, -1, 2, -2], im: null });
  run('y = [1 - 1, 2-2];');
  check('binary minus in matrix literal', fmtVar(interp, 'y'), { rows: 1, cols: 2, re: [0, 0], im: null });
}

// ---------------- power precedence & associativity ----------------
{
  const { interp, run } = makeInterp();
  run('a = -2^2;'); check('unary looser than power', fmtVar(interp, 'a'), -4);
  run('b = 2^3^2;'); check('power left-assoc', fmtVar(interp, 'b'), 64);
}

// ---------------- control flow ----------------
{
  const { interp, run } = makeInterp();
  run(`
    total = 0;
    for i = 1:10
      total = total + i;
    end
  `);
  check('for loop sum 1..10', fmtVar(interp, 'total'), 55);

  run(`
    n = 0;
    while n < 5
      n = n + 1;
    end
  `);
  check('while loop', fmtVar(interp, 'n'), 5);

  run(`
    if 3 > 5
      r = 1;
    elseif 3 > 2
      r = 2;
    else
      r = 3;
    end
  `);
  check('if/elseif/else', fmtVar(interp, 'r'), 2);

  run(`
    s = 0;
    for i = 1:10
      if mod(i,2) == 0
        continue;
      end
      if i > 7
        break;
      end
      s = s + i;
    end
  `);
  check('break/continue', fmtVar(interp, 's'), 1 + 3 + 5 + 7);

  run(`
    switch 2
      case 1
        w = 10;
      case {2,3}
        w = 20;
      otherwise
        w = 30;
    end
  `);
  check('switch with cell case list', fmtVar(interp, 'w'), 20);
}

// ---------------- logical indexing vs numeric indexing ----------------
{
  const { interp, run } = makeInterp();
  run('x = [5 -3 8 -1 0];');
  run('y = x(x > 0);');
  check('logical indexing', fmtVar(interp, 'y'), { rows: 1, cols: 2, re: [5, 8], im: null });
  run('x(x < 0) = 0;');
  check('logical index assignment', fmtVar(interp, 'x'), { rows: 1, cols: 5, re: [5, 0, 8, 0, 0], im: null });
}

// ---------------- growth & deletion ----------------
{
  const { interp, run } = makeInterp();
  run('x = [1 2 3];');
  run('x(5) = 9;');
  check('vector auto-growth', fmtVar(interp, 'x'), { rows: 1, cols: 5, re: [1, 2, 3, 0, 9], im: null });
  run('A = [1 2; 3 4];');
  run('A(3,3) = 7;');
  check('matrix auto-growth', fmtVar(interp, 'A'), { rows: 3, cols: 3, re: [1, 3, 0, 2, 4, 0, 0, 0, 7], im: null });
  run('B = [1 2 3; 4 5 6];');
  run('B(:,2) = [];');
  check('column deletion', fmtVar(interp, 'B'), { rows: 2, cols: 2, re: [1, 4, 3, 6], im: null });
  run('C = [1 2 3];');
  run('C(2) = [];');
  check('element deletion', fmtVar(interp, 'C'), { rows: 1, cols: 2, re: [1, 3], im: null });
}

// ---------------- functions (regular, multi-output, anonymous) ----------------
{
  const { interp, run } = makeInterp();
  run(`
    function y = square(x)
      y = x.^2;
    end
    r = square(5);
  `);
  check('user function', fmtVar(interp, 'r'), 25);

  run(`
    function [s,p] = sumprod(a,b)
      s = a + b;
      p = a * b;
    end
    [ss,pp] = sumprod(3,4);
  `);
  check('multi-output function (sum)', fmtVar(interp, 'ss'), 7);
  check('multi-output function (prod)', fmtVar(interp, 'pp'), 12);

  run('f = @(x) x.^2 + 2*x + 1;');
  run('fv = f(3);');
  check('anonymous function', fmtVar(interp, 'fv'), 16);

  run('a = 10; g = @(x) x + a; a = 999;');
  run('gv = g(1);');
  check('anonymous function captures by value at creation', fmtVar(interp, 'gv'), 11);

  run(`
    function r = fact(n)
      if n <= 1
        r = 1;
      else
        r = n * fact(n-1);
      end
    end
    fv2 = fact(5);
  `);
  check('recursion', fmtVar(interp, 'fv2'), 120);
}

// ---------------- complex numbers ----------------
{
  const { interp, run } = makeInterp();
  run('z = 3 + 4i;');
  run('m = abs(z);');
  check('complex abs', fmtVar(interp, 'm'), 5);
  run('w = sqrt(-1);');
  check('sqrt(-1) promotes to complex', fmtVar(interp, 'w'), { re: 0, im: 1 });
  run('u = (1+2i) * (3-1i);'); // = 3-1i+6i-2i^2 = 3+5i+2 = 5+5i
  check('complex multiply', fmtVar(interp, 'u'), { re: 5, im: 5 });
}

// ---------------- strings ----------------
{
  const { interp, run } = makeInterp();
  run("s = 'it''s ok';");
  check('escaped quote in string', fmtVar(interp, 's'), "it's ok");
  run("t = ['ab' 'cd'];");
  check('char array concatenation', fmtVar(interp, 't'), 'abcd');
}

// ---------------- ranges ----------------
{
  const { interp, run } = makeInterp();
  run('r = 1:2:10;');
  check('stepped range', fmtVar(interp, 'r'), { rows: 1, cols: 5, re: [1, 3, 5, 7, 9], im: null });
}

// ---------------- reduction builtins ----------------
{
  const { interp, run } = makeInterp();
  run('A = [1 2 3; 4 5 6];');
  run('s = sum(A);'); // default dim=1 -> per column
  check('sum default dim (matrix)', fmtVar(interp, 's'), { rows: 1, cols: 3, re: [5, 7, 9], im: null });
  run('s2 = sum([1 2 3 4]);'); // row vector -> scalar
  check('sum on row vector', fmtVar(interp, 's2'), 10);
  run('m = mean([2 4 6]);');
  check('mean', fmtVar(interp, 'm'), 4);
  run('[mx,idx] = max([3 1 4 1 5 9 2 6]);');
  check('max value', fmtVar(interp, 'mx'), 9);
  check('max index', fmtVar(interp, 'idx'), 6);
}

// ---------------- linear algebra ----------------
{
  const { interp, run } = makeInterp();
  run('A = [4 0; 0 9];');
  run('d = det(A);');
  check('det', fmtVar(interp, 'd'), 36);
  run('B = inv(A);');
  checkClose('inv', fmtVar(interp, 'B').re, [0.25, 0, 0, 1 / 9]);
  run('r = rank([1 2; 2 4]);'); // rank-deficient
  check('rank deficient', fmtVar(interp, 'r'), 1);
  run('r2 = rank(eye(3));');
  check('rank full', fmtVar(interp, 'r2'), 3);
  run('x = [3 4]; n = norm(x);');
  check('vector 2-norm', fmtVar(interp, 'n'), 5);
  run('tr = trace([1 2; 3 4]);');
  check('trace', fmtVar(interp, 'tr'), 5);
  run('x2 = A \\ [4;9];');
  checkClose('backslash solve', fmtVar(interp, 'x2').re, [1, 1]);
}

pass_fail_report:
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
