// Robustness sweep: every registered builtin is called with a battery of
// awkward arguments (empties, NaN, complex, char, logical, cell, struct,
// function handles, wrong argument counts). Whatever the call does, it
// must either return valid values or raise a MATLAB error; it must never
// leak a JavaScript exception (reported as an `internal` error), change
// its arguments, or return an array sharing a typed-array buffer with an
// argument, or take more than a second. New builtins are covered
// automatically.
import { makeInterp } from './harness.js';
import { Mat, Cell, StructArray } from '../src/core/values.js';

// Builtins that wait, prompt, or tear down the session; they are covered
// by their own tests.
const SKIP = new Set(['pause', 'input', 'keyboard', 'exit', 'quit']);
// Every argument here is tiny, so any call this slow has a performance bug
// (an O(n^2) algorithm, a runaway loop).
const SLOW_MS = 1000;

const SINGLE = [
  '[]', 'zeros(1, 0)', 'zeros(0, 3)', 'NaN', 'Inf', '-2', '0', '3', '2.5', '[1 NaN 3]', '1:5', '(1:5)\'',
  '[4 -2; 1 3]', 'magic(4)', '[1+2i 3-1i]', '1i', "'ab'", "''", "['ab'; 'cd']", 'true', '[true false]',
  "{1, 'a'}", "{'ab', 'c'}", '{}', "struct('a', 1)", 'struct([])', '@sin', '@(x) x + 1',
];
const FIRSTS = ['[4 -2; 1 3]', '1:5', '[]', "'ab'", "{'ab', 'c'}", '[1+2i 3-1i]', 'NaN'];
const SECONDS = ['[]', '1', '2', '3', '0', '-1', '0.5', 'NaN', '[1 2]', "'all'", "'ab'", '{1}', 'true', '@sin', "struct('a', 1)"];
const TRIPLES = [
  ['1:5', '1:5', '1:5'], ['[4 -2; 1 3]', '1', '2'], ["'abc'", "'b'", "'x'"], ['1:5', '2', "'omitnan'"],
  ['[]', '[]', '[]'], ['1', '2', '3'], ['magic(3)', '[]', '2'], ["{'ab', 'c'}", "'a'", "'z'"],
];

const argSets = [[]];
for (const a of SINGLE) argSets.push([a]);
for (const a of FIRSTS) for (const b of SECONDS) argSets.push([a, b]);
for (const t of TRIPLES) argSets.push(t);

function snapshot(v) {
  if (v instanceof Mat) return JSON.stringify([v.rows, v.cols, Array.from(v.re), v.im ? Array.from(v.im) : null, v.isChar, v.isLogical]);
  if (v instanceof Cell) return JSON.stringify([v.rows, v.cols, v.data.map(snapshot)]);
  if (v instanceof StructArray) return JSON.stringify([v.rows, v.cols, v.fieldNames, v.data.map(m => [...m.values()].map(snapshot))]);
  return String(v && v.constructor && v.constructor.name);
}

// [buffer, owning array] pairs. Two values may be the same (refcounted)
// array, but two different arrays must never share a buffer.
function buffers(v, out = []) {
  if (v instanceof Mat) { out.push([v.re, v]); if (v.im) out.push([v.im, v]); }
  else if (v instanceof Cell) v.data.forEach(x => buffers(x, out));
  else if (v instanceof StructArray) v.data.forEach(m => m.forEach(x => buffers(x, out)));
  return out;
}

// Problems with the shape of a returned value (null when it is valid).
function invalid(v) {
  if (v instanceof Mat) {
    if (!Number.isInteger(v.rows) || !Number.isInteger(v.cols) || v.rows < 0 || v.cols < 0) return `bad size ${v.rows}x${v.cols}`;
    if (v.re.length !== v.rows * v.cols) return `re has ${v.re.length} elements for ${v.rows}x${v.cols}`;
    if (v.im && v.im.length !== v.re.length) return 'im/re length mismatch';
    return null;
  }
  if (v instanceof Cell) {
    if (v.data.length !== v.rows * v.cols) return `cell has ${v.data.length} elements for ${v.rows}x${v.cols}`;
    for (const x of v.data) { const p = invalid(x); if (p) return `cell element: ${p}`; }
    return null;
  }
  if (v instanceof StructArray) {
    if (v.data.length !== v.rows * v.cols) return `struct has ${v.data.length} elements for ${v.rows}x${v.cols}`;
    return null;
  }
  if (v === undefined || v === null) return 'undefined value';
  return null;
}

const problems = [];
let calls = 0;
const names = [...makeInterp().interp.builtins.keys()].filter(n => !SKIP.has(n)).sort();
for (const name of names) {
  const h = makeInterp();
  for (const args of argSets) {
    const vars = args.map((_, i) => `a${i + 1}__`);
    h.run(args.map((a, i) => `${vars[i]} = ${a};`).join(' '));
    const inputs = vars.map(v => h.interp.workspace.get(v));
    const before = inputs.map(snapshot);
    const call = `${name}(${vars.join(', ')})`;
    calls++;
    let outs = [];
    const t0 = performance.now();
    try {
      outs = h.interp.callNamed(name, inputs, 1, h.interp.workspace) || [];
    } catch (e) {
      if (e && e.internal) problems.push(`${call} with (${args.join(', ')}): ${e.cause && e.cause.stack ? e.cause.stack.split('\n').slice(0, 2).join(' @ ') : e.message}`);
      else if (!(e && e.name === 'MatlabError') && !(e && (e.name === 'ParseError' || e.name === 'LexError'))) problems.push(`${call} with (${args.join(', ')}): non-MATLAB exception ${e && e.name}: ${e && e.message}`);
    }
    const ms = performance.now() - t0;
    if (ms > SLOW_MS) problems.push(`${call} with (${args.join(', ')}): took ${ms.toFixed(0)} ms (limit ${SLOW_MS} ms)`);
    inputs.forEach((v, i) => {
      if (snapshot(v) !== before[i]) problems.push(`${call} with (${args.join(', ')}): changed argument ${i + 1}`);
    });
    const inBufs = new Map(inputs.flatMap(v => buffers(v)));
    for (const o of outs) {
      const p = invalid(o);
      if (p) problems.push(`${call} with (${args.join(', ')}): invalid result (${p})`);
      if (inputs.includes(o)) continue;
      if (buffers(o).some(([b, owner]) => inBufs.has(b) && inBufs.get(b) !== owner)) problems.push(`${call} with (${args.join(', ')}): result shares a buffer with an argument`);
    }
  }
}

for (const p of problems) console.log('FAIL:', p);
console.log(`\n${names.length} builtins, ${calls} calls: ${problems.length === 0 ? 'all passed' : `${problems.length} problems`}`);
process.exit(problems.length ? 1 : 0);
