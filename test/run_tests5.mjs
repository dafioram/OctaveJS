// Tests for cell arrays, structs, try/catch and errors, varargin/varargout,
// copy-on-write value semantics, and the worker session protocol.
import { makeInterp, fmtVar } from './harness.js';
import { createSession } from '../src/worker/session.js';
import { Mat, serializeValue } from '../src/core/values.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkThrows(label, fn, pattern) {
  try { fn(); fail++; console.log(`FAIL(expected throw): ${label}`); }
  catch (e) {
    if (pattern && !pattern.test(e.message)) { fail++; console.log(`FAIL(wrong error): ${label}\n  got: ${e.message}`); }
    else pass++;
  }
}
const row = (...re) => ({ rows: 1, cols: re.length, re, im: null });
const cls = (interp, name) => interp.workspace.get(name).className();
const show = (h, src) => { h.clearOutput(); h.run(src); return h.getOutput(); };

// ---------------- cell arrays ----------------
{
  const h = makeInterp();
  const { interp, run } = h;
  run("c = {1, 'abc'; [1 2 3], {4}}; n = numel(c); sz = size(c); k = class(c);");
  check('cell literal numel', fmtVar(interp, 'n'), 4);
  check('cell literal size', fmtVar(interp, 'sz'), row(2, 2));
  check('class cell', fmtVar(interp, 'k'), 'cell');
  run('x = c{1, 2}; y = c{2, 1}(2); inner = c{2, 2}{1};');
  check('brace read', fmtVar(interp, 'x'), 'abc');
  check('brace then paren', fmtVar(interp, 'y'), 2);
  check('nested brace', fmtVar(interp, 'inner'), 4);
  run('sub = c(1, :); ksub = class(sub); szsub = size(sub);');
  check('paren read gives cell', fmtVar(interp, 'ksub'), 'cell');
  check('paren read size', fmtVar(interp, 'szsub'), row(1, 2));
  run('d = {}; d{3} = 5; nd = numel(d); e1 = isempty(d{1});');
  check('brace assignment grows', fmtVar(interp, 'nd'), 3);
  check('grown cells are []', fmtVar(interp, 'e1'), 1);
  run('d(2) = []; nd2 = numel(d); d(end+1) = {7}; last = d{end};');
  check('paren deletion', fmtVar(interp, 'nd2'), 2);
  check('paren assignment of a cell', fmtVar(interp, 'last'), 7);
  checkThrows('paren-assigning a number into a cell errors', () => run('d(1) = 5;'), /Conversion to cell/);
  run('q = {1, 2, 3}; [a, b, c3] = q{:}; m = [q{:}]; w = {q{:}, 4}; nw = numel(w); nested = {q, 4}; nn = numel(nested);');
  check('cs-list multi-assign', [fmtVar(interp, 'a'), fmtVar(interp, 'b'), fmtVar(interp, 'c3')], [1, 2, 3]);
  check('cs-list in [ ]', fmtVar(interp, 'm'), row(1, 2, 3));
  check('cs-list in { }', fmtVar(interp, 'nw'), 4);
  check('cell inside { } nests', fmtVar(interp, 'nn'), 2);
  run('cc = [q, {9}]; ncc = numel(cc); t = q\'; szt = size(t);');
  check('[ ] concatenates cells', fmtVar(interp, 'ncc'), 4);
  check('cell transpose', fmtVar(interp, 'szt'), { rows: 1, cols: 2, re: [3, 1], im: null });
  run("txt = sprintf('%d-%d-%d', q{:});");
  check('cs-list as function arguments', fmtVar(interp, 'txt'), '1-2-3');
  run('acc = 0; for e = {1, 2, 3}, acc = acc + e{1}; end');
  check('for over a cell', fmtVar(interp, 'acc'), 6);
  check('cell display', show(h, "z = {1, 'two', [3 4], {5}}"), "z =\n  1x4 cell array\n\n    {[1]}    {'two'}    {[3 4]}    {1x1 cell}\n");
  check('cs-list display', show(h, 'r = {1, 2}; r{:}'), 'ans =\n     1\nans =\n     2\n');
}

