# Checking MatWeb against real MATLAB

MatWeb's tests pin down what MATLAB does, but most expected values were
written from MATLAB's documentation. These tools check them against an
actual MATLAB installation.

## 1. Run the reference script in MATLAB

Copy `matweb_reference.m` to a folder on your MATLAB path (or `cd` to
this folder) and run:

```matlab
matweb_reference
```

It writes `matweb_reference.txt` (a few MB) in the current folder, in a
minute or two. Warnings printed while it runs are expected. It records,
for about 26,000 cases:

- every behavior contract in `test/contracts-data.mjs` (class, size and
  value of a call) and every error-message case,
- the probes in `make-reference.mjs` (behaviors we are unsure of),
- a sweep of every pure library function over awkward arguments (empty,
  NaN, Inf, complex, char, logical, cell, struct, function handles),
- the command-window display of the scripts in `test/display/`
  (with `format compact`, via `evalc`).

Nothing random is recorded: MatWeb's random numbers are statistically
equivalent to MATLAB's, not the same stream. The script only uses
long-standing MATLAB features, so older releases work too; functions an
older release lacks are recorded as errors.

## 2. Compare

```sh
node tools/matlab/compare-reference.mjs matweb_reference.txt
node tools/matlab/compare-reference.mjs matweb_reference.txt --kind=display --limit=100
node tools/matlab/compare-reference.mjs matweb_reference.txt --json=diffs.json
```

This lists every case where MatWeb differs: class, size, values (to a
relative 1e-12), errors where MATLAB returns a value (and the reverse),
exact error messages, and display text (blank lines ignored).

MatWeb follows current MATLAB, so a difference from an older release
needs checking against the current documentation before it becomes a
fix or a test (implicit expansion, the `string` type and some error
messages changed over the years).

## Regenerating the script

`matweb_reference.m` is generated; after changing the contracts, the
display scripts or the probes, run:

```sh
node tools/matlab/make-reference.mjs
```

A reference file from an older script still works: cases whose code has
changed are reported as stale and skipped.
