// session.js — The interpreter side of the page <-> interpreter protocol.
// It runs inside a Web Worker (worker.js), so a long-running command never
// freezes the page and can be stopped; if workers are unavailable (e.g.
// the page was opened from file://), the page runs it in-thread instead.
// No DOM access here, so the test suite drives it directly under Node.
//
// Page -> session messages:
//   { type: 'init', files: [[name, entry]], snapshot? }  start (or restart after Stop)
//   { type: 'run', id, src }                             run code
//   { type: 'putFile', name, entry } / { type: 'deleteFile', name }
//   { type: 'deleteVar', name } / { type: 'clearVars' } / { type: 'setVar', name, value }
//   { type: 'getVar', id, name }                         value for the variable viewer
//   { type: 'closeFigure', num }
// Session -> page messages:
//   { type: 'ready', workspace }
//   { type: 'print', text } / { type: 'clc' }
//   { type: 'fileWritten', name, entry }                 save/writematrix output
//   { type: 'done', id, error, workspace, delta, figures }
//   { type: 'workspace', workspace, delta }
//   { type: 'var', id, name, value }
//
// `delta` lists what changed in the interpreter's state since the last
// message (serialized). The page folds deltas into a mirror; when the user
// presses Stop, the page terminates the worker and starts a new one from
// that mirror — i.e. the state just before the interrupted command.

import { Interpreter, formatValue, toMatlabError } from '../core/interpreter.js';
import { buildBuiltinsRegistry } from '../builtins/index.js';
import { Mat, FunctionHandle, serializeValue, deserializeValue, retain, valueClassName } from '../core/values.js';

const VIEWER_MAX_ELEMENTS = 2000;

export function createSession(post, { snapshots = true } = {}) {
  let interp = null;
  let touched = []; // figure numbers touched by the current command, first-touch order

  function touch(num) { if (!touched.includes(num)) touched.push(num); }

  function newInterpreter() {
    const it = new Interpreter({
      print: (text) => post({ type: 'print', text }),
      clearConsole: () => post({ type: 'clc' }),
      figures: { render: touch, show: touch },
      io: { fileWritten: (name, entry) => post({ type: 'fileWritten', name, entry }) },
    });
    it.registerBuiltins(buildBuiltinsRegistry());
    return it;
  }

  function resolveLocals(fileName) {
    try {
      const info = interp.loadMFile(fileName);
      return info && info.kind === 'function' ? info.primary.locals : null;
    } catch (e) {
      return null;
    }
  }

  function workspaceSummary() {
    const ws = interp.workspace;
    return [...ws.names()].sort().map(name => {
      const v = ws.get(name);
      return { name, size: v instanceof FunctionHandle ? '1x1' : v.sizeStr(), cls: valueClassName(v) };
    });
  }

  function serializeStore(map) { return [...map.entries()].map(([k, v]) => [k, serializeValue(v)]); }

  // Everything that changed since the previous delta (see header comment).
  function takeDelta() {
    const ws = interp.workspace;
    if (!snapshots) { ws.dirty.clear(); return null; }
    const d = { vars: [], deleted: [], globalNames: [...ws.globalNames], figureState: { ...interp.figureState } };
    for (const name of ws.dirty) {
      if (ws.vars.has(name)) d.vars.push([name, serializeValue(ws.vars.get(name))]);
      else d.deleted.push(name);
    }
    ws.dirty.clear();
    if (interp.globalsDirty) { d.globals = serializeStore(interp.globals); interp.globalsDirty = false; }
    if (interp.persistentsDirty) {
      d.persistents = [...interp._persistents.entries()].map(([fn, store]) => [fn, serializeStore(store)]);
      interp.persistentsDirty = false;
    }
    if (interp.funcTableDirty) { d.funcTable = [...interp.funcTable.values()]; interp.funcTableDirty = false; }
    return d;
  }

  function figuresPayload() {
    const out = touched.map(num => ({ num, fig: interp.figures && interp.figures.has(num) ? interp.figures.get(num) : null }));
    touched = [];
    return out;
  }

  function restore(snap) {
    const load = (o) => deserializeValue(o, resolveLocals);
    for (const def of snap.funcTable || []) interp.funcTable.set(def.name, def);
    for (const [k, o] of snap.globals || []) interp.globals.set(k, retain(load(o)));
    for (const [fn, entries] of snap.persistents || []) {
      const store = interp._persistentStore(fn);
      for (const [k, o] of entries) store.set(k, retain(load(o)));
    }
    for (const name of snap.globalNames || []) interp.workspace.globalNames.add(name);
    for (const [k, o] of snap.vars || []) interp.workspace.set(k, load(o));
    if (snap.figureState) interp.figureState = { ...snap.figureState };
    if (snap.figures && snap.figures.length) interp.figures = new Map(snap.figures);
    interp.workspace.dirty.clear();
    interp.globalsDirty = interp.persistentsDirty = interp.funcTableDirty = false;
  }

  // What the variable viewer shows: a numeric table for modest matrices,
  // otherwise the Command Window's text rendering.
  function describe(v) {
    if (v instanceof Mat && !v.isChar && v.numel <= VIEWER_MAX_ELEMENTS) {
      return { kind: 'matrix', rows: v.rows, cols: v.cols, re: Array.from(v.re), im: v.im ? Array.from(v.im) : null, size: v.sizeStr(), cls: v.className() };
    }
    if (v instanceof Mat && !v.isChar) {
      return { kind: 'text', text: `${v.sizeStr()} ${v.className()} — too large to preview here (${v.numel} elements); use disp() in the Command Window.`, size: v.sizeStr(), cls: v.className() };
    }
    const size = v instanceof FunctionHandle ? '1x1' : v.sizeStr();
    return { kind: 'text', text: formatValue(v), size, cls: valueClassName(v) };
  }

  function postWorkspace() { post({ type: 'workspace', workspace: workspaceSummary(), delta: takeDelta() }); }

  function handle(msg) {
    switch (msg.type) {
      case 'init': {
        interp = newInterpreter();
        for (const [name, entry] of msg.files || []) interp.files.set(name, entry);
        if (msg.snapshot) restore(msg.snapshot);
        post({ type: 'ready', workspace: workspaceSummary() });
        return;
      }
      case 'run': {
        let error = null;
        try {
          interp.runSource(msg.src);
        } catch (e) {
          error = toMatlabError(e).message;
        }
        post({ type: 'done', id: msg.id, error, workspace: workspaceSummary(), delta: takeDelta(), figures: figuresPayload() });
        return;
      }
      case 'putFile': interp.files.set(msg.name, msg.entry); return;
      case 'deleteFile': interp.files.delete(msg.name); return;
      case 'deleteVar': interp.workspace.delete(msg.name); postWorkspace(); return;
      case 'clearVars': interp.workspace.clearAll(); postWorkspace(); return;
      case 'setVar': interp.workspace.set(msg.name, deserializeValue(msg.value, resolveLocals)); postWorkspace(); return;
      case 'getVar': {
        const ws = interp.workspace;
        post({ type: 'var', id: msg.id, name: msg.name, value: ws.has(msg.name) ? describe(ws.get(msg.name)) : null });
        return;
      }
      case 'closeFigure': {
        if (interp.figures) interp.figures.delete(msg.num);
        if (!interp.figures || interp.figures.size === 0) interp.figureState.current = undefined;
        postWorkspace();
        return;
      }
      default:
        throw new Error(`Unknown session message '${msg.type}'`);
    }
  }

  return { handle };
}