// ---------------- structs ----------------
{
  const h = makeInterp();
  const { interp, run } = h;
  run("s.a = 1; s.b.c = 'deep'; s.v(3) = 7; s.list{2} = 'x';");
  run('a = s.a; bc = s.b.c; v = s.v; l2 = s.list{2}; k = class(s);');
  check('field assign/read', fmtVar(interp, 'a'), 1);
  check('nested field auto-created', fmtVar(interp, 'bc'), 'deep');
  check('indexed field assignment grows', fmtVar(interp, 'v'), row(0, 0, 7));
  check('cell field via braces', fmtVar(interp, 'l2'), 'x');
  check('class struct', fmtVar(interp, 'k'), 'struct');
  run("f = 'a'; dyn = s.(f); s.(['n' 'ew']) = 5; nw = s.new;");
  check('dynamic field read', fmtVar(interp, 'dyn'), 1);
  check('dynamic field write', fmtVar(interp, 'nw'), 5);
  run('p(3).x = 1; np = numel(p); emptyx = isempty(p(1).x); p(2).x = 20; xs = [p.x];');
  check('struct array grows', fmtVar(interp, 'np'), 3);
  check('new elements have empty fields', fmtVar(interp, 'emptyx'), 1);
  check('s.field on struct array is a cs-list', fmtVar(interp, 'xs'), row(20, 1));
  run("t = struct('n', {10, 20, 30}, 'tag', 'same'); nt = numel(t); n2 = t(2).n; tag3 = t(3).tag;");
  check('struct() with cell values makes an array', fmtVar(interp, 'nt'), 3);
  check('struct() per-element value', fmtVar(interp, 'n2'), 20);
  check('struct() shared value', fmtVar(interp, 'tag3'), 'same');
  run("fn = fieldnames(s); nf = numel(fn); f1 = fn{1}; has = isfield(s, {'a', 'zz'}); r = rmfield(s, 'a'); hasA = isfield(r, 'a'); isS = isstruct(s);");
  check('fieldnames', [fmtVar(interp, 'nf'), fmtVar(interp, 'f1')], [5, 'a']);
  check('isfield with cell', fmtVar(interp, 'has'), row(1, 0));
  check('rmfield', fmtVar(interp, 'hasA'), 0);
  check('isstruct', fmtVar(interp, 'isS'), 1);
  checkThrows('missing field read', () => run('s.nope'), /Unrecognized field name "nope"/);
  checkThrows('dot on a non-struct', () => run('z = 5; z.a'), /Dot indexing/);
  run('u = s; u.a = 100; sa = s.a;');
  check('struct copy is independent', fmtVar(interp, 'sa'), 1);
  run('w(1).a = 1; w(2) = w(1); w(2).a = 5; w1 = w(1).a;');
  check('struct element copies are independent', fmtVar(interp, 'w1'), 1);
  check('struct display', show(h, "d.name = 'Ada'; d.age = 36; d.tags = {1, 2}; d"),
    "d =\n  struct with fields:\n\n    name: 'Ada'\n     age: 36\n    tags: {1x2 cell}\n");
  check('struct array display', show(h, 'p'), 'p =\n  1x3 struct array with fields:\n\n    x\n');
}

// ---------------- try/catch and errors ----------------
{
  const h = makeInterp();
  const { interp, run } = h;
  run("try, error('pkg:bad', 'value %d is bad', 3); catch ME, id = ME.identifier; msg = ME.message; k = class(ME); end");
  check('caught identifier', fmtVar(interp, 'id'), 'pkg:bad');
  check('caught formatted message', fmtVar(interp, 'msg'), 'value 3 is bad');
  check('caught value is an MException', fmtVar(interp, 'k'), 'MException');
  run("try, error('only: a message'); catch E2, m2 = E2.message; id2 = E2.identifier; end");
  check('single-arg error is a literal message', fmtVar(interp, 'm2'), 'only: a message');
  check('single-arg error has no identifier', fmtVar(interp, 'id2'), '');
  run('try, v = [1 2 3]; v(7); catch E3, id3 = E3.identifier; end');
  check('built-in errors carry identifiers', fmtVar(interp, 'id3'), 'MATLAB:badsubscript');
  run("try, undefined_thing_here; catch E4, id4 = E4.identifier; end");
  check('undefined function identifier', fmtVar(interp, 'id4'), 'MATLAB:UndefinedFunction');
  run("reached = 0; try, error('x'); reached = 1; catch, end");
  check('catch without identifier; rest of try skipped', fmtVar(interp, 'reached'), 0);
  run("error(''); ok = 1;");
  check("error('') is a no-op", fmtVar(interp, 'ok'), 1);
  checkThrows('rethrow keeps the message', () => run("try, error('a:b', 'inner'); catch Q, rethrow(Q); end"), /^inner$/);
  checkThrows('throw(MException)', () => run("throw(MException('my:id', 'made %s', 'here'))"), /made here/);
  checkThrows('error(struct)', () => run("err.message = 'from struct'; err.identifier = 'x:y'; error(err)"), /from struct/);
  checkThrows('assert default message', () => run('assert(false)'), /Assertion failed/);
  checkThrows('assert formatted message', () => run("assert(1 == 2, 'want %d', 5)"), /want 5/);
  run('assert(true); assert([1 1 1]);');
  check('warning prints', show(h, "warning('careful %d', 1)"), 'Warning: careful 1\n');
  check('warning off by id', show(h, "warning('off', 'my:w'); warning('my:w', 'hidden'); warning('on', 'my:w'); warning('my:w', 'shown')"), 'Warning: shown\n');
  run("function boom()\n error('fn:boom', 'from a function');\nend\ntry, boom(); catch F, fid = F.identifier; end");
  check('errors propagate out of functions', fmtVar(interp, 'fid'), 'fn:boom');
  run('n = 0; for k = 1:5, try, if k == 3, break; end, n = n + 1; catch, end, end');
  check('break inside try still breaks the loop', fmtVar(interp, 'n'), 2);
  run("r = getReport(MException('a:b', 'rep'));");
  check('getReport', fmtVar(interp, 'r'), 'rep');
}

