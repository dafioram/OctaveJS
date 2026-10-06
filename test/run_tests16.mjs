// Real-MATLAB lock-in: every reference file recorded in real MATLAB
// (tools/matlab/reference/<release>.txt, from matweb_reference.m) is
// compared with MatWeb case by case, about 20,000 calls plus the display
// scripts. Every difference must be listed, with its reason, in
// <release>-known.json; the test fails on
//   - a new difference (MatWeb drifted from MATLAB: fix it, or if it is a
//     deliberate choice, record it with its reason), and
//   - a listed difference that now matches (remove it, so the list stays
//     exact and the match is locked in).
// After an intended change, regenerate the list and review its diff:
//   node tools/matlab/compare-reference.mjs tools/matlab/reference/R2015a.txt \
//     --update-known=tools/matlab/reference/R2015a-known.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareReference } from '../tools/matlab/compare-reference.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'matlab', 'reference');
let pass = 0, fail = 0;
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort()) {
  const release = file.replace(/\.txt$/, '');
  const knownFile = path.join(dir, `${release}-known.json`);
  const known = fs.existsSync(knownFile) ? JSON.parse(fs.readFileSync(knownFile, 'utf8')) : {};
  const { stats, diffs } = await compareReference(fs.readFileSync(path.join(dir, file), 'utf8'));
  const found = new Set(diffs.map(d => d.key));
  const unexpected = diffs.filter(d => !(d.key in known));
  const fixed = Object.keys(known).filter(k => !found.has(k));
  const matching = Object.values(stats).reduce((n, s) => n + s.same, 0);
  if (unexpected.length) {
    fail++;
    console.log(`FAIL: ${release}: ${unexpected.length} new difference(s) from MATLAB`);
    for (const d of unexpected.slice(0, 25)) console.log(`  ${d.code}  ->  ${d.diff}`);
  } else pass++;
  if (fixed.length) {
    fail++;
    console.log(`FAIL: ${release}: ${fixed.length} listed difference(s) now match MATLAB; remove them from ${path.basename(knownFile)} (--update-known)`);
    for (const k of fixed.slice(0, 25)) console.log(`  ${k}`);
  } else pass++;
  console.log(`${release}: ${matching} cases match MATLAB, ${diffs.length} known differences`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
