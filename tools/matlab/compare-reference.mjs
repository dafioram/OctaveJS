// compare-reference.mjs — compares MatWeb with a reference file written by
// matweb_reference.m in real MATLAB, case by case: class, size and value
// of every result, whether (and with which message) a call errors, and the
// command-window display of the display scripts.
//
//   node tools/matlab/compare-reference.mjs matweb_reference.txt [options]
//     --kind=contract,probe,sweep,error,display   only these kinds
//     --limit=N                                   differences listed per kind (default 40)
//     --json=FILE                                 also write every difference as JSON
import fs from 'fs';
import { makeInterp, transcript } from '../../test/harness.js';
import { Mat, Cell, StructArray, FunctionHandle, valueClassName } from '../../src/core/values.js';

// ---- reading the reference file ----
// A number as MATLAB's %.17g prints it (Inf, -Inf and NaN included).
const numberToken = (t) => (t === 'Inf' ? Infinity : t === '-Inf' ? -Infinity : Number(t));
export function parseReference(text) {
  const header = {}, cases = [], displays = [];
  let cur = null, disp = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (disp) {
      if (line === '@@ enddisplay') { displays.push(disp); disp = null; } else disp.lines.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      const [k, ...v] = line.slice(1).split(' ');
      if (k === 'PRODUCT') (header.products ||= []).push(v.join(' ')); else header[k] = v.join(' ');
      continue;
    }
    if (line.startsWith('@@ display ')) {
      const [, , file, k] = line.split(' ');
      disp = { file, line: Number(k), lines: [] };
      cur = null;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const [, kind, id] = line.split(' ');
      cur = { kind, id, value: null, stack: [] };
      cases.push(cur);
      continue;
    }
    if (!cur) continue;
    const depth = (line.length - line.trimStart().length) / 2;
    const t = line.trim();
    const colon = t.indexOf(':');
    const key = colon >= 0 ? t.slice(0, colon) : t;
    const val = colon >= 0 ? t.slice(colon + 1).trim() : '';
    if (key === 'code' && depth === 0) { cur.code = val; continue; }
    if (key === 'error' && depth === 0) { cur.error = val; continue; }
    if (key === 'message' && depth === 0) { cur.message = val.replace(/\\n/g, '\n'); continue; }
    if (key === 'warning' && depth === 0) { cur.warning = val; continue; }
    if (t === 'noerror') { cur.noerror = true; continue; }
    // value fields; "cell k" starts an element whose fields are indented
    // one level deeper. stack[d] receives the fields at depth d.
    if (depth === 0) cur.stack[0] = (cur.value ||= {});
    if (key.startsWith('cell ')) {
      const child = {};
      (cur.stack[depth].cells ||= []).push(child);
      cur.stack[depth + 1] = child;
      cur.stack.length = depth + 2;
      continue;
    }
    const target = cur.stack[depth];
    if (key === 'class') target.cls = val;
    else if (key === 'size') target.size = val.split(' ').map(Number);
    else if (key === 're' || key === 'im') target[key] = val === '' ? [] : val.split(' ').map(numberToken);
    else if (key === 'truncated') target.truncated = Number(val);
    else if (key === 'fields') target.fields = val ? val.split(' ') : [];
    else if (key === 'func') target.func = val;
  }
  return { header, cases, displays };
}

// ---- MatWeb's results in the same form ----
function describe(v, depth = 0) {
  const d = { cls: valueClassName(v), size: v instanceof FunctionHandle ? [1, 1] : [v.rows, v.cols] };
  if (v instanceof Mat) {
    const n = Math.min(v.numel, 60);
    d.re = Array.from(v.re.subarray(0, n));
    if (v.isComplex) d.im = Array.from(v.im.subarray(0, n));
    if (v.numel > n) d.truncated = v.numel;
  } else if (v instanceof Cell && depth < 2) {
    d.cells = v.data.slice(0, 20).map(x => describe(x, depth + 1));
  } else if (v instanceof StructArray) {
    d.fields = [...v.fieldNames];
  } else if (v instanceof FunctionHandle) {
    d.func = v.displayName().replace(/^@/, v.name ? '' : '@');
  }
  return d;
}

function runOurs(code, name) {
  const h = makeInterp();
  try {
    h.run(code);
    return name ? { value: describe(h.interp.workspace.get(name)) } : { noerror: true };
  } catch (e) {
    return { error: e.identifier || '', message: e.message };
  }
}

const sameNum = (a, b) => (Number.isNaN(a) ? Number.isNaN(b) : a === b || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)));
// The first difference between two described values, or null.
function valueDiff(m, o, where = '') {
  if (m.cls !== o.cls) return `${where}class ${o.cls}, MATLAB ${m.cls}`;
  if ((m.size || []).join('x') !== (o.size || []).join('x')) return `${where}size ${(o.size || []).join('x')}, MATLAB ${(m.size || []).join('x')}`;
  if (m.re) {
    const ore = o.re || [];
    if (m.re.length !== ore.length || m.re.some((x, k) => !sameNum(x, ore[k]))) return `${where}values [${ore.slice(0, 8).join(' ')}${ore.length > 8 ? ' ...' : ''}], MATLAB [${m.re.slice(0, 8).join(' ')}${m.re.length > 8 ? ' ...' : ''}]`;
    const mim = m.im || null, oim = o.im || null;
    if (!!mim !== !!oim) return `${where}${mim ? 'MATLAB result is complex' : 'our result is complex'}`;
    if (mim && mim.some((x, k) => !sameNum(x, oim[k]))) return `${where}imaginary parts [${oim.slice(0, 8).join(' ')}], MATLAB [${mim.slice(0, 8).join(' ')}]`;
  }
  if (m.fields && (o.fields || []).join(',') !== m.fields.join(',')) return `${where}fields ${(o.fields || []).join(',')}, MATLAB ${m.fields.join(',')}`;
  if (m.cells) {
    for (let k = 0; k < m.cells.length; k++) {
      if (!o.cells || !o.cells[k]) return `${where}cell element ${k + 1} missing`;
      const d = valueDiff(m.cells[k], o.cells[k], `${where}{${k + 1}} `);
      if (d) return d;
    }
  }
  return null;
}