// ---------------- varargin / varargout ----------------
{
  const { interp, run } = makeInterp();
  run('function varargout = twice(varargin)\n for k = 1:nargin, varargout{k} = 2 * varargin{k}; end\nend\n[a, b] = twice(1, 5);');
  check('varargin/varargout', [fmtVar(interp, 'a'), fmtVar(interp, 'b')], [2, 10]);
  run('function n = count(first, varargin)\n n = numel(varargin);\nend\nc0 = count(1); c2 = count(1, 2, 3);');
  check('varargin collects extras', [fmtVar(interp, 'c0'), fmtVar(interp, 'c2')], [0, 2]);
  checkThrows('missing varargout element', () => run('function varargout = none()\n varargout = {};\nend\nx = none();'), /varargout/);
}

// ---------------- cellfun / arrayfun / strings ----------------
{
  const { interp, run } = makeInterp();
  run("n = cellfun(@numel, {'a', 'bb', ''}); e = cellfun('isempty', {[], 1}); l = cellfun(@ischar, {'a', 1});");
  check('cellfun uniform', fmtVar(interp, 'n'), row(1, 2, 0));
  check('cellfun by name', fmtVar(interp, 'e'), row(1, 0));
  check('cellfun logical results stay logical', interp.workspace.get('l').isLogical, true);
  run("u = cellfun(@(x) [x x], {1, 2}, 'UniformOutput', false); u2 = u{2};");
  check('cellfun UniformOutput false', fmtVar(interp, 'u2'), row(2, 2));
  run('[mx, ix] = cellfun(@max, {[1 3 2], [5 4]});');
  check('cellfun multiple outputs', [fmtVar(interp, 'mx'), fmtVar(interp, 'ix')], [row(3, 5), row(2, 1)]);
  run("sq = arrayfun(@(x) x^2, [1 2 3]); ac = arrayfun(@(x) 1:x, 1:3, 'UniformOutput', false); ac3 = ac{3};");
  check('arrayfun uniform', fmtVar(interp, 'sq'), row(1, 4, 9));
  check('arrayfun UniformOutput false', fmtVar(interp, 'ac3'), row(1, 2, 3));
  checkThrows('non-scalar uniform output', () => run('arrayfun(@(x) [x x], 1:2)'), /UniformOutput/);
  run("parts = strsplit('a,b,,c', ','); np = numel(parts); p3 = parts{3}; j = strjoin(parts, '-'); ws = strsplit('  x  y'); nws = numel(ws);");
  check('strsplit collapses delimiters', [fmtVar(interp, 'np'), fmtVar(interp, 'p3')], [3, 'c']);
  check('strjoin', fmtVar(interp, 'j'), 'a-b-c');
  check('strsplit default whitespace', fmtVar(interp, 'nws'), 3);
  run("cmp = strcmp({'a', 'b', 'a'}, 'a'); srt = sort({'pear', 'apple', 'fig'}); s1 = srt{1}; uq = unique({'b', 'a', 'b'}); nuq = numel(uq);");
  check('strcmp with a cell', fmtVar(interp, 'cmp'), row(1, 0, 1));
  check('sort cellstr', fmtVar(interp, 's1'), 'apple');
  check('unique cellstr', fmtVar(interp, 'nuq'), 2);
  run("n2c = num2cell([1 2]); c2m = cell2mat({[1 2], 3; [4 5], 6}); cs = cellstr(['ab '; 'cd ']); cs1 = cs{1};");
  check('num2cell', [cls(interp, 'n2c'), interp.workspace.get('n2c').numel], ['cell', 2]);
  check('cell2mat', fmtVar(interp, 'c2m'), { rows: 2, cols: 3, re: [1, 4, 2, 5, 3, 6], im: null });
  check('cellstr trims trailing blanks', fmtVar(interp, 'cs1'), 'ab');
  run("txt = ['abc' 10 'd']; ntxt = numel(txt); pair = [1 (2)];");
  check("[char number char] is one char row", [fmtVar(interp, 'ntxt'), cls(interp, 'txt')], [5, 'char']);
  check('[a (b)] is two elements', fmtVar(interp, 'pair'), row(1, 2));
}

