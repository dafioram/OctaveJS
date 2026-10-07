// interpreter.js — Tree-walking evaluator over the AST produced by parser.js.
//
// Scoping model: MATLAB scripts share one flat "base workspace"; each
// function call gets its own fresh scope (no access to the caller's
// variables) except for names declared `global` (routed to a single shared
// store) or `persistent` (routed to a per-function store that survives
// across calls). Anonymous functions capture the *values* of free
// variables at creation time (a snapshot, not a live reference) — this
// matches real MATLAB closure semantics.

import { parse } from './parser.js';
import {
  Mat, Cell, StructArray, FunctionHandle, MatlabError, colonRange,
  retain, release, valueClassName, makeMException, truthOf,
} from './values.js';
import * as C from './cmath.js';

class BreakSignal { }
class ContinueSignal { }
class ReturnSignal { }

class Scope {
  constructor(interp, { isFunction = false, funcName = null, trackDirty = false } = {}) {
    this.interp = interp;
    this.vars = new Map();
    this.isFunction = isFunction;
    this.funcName = funcName;
    this.globalNames = new Set();
    this.persistentNames = new Set();
    // The base workspace records which names changed, so the worker can
    // send the page a delta (for restoring state after Stop).
    this.dirty = trackDirty ? new Set() : null;
  }
  _store(name) {
    if (this.globalNames.has(name)) return this.interp.globals;
    if (this.persistentNames.has(name)) return this.interp._persistentStore(this.funcName);
    return this.vars;
  }
  _markDirty(name) {
    if (this.globalNames.has(name)) this.interp.globalsDirty = true;
    else if (this.persistentNames.has(name)) this.interp.persistentsDirty = true;
    else if (this.dirty) this.dirty.add(name);
  }
  has(name) { return this._store(name).has(name); }
  get(name) { return this._store(name).get(name); }
  // Stores keep reference counts (see values.js) so indexed assignment
  // knows when it may modify a value in place.
  set(name, value) {
    const store = this._store(name);
    const old = store.get(name);
    if (old !== value) { retain(value); release(old); }
    store.set(name, value);
    this._markDirty(name);
  }
  delete(name) {
    if (this.globalNames.has(name)) { this.globalNames.delete(name); if (this.dirty) this.dirty.add(name); return; }
    if (this.vars.has(name)) { release(this.vars.get(name)); this.vars.delete(name); if (this.dirty) this.dirty.add(name); }
  }
  clearAll() {
    for (const name of [...this.vars.keys(), ...this.globalNames]) this.delete(name);
  }
  // Drop this scope's holds on its values (a function call returning).
  releaseAll() {
    for (const v of this.vars.values()) release(v);
  }
  declareGlobal(name) {
    if (this.vars.has(name)) { release(this.vars.get(name)); this.vars.delete(name); }
    this.globalNames.add(name);
    if (!this.interp.globals.has(name)) { this.interp.globals.set(name, retain(Mat.empty())); this.interp.globalsDirty = true; }
    if (this.dirty) this.dirty.add(name);
  }
  declarePersistent(name) {
    this.persistentNames.add(name);
    const store = this.interp._persistentStore(this.funcName);
    if (!store.has(name)) { store.set(name, retain(Mat.empty())); this.interp.persistentsDirty = true; }
  }
  names() {
    return new Set([...this.vars.keys(), ...this.globalNames, ...this.persistentNames]);
  }
}

export class Interpreter {
  constructor(host = {}) {
    this.host = host; // { print(text), warn(text), figures: {...}, files: Map, ... }
    this.workspace = new Scope(this, { isFunction: false, trackDirty: true });
    this.globalsDirty = false;
    this.persistentsDirty = false;
    this.funcTableDirty = false;
    this.funcTable = new Map(); // user-defined functions (script-local)
    this.globals = new Map();
    this._persistents = new Map(); // funcName -> Map
    this.builtins = new Map(); // registered by builtins/index.js via registerBuiltins()
    this.endStack = []; // stack of {size} for resolving `end` inside index args
    this.callDepth = 0;
    // Local-function tables of the function files currently executing
    // (top = innermost). A function file's subfunctions are only visible
    // to code inside that file, matching MATLAB's scoping.
    this.localFnStack = [];
    this._mfileCache = new Map(); // name -> { text, ast, kind, primary, locals }
    this.figureState = { current: 1, hold: false };
    // Virtual file store: name -> { kind: 'csv'|'m'|'mat', text?, bytes? }.
    // Populated by the host UI (file picker / drag-drop) or by tests.
    this.files = new Map();
  }

  _persistentStore(funcName) {
    if (!this._persistents.has(funcName)) this._persistents.set(funcName, new Map());
    return this._persistents.get(funcName);
  }

  registerBuiltins(map) {
    for (const [k, v] of map.entries()) this.builtins.set(k, v);
  }

  print(text) { if (this.host.print) this.host.print(text); }
  // A MATLAB warning: printed unless turned off with warning('off', ...).
  warn(message, identifier = '') {
    const state = this.warningState;
    if (state && (!state.all || (identifier && state.off.has(identifier)))) return;
    this.print(`Warning: ${message}\n`);
  }
  // Warnings a numeric routine attached to its result (see linalg.js).
  reportWarnings(v) {
    if (v && v.warnings) { for (const w of v.warnings) this.warn(w.message, w.identifier); delete v.warnings; }
    return v;
  }

  // ---------------- top-level run ----------------

  runSource(source) {
    const ast = parse(source);
    return this.runProgram(ast);
  }

  // eval(code): runs MATLAB text in `scope`. With outputs requested, the
  // text must be one expression and its values are returned.
  evalString(code, scope, nargout) {
    let ast;
    try { ast = parse(code); } catch (e) { throw toMatlabError(e); }
    if (nargout > 0) {
      const stmt = ast.body.length === 1 ? ast.body[0] : null;
      if (!stmt || stmt.type !== 'ExprStmt') throw new MatlabError("eval with outputs requires a single expression, such as eval('2 + 2').", 'MATLAB:eval:notAnExpression');
      return this.evalForNargout(stmt.expr, scope, nargout);
    }
    this.runProgram(ast, scope);
    return [];
  }

  // str2func: a function name, or the text of an anonymous function
  // (which sees no workspace variables).
  handleFromString(text) {
    const t = text.trim();
    if (!t.startsWith('@')) return new FunctionHandle({ name: t });
    let ast;
    try { ast = parse(t); } catch (e) { throw toMatlabError(e); }
    const stmt = ast.body[0];
    if (ast.body.length !== 1 || stmt.type !== 'ExprStmt' || stmt.expr.type !== 'AnonFunc') throw new MatlabError(`Invalid function handle text '${t}'.`);
    return this.evalExpr(stmt.expr, new Scope(this));
  }

  runProgram(ast, scope = this.workspace) {
    // Hoist function definitions first (script-local functions), matching
    // MATLAB script behavior where a function can be called before its
    // textual definition later in the same file.
    const execStmts = [];
    for (const stmt of ast.body) {
      if (stmt.type === 'FunctionDef') { this.funcTable.set(stmt.name, stmt); this.funcTableDirty = true; }
      else execStmts.push(stmt);
    }
    for (const stmt of execStmts) {
      try {
        this.execStmt(stmt, scope);
      } catch (e) {
        if (e instanceof ReturnSignal) break; // `return` in a script ends the script
        throw e;
      }
    }
  }

  // Parses (with caching) a .m file from the virtual file store and
  // classifies it: a *function file* starts with `function` (its first
  // function is the one callable by the file's name, the rest are local
  // subfunctions), anything else is a *script*.
  loadMFile(name) {
    const entry = this.files.get(name + '.m');
    if (!entry) return null;
    const cached = this._mfileCache.get(name);
    if (cached && cached.text === entry.text) return cached;
    const ast = parse(entry.text);
    const first = ast.body[0];
    let info;
    if (first && first.type === 'FunctionDef') {
      const locals = new Map();
      for (const stmt of ast.body) {
        if (stmt.type !== 'FunctionDef') throw new MatlabError(`Function file '${name}.m' may only contain function definitions`);
        locals.set(stmt.name, stmt);
      }
      locals.fileName = name; // lets function handles to subfunctions be serialized
      for (const def of locals.values()) def.locals = locals;
      info = { text: entry.text, ast, kind: 'function', primary: first };
    } else {
      info = { text: entry.text, ast, kind: 'script' };
    }
    this._mfileCache.set(name, info);
    return info;
  }

  _currentLocals() {
    return this.localFnStack.length ? this.localFnStack[this.localFnStack.length - 1] : null;
  }

  // ---------------- statements ----------------

