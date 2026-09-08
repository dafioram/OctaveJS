# MatWeb — a lightweight, offline-capable, MATLAB-compatible console

MatWeb is a real MATLAB-syntax interpreter — a lexer, recursive-descent
parser, and tree-walking evaluator, all hand-written — running entirely in
your browser, wrapped in a small IDE: a Command Window (REPL), a script
editor with syntax highlighting, a workspace browser, and Plotly-based
plotting. Nothing is sent to a server; once the page is loaded, it works
offline.

It is **not** a MATLAB clone. It implements a real subset of the language
and a real subset of MATLAB's function library, chosen to cover the common
cases well rather than to cover everything shallowly. This README is the
honest account of exactly where that subset ends — what's implemented,
what isn't, and what to do instead — because that's more useful to you
than a marketing description.

## Running it

- **Just want to use it:** open `dist/index.html` in a browser (or serve
  the `dist/` folder with any static file server — some browsers restrict
  ES module loading over `file://`, in which case run e.g. `npx serve dist`
  and open the printed `localhost` URL). Everything needed is already
  bundled into `dist/main.js`; there is no build step required to use it.
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
- **Running the interpreter's own test suite:** `npm test` (130 assertions
  covering the language core, builtins, plotting, file I/O, and the MAT5
  codec; see `test/`).

## What's implemented

**Language:** variables; real and complex scalars/matrices; string (char
array) literals; `if`/`elseif`/`else`, `for`, `while`, `switch`/`case`
(including `case {a,b,c}` multi-value matching), `break`/`continue`/
`return`; functions with multiple return values (`[a,b] = f(...)`),
default `nargin`/`nargout`, recursion; anonymous functions (`@(x) ...`,
correctly capturing free variables *by value* at creation time, matching
real MATLAB); function handles to named functions (`@sin`); `global` and
`persistent`; the full operator set including matrix vs. elementwise
operators (`*` vs `.*`, `^` vs `.^`, etc.), ranges (`a:b`, `a:step:b`),
transpose (`'`, `.'`); both logical and numeric indexing (with the correct
different semantics for each); linear and 2-D indexing including `end`;
auto-growing arrays on assignment; element/row/column deletion via
`x(i) = []`.

**Math:** the trig/exp/log/rounding family (auto-promoting to complex
where real MATLAB does, e.g. `sqrt(-1)`, `asin(2)`); `sum`, `prod`, `mean`,
`median`, `std`, `var`, `min`/`max` (with index output), `cumsum`,
`cumprod`; `sort` (with index output, `'ascend'`/`'descend'`), `unique`,
`find` (linear or `[row,col]`/`[row,col,val]` forms, with optional count
and `'first'`/`'last'`), `any`, `all`, `isnan`, `isinf`, `isfinite`;
`fliplr`, `flipud`, `flip`, `repmat`, `cat`/`horzcat`/`vertcat`; `size`,
`length`, `numel`, `reshape`, `diag`, `triu`, `tril`, `det`, `trace`,
`rank`, `norm`, `dot`, `cross`, `inv`, `pinv`, `eig`, `svd`, `lu`, `qr`;
`fft`/`ifft`; `polyfit`, `polyval`, `interp1` (linear interpolation).

**Strings:** `strcmp`, `strcmpi`, `upper`, `lower`, `strtrim`, `strrep`,
`str2double`, `str2num` (evaluates the string as a MATLAB expression
through this same interpreter — no different in kind from any other code
you run here). `strsplit` is intentionally not implemented since its
natural return type is a cell array; see the limitations table below.

**Plotting:** `plot` (with inline linespec strings like `'r--'` or
`'b-o'`), `scatter`, `bar`, `histogram`, `hist` (the classic MATLAB
function — plots when called with no output arguments, returns
`[counts, centers]` otherwise; `histogram` is the more robust,
Plotly-native-binned modern equivalent), `figure`, `hold`, `xlabel`/
`ylabel`/`title`, `legend`, `grid`, `xlim`/`ylim`, `axis('equal'|'tight'|
[xmin xmax ymin ymax])`. Each figure's tab in the Figures panel has a
&times; to close it.

**I/O:** `readmatrix`/`writematrix` (CSV), `save`/`load` (a real MAT5
`.mat` writer/reader — see below), `run('script.m')`, and calling a script
by its bare name if it's been opened in the app.

## What isn't supported, and what to do instead

These are deliberate scope cuts, not oversights — each is a meaningful
implementation effort with a niche payoff for a lightweight tool. Where
there's a reasonable workaround, it's listed.

