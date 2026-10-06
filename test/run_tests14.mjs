// Command-window display snapshots. Each test/display/*.m script runs one
// statement per line (comment lines skipped) in a single session, and the
// transcript (">> statement" followed by what it printed) must match the
// saved test/display/*.out exactly, so any change to how values display
// shows up as a diff.
//
// After an intended display change, regenerate the snapshots with
//   node test/run_tests14.mjs --update
// and review the diff of the .out files before committing.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transcript } from './harness.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'display');
const update = process.argv.includes('--update');

let pass = 0, fail = 0;
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.m')).sort()) {
  const actual = transcript(fs.readFileSync(path.join(dir, file), 'utf8'));
  const outFile = path.join(dir, file.replace(/\.m$/, '.out'));
  if (update) { fs.writeFileSync(outFile, actual); console.log(`updated ${path.basename(outFile)}`); continue; }
  const expected = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
  if (expected === actual) { pass++; continue; }
  fail++;
  console.log(`FAIL: ${file} display differs from ${path.basename(outFile)}${expected === null ? ' (missing; run with --update)' : ''}`);
  if (expected !== null) {
    const a = actual.split('\n'), e = expected.split('\n');
    for (let i = 0; i < Math.max(a.length, e.length); i++) {
      if (a[i] !== e[i]) { console.log(`  line ${i + 1}\n    expected: ${JSON.stringify(e[i])}\n    actual:   ${JSON.stringify(a[i])}`); break; }
    }
  }
}
if (!update) console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
