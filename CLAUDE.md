# MatWeb — notes for Claude

- **MATLAB syntax only.** Implement MATLAB's language, not Octave's
  extensions: no `++`/`--`, `+=`/`-=`, `!`/`!=`, `#` comments,
  `do ... until`, `endif`/`endfor`/`endfunction`, `printf`/`puts`, or
  Octave-only builtins. When MATLAB and Octave differ, follow MATLAB.
- Run `npm test` before committing; `npm run build` must also succeed
  (CI runs both before deploying to GitHub Pages).
- `src/core/` and `src/builtins/` must stay free of DOM/browser APIs so
  the interpreter runs under Node for the test suite; browser-only code
  belongs in `src/ui/`.
- `src/worker/` (the interpreter session behind the Web Worker) and
  `src/plot/` (figure model -> Plotly conversion) must also stay DOM-free;
  `test/run_tests5.mjs` drives the worker protocol and
  `test/run_tests7.mjs` covers 2-D plotting (model and Plotly output) and
  `test/run_tests8.mjs` 3-D plots, images, colormaps, saving figures and
  drawnow/pause. `test/run_tests9.mjs` covers the numerical solvers
  (ODEs, fzero/fmin*, integral, interpolation, matrix functions),
  `test/run_tests10.mjs` random numbers (rng, statistics, Stop restore)
  and `test/run_tests11.mjs` the math and data library (trig/special
  functions, sets, statistics, fft2/conv2, number theory).
- New MATLAB-compatibility fixes get a regression test in
  `test/run_tests4.mjs`; tests for language features go in
  `test/run_tests5.mjs` and for library functions in `test/run_tests6.mjs`
  (or a new test file wired into `npm test`). Every builtin needs a
  `help-data.js` entry.
- Values use copy-on-write via reference counts (`_refs`, see
  `src/core/values.js`). Anything that stores a value somewhere new must
  `retain` it (Scope.set, Cell/StructArray constructors and setters do
  this); never let two arrays share a typed-array buffer.
