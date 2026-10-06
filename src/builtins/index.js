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
import { registerRandom } from './random.js';
import { registerMissing } from './missing.js';
import { registerSpecfun } from './specfun.js';
import { registerSets } from './sets.js';
import { registerStats } from './stats.js';

// Minimum argument counts: a call with fewer raises MATLAB's "Not enough
// input arguments." before the builtin runs. (Calls with no arguments at
// all are caught generically; see runBuiltin in interpreter.js.)
const MIN_ARGS = {
  circshift: 2, colon: 2, conv: 2, cross: 2, dot: 2, gcd: 2, isa: 2, kron: 2, lcm: 2,
  linspace: 2, logspace: 2, nchoosek: 2, polyfit: 3, polyval: 2, power: 2, realpow: 2,
  strrep: 3, sub2ind: 2, ind2sub: 2, squeeze: 1, writematrix: 2,
};

// Registers a module's builtins as numeric-only: a cell, struct or function
// handle argument (every argument, or just the first) raises MATLAB's
// "Undefined function 'f' for input arguments of type 'cell'." up front,
// rather than reaching code that would misread it.
const numericOnly = (reg, which) => ({ set: (name, spec) => reg.set(name, { ...spec, numericArgs: which }) });

export function buildBuiltinsRegistry() {
  const reg = new Map();
  registerElementwise(numericOnly(reg, 'all'));
  registerReduction(numericOnly(reg, 'first'));
  registerLinalg(reg); // also registers the \, /, ^ backend hooks
  registerFFT(numericOnly(reg, 'all'));
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
  registerRandom(reg);
  registerMissing(reg);
  registerSpecfun(numericOnly(reg, 'all'));
  registerSets(reg);
  registerStats(numericOnly(reg, 'first'));
  for (const [name, n] of Object.entries(MIN_ARGS)) reg.get(name).minArgs = n;
  return reg;
}