// ---------------- copy-on-write value semantics ----------------
{
  const { interp, run } = makeInterp();
  run('a = [1 2 3]; b = a; b(2) = 99;');
  check('assigning into a copy leaves the original', fmtVar(interp, 'a'), row(1, 2, 3));
  run('function v = modify(v)\n v(1) = -1;\nend\nx = [5 6]; y = modify(x);');
  check('function parameter changes stay local', fmtVar(interp, 'x'), row(5, 6));
  check('function returns the changed copy', fmtVar(interp, 'y'), row(-1, 6));
  run('k = [1 2]; g = @() k; k(1) = 9; gk = g();');
  check('closures keep their snapshot', fmtVar(interp, 'gk'), row(1, 2));
  run('c = {[1 2]}; d = c; d{1}(1) = 50; c1 = c{1};');
  check('cell copies are independent', fmtVar(interp, 'c1'), row(1, 2));
  run('m = [1 2 3]; c = {m}; m(1) = 0; cm = c{1};');
  check('storing into a cell copies on later write', fmtVar(interp, 'cm'), row(1, 2, 3));
  run('r = 1:6; r2 = reshape(r, 2, 3); r2(1) = 100; r1 = r(1);');
  check('reshape result is independent', fmtVar(interp, 'r1'), 1);
  run("ss.a = 1; ss.b = ss; selfNested = isfield(ss.b, 'b'); cc = {1}; cc{2} = cc; ninner = numel(cc{2}); ss.x.y = 1; ss.x.z = ss.x; zf = numel(fieldnames(ss.x.z));");
  check('s.b = s stores a copy, not a cycle', fmtVar(interp, 'selfNested'), 0);
  check('c{2} = c stores a copy', fmtVar(interp, 'ninner'), 1);
  check('s.x.z = s.x stores a copy', fmtVar(interp, 'zf'), 1);
  run('z = 1:5; z(end:-1:1) = z;');
  check('self-referencing assignment', fmtVar(interp, 'z'), row(5, 4, 3, 2, 1));
  const t0 = Date.now();
  run('big = zeros(1, 100000); for i = 1:100000, big(i) = i; end, total = sum(big);');
  check('in-place loop assignment result', fmtVar(interp, 'total'), 5000050000);
  check('in-place loop assignment is fast (< 3s for 1e5)', Date.now() - t0 < 3000, true);
}

// ---------------- copy-on-write differential test ----------------
// Random programs of assignments, calls and closures over matrices, cells
// and structs must end in the same state whether values are updated in
// place (copy-on-write) or copied on every assignment (the reference).
{
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = (arr) => arr[rnd(arr.length)];
  const V = ['a', 'b', 'c', 'd'];
  const stmt = () => {
    const x = pick(V), y = pick(V), k = 1 + rnd(4), n = rnd(100), f = pick(['f', 'g']);
    return pick([
      `${x} = ${y};`, `${x}(${k}) = ${n};`, `${x}{${k}} = ${y};`, `${x}.${f} = ${y};`,
      `${x}.${f}(${k}) = ${n};`, `${x}{${k}}(${1 + rnd(2)}) = ${n};`, `${x}.${f}{${k}} = ${n};`,
      `${x} = modp(${y});`, `h = @() ${y}; ${x} = h();`, `${x}(${k}) = [];`, `${x} = {${y}, ${n}};`,
      `${x}(end+1) = ${y};`, `${x}.${f} = ${x};`, `${x}{${k}} = ${x};`, `${x}(${k}).${f} = ${n};`,
      `for q = 1:2, ${x}(q) = ${y}; end`,
    ]);
  };
  const prelude = 'function v = modp(v)\n try, v(1) = -7; catch, end\n try, v{1} = -7; catch, end\nend\n';
  const snapshot = (interp) => JSON.stringify([...V, 'h'].filter(v => interp.workspace.has(v))
    .map(v => [v, serializeValue(interp.workspace.get(v))]), (k, x) => (x instanceof Float64Array ? Array.from(x) : x));
  let mismatches = 0;
  for (let r = 0; r < 150; r++) {
    const lines = ["a = [1 2 3]; b = {1, 'x'}; c.f = [4 5]; c.g = {6}; d = 9;"];
    for (let i = 0; i < 18; i++) lines.push(`try, ${stmt()} catch, end`);
    const src = prelude + lines.join('\n');
    const cow = makeInterp(), ref = makeInterp();
    const orig = ref.interp._assignPath.bind(ref.interp);
    ref.interp._assignPath = (cur, owned, ...rest) => orig(cur, false, ...rest);
    cow.run(src); ref.run(src);
    if (snapshot(cow.interp) !== snapshot(ref.interp)) mismatches++;
  }
  check('copy-on-write matches always-copy on 150 random programs', mismatches, 0);
}

