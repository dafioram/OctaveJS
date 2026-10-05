# MatWeb — a lightweight, offline-capable, MATLAB-compatible console

MatWeb is a real MATLAB-syntax interpreter — a lexer, recursive-descent
parser, and tree-walking evaluator, all hand-written — running entirely in
your browser, wrapped in a small IDE: a Command Window (REPL), a
multi-file script editor with syntax highlighting, a workspace browser, a
file panel whose contents are saved in your browser, and Plotly-based
plotting. Code runs in a background Web Worker, so a long computation
never freezes the page and can be stopped. Nothing is sent to a server;
once the page is loaded, it works offline.

It is **not** a MATLAB clone. It implements a real subset of the language
and a real subset of MATLAB's function library, chosen to cover the common
cases well rather than to cover everything shallowly. This README is the
honest account of exactly where that subset ends — what's implemented,
what isn't, and what to do instead — because that's more useful to you
than a marketing description.

## Running it

- **Just want to use it:** serve the `dist/` folder with any static file
  server (e.g. `npx serve dist`) and open the printed `localhost` URL.
  Opening `dist/index.html` straight from disk (`file://`) doesn't work in
  most browsers, which refuse to load ES modules and Web Workers that way.
  Everything needed is already bundled into `dist/main.js` (the page) and
  `dist/worker.js` (the interpreter); there is no build step required to
  use it. If a browser can't start the worker, the app runs code on the
  page itself instead — everything works except the Stop button.
- **Deploying to GitHub Pages (recommended — no manual builds):** this repo
  includes `.github/workflows/deploy.yml`, which builds and deploys `dist/`
  automatically on every push to `main`. One-time setup: in the repo's
  **Settings → Pages**, set **Build and deployment → Source** to
  **"GitHub Actions"** (not "Deploy from a branch"). After that, just push
  to `main` — no need to ever commit `dist/` itself, so the existing
  `.gitignore` entry for it is left as-is. If the workflow fails, check the
  **Actions** tab; it runs `npm test` before building, so a broken test
  will block a broken deploy rather than silently ship one.
- **Deploying anywhere else** (Cloudflare Pages, S3, Netlify, or GitHub
  Pages the manual way): run `npm run build` locally, then upload the
  contents of `dist/` as-is — it's a plain static site, no server-side
  logic. For GitHub Pages specifically without Actions, that means
  committing the built `dist/` contents to a branch (commonly `gh-pages`)
  or to a `docs/` folder on `main`, and pointing **Settings → Pages →
  Source** at "Deploy from a branch" and that location — but then you have
  to remember to rebuild and re-push every time the source changes, which
  is exactly what the Actions workflow above avoids.
- **Rebuilding from source:** `npm install`, then `npm run build` (uses
  esbuild to bundle `src/ui/main.js` and everything it imports —
  math.js, Plotly, Papa Parse, CodeMirror 6 — into `dist/main.js`, with
  `dist/index.html` and `dist/styles.css` copied alongside it).
- **Running the interpreter's own test suite:** `npm test` (about 420
  assertions covering the language core, builtins, cells/structs,
  try/catch, copy-on-write semantics, the worker protocol, plotting, file
  I/O, the MAT5 codec, and MATLAB-compatibility regressions; see `test/`).

## What's implemented

**Language:** variables; real and complex scalars/matrices; string (char
array) literals; `if`/`elseif`/`else`, `for`, `while`, `switch`/`case`
(including `case {a,b,c}` multi-value matching), `break`/`continue`/
`return`; `try`/`catch` (with `catch ME` giving an MException);
functions with multiple return values (`[a,b] = f(...)`), `nargin`/
`nargout`, `varargin`/`varargout`, recursion; anonymous functions (`@(x) ...`,
correctly capturing free variables *by value* at creation time, matching
real MATLAB); function handles to named functions (`@sin`); `global` and
`persistent`; the full operator set including matrix vs. elementwise
operators (`*` vs `.*`, `^` vs `.^`, etc.) with implicit expansion
(`A - mean(A)` subtracts a row from every row; sizes must match or be 1
in each dimension), ranges (`a:b`, `a:step:b`),
transpose (`'`, `.'`); both logical and numeric indexing (with the correct
different semantics for each); linear and 2-D indexing including `end`;
auto-growing arrays on assignment; element/row/column deletion via
`x(i) = []`. **Cell arrays**: `{a, b; c, d}` literals, `c(i)` (a sub-cell)
vs. `c{i}` (the contents), comma-separated lists (`c{:}` expands into
function arguments, `[c{:}]`, `{c{:}}` and `[a, b] = c{:}`), growth and
deletion. **Structs**: `s.a = 1`, nested `s.a.b.c = 2` (created on the
fly), struct arrays (`s(3).x = 1`, `[s.x]`), dynamic fields `s.(name)`, and
any mix of chained assignment such as `s.data{2}(3) = 5`. Arrays have
value semantics with copy-on-write: `b = a; b(1) = 0` never changes `a`,
and assigning into a variable nobody else shares (the usual `v(k) = ...`
loop) updates it in place instead of copying it every time.

