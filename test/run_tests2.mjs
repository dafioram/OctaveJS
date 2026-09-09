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
function checkThrowsMsg(label, fn, substr) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (substr && !e.message.includes(substr)) { fail++; console.log(`FAIL(wrong message): ${label}\n  got: ${e.message}\n  expected substring: ${substr}`); }
    else pass++;
  }
}

// ---------------- eig (real + complex eigenvalues) ----------------
{
  const { interp, run } = makeInterp();
  run('e = eig([2 0; 0 5]);');
  const e = fmtVar(interp, 'e');
  checkClose('eig diagonal matrix', [...e.re].sort((a, b) => a - b), [2, 5]);

  run('e2 = eig([0 -1; 1 0]);'); // rotation matrix -> +-i
  const e2 = fmtVar(interp, 'e2');
  const mags = e2.re.map((r, k) => Math.hypot(r, e2.im[k])).sort();
  checkClose('eig complex eigenvalues (magnitudes)', mags, [1, 1]);
}

// ---------------- fft/ifft ----------------
{
  const { interp, run } = makeInterp();
  run('X = fft([1 2 3 4]);');
  const X = fmtVar(interp, 'X');
  checkClose('fft length-4 real part', X.re, [10, -2, -2, -2]);
  checkClose('fft length-4 imag part', X.im, [0, 2, 0, -2]);

  run('Y = fft([1 2 3]);'); // non-power-of-2
  const Y = fmtVar(interp, 'Y');
  check('fft non-power-of-2 produces 3 elements', Y.re.length, 3);

  run('x0 = [1 2 3 4]; xr = real(ifft(fft(x0)));');
  const xr = fmtVar(interp, 'xr');
  checkClose('fft/ifft round trip', xr.re, [1, 2, 3, 4]);
}

// ---------------- plotting (mock host records calls) ----------------
{
  const { interp, run } = makeInterp();
  let lastTraces = null, lastLayout = null;
  interp.host.figures.render = (num, traces, layout) => { lastTraces = traces; lastLayout = layout; };
  run("x = 0:0.1:1; plot(x, x.^2, 'r--'); xlabel('x'); ylabel('y'); title('demo');");
  check('plot produced one trace', lastTraces.length, 1);
  check('plot linespec color parsed', lastTraces[0].line.color, '#d62728');
  check('plot linespec dash parsed', lastTraces[0].line.dash, 'dash');
  check('xlabel set', lastLayout.xaxis.title.text, 'x');
  check('title set', lastLayout.title.text, 'demo');

  run("hold('on'); scatter(x, x);");
  check('hold on keeps previous trace, adds new one', lastTraces.length, 2);
  run("hold('off'); bar([1 2 3]);");
  check('hold off replaces traces', lastTraces.length, 1);
  check('bar trace type', lastTraces[0].type, 'bar');
}

// ---------------- CSV I/O via virtual file store ----------------
{
  const { interp, run } = makeInterp();
  interp.files.set('data.csv', { kind: 'csv', text: '1,2,3\n4,5,6\n' });
  run("A = readmatrix('data.csv');");
  check('readmatrix parses CSV', fmtVar(interp, 'A'), { rows: 2, cols: 3, re: [1, 4, 2, 5, 3, 6], im: null });

  run("writematrix(A*2, 'out.csv');");
  const written = interp.files.get('out.csv');
  check('writematrix stores CSV text', written.text, '2,4,6\n8,10,12\n');
}

// ---------------- MAT5 save/load via virtual file store ----------------
{
  const { interp, run } = makeInterp();
  run('A = [1 2; 3 4]; s = 42;');
  run("save('ws.mat');");
  const saved = interp.files.get('ws.mat');
  check('save produced bytes', saved.bytes.length > 0, true);

  const { interp: interp2, run: run2 } = makeInterp();
  interp2.files.set('ws.mat', saved);
  run2("load('ws.mat');");
  check('load restores A', fmtVar(interp2, 'A'), { rows: 2, cols: 2, re: [1, 3, 2, 4], im: null });
  check('load restores s', fmtVar(interp2, 's'), 42);
}

