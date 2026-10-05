// random.js — Random numbers: rand, randn, randi, randperm and rng.
//
// All of them draw from one seedable generator per session: the Mersenne
// Twister (MT19937), MATLAB's default 'twister' generator, seeded like
// MATLAB's (seed 0 means MT seed 5489, which MATLAB uses by default), so a
// session starts from the same state every time, as MATLAB does. Uniform
// doubles use 53 random bits, in the open interval (0, 1). Normal values
// use the Box–Muller transform, so randn is statistically equivalent to
// MATLAB's but not the same sequence (MATLAB's ziggurat is not published).
//
// The generator state is part of the session settings, so Stop restores
// it along with the workspace (see worker/session.js).

import { Mat, StructArray, MatlabError, shapeArgs } from '../core/values.js';

const N = 624, M = 397;

export class MersenneTwister {
  constructor(seed = 0) { this.seed(seed); }

  seed(s) {
    this.seedValue = s;
    const mt = new Uint32Array(N);
    mt[0] = (s === 0 ? 5489 : s) >>> 0;
    for (let k = 1; k < N; k++) {
      const p = mt[k - 1] ^ (mt[k - 1] >>> 30);
      mt[k] = (Math.imul(1812433253, p) + k) >>> 0;
    }
    this.mt = mt;
    this.index = N;
  }