**Math:** the trig/exp/log/rounding family (auto-promoting to complex
where real MATLAB does, e.g. `sqrt(-1)`, `asin(2)`); `sum`, `prod`, `mean`,
`median`, `std`, `var`, `min`/`max` (with index output), `range`, `mode`,
`cumsum`, `cumprod` — all with a dimension argument and, where MATLAB has
them, the `'all'` and `'omitnan'`/`'includenan'` options; `sort` (with index output, `'ascend'`/`'descend'`), `unique`,
`find` (linear or `[row,col]`/`[row,col,val]` forms, with optional count
and `'first'`/`'last'`), `any`, `all`, `isnan`, `isinf`, `isfinite`;
`fliplr`, `flipud`, `flip`, `repmat`, `cat`/`horzcat`/`vertcat`; `size`,
`length`, `numel`, `reshape`, `diag`, `triu`, `tril`, `det`, `trace`,
`rank`, `norm`, `dot`, `cross`, `inv`, `pinv`, `eig`, `svd`, `lu`, `qr`,
`kron`, `nnz`; `fft`/`ifft` (vectors or matrix columns, with length and
dimension arguments); `polyfit`, `polyval`, `roots`, `conv`, `deconv`,
`filter`, `interp1` (linear interpolation); `magic`, `meshgrid`, `ndgrid`,
`diff`, `trapz`, `cumtrapz`, `circshift`, `sub2ind`/`ind2sub`;
`factorial`, `nchoosek` (count or combinations), `primes`, `isprime`,
`gcd`, `lcm`.

**Comparison & operators as functions:** `isequal`, `isequaln`,
`ismember` (numbers or cell arrays of strings, with the location output),
`xor`, `not`, `and`, `or`, and `plus`, `minus`, `times`, `rdivide`,
`ldivide`, `mtimes`, `mrdivide`, `mldivide`, `mpower`, `eq`, `ne`, `lt`,
`gt`, `le`, `ge`, `uminus`, `uplus` (so `cellfun(@plus, a, b)` works);
`bsxfun`.

**Strings:** `strcmp`, `strcmpi` (both also compare element-wise against
a cell array of strings), `upper`, `lower`, `strtrim`, `strrep`,
`strsplit`, `strjoin`, `strcat`, `strfind`, `contains`, `startsWith`,
`endsWith`, `regexp`/`regexpi` (all seven outputs — `'match'`,
`'tokens'`, `'names'`, `'split'`, … — and `'once'`), `regexprep`,
`num2str` (including a format argument), `int2str`, `str2double`,
`str2num` (evaluates the string as a MATLAB expression through this same
interpreter — no different in kind from any other code you run here);
`sort` and `unique` accept cell arrays of strings. Regular expressions
run on JavaScript's engine, which agrees with MATLAB on the common syntax
(classes, quantifiers, groups, lookaround, `(?<name>...)`); MATLAB's `\<`
and `\>` word anchors are translated.

**Timing & display:** `tic`/`toc` (including `t = tic; toc(t)`), `format
long`/`format short`.

**Cells & structs:** `cell`, `iscell`, `iscellstr`, `cellfun` and
`arrayfun` (including `'UniformOutput', false` and multiple outputs),
`num2cell`, `cell2mat`, `cellstr`, `struct` (cell-valued arguments make
struct arrays), `fieldnames`, `isfield`, `rmfield`, `isstruct`,
`getfield`, `setfield`, `struct2cell`, `numfields`.

**Errors:** `error` (message, format + args, or identifier + format),
`warning` (including `warning('off', id)`), `assert`, `MException`,
`throw`/`rethrow`, `getReport`. Built-in errors carry identifiers such as
`MATLAB:UndefinedFunction` and `MATLAB:badsubscript`.

