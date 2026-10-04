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
- New MATLAB-compatibility fixes get a regression test in
  `test/run_tests4.mjs` (or a new test file wired into `npm test`).
