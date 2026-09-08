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
import { Mat, FunctionHandle, MatlabError } from './values.js';
import * as C from './cmath.js';

class BreakSignal { }
class ContinueSignal { }
class ReturnSignal { }

class Scope {
  constructor(interp, { isFunction = false, funcName = null } = {}) {
    this.interp = interp;
    this.vars = new Map();
    this.isFunction = isFunction;
    this.funcName = funcName;
    this.globalNames = new Set();
    this.persistentNames = new Set();
  }
  has(name) {
    if (this.globalNames.has(name)) return this.interp.globals.has(name);
    if (this.persistentNames.has(name)) return this.interp._persistentStore(this.funcName).has(name);
    return this.vars.has(name);
  }
  get(name) {
    if (this.globalNames.has(name)) return this.interp.globals.get(name);
    if (this.persistentNames.has(name)) return this.interp._persistentStore(this.funcName).get(name);
    return this.vars.get(name);
  }
  set(name, value) {
    if (this.globalNames.has(name)) { this.interp.globals.set(name, value); return; }
    if (this.persistentNames.has(name)) { this.interp._persistentStore(this.funcName).set(name, value); return; }
    this.vars.set(name, value);
  }
  declareGlobal(name) {
    this.globalNames.add(name);
    if (!this.interp.globals.has(name)) this.interp.globals.set(name, Mat.empty());
  }
  declarePersistent(name) {
    this.persistentNames.add(name);
    const store = this.interp._persistentStore(this.funcName);
    if (!store.has(name)) store.set(name, Mat.empty());
  }
  names() {
    return new Set([...this.vars.keys(), ...this.globalNames, ...this.persistentNames]);
  }
}