**Plotting:** `plot` (a matrix gives one line per column; line specs
like `'r--o'`; Name,Value options `Color`, `LineWidth`, `LineStyle`,
`Marker`, `MarkerSize`, `MarkerFaceColor`, `MarkerEdgeColor`,
`DisplayName`), `semilogx`/`semilogy`/`loglog`, `stairs`, `stem`,
`errorbar`, `scatter` (sizes, per-point colors, `'filled'`), `bar`/`barh`
(grouped or `'stacked'`), `histogram` (bin count/edges/width,
`Normalization`), `hist` (the classic function — plots with no output
arguments, returns `[counts, centers]` otherwise), `area`, `fill`, `pie`,
`polarplot`, `text`. Figures and axes: `figure` (with `'Name'`), `subplot`
(including spanning `subplot(2,2,[1 2])`), `sgtitle`, `hold`, `ishold`,
`gcf`, `gca`, `clf`, `close`/`close all`; `title` (with subtitle),
`xlabel`, `ylabel`, `legend` (labels, `DisplayName`, `'Location'`,
`show`/`off`), `grid on|off|minor`, `box`, `xlim`/`ylim`, `axis` (limits,
`equal`, `tight`, `ij`, `off`, ...), `xticks`/`yticks`,
`xticklabels`/`yticklabels`. Lines use MATLAB's color order, and
titles/labels/legends/text understand MATLAB's TeX subset (`x^2`,
`x_{i}`, `\alpha`). Plotting functions return handles: `set`/`get` cover
the common line properties (including `XData`/`YData`), axes `XLim`/
`YLim`/`XScale`/`YScale`/`XGrid`/`YGrid`/`Box` and the figure `Name`;
`isgraphics` checks a handle. Each figure's tab in the Figures panel has
a &times; to close it.

**3-D plots, images and color:** `plot3`, `scatter3`, `surf` and `mesh`
(with `X`/`Y` as vectors or `meshgrid` matrices, an optional color matrix
`C`, `FaceColor`/`EdgeColor`/`FaceAlpha`/`LineStyle`), `contour`/
`contourf` (a level count or vector, `LevelList`, `LineColor`,
`ShowText`), `imagesc` (optional color limits) and `image`, plus the
sample data `peaks` and `sphere`. `view(az, el)`/`view(2)`/`view(3)` with
MATLAB's orthographic camera, `zlabel`, `zlim`, `axis` with six limits,
`shading flat|interp|faceted`. Colormaps: `colormap` takes a name or an
N-by-3 matrix, per figure or per axes (`colormap(gca, hot)`); the
functions `parula` (the default), `turbo`, `jet`, `hsv`, `hot`, `cool`,
`spring`, `summer`, `autumn`, `winter`, `gray`, `bone`, `copper`, `pink`,
`white` and `lines` return the maps as matrices. `colorbar` and
`clim`/`caxis` work per axes, and 2-D and 3-D axes mix freely in
subplots. `set`/`get` also cover `ZData`, `CData`, `CLim`, `View`,
`ZLim`, contour `LevelList`, and the figure `Colormap`.

**Saving figures and animation:** `saveas(gcf, 'plot.png')`,
`exportgraphics(gca, 'plot.png', 'Resolution', 300)` and
`print('plot', '-dsvg')` save PNG, JPEG or SVG files into the **Files**
panel (download them from there). `drawnow` shows the figures while a
loop keeps running (up to about 30 updates a second), and `pause(t)`
shows them and then waits; Stop still interrupts the loop. `pause off`
turns pauses into no-ops.

**I/O:** `readmatrix`/`writematrix` (CSV), `save`/`load` (a real MAT5
`.mat` writer/reader — see below), `run('script.m')`, and calling a script
by its bare name. All of these work on the files in the **Files** panel.
A `.m` file that starts
with `function` is a *function file*: `name(args)` calls its first
function, and any further functions in it are local subfunctions visible
only inside that file (a handle like `@helper` created there keeps working
outside it).

## What isn't supported, and what to do instead

These are deliberate scope cuts, not oversights — each is a meaningful
implementation effort with a niche payoff for a lightweight tool. Where
there's a reasonable workaround, it's listed.

