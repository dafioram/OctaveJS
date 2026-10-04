// io.js — File I/O builtins. All operate against `interp.files`, a
// virtual file store the host UI keeps in sync with its saved file list
// (the Files panel). Files written by `save`/`writematrix` are reported
// to the host via `host.io.fileWritten` so they appear there too. This
// keeps the interpreter itself free of any DOM/File-API dependency, so the
// same code runs under Node for testing.
//
// readmatrix's CSV parser is intentionally basic: comma-delimited,
// newline rows, no quoted-field/embedded-comma support. The UI's
// File > Import CSV action uses Papa Parse for messier files and assigns
// straight into the workspace instead of going through this builtin —
// see README.

import { Mat, FunctionHandle, MatlabError } from '../core/values.js';
import { encodeMat5, decodeMat5 } from '../mat5/mat5.js';

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows = lines.map(line => line.split(',').map(cell => parseFloat(cell.trim())));
  return rows;
}
function writeCSV(mat) {
  const lines = [];
  for (let r = 0; r < mat.rows; r++) {
    const cells = [];
    for (let c = 0; c < mat.cols; c++) cells.push(String(mat.get2(r, c)));
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

function requireFile(ctx, name, kinds) {
  const entry = ctx.interp.files.get(name);
  if (!entry) {
    throw new MatlabError(`File '${name}' was not found. Use File > Open/Import in the app to load it first, or check the filename.`);
  }
  return entry;
}

export function registerIO(reg) {
  reg.set('readmatrix', {
    fn: (args, _n, ctx) => {
      const name = args[0].toJSString();
      const entry = requireFile(ctx, name);
      const text = entry.text !== undefined ? entry.text : '';
      const rows = parseCSV(text);
      return [Mat.fromRows(rows)];
    },
  });
  reg.set('writematrix', {
    fn: (args, _n, ctx) => {
      const mat = args[0];
      const name = args[1].toJSString();
      const text = writeCSV(mat);
      const entry = { kind: 'csv', text };
      ctx.interp.files.set(name, entry);
      if (ctx.host.io && ctx.host.io.fileWritten) ctx.host.io.fileWritten(name, entry);
      return [];
    },
  });

  reg.set('save', {
    fn: (args, _n, ctx) => {
      if (args.length === 0) throw new MatlabError("save requires a filename, e.g. save('workspace.mat')");
      let name = args[0].toJSString();
      if (!/\.mat$/i.test(name)) name += '.mat';
      const varNames = args.slice(1).map(a => a.toJSString());
      const scope = ctx.scope;
      const names = varNames.length ? varNames : [...scope.names()];
      const vars = {};
      const skipped = [];
      for (const n of names) {
        if (!scope.has(n)) continue;
        const v = scope.get(n);
        if (v instanceof Mat) vars[n] = v;
        else skipped.push(n);
      }
      const bytes = encodeMat5(vars);
      const entry = { kind: 'mat', bytes };
      ctx.interp.files.set(name, entry);
      if (ctx.host.io && ctx.host.io.fileWritten) ctx.host.io.fileWritten(name, entry);
      if (skipped.length) ctx.interp.print(`Note: only numeric, char and logical arrays can be saved to .mat; skipped: ${skipped.join(', ')}\n`);
      return [];
    },
  });
  reg.set('load', {
    fn: (args, _n, ctx) => {
      let name = args[0].toJSString();
      if (!ctx.interp.files.has(name) && !/\.mat$/i.test(name) && ctx.interp.files.has(name + '.mat')) name += '.mat';
      const entry = requireFile(ctx, name);
      if (!entry.bytes) throw new MatlabError(`'${name}' does not look like a .mat file loaded as binary data`);
      const vars = decodeMat5(entry.bytes);
      for (const [k, v] of Object.entries(vars)) ctx.scope.set(k, v);
      ctx.interp.print(`Loaded ${Object.keys(vars).length} variable(s) from ${name}: ${Object.keys(vars).join(', ')}\n`);
      return [];
    },
  });

  reg.set('run', {
    fn: (args, _n, ctx) => {
      const name = args[0].toJSString();
      const file = name.endsWith('.m') ? name : name + '.m';
      requireFile(ctx, file);
      // A function file runs its main function with no inputs (like the
      // editor's Run button in MATLAB); a script runs in the caller's workspace.
      const info = ctx.interp.loadMFile(file.slice(0, -2));
      if (info.kind === 'function') ctx.interp.callUserFunction(info.primary, [], 0);
      else ctx.interp.runProgram(info.ast, ctx.scope);
      return [];
    },
  });
}
