import { Interpreter } from '../src/core/interpreter.js';
import { buildBuiltinsRegistry } from '../src/builtins/index.js';

export function makeInterp() {
  let output = '';
  const host = {
    print: (t) => { output += t; },
    figures: { render() {}, show() {} },
    io: {},
  };
  const interp = new Interpreter(host);
  interp.registerBuiltins(buildBuiltinsRegistry());
  return {
    interp,
    run(src) { interp.runSource(src); },
    getOutput() { return output; },
    clearOutput() { output = ''; },
  };
}

export function fmtVar(interp, name) {
  const v = interp.workspace.get(name);
  if (!v) return undefined;
  if (v.isChar) return v.toJSString();
  if (v.numel === 1) return v.isComplex ? { re: v.re[0], im: v.im[0] } : v.re[0];
  return { rows: v.rows, cols: v.cols, re: Array.from(v.re), im: v.im ? Array.from(v.im) : null };
}
