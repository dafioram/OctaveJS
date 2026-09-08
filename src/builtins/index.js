// index.js — Assembles every builtins/*.js registry into one Map and
// wires up the linear-algebra backend hooks (`\`, `/`, `^`) that
// interpreter.js needs but can't import directly (avoids a circular
// import between interpreter.js and linalg.js).

import { registerElementwise } from './elementwise.js';
import { registerReduction } from './reduction.js';
import { registerLinalg } from './linalg.js';
import { registerFFT } from './fft.js';
import { registerSystem } from './system.js';
import { registerPlotting } from './plotting.js';
import { registerIO } from './io.js';
import { registerArrayOps } from './arrayops.js';
import { registerNumeric } from './numeric.js';

export function buildBuiltinsRegistry() {
  const reg = new Map();
  registerElementwise(reg);
  registerReduction(reg);
  registerLinalg(reg); // also registers the \, /, ^ backend hooks
  registerFFT(reg);
  registerSystem(reg);
  registerPlotting(reg);
  registerIO(reg);
  registerArrayOps(reg);
  registerNumeric(reg);
  return reg;
}