// ---- main ----
if (process.argv[1] && process.argv[1].endsWith('compare-reference.mjs')) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/matlab/compare-reference.mjs matweb_reference.txt [--kind=...] [--limit=N] [--json=FILE]'); process.exit(2); }
  const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : dflt; };
  const kinds = opt('kind', 'contract,probe,sweep,error,display').split(',');
  const limit = Number(opt('limit', 40));
  const { referenceCases } = await import('./make-reference.mjs');
  const { cases: generated } = await referenceCases();
  const nameOf = new Map(generated.map(([kind, id, code, name]) => [`${kind} ${id}`, { code, name }]));

  const ref = parseReference(fs.readFileSync(file, 'utf8'));
  console.log(`Reference: MATLAB ${ref.header.VERSION || '?'} on ${ref.header.COMPUTER || '?'} (${ref.header.DATE || '?'})`);
  if (ref.header.products) console.log(`Installed: ${ref.header.products.join('; ')}`);
  // Functions this MATLAB doesn't have (a toolbox function in a release or
  // edition without the toolbox): every call to them fails with "Undefined
  // function" naming them. Their cases are listed once, not as differences.
  const calledName = (code) => (/^r__ = ([A-Za-z]\w*)\(/.exec(code) || [])[1];
  const calls = new Map();
  for (const c of ref.cases) {
    const name = calledName(c.code || '');
    if (!name) continue;
    const e = calls.get(name) || { total: 0, undefined: 0, plain: 0 };
    e.total++;
    if (c.error === 'MATLAB:UndefinedFunction' && c.message.includes(`'${name}'`)) {
      e.undefined++;
      // "for input arguments of type 'cell'" also happens when the
      // function exists; a missing one fails for plain numbers too.
      if (/function or variable|of type '(double|logical|char)'/.test(c.message)) e.plain++;
    }
    calls.set(name, e);
  }
  const missing = new Set([...calls].filter(([, e]) => e.total > 0 && e.undefined === e.total && e.plain > 0).map(([n]) => n));
  if (missing.size) console.log(`Not in this MATLAB (skipped): ${[...missing].sort().join(', ')}`);
  const diffs = [];
  const stats = {};
  for (const c of ref.cases) {
    if (!kinds.includes(c.kind)) continue;
    const st = (stats[c.kind] ||= { same: 0, different: 0, stale: 0, missing: 0 });
    if (missing.has(calledName(c.code || ''))) { st.missing++; continue; }
    const gen = nameOf.get(`${c.kind} ${c.id}`);
    if (!gen || gen.code !== c.code) { st.stale++; continue; } // regenerate the .m file and rerun MATLAB
    const ours = runOurs(c.code, gen.name);
    let diff = null;
    if (c.kind === 'error') {
      if (ours.noerror) diff = `no error, MATLAB: ${c.message}`;
      else if (ours.message !== c.message) diff = `message "${ours.message}", MATLAB "${c.message}"`;
    } else if (c.error !== undefined) {
      if (ours.value) diff = `returns a ${ours.value.cls} ${ours.value.size.join('x')}, MATLAB errors: ${c.message}`;
    } else if (!ours.value) {
      diff = `errors (${ours.message}), MATLAB returns a ${c.value ? `${c.value.cls} ${(c.value.size || []).join('x')}` : 'value'}`;
    } else if (c.value) {
      diff = valueDiff(c.value, ours.value);
    }
    if (diff) { st.different++; diffs.push({ kind: c.kind, id: c.id, code: c.code, diff }); } else st.same++;
  }
  if (kinds.includes('display')) {
    const st = (stats.display = { same: 0, different: 0, stale: 0 });
    const byFile = new Map();
    for (const d of ref.displays) { if (!byFile.has(d.file)) byFile.set(d.file, []); byFile.get(d.file).push(d); }
    for (const [f, entries] of byFile) {
      let src;
      try { src = fs.readFileSync(new URL(`../../test/display/${f}`, import.meta.url), 'utf8'); } catch { st.stale += entries.length; continue; }
      const ours = transcript(src).split(/^(?=>> )/m);
      for (const e of entries) {
        const mine = (ours[e.line - 1] || '').split('\n').slice(1).filter(l => l.trim() !== '');
        const theirs = e.lines.slice(1).filter(l => l.trim() !== '');
        if (mine.join('\n') === theirs.join('\n')) st.same++;
        else { st.different++; diffs.push({ kind: 'display', id: `${f}:${e.line}`, code: e.lines[0], diff: `\n      ours:   ${JSON.stringify(mine.join('\n'))}\n      MATLAB: ${JSON.stringify(theirs.join('\n'))}` }); }
      }
    }
  }
  for (const kind of Object.keys(stats)) {
    const st = stats[kind];
    console.log(`\n== ${kind}: ${st.same} same, ${st.different} different${st.missing ? `, ${st.missing} skipped (function not in this MATLAB)` : ''}${st.stale ? `, ${st.stale} stale (regenerate the .m file)` : ''}`);
    diffs.filter(d => d.kind === kind).slice(0, limit).forEach(d => console.log(`  ${d.code}  ->  ${d.diff}`));
  }
  const json = opt('json', null);
  if (json) { fs.writeFileSync(json, JSON.stringify(diffs, null, 1)); console.log(`\nwrote ${diffs.length} differences to ${json}`); }
}
