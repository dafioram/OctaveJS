import { makeInterp, fmtVar } from './harness.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkClose(label, actual, expected, tol = 1e-6) {
  const arrA = Array.isArray(actual) ? actual : [actual];
  const arrE = Array.isArray(expected) ? expected : [expected];
  let ok = arrA.length === arrE.length;
  if (ok) for (let i = 0; i < arrA.length; i++) if (Math.abs(arrA[i] - arrE[i]) > tol) ok = false;
  if (ok) pass++; else { fail++; console.log(`FAIL(close): ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// ---------------- find ----------------
{
  const { interp, run } = makeInterp();
  run('x = [0 5 0 -3 0 8];');
  run('idx = find(x);');
  check('find on row vector', fmtVar(interp, 'idx'), { rows: 1, cols: 3, re: [2, 4, 6], im: null });
  run('idx2 = find(x, 2);');
  check('find with count limit', fmtVar(interp, 'idx2'), { rows: 1, cols: 2, re: [2, 4], im: null });
  run('idx3 = find(x, 1, \'last\');');
  check("find with 'last'", fmtVar(interp, 'idx3'), 6);
  run('A = [0 1; 2 0];');
  run('[r,c] = find(A);');
  check('find 2-output rows', fmtVar(interp, 'r'), { rows: 2, cols: 1, re: [2, 1], im: null });
  check('find 2-output cols', fmtVar(interp, 'c'), { rows: 2, cols: 1, re: [1, 2], im: null });
}

// ---------------- any / all ----------------
{
  const { interp, run } = makeInterp();
  run('a1 = any([0 0 1 0]);'); check('any true', fmtVar(interp, 'a1'), 1);
  run('a2 = any([0 0 0]);'); check('any false', fmtVar(interp, 'a2'), 0);
  run('a3 = all([1 1 1]);'); check('all true', fmtVar(interp, 'a3'), 1);
  run('a4 = all([1 0 1]);'); check('all false', fmtVar(interp, 'a4'), 0);
  run('a5 = any([0 1; 0 0]);'); check('any per-column on matrix', fmtVar(interp, 'a5'), { rows: 1, cols: 2, re: [0, 1], im: null });
}

// ---------------- isnan / isinf / isfinite ----------------
{
  const { interp, run } = makeInterp();
  run('x = [1 NaN Inf -Inf 0];');
  run('n = isnan(x); i = isinf(x); f = isfinite(x);');
  check('isnan', fmtVar(interp, 'n'), { rows: 1, cols: 5, re: [0, 1, 0, 0, 0], im: null });
  check('isinf', fmtVar(interp, 'i'), { rows: 1, cols: 5, re: [0, 0, 1, 1, 0], im: null });
  check('isfinite', fmtVar(interp, 'f'), { rows: 1, cols: 5, re: [1, 0, 0, 0, 1], im: null });
}

// ---------------- fliplr / flipud / flip ----------------
{
  const { interp, run } = makeInterp();
  run('A = [1 2 3; 4 5 6];');
  run('L = fliplr(A); U = flipud(A);');
  check('fliplr', fmtVar(interp, 'L'), { rows: 2, cols: 3, re: [3, 6, 2, 5, 1, 4], im: null });
  check('flipud', fmtVar(interp, 'U'), { rows: 2, cols: 3, re: [4, 1, 5, 2, 6, 3], im: null });
}

// ---------------- sort ----------------
{
  const { interp, run } = makeInterp();
  run('[s,idx] = sort([3 1 4 1 5]);');
  check('sort ascending values', fmtVar(interp, 's'), { rows: 1, cols: 5, re: [1, 1, 3, 4, 5], im: null });
  check('sort ascending indices', fmtVar(interp, 'idx'), { rows: 1, cols: 5, re: [2, 4, 1, 3, 5], im: null });
  run("s2 = sort([3 1 4], 'descend');");
  check('sort descending', fmtVar(interp, 's2'), { rows: 1, cols: 3, re: [4, 3, 1], im: null });
}

// ---------------- unique ----------------
{
  const { interp, run } = makeInterp();
  run('u = unique([3 1 2 1 3 3]);');
  const u = fmtVar(interp, 'u');
  check('unique values', u.re, [1, 2, 3]);
}

// ---------------- repmat ----------------
{
  const { interp, run } = makeInterp();
  run('R = repmat([1 2], 2, 3);');
  check('repmat', fmtVar(interp, 'R'), { rows: 2, cols: 6, re: [1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2], im: null });
}

// ---------------- cat / horzcat / vertcat ----------------
{
  const { interp, run } = makeInterp();
  run('H = horzcat([1;2],[3;4]); V = vertcat([1 2],[3 4]); C1 = cat(1,[1 2],[3 4]); C2 = cat(2,[1;2],[3;4]);');
  check('horzcat', fmtVar(interp, 'H'), { rows: 2, cols: 2, re: [1, 2, 3, 4], im: null });
  check('vertcat', fmtVar(interp, 'V'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  check('cat dim1', fmtVar(interp, 'C1'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  check('cat dim2', fmtVar(interp, 'C2'), { rows: 2, cols: 2, re: [1, 2, 3, 4], im: null });
}

// ---------------- polyfit / polyval ----------------
{
  const { interp, run } = makeInterp();
  // y = 2x + 3 exactly
  run('x = [0 1 2 3 4]; y = 2*x + 3;');
  run('p = polyfit(x, y, 1);');
  const p = fmtVar(interp, 'p');
  checkClose('polyfit linear fit coefficients', p.re, [2, 3]);
  run('yv = polyval(p, 5);');
  checkClose('polyval', fmtVar(interp, 'yv'), 13);
}

// ---------------- interp1 ----------------
{
  const { interp, run } = makeInterp();
  run('x = [0 1 2 3]; y = [0 10 20 30];');
  run('v = interp1(x, y, 1.5);');
  checkClose('interp1 midpoint', fmtVar(interp, 'v'), 15);
  run('v2 = interp1(x, y, [0.5 2.5]);');
  checkClose('interp1 vector query', fmtVar(interp, 'v2').re, [5, 25]);
}

// ---------------- hist ----------------
{
  const { interp, run } = makeInterp();
  run('[n,c] = hist([1 1 2 2 2 3], 3);');
  const n = fmtVar(interp, 'n');
  check('hist counts sum to total', n.re.reduce((a, b) => a + b, 0), 6);
}

// ---------------- string utilities ----------------
{
  const { interp, run } = makeInterp();
  run("b1 = strcmp('abc','abc'); b2 = strcmp('abc','abd');");
  check('strcmp true', fmtVar(interp, 'b1'), 1);
  check('strcmp false', fmtVar(interp, 'b2'), 0);
  run("u = upper('AbC'); l = lower('AbC');");
  check('upper', fmtVar(interp, 'u'), 'ABC');
  check('lower', fmtVar(interp, 'l'), 'abc');
  run("t = strtrim('  hi  ');");
  check('strtrim', fmtVar(interp, 't'), 'hi');
  run("r = strrep('hello world', 'world', 'there');");
  check('strrep', fmtVar(interp, 'r'), 'hello there');
  run("d = str2double('3.14');");
  check('str2double', fmtVar(interp, 'd'), 3.14);
  run("m = str2num('[1 2 3] * 2');");
  check('str2num evaluates expression', fmtVar(interp, 'm'), { rows: 1, cols: 3, re: [2, 4, 6], im: null });
}

// ---------------- clc calls host.clearConsole ----------------
{
  const { interp, run } = makeInterp();
  let cleared = false;
  interp.host.clearConsole = () => { cleared = true; };
  run('clc');
  check('clc invokes host.clearConsole', cleared, true);
}

// ---------------- help ----------------
{
  const { interp, run, getOutput } = makeInterp();
  run("help('plot')");
  check('help on builtin mentions syntax', getOutput().includes('plot(x, y)'), true);
  run(`
    function y = square(x)
      y = x.^2;
    end
    help('square')
  `);
  check('help on user function shows signature', getOutput().includes('y = square(x)'), true);
  run("help('totallyMadeUpName123')");
  check('help on unknown name says not found', getOutput().includes('not found'), true);
}

// ---------------- command syntax (clear/hold/grid/axis/disp) ----------------
{
  const { interp, run } = makeInterp();
  run('x = 5; y = 10;');
  run('clear x');
  check('clear x (command syntax) removes just x', interp.workspace.has('x'), false);
  check('clear x (command syntax) leaves y', fmtVar(interp, 'y'), 10);

  run('a = 1; b = 2; c = 3;');
  run('clear a b');
  check('clear a b (command syntax) removes a', interp.workspace.has('a'), false);
  check('clear a b (command syntax) removes b', interp.workspace.has('b'), false);
  check('clear a b (command syntax) leaves c', fmtVar(interp, 'c'), 3);
}
{
  const { interp, run, getOutput } = makeInterp();
  run("disp hello");
  check('disp hello (command syntax)', getOutput().trim(), 'hello');
}
{
  const { interp, run } = makeInterp();
  let lastTraces = null, lastLayout = null;
  interp.host.figures.render = () => {};
  // plotting.js reads state via ctx.interp.figures directly for these
  // tests, so just confirm hold/grid/axis command-syntax calls don't
  // throw and produce the same effect as their parenthesized form.
  run("plot(1:3, [1 2 3]); hold on; plot(1:3, [3 2 1]);");
  const fig = interp.figures.get(interp.figureState.current);
  check('hold on (command syntax) enabled hold', fig.hold, true);
  run("grid on;");
  check('grid on (command syntax) set showgrid', fig.layout.xaxis.showgrid, true);
  run("axis equal;");
  check('axis equal (command syntax) set scaleanchor', fig.layout.yaxis.scaleanchor, 'x');
}
{
  // Regression: normal (non-command) usage of these exact identifiers is
  // completely unaffected — assignment, parenthesized calls, and bare
  // no-arg calls all still work as before.
  const { interp, run } = makeInterp();
  run("clear('onlyThis');"); // parenthesized form still works (no throw)
  run("x = 1; clear;"); // bare clear (no args) still clears everything
  check('bare clear (no command syntax) still clears all', interp.workspace.has('x'), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