export class Interpreter {
  constructor(host = {}) {
    this.host = host; // { print(text), warn(text), figures: {...}, files: Map, ... }
    this.workspace = new Scope(this, { isFunction: false });
    this.funcTable = new Map(); // user-defined functions (script-local)
    this.globals = new Map();
    this._persistents = new Map(); // funcName -> Map
    this.builtins = new Map(); // registered by builtins/index.js via registerBuiltins()
    this.endStack = []; // stack of {size} for resolving `end` inside index args
    this.callDepth = 0;
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

  // ---------------- top-level run ----------------

  runSource(source) {
    const ast = parse(source);
    return this.runProgram(ast);
  }

  runProgram(ast) {
    // Hoist function definitions first (script-local functions), matching
    // MATLAB script behavior where a function can be called before its
    // textual definition later in the same file.
    const execStmts = [];
    for (const stmt of ast.body) {
      if (stmt.type === 'FunctionDef') this.funcTable.set(stmt.name, stmt);
      else execStmts.push(stmt);
    }
    for (const stmt of execStmts) {
      try {
        this.execStmt(stmt, this.workspace);
      } catch (e) {
        if (e instanceof ReturnSignal) break;
        throw e;
      }
    }
  }

  // ---------------- statements ----------------

  execStmt(node, scope) {
    switch (node.type) {
      case 'ExprStmt': {
        const vals = this.evalForNargout(node.expr, scope, 0); // side-effect calls (e.g. plot) want nargout=0
        if (vals.length > 0 && !(node.expr.type === 'Index' && this._isVoidCallTarget(node.expr, scope))) {
          this.workspace.set('ans', vals[0]);
          if (scope !== this.workspace) scope.set('ans', vals[0]);
          if (!node.suppressed) this.displayValue('ans', vals[0]);
        }
        return;
      }
      case 'Assign': {
        const val = this.evalExpr(node.expr, scope);
        this.assignTo(node.target, val, scope);
        if (!node.suppressed) this.displayAssignTarget(node.target, scope);
        return;
      }
      case 'MultiAssign': {
        const vals = this.evalForNargout(node.expr, scope, node.targets.length);
        for (let k = 0; k < node.targets.length; k++) {
          const t = node.targets[k];
          if (t.type === 'Tilde') continue;
          const v = vals[k];
          if (v === undefined) throw new MatlabError('Not enough output arguments returned');
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
          if (this.evalExpr(clause.test, scope).isTruthy()) {
            this.execBlock(clause.body, scope);
            return;
          }
        }
        if (node.elseBody) this.execBlock(node.elseBody, scope);
        return;
      }
      case 'For': {
        const iterVal = this.evalExpr(node.iter, scope);
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
        while (this.evalExpr(node.test, scope).isTruthy()) {
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
      case 'FunctionDef': this.funcTable.set(node.name, node); return;
      case 'Global': for (const n of node.names) scope.declareGlobal(n); return;
      case 'Persistent': for (const n of node.names) scope.declarePersistent(n); return;
      default:
        throw new MatlabError(`Cannot execute statement of type ${node.type}`);
    }
  }

  _switchMatches(subject, testVal) {
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

  _isVoidCallTarget(indexNode, scope) {
    // Heuristic used only to decide whether to store/print `ans`: a bare
    // call to a function that returns nothing (like `plot(...)`, `disp(...)`)
    // should not touch `ans`. We treat "returned an empty array list" as
    // void, which evalForNargout already produces for such builtins.
    return false;
  }

  // ---------------- assignment targets ----------------

  assignTo(target, value, scope) {
    if (target.type === 'Ident') { scope.set(target.name, value); return; }
    if (target.type === 'Field') {
      throw new MatlabError(`Struct field assignment ('${this._exprSrc(target)}') is not supported — structs aren't implemented. Use separate variables instead.`);
    }
    if (target.type === 'Index') {
      const baseName = this._rootIdentName(target.target);
      let mat = scope.has(baseName) ? scope.get(baseName) : Mat.empty();
      if (!(mat instanceof Mat)) throw new MatlabError(`Cannot index-assign into '${baseName}' (not a matrix)`);
      mat = this.indexedAssign(mat.clone(), target.args, scope, value);
      scope.set(baseName, mat);
      return;
    }
    throw new MatlabError(`Invalid assignment target of type ${target.type}`);
  }

  _rootIdentName(node) {
    if (node.type === 'Ident') return node.name;
    throw new MatlabError('Chained indexed assignment (e.g. f(x)(y)=...) is not supported');
  }

  _exprSrc(node) { return node && node.name ? node.name : '<expr>'; }

  displayAssignTarget(target, scope) {
    if (target.type === 'Ident') { this.displayValue(target.name, scope.get(target.name)); return; }
    if (target.type === 'Index') {
      const name = this._rootIdentName(target.target);
      this.displayValue(name, scope.get(name));
    }
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
      case 'Bool': return [Mat.logicalScalar(node.value)];
      case 'Str': return [Mat.fromString(node.value)];
      case 'End': {
        if (this.endStack.length === 0) throw new MatlabError("'end' used outside of an indexing expression");
        return [Mat.scalar(this.endStack[this.endStack.length - 1])];
      }
      case 'Ident': {
        if (scope.has(node.name)) return [scope.get(node.name)];
        if (this.funcTable.has(node.name) || this.builtins.has(node.name) || this.files.has(node.name + '.m')) {
          return this.callNamed(node.name, [], nargout, scope);
        }
        throw new MatlabError(`Undefined variable or function '${node.name}'`);
      }
      case 'Paren': return [this.evalExpr(node.expr, scope)];
      case 'Range': return [this.evalRange(node, scope)];
      case 'MatrixLit': return [this.evalMatrixLit(node, scope)];
      case 'Unary': return [this.evalUnary(node, scope)];
      case 'Binary': return [this.evalBinary(node, scope)];
      case 'Transpose': return [this.evalTranspose(node, scope)];
      case 'AnonFunc': return [this.evalAnonFunc(node, scope)];
      case 'FuncHandle': return [new FunctionHandle({ name: node.name })];
      case 'Field':
        throw new MatlabError(`Struct field access ('.${node.name}') is not supported — structs aren't implemented. Consider separate variables or a Map-like workaround.`);
      case 'CellIndex':
        throw new MatlabError('Cell arrays ({...}) are not supported.');
      case 'Index': return this.evalIndexOrCall(node, scope, nargout);
      default:
        throw new MatlabError(`Cannot evaluate expression of type ${node.type}`);
    }
  }

  evalRange(node, scope) {
    const start = this.evalExpr(node.start, scope).toScalarNumber();
    const stop = this.evalExpr(node.stop, scope).toScalarNumber();
    const step = node.step ? this.evalExpr(node.step, scope).toScalarNumber() : 1;
    const vals = [];
    if (step === 0) return Mat.zeros(1, 0);
    if (step > 0) { for (let v = start; v <= stop + 1e-10; v += step) vals.push(v); }
    else { for (let v = start; v >= stop - 1e-10; v += step) vals.push(v); }
    const re = new Float64Array(vals.length);
    re.set(vals);
    return new Mat(vals.length ? 1 : 1, vals.length, re);
  }

  evalMatrixLit(node, scope) {
    if (node.rows.length === 0) return Mat.empty();
    // Evaluate each element (may itself be a matrix, for horzcat/vertcat).
    const rowMats = node.rows.map(row => row.map(el => this.evalExpr(el, scope)));
    // Horizontal concat within each row, then vertical concat across rows.
    const isCharRow = rowMats.map(r => r.length > 0 && r.every(m => m.isChar));
    const hcatRows = rowMats.map((r, idx) => this.hconcat(r));
    return this.vconcat(hcatRows);
  }

  hconcat(mats) {
    mats = mats.filter(m => !(m.isEmpty && m.rows === 0 && m.cols === 0));
    if (mats.length === 0) return Mat.empty();
    const rows = mats[0].rows;
    for (const m of mats) if (m.rows !== rows) throw new MatlabError('Dimension mismatch in matrix literal (row heights differ)');
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
    const allChar = mats.every(m => m.isChar);
    return new Mat(rows, cols, re, im, { isChar: allChar });
  }

  vconcat(mats) {
    mats = mats.filter(m => !(m.isEmpty && m.rows === 0 && m.cols === 0));
    if (mats.length === 0) return Mat.empty();
    const cols = mats[0].cols;
    for (const m of mats) if (m.cols !== cols) throw new MatlabError('Dimension mismatch in matrix literal (row widths differ)');
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
    const allChar = mats.every(m => m.isChar);
    return new Mat(rows, cols, re, im, { isChar: allChar });
  }

  evalUnary(node, scope) {
    const v = this.evalExpr(node.expr, scope);
    if (node.op === '+') return v;
    if (node.op === '-') return Mat.mapElementwise(v, (r, i) => [-r, -i]);
    if (node.op === '~') return Mat.mapElementwise(v, (r, i) => [(r === 0 && i === 0) ? 1 : 0, 0]);
    throw new MatlabError(`Unknown unary operator ${node.op}`);
  }

  evalTranspose(node, scope) {
    const v = this.evalExpr(node.expr, scope);
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
    // Capture free variables by value at creation time.
    const closure = new Map();
    const paramSet = new Set(node.params);
    const free = new Set();
    collectFreeIdents(node.body, paramSet, free);
    for (const name of free) {
      if (scope.has(name)) closure.set(name, scope.get(name));
      else if (this.funcTable.has(name) || this.builtins.has(name)) {
        closure.set(name, new FunctionHandle({ name }));
      }
    }
    return new FunctionHandle({ params: node.params, body: node.body, closure });
  }

  evalBinary(node, scope) {
    const op = node.op;
    if (op === '&&') {
      const l = this.evalExpr(node.left, scope);
      if (!l.isTruthy()) return Mat.logicalScalar(false);
      const r = this.evalExpr(node.right, scope);
      return Mat.logicalScalar(r.isTruthy());
    }
    if (op === '||') {
      const l = this.evalExpr(node.left, scope);
      if (l.isTruthy()) return Mat.logicalScalar(true);
      const r = this.evalExpr(node.right, scope);
      return Mat.logicalScalar(r.isTruthy());
    }
    const a = this.evalExpr(node.left, scope);
    const b = this.evalExpr(node.right, scope);
    return applyBinaryOp(op, a, b);
  }

  // ---------------- indexing & calls ----------------

  evalIndexOrCall(node, scope, nargout) {
    // Disambiguate: variable indexing takes priority over a same-named
    // function, matching real MATLAB name resolution.
    if (node.target.type === 'Ident') {
      const name = node.target.name;
      if (scope.has(name)) {
        const base = scope.get(name);
        if (base instanceof FunctionHandle) {
          const args = node.args.map(a => this.evalExpr(a, scope));
          return this.callHandle(base, args, nargout, scope);
        }
        return [this.indexRead(base, node.args, scope)];
      }
      return this.callNamed(name, node.args.map(a => this.evalExpr(a, scope)), nargout, scope, node.args, scope);
    }
    // Chained call, e.g. handle-returning expression called immediately: g(x)(y)
    const target = this.evalExpr(node.target, scope);
    if (target instanceof FunctionHandle) {
      const args = node.args.map(a => this.evalExpr(a, scope));
      return this.callHandle(target, args, nargout, scope);
    }
    return [this.indexRead(target, node.args, scope)];
  }

  callNamed(name, argValues, nargout, callerScope) {
    if (this.funcTable.has(name)) {
      return this.callUserFunction(this.funcTable.get(name), argValues, nargout);
    }
    if (this.builtins.has(name)) {
      const spec = this.builtins.get(name);
      const result = spec.fn(argValues, nargout, this._builtinCtx(callerScope));
      return result === undefined ? [] : result;
    }
    if (this.files.has(name + '.m')) {
      // Bare script-name call (e.g. `>> projectile`), matching MATLAB's
      // behavior of running a same-named .m script found on the path.
      const entry = this.files.get(name + '.m');
      const ast = parse(entry.text);
      for (const stmt of ast.body) if (stmt.type === 'FunctionDef') this.funcTable.set(stmt.name, stmt);
      const scope = callerScope || this.workspace;
      for (const stmt of ast.body) {
        if (stmt.type === 'FunctionDef') continue;
        try { this.execStmt(stmt, scope); } catch (e) { if (e instanceof ReturnSignal) break; throw e; }
      }
      return [];
    }
    throw new MatlabError(`Undefined function '${name}'`);
  }

  callHandle(fh, argValues, nargout, callerScope) {
    if (fh.builtin) return fh.builtin(argValues, nargout, this._builtinCtx(callerScope));
    if (fh.name) return this.callNamed(fh.name, argValues, nargout, callerScope);
    // anonymous function
    const scope = new Scope(this, { isFunction: true, funcName: '<anonymous>' });
    for (const [k, v] of fh.closure.entries()) scope.set(k, v);
    if (argValues.length > fh.params.length) throw new MatlabError('Too many input arguments');
    fh.params.forEach((p, i) => { if (i < argValues.length) scope.set(p, argValues[i]); });
    scope.set('nargin', Mat.scalar(argValues.length));
    const result = this.evalExpr(fh.body, scope);
    return [result];
  }

  callFunctionValue(fh, argValues, nargout, callerScope) {
    // Public helper used by builtins like feval/arrayfun.
    if (fh instanceof FunctionHandle) return this.callHandle(fh, argValues, nargout, callerScope || this.workspace);
    throw new MatlabError('Value is not callable');
  }

  callUserFunction(def, argValues, nargout) {
    this.callDepth++;
    if (this.callDepth > 200) { this.callDepth--; throw new MatlabError('Maximum recursion depth exceeded'); }
    try {
      if (argValues.length > def.params.length) throw new MatlabError(`Too many input arguments to '${def.name}'`);
      const scope = new Scope(this, { isFunction: true, funcName: def.name });
      def.params.forEach((p, i) => { if (i < argValues.length) scope.set(p, argValues[i]); });
      scope.set('nargin', Mat.scalar(argValues.length));
      scope.set('nargout', Mat.scalar(Math.max(nargout, 0)));
      try {
        this.execBlock(def.body, scope);
      } catch (e) {
        if (!(e instanceof ReturnSignal)) throw e;
      }
      const outputs = [];
      for (const outName of def.outputs) {
        if (scope.vars.has(outName)) outputs.push(scope.vars.get(outName));
        else break; // later outputs simply not requested/assigned
      }
      return outputs;
    } finally {
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
    if (!(mat instanceof Mat)) throw new MatlabError('Cannot index into this value');
    if (argNodes.length === 0) throw new MatlabError('Empty index expression is not supported');
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
      if (p < 0 || p >= mat.numel) throw new MatlabError(`Index (${p + 1}) out of bounds (numel=${mat.numel})`);
      re[k] = mat.re[p];
      if (im) im[k] = mat.im[p];
    }
    let rows, cols;
    if (mat.isVector && mat.numel !== 1) {
      if (mat.rows === 1) { rows = 1; cols = positions.length; }
      else { rows = positions.length; cols = 1; }
    } else if (idxMat.isVector) {
      if (idxMat.rows === 1) { rows = 1; cols = positions.length; }
      else { rows = positions.length; cols = 1; }
    } else {
      rows = idxMat.rows; cols = idxMat.cols;
    }
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
        if (rr < 0 || rr >= mat.rows || cc < 0 || cc >= mat.cols) {
          throw new MatlabError(`Index out of bounds (size is ${mat.sizeStr()})`);
        }
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
      if (!Number.isInteger(v) || v < 1) throw new MatlabError(`Array indices must be positive integers (got ${v})`);
      positions.push(v - 1);
    }
    return positions;
  }

  // ---- indexing (assignment, incl. growth & deletion) ----

  indexedAssign(mat, argNodes, scope, rhs) {
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
      return this._deleteLinear(mat, positions);
    }

    let positions = isFullColon
      ? Array.from({ length: mat.numel }, (_, k) => k)
      : this._resolvePositions(idxMat, mat.numel);

    const maxPos = positions.length ? Math.max(...positions) : -1;
    if (maxPos >= mat.numel) {
      if (!mat.isVector && mat.numel !== 0) {
        throw new MatlabError('Cannot grow a non-vector matrix via linear indexing; use 2-subscript assignment instead');
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
      throw new MatlabError(`Cannot assign ${rhs.numel} values to ${positions.length} destination elements`);
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
      throw new MatlabError("Deleting elements requires a full ':' on exactly one dimension, e.g. A(:,2) = []");
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
      throw new MatlabError(`Cannot assign ${rhs.numel} values to ${total} destination elements`);
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
    const asRow = mat.rows === 1;
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
    this.print(this.host.formatAssignment ? this.host.formatAssignment(name, val) : `${name} =\n${formatMat(val)}\n`);
  }
}

// ---------------- free binary operator dispatch ----------------

function applyBinaryOp(op, a, b) {
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
    case '&': return taggedLogical(Mat.broadcastBinary(a, b, (ar, ai, br, bi) => [((ar !== 0 || ai !== 0) && (br !== 0 || bi !== 0)) ? 1 : 0, 0]));
    case '|': return taggedLogical(Mat.broadcastBinary(a, b, (ar, ai, br, bi) => [((ar !== 0 || ai !== 0) || (br !== 0 || bi !== 0)) ? 1 : 0, 0]));
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
  if (a.cols !== b.rows) throw new MatlabError(`Inner matrix dimensions must agree (${a.sizeStr()} * ${b.sizeStr()})`);
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
    if (a.rows !== a.cols) throw new MatlabError('For A^n, A must be a square matrix');
    if (n === 0) return identityLike(a.rows);
    let result = identityLike(a.rows);
    let base = n < 0 ? matInverse(a) : a;
    let exp = Math.abs(n);
    while (exp > 0) {
      if (exp & 1) result = matMultiply(result, base);
      base = matMultiply(base, base);
      exp >>= 1;
    }
    return result;
  }
  throw new MatlabError('Matrix power A^B with non-scalar, non-integer exponent is not supported');
}

function identityLike(n) {
  const re = new Float64Array(n * n);
  for (let k = 0; k < n; k++) re[k * n + k] = 1;
  return new Mat(n, n, re);
}

// These delegate to builtins/linalg.js's solver via a late-bound reference
// to avoid a circular import; set by builtins/index.js at registration time.
let _matInverseImpl = null, _matSolveImpl = null;
export function _registerLinalgHooks({ inverse, solve }) { _matInverseImpl = inverse; _matSolveImpl = solve; }
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

export function formatMat(mat) {
  if (mat.isChar) return mat.toJSString();
  if (mat.isEmpty) return `     [](${mat.rows}x${mat.cols})`;
  const fmtNum = (r, i) => {
    if (i && i !== 0) {
      const sign = i < 0 ? '-' : '+';
      return `${fmtReal(r)} ${sign} ${fmtReal(Math.abs(i))}i`;
    }
    return fmtReal(r);
  };
  const cells = [];
  for (let r = 0; r < mat.rows; r++) {
    const row = [];
    for (let c = 0; c < mat.cols; c++) {
      const k = c * mat.rows + r;
      row.push(fmtNum(mat.re[k], mat.isComplex ? mat.im[k] : 0));
    }
    cells.push(row);
  }
  const width = Math.max(...cells.flat().map(s => s.length), 1);
  return cells.map(row => '   ' + row.map(s => s.padStart(width)).join('   ')).join('\n');
}
function fmtReal(x) {
  if (Number.isInteger(x)) return String(x);
  if (!isFinite(x)) return String(x);
  return Number(x.toPrecision(5)).toString();
}