| Not supported | Use instead |
|---|---|
| Double-quoted strings (`"hello"`, MATLAB string arrays) | Single-quoted char arrays: `'hello'` |
| **General command syntax** for arbitrary/user-defined functions, e.g. calling your own `function foo(s)` as `foo bar` | Use the normal parenthesized form: `foo('bar')`. A small, fixed whitelist — `clear`, `hold`, `grid`, `axis`, `disp`, `format`, `box`, `legend`, `close`, `warning`, `xlim`, `ylim`, `zlim`, `colormap`, `colorbar`, `shading`, `clim`, `caxis`, `drawnow`, `pause` — *does* support command syntax (`clear x y`, `hold on`, `grid off`, `axis equal`, `disp hello`, `format long`, `close all`, `legend off`, `colormap hot`, `shading interp`), since those are idiomatic and unambiguous enough to special-case safely; see the note below the table. |
| N-D arrays (more than 2 subscripts) | Reshape/index a 2-D matrix, or use multiple 2-D matrices |
| Integer classes (`int8`, `uint16`, ...) — everything is `double` (or tagged `logical`/`char`) | Just use `double`; a trailing class-name argument to `zeros`/`ones` (e.g. `zeros(3,'int8')`) is silently ignored |
| `()` followed by more indexing in an assignment, e.g. `x(2)(3) = 1` (MATLAB rejects this too; `s(2).f = 1` and `c{2}(3) = 1` *are* supported) | Use an intermediate variable |
| Other 3-D plot types (`quiver3`, `patch`, `fill3`, `waterfall`, ...), lighting (`light`, `lighting`, `material`) and `rotate3d` | `surf`/`mesh`/`plot3`/`scatter3`; drag the plot to rotate it in the Figures panel |
| Saving figures as PDF or EPS, or printing to a printer | Save as SVG (vector) or PNG |
| Full handle graphics (every property, `delete`, `findobj`, `uicontrol`, ...) | The `set`/`get` properties listed above; `axis square` is accepted but has no effect |
| Complex-matrix `rank`/`svd` | `rank(real(A))` as an approximation, or avoid complex inputs |
| Saving cell arrays or structs to `.mat` | They're skipped with a note; save their numeric contents as separate variables |
| `classdef` classes, `containers.Map`, tables | Structs and cell arrays |