  execStmt(node, scope) {
    switch (node.type) {
      case 'ExprStmt': {
        // A bare variable name just displays the variable under its own
        // name; it doesn't touch `ans` (MATLAB behavior).
        if (node.expr.type === 'Ident' && scope.has(node.expr.name)) {
          if (!node.suppressed) this.displayValue(node.expr.name, scope.get(node.expr.name));
          return;
        }
        const vals = this.evalForNargout(node.expr, scope, 0); // side-effect calls (e.g. plot) want nargout=0
        // A comma-separated list (c{:}, s.field on a struct array) shows
        // every element as `ans`; anything else shows just its value.
        const shown = isCsListNode(node.expr) ? vals : vals.slice(0, 1);
        for (const v of shown) {
          scope.set('ans', v);
          if (!node.suppressed) this.displayValue('ans', v);
        }
        return;
      }
      case 'Assign': {
        const val = this.evalExpr(node.expr, scope);
        this.assignTo(node.target, val, scope);
        if (!node.suppressed) this.displayAssignTarget(node.target, scope);
        return;
      }
      case 'Try': {
        try {
          this.execBlock(node.body, scope);
        } catch (e) {
          if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) throw e;
          const err = toMatlabError(e);
          if (node.ident) scope.set(node.ident, makeMException(err.identifier, err.message));
          this.execBlock(node.catchBody, scope);
        }
        return;
      }
      case 'MultiAssign': {
        const vals = this.evalForNargout(node.expr, scope, node.targets.length);
        for (let k = 0; k < node.targets.length; k++) {
          const t = node.targets[k];
          if (t.type === 'Tilde') continue;
          const v = vals[k];
          if (v === undefined) throw new MatlabError('Insufficient number of outputs from right hand side of equal sign to satisfy assignment.');
          this.assignTo(t, v, scope);
        }
        if (!node.suppressed) {
          for (const t of node.targets) {
            if (t.type === 'Tilde') continue;
            this.displayAssignTarget(t, scope);
          }
        }
        return;
      }
      case 'If': {
        for (const clause of node.clauses) {
          if (this._truthy(this.evalExpr(clause.test, scope))) {
            this.execBlock(clause.body, scope);
            return;
          }
        }
        if (node.elseBody) this.execBlock(node.elseBody, scope);
        return;
      }
      case 'For': {
        const iterVal = this.evalExpr(node.iter, scope);
        if (!(iterVal instanceof Mat)) {
          // Cell and struct arrays iterate column by column too, each
          // iteration getting a rows-by-1 piece of the container.
          if (!(iterVal instanceof Cell || iterVal instanceof StructArray)) throw new MatlabError(`Cannot iterate over a ${valueClassName(iterVal)}`);
          for (let c = 0; c < iterVal.cols; c++) {
            const pieces = iterVal.data.slice(c * iterVal.rows, (c + 1) * iterVal.rows);
            const col = iterVal instanceof Cell ? new Cell(iterVal.rows, 1, pieces)
              : new StructArray(iterVal.rows, 1, iterVal.fieldNames, pieces.map(el => new Map(el)), iterVal.classOverride);
            scope.set(node.varName, col);
            try {
              this.execBlock(node.body, scope);
            } catch (e) {
              if (e instanceof BreakSignal) break;
              if (e instanceof ContinueSignal) continue;
              throw e;
            }
          }
          return;
        }
        // Iterate over columns (MATLAB semantics): for a row vector this is
        // one element per iteration; for a matrix, one column per iteration.
        for (let c = 0; c < iterVal.cols; c++) {
          const col = Mat.zeros(iterVal.rows, 1);
          let colIm = null;
          for (let r = 0; r < iterVal.rows; r++) {
            const lin = c * iterVal.rows + r;
            col.re[r] = iterVal.re[lin];
            if (iterVal.isComplex && iterVal.im[lin] !== 0) {
              if (!colIm) colIm = new Float64Array(iterVal.rows);
              colIm[r] = iterVal.im[lin];
            }
          }
          if (colIm) col.im = colIm;
          col.isChar = iterVal.isChar; col.isLogical = iterVal.isLogical;
          scope.set(node.varName, col);
          try {
            this.execBlock(node.body, scope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'While': {
        while (this._truthy(this.evalExpr(node.test, scope))) {
          try {
            this.execBlock(node.body, scope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'Switch': {
        const subject = this.evalExpr(node.expr, scope);
        for (const c of node.cases) {
          for (const testExpr of c.tests) {
            const tv = this.evalExpr(testExpr, scope);
            if (this._switchMatches(subject, tv)) { this.execBlock(c.body, scope); return; }
          }
        }
        if (node.otherwiseBody) this.execBlock(node.otherwiseBody, scope);
        return;
      }
      case 'Break': throw new BreakSignal();
      case 'Continue': throw new ContinueSignal();
      case 'Return': throw new ReturnSignal();
      case 'FunctionDef': this.funcTable.set(node.name, node); this.funcTableDirty = true; return;
      case 'Global': for (const n of node.names) scope.declareGlobal(n); return;
      case 'Persistent': for (const n of node.names) scope.declarePersistent(n); return;
      default:
        throw new MatlabError(`Cannot execute statement of type ${node.type}`);
    }
  }

  _truthy(v) {
    if (!(v instanceof Mat)) throw new MatlabError(`Conversion to logical from ${valueClassName(v)} is not possible.`);
    return v.isTruthy();
  }

  _switchMatches(subject, testVal) {
    // `case {a, b}` with a cell value matches any of its elements.
    if (testVal instanceof Cell) return testVal.data.some(v => this._switchMatches(subject, v));
    if (!(subject instanceof Mat)) throw new MatlabError('SWITCH expression must be a scalar or a character vector.');
    if (!(testVal instanceof Mat)) return false;
    if (subject.isChar && testVal.isChar) return subject.toJSString() === testVal.toJSString();
    if (subject.isChar !== testVal.isChar) return false;
    if (subject.numel !== testVal.numel) return false;
    for (let k = 0; k < subject.numel; k++) {
      if (subject.re[k] !== testVal.re[k]) return false;
      const ai = subject.isComplex ? subject.im[k] : 0;
      const bi = testVal.isComplex ? testVal.im[k] : 0;
      if (ai !== bi) return false;
    }
    return true;
  }

  execBlock(stmts, scope) {
    for (const s of stmts) this.execStmt(s, scope);
  }

  // ---------------- assignment targets ----------------
  //
  // An assignment target is a root variable plus a chain of accessors,
  // e.g. `s.data{2}(3) = v` is s -> .data -> {2} -> (3). _assignPath walks
  // the chain, creating structs/cells/arrays as needed, and rebuilds each
  // level. A level is modified in place when it's "owned" — held only by
  // its parent (refcount <= 1, with every level above it also owned) —
  // and copied first otherwise (copy-on-write).

  assignTo(target, value, scope) {
    if (target.type === 'Ident') { scope.set(target.name, value); return; }
    const { root, chain } = this._flattenLValue(target);
    const cur = scope.has(root) ? scope.get(root) : undefined;
    const updated = this._assignPath(cur, cur !== undefined && cur._refs <= 1, chain, 0, value, scope);
    scope.set(root, updated);
  }

  _flattenLValue(node) {
    const chain = [];
    while (node.type !== 'Ident') {
      if (node.type === 'Index') chain.unshift({ kind: 'paren', args: node.args });
      else if (node.type === 'CellIndex') chain.unshift({ kind: 'brace', args: node.args });
      else if (node.type === 'Field') chain.unshift({ kind: 'field', name: node.name });
      else if (node.type === 'DynField') chain.unshift({ kind: 'field', nameExpr: node.nameExpr });
      else throw new MatlabError('Invalid assignment target');
      node = node.target;
    }
    return { root: node.name, chain };
  }

  _fieldName(acc, scope) {
    if (acc.name !== undefined) return acc.name;
    const v = this.evalExpr(acc.nameExpr, scope);
    if (!(v instanceof Mat) || !v.isChar) throw new MatlabError('Dynamic structure field names must be character vectors');
    const name = v.toJSString();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new MatlabError(`Invalid field name '${name}'`);
    return name;
  }

  _own(v, owned) { return owned ? v : v.clone(); }

  _assignPath(cur, owned, chain, i, value, scope) {
    if (i === chain.length) return value;
    // Storing a container into itself (s.b = s, c{2} = c) must store a
    // copy, or modifying it in place would make it contain itself.
    if (value === cur && (cur instanceof Cell || cur instanceof StructArray)) value = value.clone();
    const acc = chain[i];
    const last = i === chain.length - 1;
    const isBlank = cur === undefined || (cur instanceof Mat && cur.isEmpty);

    if (acc.kind === 'field') {
      let s;
      if (isBlank) s = new StructArray(1, 1, []);
      else if (cur instanceof StructArray) s = this._own(cur, owned);
      else throw new MatlabError('Unable to perform assignment because dot indexing is not supported for variables of this type.', 'MATLAB:dotAssignmentNotSupported');
      if (s.numel === 0) s = new StructArray(1, 1, s.fieldNames);
      if (s.numel !== 1) throw new MatlabError('Scalar structure required for this assignment.');
      const name = this._fieldName(acc, scope);
      const child = s.hasField(name) ? s.data[0].get(name) : undefined;
      s.setField(0, name, this._assignPath(child, child !== undefined && child._refs <= 1, chain, i + 1, value, scope));
      return s;
    }

    if (acc.kind === 'brace') {
      let c;
      if (isBlank) c = Cell.empty();
      else if (cur instanceof Cell) c = this._own(cur, owned);
      else throw new MatlabError('Unable to perform assignment because brace indexing is not supported for variables of this type.');
      const sel = this._assignSelection(c, acc.args, scope);
      if (sel.positions.length !== 1) throw new MatlabError('Brace assignment needs exactly one target element here.');
      this._growContainer(c, sel);
      const pos = sel.positions[0];
      const child = c.data[pos];
      c.setLin(pos, last ? value : this._assignPath(child, child._refs <= 1, chain, i + 1, value, scope));
      return c;
    }

    // paren
    if (!last) {
      // The only form allowed past `(...)` is s(k).field on a struct array.
      const next = chain[i + 1];
      if (next.kind !== 'field') throw new MatlabError("Indexing with parentheses '()' must appear as the last operation of a valid indexing expression.");
      let s;
      if (isBlank) s = new StructArray(0, 0, []);
      else if (cur instanceof StructArray) s = this._own(cur, owned);
      else throw new MatlabError('Unable to perform assignment because dot indexing is not supported for variables of this type.', 'MATLAB:dotAssignmentNotSupported');
      const sel = this._assignSelection(s, acc.args, scope);
      if (sel.positions.length !== 1) throw new MatlabError('Field assignment through ()-indexing needs exactly one struct element.');
      this._growContainer(s, sel);
      const pos = sel.positions[0];
      const name = this._fieldName(next, scope);
      const child = s.hasField(name) ? s.data[pos].get(name) : undefined;
      s.setField(pos, name, this._assignPath(child, child !== undefined && child._refs <= 1, chain, i + 2, value, scope));
      return s;
    }
    return this._parenAssign(cur, owned, acc.args, value, scope);
  }

  // x(i) = v, with x a matrix, cell array or struct array (or not yet defined).
  _parenAssign(cur, owned, args, value, scope) {
    const blank = cur === undefined || (cur instanceof Mat && cur.isEmpty && !(value instanceof Mat));
    const isDelete = value instanceof Mat && value.isEmpty && value.rows === 0 && value.cols === 0;
    if (cur instanceof Cell || (blank && value instanceof Cell)) {
      const c = cur instanceof Cell ? this._own(cur, owned) : Cell.empty();
      if (isDelete) return this._containerDelete(c, args, scope);
      if (!(value instanceof Cell)) throw new MatlabError(`Conversion to cell from ${valueClassName(value)} is not possible.`);
      return this._containerAssign(c, args, scope, value);
    }
    if (cur instanceof StructArray || (blank && value instanceof StructArray)) {
      const s = cur instanceof StructArray ? this._own(cur, owned) : new StructArray(0, 0, value.fieldNames);
      if (isDelete) return this._containerDelete(s, args, scope);
      if (!(value instanceof StructArray)) throw new MatlabError(`Conversion to struct from ${valueClassName(value)} is not possible.`);
      return this._containerAssign(s, args, scope, value);
    }
    if (cur !== undefined && !(cur instanceof Mat)) throw new MatlabError(`Unable to use ()-assignment on a ${valueClassName(cur)}.`);
    if (!(value instanceof Mat)) throw new MatlabError(`Conversion to double from ${valueClassName(value)} is not possible.`);
    let mat = cur === undefined ? Mat.empty() : (owned ? cur : cur.clone());
    if (value === mat) value = value.clone(); // e.g. x(end:-1:1) = x
    const fresh = mat.isEmpty && !mat.isChar && !mat.isLogical;
    mat = this.indexedAssign(mat, args, scope, value);
    if (fresh) {
      // Assigning into a new/empty variable takes on the value's class:
      // `s = []; s(1) = 'a'` yields a char, not a double.
      mat.isChar = value.isChar; mat.isLogical = value.isLogical;
    } else if (mat.isLogical && !value.isLogical) {
      // Storing numbers into a logical array converts them to logical.
      for (let k = 0; k < mat.numel; k++) {
        const nz = mat.re[k] !== 0 || (mat.isComplex && mat.im[k] !== 0);
        mat.re[k] = nz ? 1 : 0;
      }
      mat.im = null;
    }
    return mat;
  }

  // Subscripts past the second must address the (singleton) trailing
  // dimensions of a 2-D array: A(i, j, 1), A(:, :, end), A(i, j, :). Those
  // are dropped so the rest of indexing sees two subscripts; anything else
  // would need an N-D array.
  _dropTrailingSubscripts(argNodes, scope, assigning) {
    if (argNodes.length <= 2) return argNodes;
    for (let k = 2; k < argNodes.length; k++) {
      if (argNodes[k].type === 'FullColon') continue;
      this.endStack.push(1);
      let positions;
      try { positions = this._resolvePositions(this.evalExpr(argNodes[k], scope), 1); } finally { this.endStack.pop(); }
      if (positions.length === 1 && positions[0] === 0) continue;
      if (assigning) throw new MatlabError(`Assignment to index ${positions.map(p => p + 1).join(', ') || '(none)'} in position ${k + 1} would create an N-D array, which is not supported`);
      if (positions.some(p => p > 0)) throw new MatlabError(`Index in position ${k + 1} exceeds array bounds. Index must not exceed 1.`, 'MATLAB:badsubscript');
      throw new MatlabError(`Indexing in position ${k + 1} would create an N-D array, which is not supported`);
    }
    return argNodes.slice(0, 2);
  }

  // Resolves the target positions of an assignment into a cell/struct
  // array, and the (possibly larger) size the array must grow to.
  _assignSelection(arr, args, scope) {
    args = this._dropTrailingSubscripts(args, scope, true);
    if (args.length === 1) {
      let positions;
      if (args[0].type === 'FullColon') positions = Array.from({ length: arr.numel }, (_, k) => k);
      else {
        this.endStack.push(arr.numel);
        let idx;
        try { idx = this.evalExpr(args[0], scope); } finally { this.endStack.pop(); }
        positions = this._resolvePositions(idx, arr.numel);
      }
      const need = positions.length ? Math.max(...positions) + 1 : 0;
      let rows = arr.rows, cols = arr.cols;
      if (need > arr.numel) {
        if (arr.numel === 0 || arr.rows === 1) { rows = 1; cols = need; }
        else if (arr.cols === 1) { rows = need; cols = 1; }
        else throw new MatlabError('Attempt to grow a matrix along ambiguous dimension; use two subscripts instead.');
      }
      return { positions, rows, cols };
    }
    if (args.length === 2) {
      const sel = (node, size) => {
        if (node.type === 'FullColon') return Array.from({ length: size }, (_, k) => k);
        this.endStack.push(size);
        try { return this._resolvePositions(this.evalExpr(node, scope), size); } finally { this.endStack.pop(); }
      };
      const rowSel = sel(args[0], arr.rows), colSel = sel(args[1], arr.cols);
      const rows = Math.max(arr.rows, rowSel.length ? Math.max(...rowSel) + 1 : 0);
      const cols = Math.max(arr.cols, colSel.length ? Math.max(...colSel) + 1 : 0);
      const positions = [];
      for (const c of colSel) for (const r of rowSel) positions.push(c * rows + r);
      return { positions, rows, cols };
    }
    throw new MatlabError('Indexing with more than 2 subscripts is not supported (N-D arrays are out of scope)');
  }

  _growContainer(arr, sel) {
    if (sel.rows === arr.rows && sel.cols === arr.cols) return;
    const data = new Array(sel.rows * sel.cols);
    for (let c = 0; c < arr.cols; c++) for (let r = 0; r < arr.rows; r++) data[c * sel.rows + r] = arr.data[c * arr.rows + r];
    for (let k = 0; k < data.length; k++) {
      if (data[k] !== undefined) continue;
      if (arr instanceof Cell) data[k] = retain(Mat.empty());
      else { const el = arr.newElement(); for (const v of el.values()) retain(v); data[k] = el; }
    }
    arr.data = data; arr.rows = sel.rows; arr.cols = sel.cols;
  }

  _containerAssign(arr, args, scope, value) {
    const sel = this._assignSelection(arr, args, scope);
    const n = sel.positions.length;
    if (value.numel !== 1 && value.numel !== n) {
      throw new MatlabError(`Unable to perform assignment because the left and right sides have a different number of elements (${n} and ${value.numel}).`);
    }
    if (arr instanceof StructArray) {
      if (arr.numel === 0 && arr.fieldNames.length === 0) { for (const f of value.fieldNames) arr.addField(f); }
      const same = arr.fieldNames.length === value.fieldNames.length && value.fieldNames.every(f => arr.hasField(f));
      if (!same) throw new MatlabError('Subscripted assignment between dissimilar structures.');
    }
    this._growContainer(arr, sel);
    sel.positions.forEach((pos, k) => {
      const src = value.data[value.numel === 1 ? 0 : k];
      if (arr instanceof Cell) { arr.setLin(pos, src); return; }
      for (const f of arr.fieldNames) arr.setField(pos, f, src.get(f));
    });
    return arr;
  }

  _containerDelete(arr, args, scope) {
    args = this._dropTrailingSubscripts(args, scope, false);
    const drop = new Set();
    let rows, cols;
    if (args.length === 1) {
      const sel = this._readSelection(arr, args, scope);
      sel.positions.forEach(p => drop.add(p));
      const keep = arr.numel - drop.size;
      if (arr.cols === 1 && arr.rows !== 1) { rows = keep; cols = 1; } else { rows = 1; cols = keep; }
      if (drop.size === 0) return arr;
    } else if (args.length === 2) {
      const [rn, cn] = args;
      if (cn.type === 'FullColon' || rn.type === 'FullColon') {
        const byRow = cn.type === 'FullColon';
        this.endStack.push(byRow ? arr.rows : arr.cols);
        let idx;
        try { idx = this.evalExpr(byRow ? rn : cn, scope); } finally { this.endStack.pop(); }
        const which = new Set(this._resolvePositions(idx, byRow ? arr.rows : arr.cols));
        for (let c = 0; c < arr.cols; c++) for (let r = 0; r < arr.rows; r++) {
          if (which.has(byRow ? r : c)) drop.add(c * arr.rows + r);
        }
        rows = byRow ? arr.rows - which.size : arr.rows;
        cols = byRow ? arr.cols : arr.cols - which.size;
      } else {
        throw new MatlabError('A null assignment can have only one non-colon index.', 'MATLAB:null_assignment_multiple_indices');
      }
    } else throw new MatlabError('Indexing with more than 2 subscripts is not supported');
    const data = [];
    arr.data.forEach((el, k) => {
      if (!drop.has(k)) data.push(el);
      else if (arr instanceof Cell) release(el);
      else for (const v of el.values()) release(v);
    });
    arr.data = data; arr.rows = rows; arr.cols = cols;
    return arr;
  }

  displayAssignTarget(target, scope) {
    const name = target.type === 'Ident' ? target.name : this._flattenLValue(target).root;
    this.displayValue(name, scope.get(name));
  }

  // ---------------- expression evaluation ----------------

  evalExpr(node, scope) {
    const vals = this.evalForNargout(node, scope, 1);
    if (vals.length === 0) throw new MatlabError('Expression did not produce a value');
    return vals[0];
  }

  // Returns an array of values (length >= 1 for ordinary expressions; can
  // be 0 for void builtin calls like `plot(...)`, or >1 for multi-output
  // calls in a MultiAssign context).
  evalForNargout(node, scope, nargout) {
    switch (node.type) {
      case 'Num': return [Mat.scalar(node.value)];
      case 'ImagNum': return [Mat.complexScalar(0, node.value)];
      // The literal '' is 0x0, as in MATLAB (other empty text is 1x0).
      case 'Str': return [node.value === '' ? new Mat(0, 0, new Float64Array(0), null, { isChar: true }) : Mat.fromString(node.value)];
      case 'End': {
        if (this.endStack.length === 0) throw new MatlabError("'end' used outside of an indexing expression");
        return [Mat.scalar(this.endStack[this.endStack.length - 1])];
      }
      case 'Ident': {
        if (scope.has(node.name)) return [scope.get(node.name)];
        const locals = this._currentLocals();
        if ((locals && locals.has(node.name)) || this.funcTable.has(node.name) || this.builtins.has(node.name) || this.files.has(node.name + '.m')) {
          return this.callNamed(node.name, [], nargout, scope);
        }
        throw new MatlabError(`Unrecognized function or variable '${node.name}'.`, 'MATLAB:UndefinedFunction');
      }
      case 'Paren': return [this.evalExpr(node.expr, scope)];
      case 'Range': return [this.evalRange(node, scope)];
      case 'MatrixLit': return [this.evalMatrixLit(node, scope)];
      case 'CellLit': return [this.evalCellLit(node, scope)];
      case 'Unary': return [this.evalUnary(node, scope)];
      case 'Binary': return [this.evalBinary(node, scope)];
      case 'Transpose': return [this.evalTranspose(node, scope)];
      case 'AnonFunc': return [this.evalAnonFunc(node, scope)];
      case 'FuncHandle': return [new FunctionHandle({ name: node.name, locals: this._currentLocals() })];
      case 'Field':
      case 'DynField': {
        // s.name: one value per struct element (a comma-separated list
        // when s is a struct array).
        const base = this.evalExpr(node.target, scope);
        if (!(base instanceof StructArray)) throw new MatlabError('Dot indexing is not supported for variables of this type.');
        const name = this._fieldName(node.type === 'Field' ? { name: node.name } : { nameExpr: node.nameExpr }, scope);
        if (!base.hasField(name)) throw new MatlabError(`Unrecognized field name "${name}".`, 'MATLAB:nonExistentField');
        return base.data.map(el => el.get(name));
      }
      case 'CellIndex': {
        // c{...}: the selected contents, as a comma-separated list.
        const base = this.evalExpr(node.target, scope);
        if (!(base instanceof Cell)) throw new MatlabError('Brace indexing is not supported for variables of this type.');
        return this._readSelection(base, node.args, scope).positions.map(p => base.data[p]);
      }
      case 'FullColon': return [Mat.fromString(':')]; // `f(:)` passes the char ':' to a function
      case 'Index': return this.evalIndexOrCall(node, scope, nargout);
      default:
        throw new MatlabError(`Cannot evaluate expression of type ${node.type}`);
    }
  }

  evalRange(node, scope) {
    const start = this.evalExpr(node.start, scope).toScalarNumber();
    const stop = this.evalExpr(node.stop, scope).toScalarNumber();
    const step = node.step ? this.evalExpr(node.step, scope).toScalarNumber() : 1;
    return colonRange(start, step, stop);
  }

  // Evaluates an expression for use as a list item (function argument,
  // matrix/cell literal element): comma-separated lists like c{:} or
  // s.field on a struct array expand into several items.
  evalList(nodes, scope) {
    const out = [];
    for (const n of nodes) {
      if (isCsListNode(n)) out.push(...this.evalForNargout(n, scope, 1));
      else out.push(this.evalExpr(n, scope));
    }
    return out;
  }

  evalMatrixLit(node, scope) {
    if (node.rows.length === 0) return Mat.empty();
    // Horizontal concat within each row, then vertical concat across rows.
    return this.vconcat(node.rows.map(row => this.hconcat(this.evalList(row, scope))));
  }

  // {a, b; c, d}: every element is wrapped in its own cell (so a cell
  // element nests rather than concatenating), then rows are joined.
  evalCellLit(node, scope) {
    if (node.rows.length === 0) return Cell.empty();
    const rowCells = node.rows.map(row => this.hconcat(this.evalList(row, scope).map(v => new Cell(1, 1, [v]))));
    return this.vconcat(rowCells);
  }

  hconcat(vals) { return this._concat(vals, true); }
  vconcat(vals) { return this._concat(vals, false); }

  _concat(vals, horizontal) {
    if (vals.some(v => v instanceof Cell)) {
      // [c1, c2] joins cells; a non-cell item is wrapped as a 1x1 cell,
      // except [] which is dropped ([[], {1}] is {1}).
      return this._concatContainers(vals.filter(v => !(v instanceof Mat && v.rows === 0 && v.cols === 0)).map(v => v instanceof Cell ? v : new Cell(1, 1, [v])), horizontal);
    }
    if (vals.some(v => v instanceof StructArray)) {
      const items = vals.filter(v => !(v instanceof Mat && v.isEmpty));
      if (!items.every(v => v instanceof StructArray)) throw new MatlabError('Cannot concatenate a struct with a non-struct value.');
      return this._concatContainers(items, horizontal);
    }
    if (vals.some(v => v instanceof FunctionHandle)) {
      if (vals.length === 1) return vals[0];
      throw new MatlabError('Nonscalar arrays of function handles are not allowed; use cell arrays instead.');
    }
    return horizontal ? this._hconcatMats(vals) : this._vconcatMats(vals);
  }

  _concatContainers(arrs, horizontal) {
    const isCell = arrs.length === 0 || arrs[0] instanceof Cell;
    const all = arrs;
    arrs = arrs.filter(a => !(a.rows === 0 && a.cols === 0));
    if (arrs.length === 0) return isCell ? Cell.empty() : all[0];
    if (arrs.length === 1) return arrs[0];
    const first = arrs[0];
    if (!isCell) {
      for (const a of arrs) {
        const same = a.fieldNames.length === first.fieldNames.length && a.fieldNames.every(f => first.hasField(f));
        if (!same) throw new MatlabError('Concatenation of structures requires the same field names.');
      }
    }
    let rows, cols;
    if (horizontal) {
      rows = first.rows;
      if (arrs.some(a => a.rows !== rows)) throw new MatlabError('Dimensions of arrays being concatenated are not consistent.');
      cols = arrs.reduce((n, a) => n + a.cols, 0);
    } else {
      cols = first.cols;
      if (arrs.some(a => a.cols !== cols)) throw new MatlabError('Dimensions of arrays being concatenated are not consistent.');
      rows = arrs.reduce((n, a) => n + a.rows, 0);
    }
    const data = new Array(rows * cols);
    let off = 0;
    for (const a of arrs) {
      for (let c = 0; c < a.cols; c++) for (let r = 0; r < a.rows; r++) {
        const dst = horizontal ? (off + c) * rows + r : c * rows + off + r;
        const el = a.data[c * a.rows + r];
        data[dst] = isCell ? el : new Map(first.fieldNames.map(f => [f, el.get(f)]));
      }
      off += horizontal ? a.cols : a.rows;
    }
    return isCell ? new Cell(rows, cols, data) : new StructArray(rows, cols, first.fieldNames, data, first.classOverride);
  }

  _hconcatMats(mats) {
    const all = mats;
    mats = mats.filter(m => !(m.isEmpty && m.rows === 0 && m.cols === 0));
    if (mats.length === 0) return emptyConcat(all);
    const rows = mats[0].rows;
    for (const m of mats) if (m.rows !== rows) throw new MatlabError('Dimensions of arrays being concatenated are not consistent.', 'MATLAB:catenate:dimensionMismatch');
    const cols = mats.reduce((s, m) => s + m.cols, 0);
    const anyComplex = mats.some(m => m.isComplex);
    const re = new Float64Array(rows * cols);
    const im = anyComplex ? new Float64Array(rows * cols) : null;
    let colOff = 0;
    for (const m of mats) {
      for (let c = 0; c < m.cols; c++) {
        for (let r = 0; r < rows; r++) {
          const src = c * m.rows + r, dst = (colOff + c) * rows + r;
          re[dst] = m.re[src];
          if (im) im[dst] = m.isComplex ? m.im[src] : 0;
        }
      }
      colOff += m.cols;
    }
    return charConcat(new Mat(rows, cols, re, im, concatClass(mats)));
  }

  _vconcatMats(mats) {
    const all = mats;
    mats = mats.filter(m => !(m.isEmpty && m.rows === 0 && m.cols === 0));
    if (mats.length === 0) return emptyConcat(all);
    const cols = mats[0].cols;
    for (const m of mats) if (m.cols !== cols) throw new MatlabError('Dimensions of arrays being concatenated are not consistent.', 'MATLAB:catenate:dimensionMismatch');
    const rows = mats.reduce((s, m) => s + m.rows, 0);
    const anyComplex = mats.some(m => m.isComplex);
    const re = new Float64Array(rows * cols);
    const im = anyComplex ? new Float64Array(rows * cols) : null;
    let rowOff = 0;
    for (const m of mats) {
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < m.rows; r++) {
          const src = c * m.rows + r, dst = c * rows + (rowOff + r);
          re[dst] = m.re[src];
          if (im) im[dst] = m.isComplex ? m.im[src] : 0;
        }
      }
      rowOff += m.rows;
    }
    return charConcat(new Mat(rows, cols, re, im, concatClass(mats)));
  }

  evalUnary(node, scope) {
    const v = this.evalExpr(node.expr, scope);
    requireMatOperand(v, node.op);
    if (node.op === '+') return v.isChar || v.isLogical ? Mat.mapElementwise(v, (r, i) => [r, i]) : v; // +'ab' is double
    if (node.op === '-') return Mat.mapElementwise(v, (r, i) => [-r, -i]);
    if (node.op === '~') {
      const out = Mat.mapElementwise(v, (r, i) => {
        return [truthOf(r, i) ? 0 : 1, 0];
      });
      out.isLogical = true;
      return out;
    }
    throw new MatlabError(`Unknown unary operator ${node.op}`);
  }

  evalTranspose(node, scope) {
    const v = this.evalExpr(node.expr, scope);
    if (v instanceof Cell || v instanceof StructArray) return transposeContainer(v);
    requireMatOperand(v, "'");
    const re = new Float64Array(v.numel);
    const im = v.isComplex ? new Float64Array(v.numel) : null;
    for (let r = 0; r < v.rows; r++) {
      for (let c = 0; c < v.cols; c++) {
        const src = c * v.rows + r, dst = r * v.cols + c;
        re[dst] = v.re[src];
        if (im) im[dst] = node.conjugate ? -v.im[src] : v.im[src];
      }
    }
    return new Mat(v.cols, v.rows, re, im, { isChar: v.isChar, isLogical: v.isLogical });
  }

  evalAnonFunc(node, scope) {
    // Capture free *variables* by value at creation time. Function names
    // are not captured as values (that would turn `pi` into a handle
    // rather than 3.14159); they resolve normally at call time, with the
    // creating file's local functions remembered in `locals`.
    const closure = new Map();
    const paramSet = new Set(node.params);
    const free = new Set();
    collectFreeIdents(node.body, paramSet, free);
    for (const name of free) {
      if (scope.has(name)) closure.set(name, retain(scope.get(name)));
    }
    return new FunctionHandle({ params: node.params, body: node.body, closure, source: node.source ?? null, locals: this._currentLocals() });
  }

  evalBinary(node, scope) {
    const op = node.op;
    if (op === '&&') {
      const l = this.evalExpr(node.left, scope);
      if (!this._truthy(l)) return Mat.logicalScalar(false);
      const r = this.evalExpr(node.right, scope);
      return Mat.logicalScalar(this._truthy(r));
    }
    if (op === '||') {
      const l = this.evalExpr(node.left, scope);
      if (this._truthy(l)) return Mat.logicalScalar(true);
      const r = this.evalExpr(node.right, scope);
      return Mat.logicalScalar(this._truthy(r));
    }
    const a = this.evalExpr(node.left, scope);
    const b = this.evalExpr(node.right, scope);
    requireMatOperand(a, op);
    requireMatOperand(b, op);
    return this.reportWarnings(applyBinaryOp(op, a, b));
  }

  // ---------------- indexing & calls ----------------

  evalIndexOrCall(node, scope, nargout) {
    // Disambiguate: variable indexing takes priority over a same-named
    // function, matching real MATLAB name resolution.
    if (node.target.type === 'Ident') {
      const name = node.target.name;
      if (scope.has(name)) {
        const base = scope.get(name);
        if (base instanceof FunctionHandle) return this.callHandle(base, this.evalList(node.args, scope), nargout, scope);
        return [this.indexValue(base, node.args, scope)];
      }
      return this.callNamed(name, this.evalList(node.args, scope), nargout, scope);
    }
    // Chained call, e.g. handle-returning expression called immediately: g(x)(y)
    const target = this.evalExpr(node.target, scope);
    if (target instanceof FunctionHandle) return this.callHandle(target, this.evalList(node.args, scope), nargout, scope);
    return [this.indexValue(target, node.args, scope)];
  }

  // v(...) for any indexable value: a matrix gives a matrix, a cell array
  // a (sub-)cell array, a struct array a (sub-)struct array.
  indexValue(base, argNodes, scope) {
    if (base instanceof Mat) return this.indexRead(base, argNodes, scope);
    if (base instanceof Cell || base instanceof StructArray) {
      const sel = this._readSelection(base, argNodes, scope);
      if (base instanceof Cell) return new Cell(sel.rows, sel.cols, sel.positions.map(p => base.data[p]));
      return new StructArray(sel.rows, sel.cols, base.fieldNames, sel.positions.map(p => new Map(base.data[p])), base.classOverride);
    }
    throw new MatlabError(`Cannot index into a ${valueClassName(base)}`);
  }

  // Positions (0-based, column-major) selected by a read index into a
  // cell/struct array, plus the shape of the result.
  _readSelection(arr, argNodes, scope) {
    if (argNodes.length === 0) throw new MatlabError('Empty index expression is not supported');
    argNodes = this._dropTrailingSubscripts(argNodes, scope, false);
    if (argNodes.length === 1) {
      const node = argNodes[0];
      if (node.type === 'FullColon') return { positions: Array.from({ length: arr.numel }, (_, k) => k), rows: arr.numel, cols: 1 };
      this.endStack.push(arr.numel);
      let idx;
      try { idx = this.evalExpr(node, scope); } finally { this.endStack.pop(); }
      const positions = this._resolvePositions(idx, arr.numel);
      for (const p of positions) if (p >= arr.numel) throw new MatlabError(`Index exceeds the number of array elements. Index must not exceed ${arr.numel}.`, 'MATLAB:badsubscript');
      const [rows, cols] = linearResultShape(arr, idx, positions.length);
      return { positions, rows, cols };
    }
    if (argNodes.length === 2) {
      this.endStack.push(arr.rows);
      let rowSel;
      try { rowSel = this._resolveDimSelector(argNodes[0], scope, arr.rows); } finally { this.endStack.pop(); }
      this.endStack.push(arr.cols);
      let colSel;
      try { colSel = this._resolveDimSelector(argNodes[1], scope, arr.cols); } finally { this.endStack.pop(); }
      const positions = [];
      for (const c of colSel) for (const r of rowSel) {
        if (r >= arr.rows || c >= arr.cols) throw subscriptError(r >= arr.rows ? 1 : 2, r >= arr.rows ? arr.rows : arr.cols);
        positions.push(c * arr.rows + r);
      }
      return { positions, rows: rowSel.length, cols: colSel.length };
    }
    throw new MatlabError('Indexing with more than 2 subscripts is not supported (N-D arrays are out of scope)');
  }

  callNamed(name, argValues, nargout, callerScope) {
    const locals = this._currentLocals();
    if (locals && locals.has(name)) {
      return this.callUserFunction(locals.get(name), argValues, nargout);
    }
    if (this.funcTable.has(name)) {
      return this.callUserFunction(this.funcTable.get(name), argValues, nargout);
    }
    if (this.builtins.has(name)) {
      const spec = this.builtins.get(name);
      if (spec.minArgs && argValues.length < spec.minArgs) throw new MatlabError('Not enough input arguments.', 'MATLAB:minrhs');
      if (spec.maxArgs !== undefined && argValues.length > spec.maxArgs) throw new MatlabError('Too many input arguments.', 'MATLAB:TooManyInputs');
      if (spec.numericArgs) {
        const checked = spec.numericArgs === 'first' ? argValues.slice(0, 1) : argValues;
        const odd = checked.find(a => !(a instanceof Mat));
        if (odd) throw new MatlabError(`Undefined function '${name}' for input arguments of type '${valueClassName(odd)}'.`, 'MATLAB:UndefinedFunction');
      }
      const result = runBuiltin(name, spec.fn, argValues, nargout, this._builtinCtx(callerScope));
      if (result === undefined) return [];
      // MATLAB stores a result with an all-zero imaginary part as real
      // (complex() is the exception that keeps it). Only new arrays are
      // changed: one with references is stored somewhere (an argument passed
      // through, a struct field) and is left alone.
      if (name !== 'complex') for (const v of result) if (v instanceof Mat && v.im && v._refs === 0 && !argValues.includes(v) && v.im.every(x => x === 0)) v.im = null;
      return result;
    }
    const mfile = this.loadMFile(name);
    if (mfile && mfile.kind === 'function') {
      return this.callUserFunction(mfile.primary, argValues, nargout);
    }
    if (mfile) {
      // Bare script-name call (e.g. `>> projectile`), matching MATLAB's
      // behavior of running a same-named .m script found on the path.
      if (argValues.length > 0) throw new MatlabError(`'${name}' is a script and cannot take input arguments`);
      this.runProgram(mfile.ast, callerScope || this.workspace);
      return [];
    }
    throw new MatlabError(`Unrecognized function or variable '${name}'.`, 'MATLAB:UndefinedFunction');
  }

  callHandle(fh, argValues, nargout, callerScope) {
    if (fh.builtin) return runBuiltin(fh.name || 'builtin', fh.builtin, argValues, nargout, this._builtinCtx(callerScope));
    // Resolve names in the context of the file the handle was created in,
    // so a handle to a local subfunction keeps working outside that file.
    this.localFnStack.push(fh.locals || null);
    try {
      if (fh.name) return this.callNamed(fh.name, argValues, nargout, callerScope);
      // anonymous function
      const scope = new Scope(this, { isFunction: true, funcName: '<anonymous>' });
      try {
        for (const [k, v] of fh.closure.entries()) scope.set(k, v);
        bindParams(scope, fh.params, argValues, 'anonymous function');
        // Forward nargout so `[a,b] = f()` works when the body is itself a
        // multi-output call, e.g. f = @() deal(1,2).
        return this.evalForNargout(fh.body, scope, nargout);
      } finally {
        scope.releaseAll();
      }
    } finally {
      this.localFnStack.pop();
    }
  }

  callFunctionValue(fh, argValues, nargout, callerScope) {
    // Public helper used by builtins like feval/arrayfun.
    if (fh instanceof FunctionHandle) return this.callHandle(fh, argValues, nargout, callerScope || this.workspace);
    throw new MatlabError('Value is not callable');
  }

  callUserFunction(def, argValues, nargout) {
    this.callDepth++;
    if (this.callDepth > MAX_RECURSION) { this.callDepth--; throw new MatlabError(`Maximum recursion limit of ${MAX_RECURSION} reached`); }
    this.localFnStack.push(def.locals || null);
    const scope = new Scope(this, { isFunction: true, funcName: def.name });
    try {
      bindParams(scope, def.params, argValues, `'${def.name}'`);
      scope.set('nargout', Mat.scalar(Math.max(nargout, 0)));
      try {
        this.execBlock(def.body, scope);
      } catch (e) {
        if (!(e instanceof ReturnSignal)) throw e;
      }
      // A trailing `varargout` output (a cell) supplies any remaining outputs.
      const outs = def.outputs;
      const hasVarargout = outs.length > 0 && outs[outs.length - 1] === 'varargout';
      const fixed = hasVarargout ? outs.slice(0, -1) : outs;
      const outputs = [];
      for (const outName of fixed) {
        if (scope.vars.has(outName)) outputs.push(scope.vars.get(outName));
        else break; // later outputs simply not requested/assigned
      }
      if (hasVarargout && outputs.length === fixed.length && scope.vars.has('varargout')) {
        const vo = scope.vars.get('varargout');
        if (!(vo instanceof Cell)) throw new MatlabError('varargout must be a cell array');
        outputs.push(...vo.data);
      }
      const required = Math.max(nargout, 1);
      if (nargout >= 1 && outputs.length < required && (outputs.length < fixed.length || hasVarargout)) {
        const missing = outputs.length < fixed.length ? fixed[outputs.length] : 'varargout';
        throw new MatlabError(`Output argument '${missing}' was not assigned during the call to '${def.name}'`);
      }
      return outputs;
    } catch (e) {
      // The JavaScript stack can run out before MAX_RECURSION is reached
      // (each MATLAB call uses many JS frames); report that as a MATLAB
      // error rather than an internal RangeError.
      if (e instanceof RangeError) throw new MatlabError(`Maximum recursion depth exceeded in '${def.name}' (out of JavaScript stack space)`);
      throw e;
    } finally {
      scope.releaseAll();
      this.localFnStack.pop();
      this.callDepth--;
    }
  }

  _builtinCtx(callerScope) {
    return {
      interp: this,
      host: this.host,
      scope: callerScope || this.workspace,
    };
  }

  // ---- indexing (read) ----

  indexRead(mat, argNodes, scope) {
    if (!(mat instanceof Mat)) return this.indexValue(mat, argNodes, scope);
    if (argNodes.length === 0) throw new MatlabError('Empty index expression is not supported');
    argNodes = this._dropTrailingSubscripts(argNodes, scope, false);
    if (argNodes.length === 1) return this.indexReadLinear(mat, argNodes[0], scope);
    if (argNodes.length === 2) return this.indexRead2D(mat, argNodes[0], argNodes[1], scope);
    throw new MatlabError('Indexing with more than 2 subscripts is not supported (N-D arrays are out of scope)');
  }

  indexReadLinear(mat, argNode, scope) {
    if (argNode.type === 'FullColon') {
      const re = Float64Array.from(mat.re);
      const im = mat.isComplex ? Float64Array.from(mat.im) : null;
      return new Mat(mat.numel, 1, re, im, { isChar: mat.isChar, isLogical: mat.isLogical });
    }
    this.endStack.push(mat.numel);
    let idxMat;
    try { idxMat = this.evalExpr(argNode, scope); } finally { this.endStack.pop(); }
    const positions = this._resolvePositions(idxMat, mat.numel);
    const re = new Float64Array(positions.length);
    const im = mat.isComplex ? new Float64Array(positions.length) : null;
    for (let k = 0; k < positions.length; k++) {
      const p = positions[k];
      if (p < 0 || p >= mat.numel) throw new MatlabError(`Index exceeds the number of array elements. Index must not exceed ${mat.numel}.`, 'MATLAB:badsubscript');
      re[k] = mat.re[p];
      if (im) im[k] = mat.im[p];
    }
    const [rows, cols] = linearResultShape(mat, idxMat, positions.length);
    return new Mat(rows, cols, re, im, { isChar: mat.isChar, isLogical: mat.isLogical });
  }

  indexRead2D(mat, rowNode, colNode, scope) {
    this.endStack.push(mat.rows);
    let rowSel;
    try { rowSel = this._resolveDimSelector(rowNode, scope, mat.rows); } finally { this.endStack.pop(); }
    this.endStack.push(mat.cols);
    let colSel;
    try { colSel = this._resolveDimSelector(colNode, scope, mat.cols); } finally { this.endStack.pop(); }
    const rows = rowSel.length, cols = colSel.length;
    const re = new Float64Array(rows * cols);
    const im = mat.isComplex ? new Float64Array(rows * cols) : null;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const rr = rowSel[r], cc = colSel[c];
        if (rr < 0 || rr >= mat.rows || cc < 0 || cc >= mat.cols) throw subscriptError(rr >= mat.rows ? 1 : 2, rr >= mat.rows ? mat.rows : mat.cols);
        const src = cc * mat.rows + rr, dst = c * rows + r;
        re[dst] = mat.re[src];
        if (im) im[dst] = mat.im[src];
      }
    }
    return new Mat(rows, cols, re, im, { isChar: mat.isChar, isLogical: mat.isLogical });
  }

  _resolveDimSelector(node, scope, dimSize) {
    if (node.type === 'FullColon') return Array.from({ length: dimSize }, (_, k) => k);
    const idxMat = this.evalExpr(node, scope);
    return this._resolvePositions(idxMat, dimSize);
  }

  _resolvePositions(idxMat, dimSize) {
    if (idxMat.isLogical) {
      const positions = [];
      for (let k = 0; k < idxMat.numel; k++) if (idxMat.re[k] !== 0) positions.push(k);
      return positions;
    }
    const positions = [];
    for (let k = 0; k < idxMat.numel; k++) {
      const v = idxMat.re[k];
      if (!Number.isInteger(v) || v < 1) throw new MatlabError('Array indices must be positive integers or logical values.', 'MATLAB:badsubscript');
      positions.push(v - 1);
    }
    return positions;
  }

  // ---- indexing (assignment, incl. growth & deletion) ----

  indexedAssign(mat, argNodes, scope, rhs) {
    argNodes = this._dropTrailingSubscripts(argNodes, scope, true);
    if (argNodes.length === 1) return this._assignLinear(mat, argNodes[0], scope, rhs);
    if (argNodes.length === 2) return this._assign2D(mat, argNodes[0], argNodes[1], scope, rhs);
    throw new MatlabError('Indexed assignment with more than 2 subscripts is not supported');
  }

  _assignLinear(mat, argNode, scope, rhs) {
    const isFullColon = argNode.type === 'FullColon';
    this.endStack.push(mat.numel);
    let idxMat = null;
    try { if (!isFullColon) idxMat = this.evalExpr(argNode, scope); } finally { this.endStack.pop(); }

    if (rhs.isEmpty && !isFullColon) {
      const positions = new Set(this._resolvePositions(idxMat, mat.numel));
      if (positions.size === 0) return mat;
      for (const p of positions) if (p >= mat.numel) throw new MatlabError('Matrix index is out of range for deletion.', 'MATLAB:matrix:indexOutOfRangeForDeletion');
      return this._deleteLinear(mat, positions);
    }

    let positions = isFullColon
      ? Array.from({ length: mat.numel }, (_, k) => k)
      : this._resolvePositions(idxMat, mat.numel);

    const maxPos = positions.length ? Math.max(...positions) : -1;
    if (maxPos >= mat.numel) {
      if (!mat.isVector && mat.numel !== 0) {
        throw new MatlabError('Attempt to grow array along ambiguous dimension.', 'MATLAB:indexed_matrix_cannot_be_resized');
      }
      mat = this._growVector(mat, maxPos + 1);
    }
    if (rhs.numel === 1) {
      const rre = rhs.re[0], rim = rhs.isComplex ? rhs.im[0] : 0;
      for (const p of positions) mat.setLin(p, rre, rim);
    } else if (rhs.numel === positions.length) {
      for (let k = 0; k < positions.length; k++) {
        mat.setLin(positions[k], rhs.re[k], rhs.isComplex ? rhs.im[k] : 0);
      }
    } else {
      throw new MatlabError('Unable to perform assignment because the left and right sides have a different number of elements.', 'MATLAB:matrix:assignmentNumelMismatch');
    }
    return mat;
  }

  _assign2D(mat, rowNode, colNode, scope, rhs) {
    const rowFull = rowNode.type === 'FullColon', colFull = colNode.type === 'FullColon';
    this.endStack.push(mat.rows);
    let rowIdxMat = null;
    try { if (!rowFull) rowIdxMat = this.evalExpr(rowNode, scope); } finally { this.endStack.pop(); }
    this.endStack.push(mat.cols);
    let colIdxMat = null;
    try { if (!colFull) colIdxMat = this.evalExpr(colNode, scope); } finally { this.endStack.pop(); }

    if (rhs.isEmpty) {
      if (rowFull && !colFull) {
        const cols = new Set(this._resolvePositions(colIdxMat, mat.cols));
        return this._deleteCols(mat, cols);
      }
      if (colFull && !rowFull) {
        const rows = new Set(this._resolvePositions(rowIdxMat, mat.rows));
        return this._deleteRows(mat, rows);
      }
      throw new MatlabError('A null assignment can have only one non-colon index.', 'MATLAB:null_assignment_multiple_indices');
    }

    let rowSel = rowFull ? Array.from({ length: mat.rows }, (_, k) => k) : this._resolvePositions(rowIdxMat, mat.rows);
    let colSel = colFull ? Array.from({ length: mat.cols }, (_, k) => k) : this._resolvePositions(colIdxMat, mat.cols);

    const needRows = rowSel.length ? Math.max(...rowSel) + 1 : 0;
    const needCols = colSel.length ? Math.max(...colSel) + 1 : 0;
    if (needRows > mat.rows || needCols > mat.cols) {
      mat = this._growMatrix(mat, Math.max(mat.rows, needRows), Math.max(mat.cols, needCols));
    }

    const total = rowSel.length * colSel.length;
    if (rhs.numel === 1) {
      const rre = rhs.re[0], rim = rhs.isComplex ? rhs.im[0] : 0;
      for (const cc of colSel) for (const rr of rowSel) mat.set2(rr, cc, rre, rim);
    } else if (rhs.numel === total) {
      let k = 0;
      for (const cc of colSel) {
        for (const rr of rowSel) {
          mat.set2(rr, cc, rhs.re[k], rhs.isComplex ? rhs.im[k] : 0);
          k++;
        }
      }
    } else {
      throw new MatlabError(`Unable to perform assignment because the size of the left side is ${rowSel.length}-by-${colSel.length} and the size of the right side is ${rhs.rows}-by-${rhs.cols}.`, 'MATLAB:subsassigndimmismatch');
    }
    return mat;
  }

  _growVector(mat, newLen) {
    const asRow = mat.numel === 0 || mat.rows === 1;
    const rows = asRow ? 1 : newLen, cols = asRow ? newLen : 1;
    const grown = Mat.zeros(rows, cols);
    for (let k = 0; k < mat.numel; k++) grown.re[k] = mat.re[k];
    if (mat.isComplex) { grown.im = new Float64Array(rows * cols); for (let k = 0; k < mat.numel; k++) grown.im[k] = mat.im[k]; }
    grown.isChar = mat.isChar; grown.isLogical = mat.isLogical;
    return grown;
  }

  _growMatrix(mat, newRows, newCols) {
    const grown = Mat.zeros(newRows, newCols);
    if (mat.isComplex) grown.im = new Float64Array(newRows * newCols);
    for (let c = 0; c < mat.cols; c++) {
      for (let r = 0; r < mat.rows; r++) {
        grown.set2(r, c, mat.re[c * mat.rows + r], mat.isComplex ? mat.im[c * mat.rows + r] : 0);
      }
    }
    grown.isChar = mat.isChar; grown.isLogical = mat.isLogical;
    return grown;
  }

  _deleteLinear(mat, positionsSet) {
    const keep = [];
    for (let k = 0; k < mat.numel; k++) if (!positionsSet.has(k)) keep.push(k);
    // A column vector stays a column; anything else (a matrix too) becomes a row.
    const asRow = !(mat.cols === 1 && mat.rows !== 1);
    const rows = asRow ? 1 : keep.length, cols = asRow ? keep.length : 1;
    const re = new Float64Array(keep.length);
    const im = mat.isComplex ? new Float64Array(keep.length) : null;
    keep.forEach((p, i) => { re[i] = mat.re[p]; if (im) im[i] = mat.im[p]; });
    return new Mat(rows, cols, re, im, { isChar: mat.isChar, isLogical: mat.isLogical });
  }

  _deleteRows(mat, rowsSet) {
    const keepRows = [];
    for (let r = 0; r < mat.rows; r++) if (!rowsSet.has(r)) keepRows.push(r);
    const re = new Float64Array(keepRows.length * mat.cols);
    const im = mat.isComplex ? new Float64Array(keepRows.length * mat.cols) : null;
    for (let c = 0; c < mat.cols; c++) {
      keepRows.forEach((r, i) => {
        re[c * keepRows.length + i] = mat.re[c * mat.rows + r];
        if (im) im[c * keepRows.length + i] = mat.im[c * mat.rows + r];
      });
    }
    return new Mat(keepRows.length, mat.cols, re, im, { isChar: mat.isChar, isLogical: mat.isLogical });
  }

  _deleteCols(mat, colsSet) {
    const keepCols = [];
    for (let c = 0; c < mat.cols; c++) if (!colsSet.has(c)) keepCols.push(c);
    const re = new Float64Array(mat.rows * keepCols.length);
    const im = mat.isComplex ? new Float64Array(mat.rows * keepCols.length) : null;
    keepCols.forEach((c, i) => {
      for (let r = 0; r < mat.rows; r++) {
        re[i * mat.rows + r] = mat.re[c * mat.rows + r];
        if (im) im[i * mat.rows + r] = mat.im[c * mat.rows + r];
      }
    });
    return new Mat(mat.rows, keepCols.length, re, im, { isChar: mat.isChar, isLogical: mat.isLogical });
  }

  // ---------------- display ----------------

  displayValue(name, val) {
    if (this.host.formatAssignment) { this.print(this.host.formatAssignment(name, val)); return; }
    this.print(`${name} =\n${formatValue(val, this.displayFormat)}\n`);
  }
}

// MATLAB's own default limit (get(0,'RecursionLimit')) is 500. In practice
// the browser's JS stack may run out first (a few hundred levels); that
// case is caught and reported in callUserFunction.
const MAX_RECURSION = 500;

function requireMatOperand(v, op) {
  if (!(v instanceof Mat)) {
    throw new MatlabError(`Operator '${op}' is not supported for operands of type '${valueClassName(v)}'.`);
  }
}

export function transposeContainer(v) {
  const data = new Array(v.numel);
  for (let r = 0; r < v.rows; r++) for (let c = 0; c < v.cols; c++) {
    const el = v.data[c * v.rows + r];
    data[r * v.cols + c] = v instanceof Cell ? el : new Map(el);
  }
  return v instanceof Cell ? new Cell(v.cols, v.rows, data) : new StructArray(v.cols, v.rows, v.fieldNames, data, v.classOverride);
}

// Nodes whose value is a comma-separated list (zero or more values).
function isCsListNode(node) {
  return node.type === 'CellIndex' || node.type === 'Field' || node.type === 'DynField';
}

// Class of a matrix concatenation: char wins (['abc' 10] is a char row),
// logical only if every piece is logical, otherwise double.
// [] of empty pieces: char if any piece is char ([''] is ''), else [].
function emptyConcat(mats) {
  return mats.some(m => m.isChar) ? new Mat(0, 0, new Float64Array(0), null, { isChar: true }) : Mat.empty();
}

// A concatenated array of class char holds character codes: numbers
// joined with text are truncated and clamped to 0..65535, NaN to 0.
function charConcat(m) {
  if (!m.isChar) return m;
  if (m.im) throw new MatlabError('Complex values cannot be converted to chars', 'MATLAB:noConversionComplexToChar');
  for (let k = 0; k < m.re.length; k++) { const x = m.re[k]; m.re[k] = Number.isNaN(x) ? 0 : Math.min(65535, Math.max(0, Math.trunc(x))); }
  return m;
}

function concatClass(mats) {
  return { isChar: mats.some(m => m.isChar), isLogical: mats.length > 0 && mats.every(m => m.isLogical) };
}

// Shape of A(idx) for a single (linear) index: a logical mask gives a
// column (or a row, for a row vector A); for a vector A the result keeps
// A's orientation; otherwise it takes the index's shape.
function linearResultShape(arr, idx, n) {
  if (idx.isLogical) return arr.rows === 1 && arr.numel !== 1 ? [1, n] : (idx.rows === 1 && arr.numel === 1 ? [1, n] : [n, 1]);
  // A matrix of indices shapes the result, even for a vector source.
  if (!idx.isVector && !idx.isEmpty) return [idx.rows, idx.cols];
  if (arr.isVector && arr.numel !== 1) return arr.rows === 1 ? [1, n] : [n, 1];
  if (idx.isVector) return idx.rows === 1 ? [1, n] : [n, 1];
  return [idx.rows, idx.cols];
}

// Binds call arguments to parameter names, collecting extras into a
// trailing `varargin` cell, and sets nargin.
function bindParams(scope, params, args, what) {
  const hasVarargin = params.length > 0 && params[params.length - 1] === 'varargin';
  const fixed = hasVarargin ? params.length - 1 : params.length;
  if (args.length > fixed && !hasVarargin) throw new MatlabError('Too many input arguments.', 'MATLAB:TooManyInputs');
  for (let i = 0; i < Math.min(fixed, args.length); i++) scope.set(params[i], args[i]);
  if (hasVarargin) {
    const extra = args.slice(fixed);
    scope.set('varargin', new Cell(1, extra.length, extra));
  }
  scope.set('nargin', Mat.scalar(args.length));
}

// MATLAB's error for a subscript past the end of dimension `position`.
function subscriptError(position, limit) {
  return new MatlabError(`Index in position ${position} exceeds array bounds. Index must not exceed ${limit}.`, 'MATLAB:badsubscript');
}

// Calls a builtin's implementation. A JavaScript exception escaping it
// (a TypeError from an argument the code didn't expect, say) becomes a
// MatlabError: MATLAB's "Undefined function 'sin' for input arguments of
// type 'cell'." when a cell, struct or function handle was passed, "Not
// enough input arguments." when there were none, or an
// error flagged `internal` (a bug in the builtin; the robustness tests
// fail on these). Control-flow signals, recursion overflow and parse
// errors from eval & co. pass through unchanged.
function runBuiltin(name, fn, args, nargout, ctx) {
  try {
    return fn(args, nargout, ctx);
  } catch (e) {
    if (!(e instanceof Error) || e instanceof MatlabError || isStackOverflow(e) || e.name === 'ParseError' || e.name === 'LexError') throw e;
    if (args.length === 0) throw new MatlabError('Not enough input arguments.', 'MATLAB:minrhs');
    const odd = args.find(a => !(a instanceof Mat));
    if (odd) {
      throw new MatlabError(`Undefined function '${name}' for input arguments of type '${valueClassName(odd)}'.`, 'MATLAB:UndefinedFunction');
    }
    const err = new MatlabError(`${name}: internal error (${e.message})`, 'MatWeb:internalError');
    err.internal = true;
    err.cause = e;
    throw err;
  }
}

function isStackOverflow(e) {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

// Any error thrown while running user code, as a MatlabError (so try/catch
// and the console can report it uniformly).
export function toMatlabError(e) {
  if (e instanceof MatlabError) return e;
  if (isStackOverflow(e)) return new MatlabError('Maximum recursion depth exceeded (out of JavaScript stack space)', 'MATLAB:recursionLimit');
  if (e && (e.name === 'ParseError' || e.name === 'LexError')) return new MatlabError(e.message, 'MATLAB:parse');
  return new MatlabError(e && e.message ? e.message : String(e));
}

// ---------------- free binary operator dispatch ----------------

export function applyBinaryOp(op, a, b) {
  switch (op) {
    case '+': return Mat.broadcastBinary(a, b, C.cadd);
    case '-': return Mat.broadcastBinary(a, b, C.csub);
    case '.*': return Mat.broadcastBinary(a, b, C.cmul);
    case './': return Mat.broadcastBinary(a, b, C.cdiv);
    case '.\\': return Mat.broadcastBinary(a, b, (ar, ai, br, bi) => C.cdiv(br, bi, ar, ai));
    case '.^': return Mat.broadcastBinary(a, b, C.cpow);
    case '==': return taggedLogical(Mat.broadcastBinary(a, b, (ar, ai, br, bi) => [(ar === br && ai === bi) ? 1 : 0, 0]));
    case '~=': return taggedLogical(Mat.broadcastBinary(a, b, (ar, ai, br, bi) => [(ar !== br || ai !== bi) ? 1 : 0, 0]));
    case '<': return taggedLogical(Mat.broadcastBinary(a, b, (ar, _ai, br, _bi) => [(ar < br) ? 1 : 0, 0]));
    case '>': return taggedLogical(Mat.broadcastBinary(a, b, (ar, _ai, br, _bi) => [(ar > br) ? 1 : 0, 0]));
    case '<=': return taggedLogical(Mat.broadcastBinary(a, b, (ar, _ai, br, _bi) => [(ar <= br) ? 1 : 0, 0]));
    case '>=': return taggedLogical(Mat.broadcastBinary(a, b, (ar, _ai, br, _bi) => [(ar >= br) ? 1 : 0, 0]));
    case '&': return taggedLogical(Mat.broadcastBinary(a, b, (ar, ai, br, bi) => [(truthOf(ar, ai) & truthOf(br, bi)) ? 1 : 0, 0]));
    case '|': return taggedLogical(Mat.broadcastBinary(a, b, (ar, ai, br, bi) => [(truthOf(ar, ai) | truthOf(br, bi)) ? 1 : 0, 0]));
    case '*': return matMultiply(a, b);
    case '/': return matRightDivide(a, b);
    case '\\': return matLeftDivide(a, b);
    case '^': return matPower(a, b);
    default: throw new MatlabError(`Unknown operator ${op}`);
  }
}

function taggedLogical(mat) { mat.isLogical = true; return mat; }

function matMultiply(a, b) {
  if (a.numel === 1 || b.numel === 1) return Mat.broadcastBinary(a, b, C.cmul);
  if (a.cols !== b.rows) throw new MatlabError('Incorrect dimensions for matrix multiplication. Check that the number of columns in the first matrix matches the number of rows in the second matrix. To operate on each element of the matrix individually, use TIMES (.*) for elementwise multiplication.', 'MATLAB:innerdim');
  const rows = a.rows, cols = b.cols, inner = a.cols;
  const anyComplex = a.isComplex || b.isComplex;
  const re = new Float64Array(rows * cols);
  const im = anyComplex ? new Float64Array(rows * cols) : null;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      let sr = 0, si = 0;
      for (let k = 0; k < inner; k++) {
        const ar = a.re[k * rows + r], ai = a.isComplex ? a.im[k * rows + r] : 0;
        const br = b.re[c * inner + k], bi = b.isComplex ? b.im[c * inner + k] : 0;
        sr += ar * br - ai * bi;
        si += ar * bi + ai * br;
      }
      re[c * rows + r] = sr;
      if (im) im[c * rows + r] = si;
    }
  }
  return new Mat(rows, cols, re, im);
}

function matPower(a, b) {
  if (a.numel === 1 && b.numel === 1) return Mat.broadcastBinary(a, b, C.cpow);
  if (b.numel === 1 && Number.isInteger(b.re[0]) && !b.isComplex) {
    const n = b.re[0];
    if (a.rows !== a.cols) throw new MatlabError('Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.', 'MATLAB:mpower:notScalarAndSquareMatrix');
    if (n === 0) return identityLike(a.rows);
    let result = identityLike(a.rows);
    let base = n < 0 ? matInverse(a) : a;
    const warnings = base.warnings;
    let exp = Math.abs(n);
    while (exp > 0) {
      if (exp & 1) result = matMultiply(result, base);
      base = matMultiply(base, base);
      exp >>= 1;
    }
    if (warnings) result.warnings = warnings;
    return result;
  }
  // A^p with a non-integer p, or s^B: through the eigendecomposition.
  const square = (m) => m.rows === m.cols;
  if ((b.numel === 1 && square(a)) || (a.numel === 1 && square(b))) {
    if (!_matPowerImpl) throw new MatlabError('Linear algebra backend not initialized');
    return _matPowerImpl(a, b);
  }
  throw new MatlabError('Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.', 'MATLAB:mpower:notScalarAndSquareMatrix');
}

function identityLike(n) {
  const re = new Float64Array(n * n);
  for (let k = 0; k < n; k++) re[k * n + k] = 1;
  return new Mat(n, n, re);
}

// These delegate to builtins/linalg.js's solver via a late-bound reference
// to avoid a circular import; set by builtins/index.js at registration time.
let _matInverseImpl = null, _matSolveImpl = null, _matPowerImpl = null;
export function _registerLinalgHooks({ inverse, solve, power }) { _matInverseImpl = inverse; _matSolveImpl = solve; _matPowerImpl = power; }
function matInverse(a) {
  if (!_matInverseImpl) throw new MatlabError('Linear algebra backend not initialized');
  return _matInverseImpl(a);
}
function matLeftDivide(a, b) {
  if (a.numel === 1) return Mat.broadcastBinary(a, b, (ar, ai, br, bi) => C.cdiv(br, bi, ar, ai));
  if (!_matSolveImpl) throw new MatlabError('Linear algebra backend not initialized');
  return _matSolveImpl(a, b);
}
function matRightDivide(a, b) {
  if (b.numel === 1) return Mat.broadcastBinary(a, b, C.cdiv);
  // A/B = (B' \ A')'
  const at = transposeMat(a), bt = transposeMat(b);
  const x = matLeftDivide(bt, at);
  return transposeMat(x);
}
function transposeMat(v) {
  const re = new Float64Array(v.numel);
  const im = v.isComplex ? new Float64Array(v.numel) : null;
  for (let r = 0; r < v.rows; r++) for (let c = 0; c < v.cols; c++) {
    const src = c * v.rows + r, dst = r * v.cols + c;
    re[dst] = v.re[src];
    if (im) im[dst] = v.im[src];
  }
  return new Mat(v.cols, v.rows, re, im);
}

// ---------------- free-variable collection for anonymous-function closures ----------------

function collectFreeIdents(node, bound, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Ident') { if (!bound.has(node.name)) out.add(node.name); return; }
  if (node.type === 'AnonFunc') {
    const innerBound = new Set([...bound, ...node.params]);
    collectFreeIdents(node.body, innerBound, out);
    return;
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) { for (const el of v) collectFreeIdents(el, bound, out); }
    else if (v && typeof v === 'object') collectFreeIdents(v, bound, out);
  }
}

// ---------------- console formatting (basic; UI may override via host) ----------------
//
// Approximates MATLAB's default `format short`: integer-valued arrays print
// as integers; other values get 4 decimal places, switching to e-notation
// (scalars) or a common "1.0e+03 *" scale factor (arrays) when the
// magnitudes fall outside [0.001, 1000).

export function formatValue(val, style = 'short') {
  if (val instanceof FunctionHandle) return `  function_handle with value:\n\n    ${val.displayName()}`;
  if (val instanceof Cell) return formatCell(val);
  if (val instanceof StructArray) return formatStruct(val);
  return formatMat(val, style);
}

// One-line summary of a value, as shown inside a cell or struct display.
// `bracket` wraps numeric arrays: [1 2 3] in struct fields, {[1 2 3]} in cells.
function summarizeValue(v, inCell) {
  if (v instanceof FunctionHandle) return v.displayName();
  if (v instanceof Cell) return inCell ? `${v.sizeStr()} cell` : `{${v.sizeStr()} cell}`;
  if (v instanceof StructArray) return inCell ? `${v.sizeStr()} ${v.className()}` : `[${v.sizeStr()} ${v.className()}]`;
  if (v.isChar && (v.rows === 1 || (v.isEmpty && !inCell))) return `'${v.toJSString()}'`;
  const cls = v.className();
  if (v.isEmpty) return inCell ? `${v.sizeStr()} ${cls}` : '[]';
  if (v.rows === 1 && v.numel <= 10 && !v.isComplex) {
    const allInt = Array.from(v.re).every(x => !Number.isFinite(x) || Number.isInteger(x));
    const parts = Array.from(v.re, x => fmtSpecial(x) ?? (allInt ? String(x) : (Math.abs(x) >= 1e-3 && Math.abs(x) < 1e3 ? x.toFixed(4) : fmtExp(x))));
    const body = parts.join(' ');
    return v.numel === 1 && !inCell ? body : `[${body}]`;
  }
  if (v.numel === 1) return formatMat(v).trim();
  return inCell ? `${v.sizeStr()} ${cls}` : `[${v.sizeStr()} ${cls}]`;
}

function formatCell(c) {
  if (c.isEmpty) return `  ${c.sizeStr()} empty cell array`;
  const cells = [];
  for (let r = 0; r < c.rows; r++) {
    const row = [];
    for (let k = 0; k < c.cols; k++) row.push(`{${summarizeValue(c.data[k * c.rows + r], true)}}`);
    cells.push(row);
  }
  const widths = Array.from({ length: c.cols }, (_, k) => Math.max(...cells.map(row => row[k].length)));
  return `  ${c.sizeStr()} cell array\n\n` + cells.map(row => '    ' + row.map((x, k) => x.padEnd(widths[k])).join('    ').trimEnd()).join('\n');
}

function formatStruct(s) {
  const cls = s.className();
  if (s.numel === 1) {
    if (s.fieldNames.length === 0) return `  ${cls} with no fields.`;
    const w = Math.max(...s.fieldNames.map(f => f.length));
    const head = s.classOverride ? `  ${cls} with properties:` : '  struct with fields:';
    return head + '\n\n' + s.fieldNames.map(f => `    ${f.padStart(w)}: ${summarizeValue(s.data[0].get(f), false)}`).join('\n');
  }
  const head = s.isEmpty ? `  ${s.sizeStr()} empty ${cls} array` : `  ${s.sizeStr()} ${cls} array`;
  if (s.fieldNames.length === 0) return `${head} with no fields.`;
  return `${head} with fields:\n\n` + s.fieldNames.map(f => `    ${f}`).join('\n');
}

// MATLAB's display of an empty array: [] for a 0x0 double, otherwise a
// description such as "0x3 empty double matrix".
function formatEmpty(mat) {
  const size = mat.sizeStr();
  if (mat.isChar) return `  ${size} empty char array`;
  if (mat.isLogical) return `  ${size} empty logical array`;
  if (mat.rows === 0 && mat.cols === 0) return '     []';
  const shape = mat.rows === 1 ? 'row vector' : mat.cols === 1 ? 'column vector' : 'matrix';
  return `  ${size} empty ${mat.isComplex ? 'complex ' : ''}double ${shape}`;
}

// `style` is the `format` setting: 'short' shows 4 decimals; 'long' shows
// about 16 significant digits (15 decimals below 10, fewer above).
export function formatMat(mat, style = 'short') {
  if (mat.isEmpty) return formatEmpty(mat);
  if (mat.isChar) {
    if (mat.rows <= 1) return mat.toJSString();
    // A char matrix shows one row per line.
    const lines = [];
    for (let r = 0; r < mat.rows; r++) {
      let line = '';
      for (let c = 0; c < mat.cols; c++) line += String.fromCharCode(mat.re[c * mat.rows + r]);
      lines.push(line);
    }
    return lines.join('\n');
  }
  const long = style.startsWith('long');
  const variant = style === 'shortg' || style === 'longg' ? 'g' : style === 'shorte' || style === 'longe' ? 'e' : '';
  const decimals = (mag) => (!long ? 4 : mag < 10 ? 15 : Math.max(15 - Math.floor(Math.log10(mag)), 1));
  const exp = (x) => fmtExp(x, long ? 15 : 4);
  if (mat.isComplex) return formatComplex(mat, decimals, exp);
  const n = mat.numel;
  let allInt = true, maxAbs = 0;
  const scan = (x) => {
    if (!Number.isFinite(x)) return;
    if (!Number.isInteger(x)) allInt = false;
    if (Math.abs(x) > maxAbs) maxAbs = Math.abs(x);
  };
  for (let k = 0; k < n; k++) { scan(mat.re[k]); if (mat.isComplex) scan(mat.im[k]); }

  // format short g / long g: %g with 5 or 15 significant digits in
  // columns 13 or 26 wide; format short e / long e: e-notation throughout.
  // Integer-valued arrays show as integers in every format.
  if (variant && !(allInt && maxAbs < 1e9)) {
    const text = variant === 'g'
      ? (x) => fmtSpecial(x) ?? fmtGeneral(x, long ? 15 : 5)
      : (x) => fmtSpecial(x) ?? exp(x);
    const lines = [];
    for (let r = 0; r < mat.rows; r++) {
      const row = [];
      for (let c = 0; c < mat.cols; c++) row.push(text(mat.re[c * mat.rows + r]));
      lines.push(row);
    }
    const width = Math.max(...lines.flat().map(t => t.length));
    if (variant === 'g') {
      const w = Math.max(long ? 26 : 13, width + 2);
      return lines.map(row => row.map(t => t.padStart(w)).join('')).join('\n');
    }
    return lines.map(row => '   ' + row.map(t => t.padStart(width)).join('   ')).join('\n');
  }

  let header = '';
  let fmt;
  if (allInt && maxAbs < 1e9) {
    fmt = (x) => fmtSpecial(x) ?? String(x === 0 ? 0 : x);
  } else if (n === 1) {
    const useFixed = !allInt && maxAbs >= 1e-3 && maxAbs < 1e3;
    fmt = (x) => fmtSpecial(x) ?? (x === 0 ? '0' : useFixed ? x.toFixed(decimals(maxAbs)) : exp(x));
  } else if (maxAbs === 0 || (maxAbs >= 1e-3 && maxAbs < 1e3)) {
    const d = decimals(maxAbs);
    fmt = (x) => fmtSpecial(x) ?? (x === 0 ? '0' : x.toFixed(d));
  } else {
    const p = Math.floor(Math.log10(maxAbs));
    const scale = Math.pow(10, p);
    header = `   1.0e${p < 0 ? '-' : '+'}${String(Math.abs(p)).padStart(2, '0')} *\n\n`;
    const d = decimals(1);
    fmt = (x) => fmtSpecial(x) ?? (x === 0 ? '0' : (x / scale).toFixed(d));
  }

  const cells = [];
  for (let r = 0; r < mat.rows; r++) {
    const row = [];
    for (let c = 0; c < mat.cols; c++) row.push(fmt(mat.re[c * mat.rows + r]));
    cells.push(row);
  }
  const width = Math.max(...cells.flat().map(s => s.length), 1);
  // format short uses MATLAB's fixed column widths: integers (and
  // logicals) 6 characters wide, 12 once a value reaches 1000; decimals 10.
  // format long keeps the integer widths; a format long scalar in
  // e-notation is right-aligned in 26 columns.
  const fixedWidth = allInt && maxAbs < 1e9 ? (maxAbs < 1000 ? 6 : 12) : long ? 0 : (n > 1 || (maxAbs >= 1e-3 && maxAbs < 1e3) || maxAbs === 0) ? 10 : 0;
  if (fixedWidth) {
    const w = Math.max(fixedWidth, width + 2);
    return header + cells.map(row => row.map(s => s.padStart(w)).join('')).join('\n');
  }
  if (long && n === 1 && /e/.test(cells[0][0])) return cells[0][0].padStart(26);
  return header + cells.map(row => '   ' + row.map(s => s.padStart(width)).join('   ')).join('\n');
}

// Complex arrays, MATLAB-style: both parts always with decimals
// (3.0000 + 4.0000i), a common scale factor for arrays of large or tiny
// values, and real and imaginary parts aligned in columns.
function formatComplex(mat, decimals, exp) {
  const n = mat.numel;
  let maxAbs = 0;
  for (let k = 0; k < n; k++) {
    for (const x of [mat.re[k], mat.im[k]]) if (Number.isFinite(x) && Math.abs(x) > maxAbs) maxAbs = Math.abs(x);
  }
  const inRange = maxAbs === 0 || (maxAbs >= 1e-3 && maxAbs < 1e3);
  let header = '', fmt;
  if (inRange) {
    const d = decimals(maxAbs);
    fmt = (x) => fmtSpecial(x) ?? x.toFixed(d);
  } else if (n === 1) {
    fmt = (x) => fmtSpecial(x) ?? exp(x);
  } else {
    const p = Math.floor(Math.log10(maxAbs));
    const scale = Math.pow(10, p);
    header = `   1.0e${p < 0 ? '-' : '+'}${String(Math.abs(p)).padStart(2, '0')} *\n\n`;
    const d = decimals(1);
    fmt = (x) => fmtSpecial(x) ?? (x / scale).toFixed(d);
  }
  const reStr = Array.from(mat.re, x => fmt(x === 0 ? 0 : x));
  const imStr = Array.from(mat.im, x => fmt(Math.abs(x)));
  const wr = Math.max(...reStr.map(t => t.length)), wi = Math.max(...imStr.map(t => t.length));
  const lines = [];
  for (let r = 0; r < mat.rows; r++) {
    const row = [];
    for (let c = 0; c < mat.cols; c++) {
      const k = c * mat.rows + r;
      row.push(`${reStr[k].padStart(wr)} ${mat.im[k] < 0 ? '-' : '+'} ${imStr[k].padStart(wi)}i`);
    }
    lines.push('   ' + row.join('   '));
  }
  return header + lines.join('\n');
}
function fmtSpecial(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Inf';
  if (x === -Infinity) return '-Inf';
  return null;
}
// e-notation with MATLAB's two-digit exponent: 1.0000e-03, not 1.0000e-3.
function fmtExp(x, digits = 4) {
  return x.toExponential(digits).replace(/e([+-])(\d)$/, 'e$10$2');
}
// %g with p significant digits (trailing zeros dropped).
function fmtGeneral(x, p) {
  if (x === 0) return '0';
  const e = Number(x.toExponential(p - 1).split('e')[1]);
  if (e < -4 || e >= p) return fmtExp(x, p - 1).replace(/\.?0+e/, 'e');
  const t = x.toFixed(Math.max(p - 1 - e, 0));
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
}
