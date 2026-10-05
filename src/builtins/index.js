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
import { registerPlotting3d } from './plotting3d.js';
import { registerIO } from './io.js';
import { registerArrayOps } from './arrayops.js';
import { registerNumeric } from './numeric.js';
import { registerErrors } from './errors.js';
import { registerContainers } from './containers.js';
import { registerLogic } from './logic.js';
import { registerMathExt } from './mathext.js';
import { registerStrings } from './strings.js';
import { registerOde } from './ode.js';
import { registerOptim } from './optim.js';
import { registerInterp } from './interp.js';

export function buildBuiltinsRegistry() {
  const reg = new Map();
  registerElementwise(reg);
  registerReduction(reg);
  registerLinalg(reg); // also registers the \, /, ^ backend hooks
  registerFFT(reg);
  registerSystem(reg);
  registerPlotting(reg);
  registerPlotting3d(reg);
  registerIO(reg);
  registerArrayOps(reg);
  registerNumeric(reg);
  registerErrors(reg);
  registerContainers(reg);
  registerLogic(reg);
  registerMathExt(reg);
  registerStrings(reg);
  registerOde(reg);
  registerOptim(reg);
  registerInterp(reg);
  return reg;
}