| Not supported | Use instead |
|---|---|
| Double-quoted strings (`"hello"`, MATLAB string arrays) | Single-quoted char arrays: `'hello'` |
| **General command syntax** for arbitrary/user-defined functions, e.g. calling your own `function foo(s)` as `foo bar` | Use the normal parenthesized form: `foo('bar')`. A small, fixed whitelist — `clear`, `hold`, `grid`, `axis`, `disp` — *does* support command syntax (`clear x y`, `hold on`, `grid off`, `axis equal`, `disp hello`), since those are idiomatic and unambiguous enough to special-case safely; see the note below the table. |
| Structs (`s.field = ...`) | Separate variables, or parallel arrays |
| Cell arrays (`{1, 2, 3}`, `c{1}`) | Separate variables, or numeric/char arrays where the contents are uniform |
| N-D arrays (more than 2 subscripts) | Reshape/index a 2-D matrix, or use multiple 2-D matrices |
| Integer classes (`int8`, `uint16`, ...) — everything is `double` (or tagged `logical`/`char`) | Just use `double`; a trailing class-name argument to `zeros`/`ones` (e.g. `zeros(3,'int8')`) is silently ignored |
| `true(m,n)` / `false(m,n)` size-constructor forms (bare `true`/`false` literals work fine) | `logical(ones(m,n))` / `logical(zeros(m,n))` |
| Chained indexed assignment, e.g. `f(x)(y) = 3` | Use an intermediate variable |
| Name-Value pairs to `plot`, e.g. `plot(x,y,'LineWidth',2)` | Inline linespec strings only, e.g. `plot(x,y,'r--')` |
| `arrayfun`'s `'UniformOutput', false` / cell outputs | Only the scalar-output form is supported (no cells to hold results in) |
| Matrix/columnwise FFT | `fft`/`ifft` only accept vector input |
| Complex-matrix `rank`/`svd` | `rank(real(A))` as an approximation, or avoid complex inputs |
| `strsplit` (would return a cell array) | Not implemented — see the cell-array row above |

**On that command-syntax whitelist:** real MATLAB decides whether `foo bar`
means "call foo with the string 'bar'" or something else by checking, at
parse time, whether `foo` is *currently* a variable in the workspace —
which makes MATLAB's grammar depend on runtime state, not just the text
being parsed. This app keeps parsing a pure, one-time, stateless step
(the parser never sees the interpreter's variables), so replicating that
general rule isn't a good fit architecturally. Instead, `clear`, `hold`,
`grid`, `axis`, and `disp` are recognized by name directly in the parser:
when one of those five words is immediately followed by a bareword on the
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

What's **not** implemented: structs, cell arrays, sparse matrices,
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
                system.js, plotting.js, io.js, index.js
                — the function library, registered into the interpreter.
src/mat5/       mat5.js — the MAT5 binary codec.
src/ui/         main.js, matlab-lang.js, styles.css
                — the browser app: DOM wiring, CodeMirror setup, Plotly
                  glue. Everything here is what actually needs a browser;
                  everything above it is plain, testable JS.
test/           harness.js + two test files — run with `npm test`.
build.mjs       esbuild bundling script -> dist/.
```

The interpreter takes a `host` object (see `src/ui/main.js`'s `host`
constant) so it can run identically in a browser or in Node for testing:
`host.print(text)` for console output, `host.figures.render(...)` for
plotting, `host.io.download*` for triggering file saves. `interp.files`
is a small virtual filesystem (`Map`) that the UI populates from file
pickers/drag-and-drop, which `readmatrix`/`save`/`load`/`run` all read
from — this is also how the test suite exercises file I/O without a real
filesystem or browser.

## A few smaller, worth-knowing behaviors

- `help('name')` prints calling syntax and a short description for any
  builtin, or the auto-derived signature for a user-defined function
  (e.g. `help('square')` after defining `function y = square(x)`). This
  app doesn't extract MATLAB's usual "leading comment after the function
  line" doc text, since comments are discarded at the lexer level rather
  than preserved — user functions only get a signature, not a description.
- `clc` clears the Command Window's output (wired to the same action as
  Edit → Clear command window in the menu bar).
- Click a script's filename in the Script Editor toolbar to rename it
  before saving — otherwise every new script saves as `untitled.m`.
- Each open figure gets its own tab in the Figures panel; click the
  &times; on a tab to close that figure. Closing the last one resets
  figure numbering, so the next plot starts again at Figure 1.
- Each variable in the Workspace panel has a small &times; to delete
  just that one, alongside the existing `clear('name')` / `clear name`
  ways to do it from the Command Window.
- Running a command or script that creates or updates a figure switches
  you to it automatically. If a single run touches several figures (e.g.
  a script that calls `figure(1)`, plots, then `figure(2)`, plots again),
  the app flips through each one in the order it was created, about a
  second apart, ending on the last.
- The left sidebar has two views — **Workspace** (variables) and
  **History** (everything you've typed or run, most recent first,
  persisted across sessions in `localStorage`). Click any history entry
  to run it again immediately. Hitting **Run** on a script logs
  `run('<filename>.m')` to history too, so re-running a whole script
  later is one click away.
  - Why `localStorage` and not `IndexedDB`: history is just a capped
    list of strings (500 entries max) — comfortably under any
    `localStorage` size limit, and its plain synchronous get/set API is
    simpler than `IndexedDB` for data this small and unstructured.
    `IndexedDB` would only start to pay for itself with much larger or
    more structured data (e.g. saved datasets), which isn't what command
    history is.
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
  everything it actually exposes (line/scatter/bar/histogram plots).