**On that command-syntax whitelist:** real MATLAB decides whether `foo bar`
means "call foo with the string 'bar'" or something else by checking, at
parse time, whether `foo` is *currently* a variable in the workspace —
which makes MATLAB's grammar depend on runtime state, not just the text
being parsed. This app keeps parsing a pure, one-time, stateless step
(the parser never sees the interpreter's variables), so replicating that
general rule isn't a good fit architecturally. Instead, `clear`, `hold`, `grid`, `axis`, `disp`, `format`, `box`, `legend`, `close`, `warning`, `xlim`, `ylim`, `zlim`, `colormap`, `colorbar`, `shading`, `clim`, `caxis`, `drawnow`, `pause`
are recognized by name directly in the parser: when one of those words is immediately followed by a bareword on the
same line, it's rewritten to the equivalent parenthesized call before
anything else happens — so `hold on` and `hold('on')` produce the exact
same result. This covers the cases people actually reach for command
syntax for, without the general ambiguity.

## math.js limitations (and what we did about them)

This app's numerical core is [math.js](https://mathjs.org), and we
verified its actual API surface directly during development rather than
assuming — two gaps turned out to matter:

- **No `svd` and no `rank`.** Confirmed directly against the installed
  math.js 15.2.0 (`Object.keys(math)` simply doesn't have them). We
  implemented both ourselves: `svd` via the classic one-sided Jacobi
  rotation algorithm, `rank` via Gaussian elimination with a size-scaled
  tolerance. Both were cross-validated against NumPy
  (`numpy.linalg.svd`/`matrix_rank`) on square, tall, wide, and
  rank-deficient test matrices during development, matching to floating-
  point precision, plus a full `A = U·S·V'` reconstruction check. They're
  real, tested implementations — just not as battle-hardened as LAPACK
  (what real MATLAB and NumPy ultimately call) for very large or
  extremely ill-conditioned matrices.
- **`A\b` for non-square `A`** (least-squares) is solved via the normal
  equations (`A'A x = A'b`), because math.js's `lusolve` only handles
  square systems directly. This is a real, working least-squares solve,
  but it's less numerically stable than the QR-based approach real
  MATLAB's `mldivide` uses, particularly for ill-conditioned or
  nearly-rank-deficient `A`. It's fine for typical well-posed
  overdetermined systems.
- `eig`, `lu` (via `lup`), `qr`, `fft`/`ifft` were all confirmed working
  correctly against math.js directly, including complex eigenvalues and
  non-power-of-two FFT lengths — no wrapper limitations there worth
  noting beyond the general ones above (2-D only, etc.)

## The `.mat` file: what "rudimentary" means here

A quick fact that's easy to get wrong: real MATLAB's *default* `.mat`
format (what you get from plain `save('x.mat')`) is **not HDF5** — it's
MATLAB's own "Level 5" binary format, a fairly simple tagged-element
format. HDF5 only enters the picture if you explicitly ask for
`save(...,'-v7.3')`. So "rudimentary MAT5 support" is a more honest
description than "rudimentary HDF5 support" — and it's also the more
useful thing to implement, since it's what `save`/`load` actually produce
and consume by default.

What's implemented is a real MAT5 binary writer and reader, from scratch,
using only `DataView`/`Uint8Array` (no Node `Buffer`, so it's the same
code in the browser and in this project's own tests):

- Real and complex double-precision 2-D numeric arrays, and best-effort
  char arrays (as UTF-16 code units).
- Uncompressed — no zlib.
- **Verified interoperable in both directions** during development: files
  this app writes load correctly with Python's `scipy.io.loadmat`
  (checked byte-for-byte against the MAT5 spec, including getting the
  endianness-indicator bytes right — `'I','M'` at offset 126–127, which
  we initially got backwards and fixed after comparing against a real
  `scipy.io.savemat` output); and this app's reader correctly parses real
  `.mat` files that `scipy.io.savemat` produces, including MATLAB's
  "compact" packed encoding for short elements (e.g. variable names ≤4
  bytes), which real tools use constantly and which we specifically added
  read support for after finding it in real output files.

What's **not** implemented: structs and cell arrays (`save` skips them
with a note), sparse matrices,
integer-class arrays, `-v7.3` (HDF5-based) files, and compression. If you
`load()` a `.mat` file containing any of those, or a `-v7.3` file, it will
fail to parse (HDF5's container format is entirely different from MAT5's
and isn't handled here at all) — this app can only read/write the plain
numeric/char case described above.

## Architecture (for anyone extending this)

```
src/core/       lexer.js, parser.js, values.js, cmath.js, interpreter.js
                — the language itself, no DOM/UI dependency.
src/builtins/   elementwise.js, reduction.js, linalg.js, fft.js,
                system.js, plotting.js (2-D plots, figures, handles,
                saving, drawnow/pause), plotting3d.js (3-D, images,
                color), io.js, containers.js, errors.js,
                logic.js, mathext.js, strings.js, index.js — the
                function library, registered into the interpreter.
src/mat5/       mat5.js — the MAT5 binary codec.
src/plot/       style.js (MATLAB color order, colors, line specs),
                colormaps.js (parula, jet, ...), contours.js (contour
                levels) and toPlotly.js (the figure model -> Plotly
                traces/layout);
                no DOM, so plotting is tested under Node.
src/worker/     session.js — the interpreter side of the page <-> worker
                message protocol (no DOM, tested under Node);
                worker.js — the Web Worker entry point.
src/ui/         main.js, backend.js, vfs.js, matlab-lang.js, styles.css
                — the browser app: DOM wiring, the worker (or in-page
                  fallback) backend, the IndexedDB file store, CodeMirror
                  setup, drawing figures with Plotly. Everything here is what actually
                  needs a browser; everything above it is plain, testable JS.
test/           harness.js + eight test files — run with `npm test`.
build.mjs       esbuild bundling script -> dist/ (main.js and worker.js).
```

The interpreter takes a `host` object so it can run identically in a
worker, on the page, or in Node for testing: `host.print(text)` for
console output, `host.figures.render(...)` for plotting,
`host.io.fileWritten(name, entry)` to report files written by `save`/
`writematrix`. `interp.files` is a small virtual filesystem (`Map`) kept
in sync with the Files panel, which `readmatrix`/`save`/`load`/`run` and
function-file lookup all use — this is also how the test suite exercises
file I/O without a real filesystem or browser.

**The worker and Stop.** The page talks to `src/worker/session.js` by
messages (`run`, `putFile`, `getVar`, … → `print`, `done`, `fileWritten`,
…). After each command the session also sends a *delta* of the variables,
globals, persistents and functions that changed; the page folds these
into a mirror of the session state. JavaScript can't interrupt a busy
worker without cross-origin-isolation headers that static hosts like
GitHub Pages can't set, so **Stop terminates the worker** and starts a new
one from that mirror — your workspace comes back exactly as it was
before the interrupted command (changes the command made before you
stopped it are discarded). The mirror does keep a second copy of the
workspace in the page's memory.

## A few smaller, worth-knowing behaviors

- `help('name')` prints calling syntax and a short description for any
  builtin, or the auto-derived signature for a user-defined function
  (e.g. `help('square')` after defining `function y = square(x)`). This
  app doesn't extract MATLAB's usual "leading comment after the function
  line" doc text, since comments are discarded at the lexer level rather
  than preserved — user functions only get a signature, not a description.
- `clc` clears the Command Window's output (wired to the same action as
  Edit → Clear command window in the menu bar).
- **Files** (the third sidebar tab) holds your scripts and data, saved in
  the browser's IndexedDB so they survive reloads. New scripts, uploads
  (or drag-and-drop anywhere on the page), and files written by `save`/
  `writematrix` all land there; use &#x2913; to download a file, &times;
  to delete it. Clicking a `.m` file opens it in the editor.
- The Script Editor has one tab per open file and saves your edits
  automatically as you type (there's no separate save step; *File →
  Download current script* gives you a copy). Click the filename in the
  editor toolbar to rename the script. Open tabs are restored on reload.
- **Stop** (next to the command line, or Ctrl+C there with no text
  selected) interrupts a running command; see "The worker and Stop"
  above for what happens to the workspace. Commands you enter while one
  is running are queued and run in order.
- Each open figure gets its own tab in the Figures panel; click the
  &times; on a tab to close that figure. Closing the last one resets
  figure numbering, so the next plot starts again at Figure 1.
- 3-D axes (`plot3`, `surf`, ...) are drawn with WebGL; drag to rotate,
  scroll to zoom. As in MATLAB, surfaces are unlit and the camera is
  orthographic. Plotly always blends colors across a surface's faces, so
  `shading flat` looks like `shading interp` (both hide the grid lines).
- Saved figures are 800-by-600 pixels at 96 dpi; `exportgraphics(...,
  'Resolution', 300)` or `print(..., '-r300')` scales that up. Passing an
  axes handle to `saveas`/`exportgraphics` saves its whole figure.
- `drawnow` and `pause` update figures mid-command only when commands run
  in the background worker. When the app is opened from `file://` (no
  worker), figures appear when the command finishes.
- Each variable in the Workspace panel has a small &times; to delete
  just that one, alongside the existing `clear('name')` / `clear name`
  ways to do it from the Command Window.
- Running a command or script that creates or updates a figure switches
  you to it automatically. If a single run touches several figures (e.g.
  a script that calls `figure(1)`, plots, then `figure(2)`, plots again),
  the app flips through each one in the order it was created, about a
  second apart, ending on the last.
- The left sidebar has three views — **Workspace** (variables),
  **History** (everything you've typed or run, most recent first,
  persisted across sessions in `localStorage`), and **Files** (above).
  Click any history entry to run it again immediately. Hitting **Run** on
  a script logs `run('<filename>.m')` to history too, so re-running a
  whole script later is one click away.
  - History uses `localStorage` (a capped list of 500 strings — small and
    simple), while files use IndexedDB, which handles much larger and
    binary data such as `.mat` files.
- Values display like MATLAB's default `format short`: integer-valued
  arrays as integers, everything else with 4 decimals, switching to
  e-notation for scalars (`1.0000e+10`) or a common `1.0e+03 *` scale
  factor for arrays whose magnitudes fall outside [0.001, 1000).
- Typing a bare variable name (`x`) displays `x = ...` and leaves `ans`
  untouched, as in MATLAB.
- Recursion is capped at MATLAB's default limit of 500 calls, but the
  browser's JavaScript stack usually runs out first (a few hundred
  levels); either way you get a "Maximum recursion depth" error rather
  than a crash.
- Reduction functions (`sum`, `mean`, etc.) default to MATLAB's "first
  non-singleton dimension" rule: down each column for a general matrix,
  along the vector itself for a row or column vector. Pass an explicit
  dimension argument to override.
- `fprintf`/`sprintf` process backslash escapes (`\n`, `\t`, `\r`, `\\`)
  in the format string itself, matching real MATLAB — this is separate
  from how the string literal itself is parsed (single-quoted strings
  don't otherwise treat `\` as special).
- `readmatrix`'s CSV parser is intentionally basic (comma-delimited, one
  row per line, no quoted-field support). The app's File → Import CSV
  menu action uses a more robust parser (Papa Parse) for messier
  real-world files and assigns straight into the workspace.
- The bundled Plotly.js contains inert string references to some optional
  features this app never invokes (basemap tile URLs for map-type charts,
  a WebGL support-check link) — they're just unused code in the bundle,
  not something that gets fetched; the app is fully usable offline for
  everything it actually exposes.
