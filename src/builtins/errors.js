// errors.js — Raising and reporting errors: error, warning, assert,
// MException, throw/rethrow, getReport. Caught errors are MException
// objects (see makeMException in values.js), so `catch ME` gives you
// ME.message and ME.identifier just like MATLAB.

import { Mat, StructArray, MatlabError, makeMException, isMException } from '../core/values.js';
import { doSprintf, flattenArgsForPrintf } from './format.js';

const ID_RE = /^[A-Za-z][\w-]*(:[\w-]+)+$/;

function isText(v) { return v instanceof Mat && v.isChar; }

// Shared argument handling for error/warning/assert/MException:
//   (msg)                  — message used literally
//   (fmt, a1, ...)         — sprintf-style formatting
//   (id, fmt, a1, ...)     — first argument is a message identifier
// Returns { identifier, message }.
function parseMessageArgs(args, fname, allowIdOnlyWithMore = true) {
  if (args.length === 0) return { identifier: '', message: '' };
  if (!isText(args[0])) throw new MatlabError(`${fname}: message must be a character vector`);
  const first = args[0].toJSString();
  if (args.length === 1) return { identifier: '', message: first };
  if (allowIdOnlyWithMore && ID_RE.test(first) && isText(args[1])) {
    return { identifier: first, message: doSprintf(args[1].toJSString(), flattenArgsForPrintf(args.slice(2))) };
  }
  return { identifier: '', message: doSprintf(first, flattenArgsForPrintf(args.slice(1))) };
}

function fieldText(s, name) {
  if (!s.hasField(name)) return '';
  const v = s.data[0].get(name);
  return isText(v) ? v.toJSString() : '';
}

function throwFromStruct(s) {
  const message = fieldText(s, 'message');
  if (message === '' && !isMException(s)) return; // error(struct with empty message) is a no-op
  throw new MatlabError(message, fieldText(s, 'identifier'));
}

export function registerErrors(reg) {
  reg.set('error', {
    fn: (args) => {
      if (args.length >= 1 && args[0] instanceof StructArray) { throwFromStruct(args[0]); return []; }
      const { identifier, message } = parseMessageArgs(args, 'error');
      if (message === '') return []; // error('') does nothing, as in MATLAB
      throw new MatlabError(message, identifier);
    },
  });

  reg.set('warning', {
    fn: (args, _n, ctx) => {
      const state = ctx.interp.warningState || (ctx.interp.warningState = { all: true, off: new Set() });
      if (args.length === 0) return [];
      const first = isText(args[0]) ? args[0].toJSString() : null;
      if (first === 'on' || first === 'off') {
        const id = args.length >= 2 && isText(args[1]) ? args[1].toJSString() : 'all';
        if (id === 'all') { state.all = first === 'on'; state.off.clear(); }
        else if (first === 'off') state.off.add(id);
        else state.off.delete(id);
        return [];
      }
      const { identifier, message } = parseMessageArgs(args, 'warning');
      if (message !== '') ctx.interp.warn(message, identifier);
      return [];
    },
  });

  reg.set('assert', {
    fn: (args) => {
      if (args.length === 0) throw new MatlabError('assert requires a condition');
      const cond = args[0];
      const ok = cond instanceof Mat && cond.isTruthy();
      if (ok) return [];
      if (args.length === 1) throw new MatlabError('Assertion failed.', 'MATLAB:assertion:failed');
      const { identifier, message } = parseMessageArgs(args.slice(1), 'assert');
      throw new MatlabError(message, identifier || 'MATLAB:assertion:failed');
    },
  });

  reg.set('MException', {
    fn: (args) => {
      if (args.length < 2 || !isText(args[0]) || !isText(args[1])) {
        throw new MatlabError('MException requires an identifier and a message: MException(id, msg, ...)');
      }
      const id = args[0].toJSString();
      if (id !== '' && !ID_RE.test(id)) throw new MatlabError(`Invalid MException identifier '${id}' (expected component:mnemonic)`);
      const message = doSprintf(args[1].toJSString(), flattenArgsForPrintf(args.slice(2)));
      return [makeMException(id, message)];
    },
  });

  const rethrowFn = {
    fn: (args) => {
      if (!(args[0] instanceof StructArray)) throw new MatlabError('Argument must be an MException object');
      throwFromStruct(args[0]);
      return [];
    },
  };
  reg.set('rethrow', rethrowFn);
  reg.set('throw', rethrowFn);

  reg.set('getReport', {
    fn: (args) => {
      if (!(args[0] instanceof StructArray)) throw new MatlabError('getReport: argument must be an MException object');
      return [Mat.fromString(fieldText(args[0], 'message'))];
    },
  });
}