// ---------------- worker session protocol ----------------
{
  const msgs = [];
  const session = createSession((m) => msgs.push(m));
  const last = (type) => [...msgs].reverse().find(m => m.type === type);
  session.handle({ type: 'init', files: [['helper.m', { kind: 'm', text: 'function h = helper()\n h = @inner;\nend\nfunction y = inner(x)\n y = 3 * x;\nend\n' }]] });
  check('init replies ready', last('ready').workspace, []);
  session.handle({ type: 'run', id: 1, src: "a = 1; s.x = {2}; f = helper(); global G; G = 7;" });
  const done1 = last('done');
  check('done has no error', done1.error, null);
  check('done lists the workspace', done1.workspace.map(v => `${v.name}:${v.cls}`), ['G:double', 'a:double', 'f:function_handle', 's:struct']);
  // Fold the deltas into a mirror the way the page does.
  const mirror = { vars: new Map(), globalNames: [], globals: [], persistents: [], funcTable: [], figureState: null };
  const apply = (d) => {
    for (const [k, v] of d.vars) mirror.vars.set(k, v);
    for (const k of d.deleted) mirror.vars.delete(k);
    mirror.globalNames = d.globalNames;
    if (d.globals) mirror.globals = d.globals;
    if (d.persistents) mirror.persistents = d.persistents;
    if (d.funcTable) mirror.funcTable = d.funcTable;
    mirror.figureState = d.figureState;
  };
  apply(done1.delta);
  session.handle({ type: 'run', id: 2, src: 'q = undefined_function_xyz(1);' });
  check('errors are reported on done', /undefined_function_xyz/.test(last('done').error), true);
  apply(last('done').delta);
  session.handle({ type: 'run', id: 3, src: "writematrix([1 2], 'out.csv'); disp('hi')" });
  check('file writes are reported', last('fileWritten').name, 'out.csv');
  check('prints are streamed', last('print').text, 'hi\n');
  apply(last('done').delta);

  // "Stop": start a fresh session from the mirror and check the state survived.
  const msgs2 = [];
  const s2 = createSession((m) => msgs2.push(m));
  s2.handle({ type: 'init', files: [['helper.m', { kind: 'm', text: 'function h = helper()\n h = @inner;\nend\nfunction y = inner(x)\n y = 3 * x;\nend\n' }]],
    snapshot: { vars: [...mirror.vars.entries()], globalNames: mirror.globalNames, globals: mirror.globals, persistents: mirror.persistents, funcTable: mirror.funcTable, figureState: mirror.figureState } });
  s2.handle({ type: 'run', id: 1, src: 'r = f(2) + a + s.x{1} + G;' });
  const d2 = [...msgs2].reverse().find(m => m.type === 'done');
  check('restored session runs without error', d2.error, null);
  s2.handle({ type: 'getVar', id: 9, name: 'r' });
  const v = [...msgs2].reverse().find(m => m.type === 'var');
  check('state (incl. handle to a subfunction, global) restored', v.value.re, [6 + 1 + 2 + 7]);
  s2.handle({ type: 'setVar', name: 'imported', value: serializeValue(Mat.fromRows([[1, 2]])) });
  check('setVar updates the workspace', [...msgs2].reverse().find(m => m.type === 'workspace').workspace.some(w => w.name === 'imported'), true);
  s2.handle({ type: 'getVar', id: 10, name: 's' });
  check('getVar renders containers as text', [...msgs2].reverse().find(m => m.type === 'var').value.kind, 'text');
  s2.handle({ type: 'run', id: 2, src: 'plot(1:3)' });
  const figs = [...msgs2].reverse().find(m => m.type === 'done').figures;
  check('figures touched by a command are sent', figs.map(f => f.num), [1]);
  check('figure payload carries the plotted line', figs[0].fig.axes[0].objects.length, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
