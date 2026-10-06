// compare-reference.mjs — compares MatWeb with a reference file written by
// matweb_reference.m in real MATLAB, case by case: class, size and value
// of every result, whether (and with which message) a call errors, and the
// command-window display of the display scripts.
//
//   node tools/matlab/compare-reference.mjs matweb_reference.txt [options]
//     --kind=contract,probe,sweep,error,display   only these kinds
//     --limit=N                                   differences listed per kind (default 40)
//     --json=FILE                                 also write every difference as JSON
//     --known=FILE                                only list differences not in FILE
//     --update-known=FILE                         write the current differences to FILE,
//                                                 keeping the reasons already recorded there
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
    // An empty array has no imaginary parts to compare.
    const mim = m.im && m.im.length ? m.im : null, oim = o.im && o.im.length ? o.im : null;
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

// ---- comparing ----
// Compares MatWeb with a parsed reference: { header, missing, stats, diffs },
// each difference { key, kind, code, diff } with a stable key.
export async function compareReference(text, kinds = ['contract', 'probe', 'lang', 'sweep', 'error', 'langerr', 'display']) {
  const { referenceCases } = await import('./make-reference.mjs');
  const { cases: generated } = await referenceCases();
  // Matched by code (and, for the same code checking several outputs, by
  // occurrence), so a reference file from an older script still works for
  // every case whose code is unchanged.
  const occurrence = () => { const seen = new Map(); return (k) => { const n = (seen.get(k) || 0) + 1; seen.set(k, n); return `${k} #${n}`; }; };
  const genKey = occurrence();
  const nameOf = new Map(generated.map(([kind, , code, name]) => [genKey(`${kind} ${code}`), name]));
  const refKey = occurrence();
  const ref = parseReference(text);

  // Functions this MATLAB doesn't have (a toolbox function in a release or
  // edition without the toolbox): every call to them fails with "Undefined
  // function" naming them, plain numeric arguments included. Their cases
  // are counted as missing, not as differences.
  const calledName = (code) => (/^r__ = ([A-Za-z]\w*)\(/.exec(code) || [])[1];
  const calls = new Map();
  for (const c of ref.cases) {
    const name = calledName(c.code || '');
    if (!name) continue;
    const e = calls.get(name) || { total: 0, undefined: 0, plain: 0 };
    e.total++;
    if (c.error === 'MATLAB:UndefinedFunction' && c.message.includes(`'${name}'`)) {
      e.undefined++;
      if (/function or variable|of type '(double|logical|char)'/.test(c.message)) e.plain++;
    }
    calls.set(name, e);
  }
  const missing = new Set([...calls].filter(([, e]) => e.undefined === e.total && e.plain > 0).map(([n]) => n));

  const diffs = [];
  const stats = {};
  for (const c of ref.cases) {
    if (!kinds.includes(c.kind)) continue;
    const st = (stats[c.kind] ||= { same: 0, different: 0, stale: 0, missing: 0 });
    if (missing.has(calledName(c.code || ''))) { st.missing++; continue; }
    const key = refKey(`${c.kind} ${c.code}`);
    if (!nameOf.has(key)) { st.stale++; continue; } // the case is no longer generated
    const ours = runOurs(c.code, nameOf.get(key));
    let diff = null;
    if ((c.kind === 'error' || c.kind === 'langerr') && c.noerror) {
      if (!ours.noerror) diff = `errors (${ours.message}), MATLAB runs without error`;
    } else if (c.kind === 'error' || c.kind === 'langerr') {
      if (ours.noerror) diff = `no error, MATLAB: ${c.message}`;
      else if (ours.message !== c.message) diff = `message "${ours.message}", MATLAB "${c.message}"`;
    } else if (c.error !== undefined) {
      if (ours.value) diff = `returns a ${ours.value.cls} ${ours.value.size.join('x')}, MATLAB errors: ${c.message}`;
    } else if (!ours.value) {
      diff = `errors (${ours.message}), MATLAB returns a ${c.value ? `${c.value.cls} ${(c.value.size || []).join('x')}` : 'value'}`;
    } else if (c.value) {
      diff = valueDiff(c.value, ours.value);
    }
    if (diff) { st.different++; diffs.push({ key: `${c.kind}|${c.code}`, kind: c.kind, code: c.code, diff }); } else st.same++;
  }
  if (kinds.includes('display')) {
    const st = (stats.display = { same: 0, different: 0, stale: 0, missing: 0 });
    const byFile = new Map();
    for (const d of ref.displays) { if (!byFile.has(d.file)) byFile.set(d.file, []); byFile.get(d.file).push(d); }
    for (const [f, entries] of byFile) {
      let src;
      try { src = fs.readFileSync(new URL(`../../test/display/${f}`, import.meta.url), 'utf8'); } catch { st.stale += entries.length; continue; }
      const ours = transcript(src).split(/^(?=>> )/m);
      for (const e of entries) {
        const mine = (ours[e.line - 1] || '').split('\n').slice(1).filter(l => l.trim() !== '');
        const theirs = e.lines.slice(1).filter(l => l.trim() !== '').map(l => l.replace(/<a href=[^>]*>([^<]*)<\/a>/g, '$1'));
        if (mine.join('\n') === theirs.join('\n')) st.same++;
        else { st.different++; diffs.push({ key: `display|${f}|${e.lines[0]}`, kind: 'display', code: e.lines[0], diff: `\n      ours:   ${JSON.stringify(mine.join('\n'))}\n      MATLAB: ${JSON.stringify(theirs.join('\n'))}` }); }
      }
    }
  }
  return { header: ref.header, missing, stats, diffs };
}

// The reason recorded for a new known difference, from its kind and
// what it is about. Reviewed by hand; refine the reason in the JSON file.
export function defaultReason(d) {
  const code = d.code;
  if (d.kind === 'error') return 'version: R2015a error message wording (MatWeb uses the current one)';
  if (d.kind === 'langerr') return 'error message: differs from R2015a (review)';
  if (d.kind === 'display') {
    if (/wide = /.test(code)) return 'not implemented: Columns n through m wrapping';
    if (/ans \* 2/.test(code)) return 'reference artifact: ans in the recording script';
    return 'version: display style changed after R2015a (MatWeb shows the current one)';
  }
  if (/'all'/.test(code)) return "version: 'all' option is newer than R2015a";
  if (/circshift\(/.test(code)) return 'version: circshift works along the first non-singleton dimension since R2016b';
  if (/int8\(/.test(code)) return 'unsupported: integer classes';
  if (d.diff.startsWith('returns')) return 'lenient: MATLAB errors on this input';
  if (d.diff.startsWith('errors')) return 'unsupported: MATLAB accepts this input';
  if (/null\(|orth\(|\[V, D\] = eig\(\[2|svd\(\[1 2; 3 4; 5 6\]\)/.test(code)) return 'convention: basis/sign differs from LAPACK (any orthonormal basis is valid)';
  return 'value: differs from R2015a (review)';
}

// ---- command line ----
if (process.argv[1] && process.argv[1].endsWith('compare-reference.mjs')) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/matlab/compare-reference.mjs reference.txt [--kind=...] [--limit=N] [--json=FILE] [--known=FILE] [--update-known=FILE]'); process.exit(2); }
  const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : dflt; };
  const kinds = opt('kind', 'contract,probe,lang,sweep,error,langerr,display').split(',');
  const limit = Number(opt('limit', 40));
  const { header, missing, stats, diffs } = await compareReference(fs.readFileSync(file, 'utf8'), kinds);
  console.log(`Reference: MATLAB ${header.VERSION || '?'} on ${header.COMPUTER || '?'} (${header.DATE || '?'})`);
  if (header.products) console.log(`Installed: ${header.products.join('; ')}`);
  if (missing.size) console.log(`Not in this MATLAB (skipped): ${[...missing].sort().join(', ')}`);
  const knownFile = opt('known', null);
  const known = knownFile ? JSON.parse(fs.readFileSync(knownFile, 'utf8')) : {};
  const shown = diffs.filter(d => !(d.key in known));
  for (const kind of Object.keys(stats)) {
    const st = stats[kind];
    console.log(`\n== ${kind}: ${st.same} same, ${st.different} different${st.missing ? `, ${st.missing} skipped (function not in this MATLAB)` : ''}${st.stale ? `, ${st.stale} stale (regenerate the .m file)` : ''}`);
    shown.filter(d => d.kind === kind).slice(0, limit).forEach(d => console.log(`  ${d.code}  ->  ${d.diff}`));
  }
  const json = opt('json', null);
  if (json) { fs.writeFileSync(json, JSON.stringify(diffs, null, 1)); console.log(`\nwrote ${diffs.length} differences to ${json}`); }
  const update = opt('update-known', null);
  if (update) {
    const old = fs.existsSync(update) ? JSON.parse(fs.readFileSync(update, 'utf8')) : {};
    const out = {};
    for (const d of diffs.slice().sort((a, b) => (a.key < b.key ? -1 : 1))) out[d.key] = old[d.key] || defaultReason(d);
    fs.writeFileSync(update, JSON.stringify(out, null, 1) + '\n');
    console.log(`\nwrote ${diffs.length} known differences to ${update}`);
  }
}