  nextUint32() {
    const mt = this.mt;
    if (this.index >= N) {
      for (let k = 0; k < N; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % N] & 0x7fffffff);
        mt[k] = mt[(k + M) % N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  // A double in (0, 1) with 53 random bits.
  uniform() {
    for (;;) {
      const a = this.nextUint32() >>> 5, b = this.nextUint32() >>> 6;
      const u = (a * 67108864 + b) / 9007199254740992;
      if (u !== 0) return u;
    }
  }

  normal() {
    const u = this.uniform(), v = this.uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // An integer in [0, n), from one uniform double.
  below(n) {
    return Math.floor(this.uniform() * n);
  }

  // State as plain numbers: the 624 words then the position (MATLAB's
  // twister State is likewise 625 values).
  getState() { return [...this.mt, this.index]; }
  setState(state) {
    if (state.length !== N + 1) throw new MatlabError('rng: the State must have 625 elements');
    this.mt = Uint32Array.from(state.slice(0, N), v => v >>> 0);
    this.index = Math.min(Math.max(Math.round(state[N]), 0), N);
  }
}

// The session's generator, created on first use.
export function generatorOf(interp) {
  if (!interp.rng) interp.rng = new MersenneTwister(0);
  return interp.rng;
}

const isText = (v) => v instanceof Mat && v.isChar;
const text = (v) => v.toJSString();

// Size arguments with trailing class names ('double', 'single') and
// 'like', p removed; no sizes means a scalar.
function sizeOf(args, fname) {
  let a = args.slice();
  if (a.length >= 2 && isText(a[a.length - 2]) && text(a[a.length - 2]).toLowerCase() === 'like') a = a.slice(0, -2);
  while (a.length && isText(a[a.length - 1])) {
    const cls = text(a[a.length - 1]).toLowerCase();
    if (!['double', 'single'].includes(cls)) throw new MatlabError(`${fname}: unsupported class '${cls}' (only double)`);
    a.pop();
  }
  if (a.length === 0) return [1, 1];
  return shapeArgs(a, fname);
}

function fill([r, c], draw) {
  const m = Mat.zeros(r, c);
  for (let k = 0; k < m.numel; k++) m.re[k] = draw();
  return m;
}

// The settings struct of rng: Type, Seed, State.
function settingsStruct(g) {
  const state = g.getState();
  return StructArray.scalar({
    Type: Mat.fromString('twister'),
    Seed: Mat.scalar(g.seedValue),
    State: new Mat(state.length, 1, Float64Array.from(state)),
  });
}

function seedValue(v, fname) {
  const s = v.toScalarNumber();
  if (!Number.isInteger(s) || s < 0 || s >= 2 ** 32) throw new MatlabError(`${fname}: the seed must be an integer between 0 and 2^32 - 1`);
  return s;
}

function shuffleSeed() {
  return ((Date.now() % 4294967296) ^ Math.floor(Math.random() * 4294967296)) >>> 0;
}

// rand('seed', s), randn('state', s), rand('twister', s), ...: MATLAB's
// discouraged syntaxes, which it will remove. They seed (or query) this
// session's single generator, with a one-time warning.
const LEGACY = ['seed', 'state', 'twister'];
function legacy(fname, args, ctx) {
  const interp = ctx.interp;
  const kind = text(args[0]).toLowerCase();
  if (!interp.warnedLegacyRng) {
    interp.print(`Warning: ${fname}('${kind}', ...) is a discouraged syntax that MATLAB will remove; use rng instead (e.g. rng(seed)). `
      + 'Here it controls the same generator as rng, so the numbers differ from MATLAB\'s legacy generators.\n');
    interp.warnedLegacyRng = true;
  }
  const g = generatorOf(interp);
  if (args.length === 1) {
    // Query: the seed for 'seed', the full state otherwise.
    if (kind === 'seed') return [Mat.scalar(g.seedValue)];
    const st = g.getState();
    return [new Mat(st.length, 1, Float64Array.from(st))];
  }
  const v = args[1];
  if (v.numel === N + 1) g.setState(Array.from(v.re));
  else g.seed(seedValue(v, fname));
  return [];
}

export function registerRandom(reg) {
  reg.set('rand', {
    fn: (args, _n, ctx) => {
      if (args.length && isText(args[0]) && LEGACY.includes(text(args[0]).toLowerCase())) return legacy('rand', args, ctx);
      const g = generatorOf(ctx.interp);
      return [fill(sizeOf(args, 'rand'), () => g.uniform())];
    },
  });
  reg.set('randn', {
    fn: (args, _n, ctx) => {
      if (args.length && isText(args[0]) && LEGACY.includes(text(args[0]).toLowerCase())) return legacy('randn', args, ctx);
      const g = generatorOf(ctx.interp);
      return [fill(sizeOf(args, 'randn'), () => g.normal())];
    },
  });
  // randi(imax, ...) | randi([imin imax], ...): uniform integers.
  reg.set('randi', {
    fn: (args, _n, ctx) => {
      if (args.length === 0) throw new MatlabError('randi: expected randi(imax) or randi([imin imax])');
      const lim = args[0];
      let lo = 1, hi;
      if (lim.numel === 1) hi = lim.re[0];
      else if (lim.numel === 2) [lo, hi] = lim.re;
      else throw new MatlabError('randi: the first input must be imax or [imin imax]');
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new MatlabError('randi: the limits must be integers');
      if (lim.numel === 1 && hi < 1) throw new MatlabError('randi: imax must be a positive integer');
      if (lo > hi) throw new MatlabError('randi: imin must be less than or equal to imax');
      if (hi - lo >= 2 ** 53) throw new MatlabError('randi: the range is too large');
      const g = generatorOf(ctx.interp);
      const span = hi - lo + 1;
      return [fill(sizeOf(args.slice(1), 'randi'), () => lo + g.below(span))];
    },
  });
  // randperm(n) | randperm(n, k): a random permutation of 1:n (or k
  // distinct values from it), as a row vector.
  reg.set('randperm', {
    fn: (args, _n, ctx) => {
      if (args.length === 0) throw new MatlabError('randperm: expected randperm(n) or randperm(n, k)');
      const n = args[0].toScalarNumber();
      if (!Number.isInteger(n) || n < 0) throw new MatlabError('randperm: n must be a nonnegative integer');
      const k = args.length >= 2 ? args[1].toScalarNumber() : n;
      if (!Number.isInteger(k) || k < 0 || k > n) throw new MatlabError('randperm: k must be an integer between 0 and n');
      const g = generatorOf(ctx.interp);
      // Partial Fisher–Yates; positions that moved are kept in a map, so
      // randperm(1e9, 3) doesn't allocate n values.
      const moved = new Map();
      const at = (i) => (moved.has(i) ? moved.get(i) : i + 1);
      const out = new Float64Array(k);
      for (let i = 0; i < k; i++) {
        const j = i + g.below(n - i);
        out[i] = at(j);
        moved.set(j, at(i));
      }
      return [new Mat(1, k, out)];
    },
  });

  // rng(seed) | rng(seed, 'twister') | rng('default') | rng('shuffle') |
  // rng(s) | s = rng. With outputs, returns the settings in effect before
  // the call (so `s = rng(1)` saves the old state).
  reg.set('rng', {
    fn: (args, nargout, ctx) => {
      const g = generatorOf(ctx.interp);
      const before = settingsStruct(g);
      if (args.length === 0) return [before];
      let a = args.slice();
      if (a.length === 2) {
        if (!isText(a[1])) throw new MatlabError('rng: the second input must be a generator name');
        const type = text(a[1]).toLowerCase();
        if (type !== 'twister') throw new MatlabError(`rng: only the 'twister' generator is supported (got '${type}')`);
        a = [a[0]];
      } else if (a.length > 2) throw new MatlabError('rng: too many input arguments');
      const v = a[0];
      if (v instanceof StructArray) {
        // rng(s): restore saved settings.
        const el = v.data[0];
        const type = el.get('Type');
        if (type && isText(type) && text(type).toLowerCase() !== 'twister') throw new MatlabError(`rng: only the 'twister' generator is supported (got '${text(type)}')`);
        const state = el.get('State');
        if (!state) throw new MatlabError('rng: the settings structure must have a State field');
        g.setState(Array.from(state.re));
        const seed = el.get('Seed');
        g.seedValue = seed ? seed.re[0] : 0;
      } else if (isText(v)) {
        const mode = text(v).toLowerCase();
        if (mode.trim() !== '' && !Number.isNaN(Number(mode))) g.seed(seedValue(Mat.scalar(Number(mode)), 'rng')); // rng 5
        else if (mode === 'default') g.seed(0);
        else if (mode === 'shuffle') g.seed(shuffleSeed());
        else throw new MatlabError(`rng: unknown option '${mode}' (use a seed, 'default' or 'shuffle')`);
      } else g.seed(seedValue(v, 'rng'));
      return nargout >= 1 ? [before] : [];
    },
  });
}