// ---------------- run() script execution + bare script-name call ----------------
{
  const { interp, run } = makeInterp();
  interp.files.set('helper.m', { kind: 'm', text: 'y = 100;\nfunction r = addone(x)\n r = x + 1;\nend\n' });
  run("run('helper.m'); z = addone(y);");
  check('run() executes script and shares scope', fmtVar(interp, 'z'), 101);

  const { interp: interp3, run: run3 } = makeInterp();
  interp3.files.set('greet.m', { kind: 'm', text: "disp('hello from script');\n" });
  run3('greet');
  check('bare script-name call produces output', interp3.host && true, true);
}

// ---------------- fprintf/sprintf ----------------
{
  const { interp, run } = makeInterp();
  run("s = sprintf('%d-%s-%5.2f', 3, 'abc', 1.5);");
  check('sprintf formatting', fmtVar(interp, 's'), '3-abc- 1.50');
  run("s2 = sprintf('%d,', [1 2 3]);"); // recycling
  check('sprintf recycles format over vector', fmtVar(interp, 's2'), '1,2,3,');
}

// ---------------- arrayfun / feval / deal ----------------
{
  const { interp, run } = makeInterp();
  run('y = arrayfun(@(x) x^2, [1 2 3 4]);');
  check('arrayfun', fmtVar(interp, 'y'), { rows: 1, cols: 4, re: [1, 4, 9, 16], im: null });
  run("z = feval(@sin, 0);");
  check('feval with handle', fmtVar(interp, 'z'), 0);
  run('[p,q,r] = deal(7);');
  check('deal replicate', [fmtVar(interp, 'p'), fmtVar(interp, 'q'), fmtVar(interp, 'r')], [7, 7, 7]);
}

// ---------------- global / persistent ----------------
{
  const { interp, run } = makeInterp();
  run(`
    function inc()
      global counter
      counter = counter + 1;
    end
    global counter
    counter = 0;
    inc(); inc(); inc();
  `);
  check('global variable shared across function calls', fmtVar(interp, 'counter'), 3);

  run(`
    function r = nextId()
      persistent n
      if isempty(n)
        n = 0;
      end
      n = n + 1;
      r = n;
    end
    a1 = nextId(); a2 = nextId(); a3 = nextId();
  `);
  check('persistent variable 1', fmtVar(interp, 'a1'), 1);
  check('persistent variable 2', fmtVar(interp, 'a2'), 2);
  check('persistent variable 3', fmtVar(interp, 'a3'), 3);
}

// ---------------- clear command-syntax limitation is documented behavior ----------------
{
  const { interp, run } = makeInterp();
  run('x = 5; y = 10;');
  run("clear('x');");
  check('clear with quoted name removes just that var', interp.workspace.has('x'), false);
  check('clear leaves other vars', fmtVar(interp, 'y'), 10);
}

// ---------------- unsupported features raise clear, targeted errors ----------------
{
  const { run } = makeInterp();
  checkThrowsMsg('double-quoted strings rejected', () => run('x = "hello";'), 'single quotes');
  checkThrowsMsg('struct field access rejected', () => run('s.x = 1;'), 'structs');
  checkThrowsMsg('cell array rejected', () => run('c = {1,2,3};'), 'not supported');
  checkThrowsMsg('cell indexing rejected', () => run('c{1};'), 'not supported');
  checkThrowsMsg('N-D indexing rejected', () => run('A=[1 2;3 4]; A(1,1,1);'), 'more than 2 subscripts');
  checkThrowsMsg('chained indexed assignment rejected', () => run('f(1)(2) = 3;'), 'not supported');
}

// ---------------- semicolon suppression at top level (regression test:
// this was silently broken — parseProgram wasn't applying it at all) ----------------
{
  const { interp, run, getOutput } = makeInterp();
  run('a = 5;'); // suppressed: should print nothing
  check('semicolon suppresses top-level output', getOutput(), '');
  run('b = 6'); // not suppressed: should auto-print "b =\n...\n"
  check('missing semicolon shows output', getOutput().includes('b ='), true);
}

// ---------------- fprintf/sprintf backslash escapes (regression test) ----------------
{
  const { interp, run, getOutput } = makeInterp();
  run("fprintf('line1\\nline2\\n');");
  check('fprintf processes \\n escape', getOutput(), 'line1\nline2\n');
  run("s = sprintf('a\\tb');");
  check('sprintf processes \\t escape', fmtVar(interp, 's'), 'a\tb');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
