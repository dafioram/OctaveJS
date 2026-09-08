// parser.js — Recursive-descent parser for the MATLAB-compatible subset.
//
// Operator precedence (low to high), matching real MATLAB:
//   || < && < | < & < relational(== ~= < > <= >=) < range(:)
//     < additive(+ -) < multiplicative(* / \ .* ./ .\)
//     < unary(+ - ~) < power(^ .^, left-assoc) < postfix(' .' () {} .field)
//
// A bare `:` used as a whole index argument (e.g. A(:,2)) is distinguished
// from the range operator by lookahead at the start of argument parsing.
//
// Newlines are insignificant while inside `(...)` or `{...}` (implicit line
// continuation, like real MATLAB), but inside a `[...]` matrix literal that
// is not itself shadowed by an inner `(`/`{`, a bare newline acts as a row
// separator, same as `;`.

import { tokenize, TT } from './lexer.js';

export class ParseError extends Error {
  constructor(message, tok) {
    const where = tok ? ` (line ${tok.line}, col ${tok.col}, got ${tok.type} ${JSON.stringify(tok.value)})` : '';
    super(message + where);
    this.name = 'ParseError';
    this.token = tok;
  }
}

const BLOCK_CLOSERS = new Set(['end', 'elseif', 'else', 'case', 'otherwise']);

// A small, deliberately narrow whitelist for MATLAB's "command syntax"
// (bare-word arguments, no parens: `hold on` instead of `hold('on')`).
// Real MATLAB resolves the general case by checking, at parse time,
// whether the leading word is currently a variable in the workspace —
// which requires the parser to see runtime state, something this app's
// architecture deliberately doesn't do (parsing stays a pure, one-time,
// stateless step, independent of any interpreter). Rather than plumb
// scope access into the parser for a fully general (and only
// MATLAB-legal in narrow cases anyway) feature, we support it for
// exactly the handful of commands where it's actually idiomatic and
// where the ambiguity this shortcut sidesteps essentially never arises
// in practice. See README.
const COMMAND_SYNTAX_NAMES = new Set(['clear', 'hold', 'grid', 'axis', 'disp']);

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
    this.bracketStack = []; // 'paren' | 'bracket' | 'brace'
  }

  peek(off = 0) { return this.toks[this.pos + off]; }
  cur() { return this.toks[this.pos]; }

  at(type, value) {
    const t = this.cur();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }
  atKw(word) { return this.at(TT.KEYWORD, word); }

  advance() { return this.toks[this.pos++]; }

  expect(type, value) {
    if (!this.at(type, value)) {
      throw new ParseError(`Expected ${value ?? type}`, this.cur());
    }
    return this.advance();
  }

  // Skip NEWLINE tokens when they're insignificant at this nesting level
  // (i.e. we're shadowed inside a paren/brace, or top of stack is none).
  skipInsignificantNewlines() {
    const top = this.bracketStack[this.bracketStack.length - 1];
    if (top === 'bracket') return; // newline is a row separator here
    while (this.at(TT.NEWLINE)) this.advance();
  }

  // Skip separators that never carry meaning between tokens inside a
  // paren/brace expression list (newlines only, per above).
  skipNLInParenOrBrace() {
    while (this.at(TT.NEWLINE)) this.advance();
  }

  parseProgram() {
    const body = [];
    this.skipStmtSeparators();
    while (!this.at(TT.EOF)) {
      body.push(this.parseStatementWithTerm());
      this.skipStmtSeparators();
    }
    return { type: 'Program', body };
  }

  skipStmtSeparators() {
    while (this.at(TT.NEWLINE) || this.at(TT.SEMI) || this.at(TT.COMMA)) this.advance();
  }

  // After a statement, consume exactly the run of separators up to (not
  // including) the next real token, remembering whether a `;` occurred
  // anywhere in that run (MATLAB suppresses output if a `;` terminates,
  // even with trailing whitespace/comments already stripped by the lexer).
  consumeTerminator() {
    let suppressed = false;
    while (this.at(TT.SEMI) || this.at(TT.NEWLINE) || this.at(TT.COMMA)) {
      if (this.at(TT.SEMI)) suppressed = true;
      this.advance();
      break; // only the first separator determines suppression; rest are blank-line noise
    }
    return suppressed;
  }

  parseBlockBody(...closers) {
    const body = [];
    this.skipStmtSeparators();
    while (!this.at(TT.EOF) && !closers.some(c => this.atKw(c))) {
      body.push(this.parseStatementWithTerm());
      this.skipStmtSeparators();
    }
    return body;
  }

  parseStatementWithTerm() {
    const stmt = this.parseStatement();
    // capture suppression from the immediate next separator, if any
    if (this.at(TT.SEMI)) { stmt.suppressed = true; this.advance(); }
    else if (this.at(TT.NEWLINE) || this.at(TT.COMMA)) { this.advance(); }
    return stmt;
  }

  parseStatement() {
    const t = this.cur();
    if (t.type === TT.KEYWORD) {
      switch (t.value) {
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'switch': return this.parseSwitch();
        case 'function': return this.parseFunctionDef();
        case 'break': this.advance(); return { type: 'Break' };
        case 'continue': this.advance(); return { type: 'Continue' };
        case 'return': this.advance(); return { type: 'Return' };
        case 'global': return this.parseGlobalOrPersistent('Global');
        case 'persistent': return this.parseGlobalOrPersistent('Persistent');
        default:
          throw new ParseError(`Unexpected keyword '${t.value}'`, t);
      }
    }
    if (t.type === TT.IDENT && COMMAND_SYNTAX_NAMES.has(t.value)) {
      const next = this.peek(1);
      // Only engage command syntax when a bareword clearly follows with a
      // space (e.g. `hold on`) — never when what follows looks like the
      // start of a normal expression continuation (`(`, `=`, an operator,
      // etc.), so ordinary calls and assignments are completely unaffected.
      if (next && next.spaceBefore && (next.type === TT.IDENT || next.type === TT.NUMBER)) {
        return this.parseCommandSyntax(t.value);
      }
    }
    return this.parseAssignmentOrExpr();
  }

  // Rewrites `name word1 word2 ...` into the same AST as
  // `name('word1', 'word2', ...)`, so nothing downstream (interpreter,
  // builtins) needs to know this shortcut exists.
  parseCommandSyntax(name) {
    this.advance(); // consume the command name
    const args = [];
    while (this.at(TT.IDENT) || this.at(TT.NUMBER)) {
      const tok = this.advance();
      args.push({ type: 'Str', value: String(tok.value) });
    }
    const call = { type: 'Index', target: { type: 'Ident', name }, args };
    return { type: 'ExprStmt', expr: call, suppressed: false };
  }

  parseGlobalOrPersistent(kind) {
    this.advance();
    const names = [];
    while (this.at(TT.IDENT)) {
      names.push(this.advance().value);
    }
    return { type: kind, names };
  }

  // Handles: `expr`, `x = expr`, `[a,b] = expr`, `[a,~,c] = expr`
  parseAssignmentOrExpr() {
    if (this.at(TT.LBRACKET)) {
      const save = this.pos;
      const multi = this.tryParseMultiAssignLHS();
      if (multi && this.at(TT.EQUALS)) {
        this.advance();
        const expr = this.parseExpr();
        return { type: 'MultiAssign', targets: multi, expr, suppressed: false };
      }
      this.pos = save; // not a multi-assign; fall through to plain expression
    }
    const expr = this.parseExpr();
    if (this.at(TT.EQUALS)) {
      this.advance();
      const rhs = this.parseExpr();
      if (!(expr.type === 'Ident' || expr.type === 'Index' || expr.type === 'Field')) {
        throw new ParseError('Invalid assignment target', this.cur());
      }
      return { type: 'Assign', target: expr, expr: rhs, suppressed: false };
    }
    return { type: 'ExprStmt', expr, suppressed: false };
  }

  tryParseMultiAssignLHS() {
    try {
      this.expect(TT.LBRACKET);
      const targets = [];
      while (!this.at(TT.RBRACKET)) {
        if (this.at(TT.OP, '~')) { this.advance(); targets.push({ type: 'Tilde' }); }
        else {
          let node = this.parsePostfix(this.parsePrimary());
          if (!(node.type === 'Ident' || node.type === 'Index' || node.type === 'Field')) return null;
          targets.push(node);
        }
        if (this.at(TT.COMMA)) this.advance();
        else break;
      }
      if (!this.at(TT.RBRACKET)) return null;
      this.advance();
      return targets;
    } catch (e) {
      return null;
    }
  }

  parseIf() {
    this.advance(); // if
    const clauses = [];
    const test = this.parseExpr();
    this.skipStmtSeparators();
    const body = this.parseBlockBody('end', 'elseif', 'else');
    clauses.push({ test, body });
    while (this.atKw('elseif')) {
      this.advance();
      const t2 = this.parseExpr();
      this.skipStmtSeparators();
      const b2 = this.parseBlockBody('end', 'elseif', 'else');
      clauses.push({ test: t2, body: b2 });
    }
    let elseBody = null;
    if (this.atKw('else')) {
      this.advance();
      this.skipStmtSeparators();
      elseBody = this.parseBlockBody('end');
    }
    this.expect(TT.KEYWORD, 'end');
    return { type: 'If', clauses, elseBody };
  }

  parseFor() {
    this.advance(); // for
    let varName;
    let hasParen = false;
    if (this.at(TT.LPAREN)) { this.advance(); hasParen = true; }
    varName = this.expect(TT.IDENT).value;
    this.expect(TT.EQUALS);
    const iter = this.parseExpr();
    if (hasParen) this.expect(TT.RPAREN);
    this.skipStmtSeparators();
    const body = this.parseBlockBody('end');
    this.expect(TT.KEYWORD, 'end');
    return { type: 'For', varName, iter, body };
  }

  parseWhile() {
    this.advance();
    const test = this.parseExpr();
    this.skipStmtSeparators();
    const body = this.parseBlockBody('end');
    this.expect(TT.KEYWORD, 'end');
    return { type: 'While', test, body };
  }

  parseSwitch() {
    this.advance();
    const expr = this.parseExpr();
    this.skipStmtSeparators();
    const cases = [];
    let otherwiseBody = null;
    while (this.atKw('case')) {
      this.advance();
      let tests;
      if (this.at(TT.LBRACE)) {
        this.advance();
        this.bracketStack.push('brace');
        tests = [];
        while (!this.at(TT.RBRACE)) {
          tests.push(this.parseExpr());
          if (this.at(TT.COMMA)) this.advance(); else break;
        }
        this.bracketStack.pop();
        this.expect(TT.RBRACE);
      } else {
        tests = [this.parseExpr()];
      }
      this.skipStmtSeparators();
      const body = this.parseBlockBody('end', 'case', 'otherwise');
      cases.push({ tests, body });
    }
    if (this.atKw('otherwise')) {
      this.advance();
      this.skipStmtSeparators();
      otherwiseBody = this.parseBlockBody('end');
    }
    this.expect(TT.KEYWORD, 'end');
    return { type: 'Switch', expr, cases, otherwiseBody };
  }

  parseFunctionDef() {
    this.advance(); // function
    let outputs = [];
    const save = this.pos;
    if (this.at(TT.LBRACKET)) {
      this.advance();
      while (!this.at(TT.RBRACKET)) {
        outputs.push(this.expect(TT.IDENT).value);
        if (this.at(TT.COMMA)) this.advance(); else break;
      }
      this.expect(TT.RBRACKET);
      this.expect(TT.EQUALS);
    } else if (this.at(TT.IDENT) && this.peek(1) && this.peek(1).type === TT.EQUALS) {
      outputs.push(this.advance().value);
      this.expect(TT.EQUALS);
    }
    const name = this.expect(TT.IDENT).value;
    const params = [];
    if (this.at(TT.LPAREN)) {
      this.advance();
      while (!this.at(TT.RPAREN)) {
        params.push(this.expect(TT.IDENT).value);
        if (this.at(TT.COMMA)) this.advance(); else break;
      }
      this.expect(TT.RPAREN);
    }
    this.skipStmtSeparators();
    const body = this.parseBlockBody('end');
    // MATLAB allows omitting the final `end` for the last function in a
    // script-style file; if we hit EOF instead of `end`, accept it.
    if (this.atKw('end')) this.advance();
    return { type: 'FunctionDef', name, outputs, params, body };
  }

  // ---------- expressions ----------

  parseExpr() { return this.parseOrOr(); }

  parseOrOr() {
    let left = this.parseAndAnd();
    while (this.at(TT.OP, '||')) { this.advance(); const right = this.parseAndAnd(); left = { type: 'Binary', op: '||', left, right }; }
    return left;
  }
  parseAndAnd() {
    let left = this.parseOr();
    while (this.at(TT.OP, '&&')) { this.advance(); const right = this.parseOr(); left = { type: 'Binary', op: '&&', left, right }; }
    return left;
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.at(TT.OP, '|')) { this.advance(); const right = this.parseAnd(); left = { type: 'Binary', op: '|', left, right }; }
    return left;
  }
  parseAnd() {
    let left = this.parseRelational();
    while (this.at(TT.OP, '&')) { this.advance(); const right = this.parseRelational(); left = { type: 'Binary', op: '&', left, right }; }
    return left;
  }
  parseRelational() {
    let left = this.parseRange();
    const relOps = new Set(['==', '~=', '<', '>', '<=', '>=']);
    while (this.cur().type === TT.OP && relOps.has(this.cur().value)) {
      const op = this.advance().value;
      const right = this.parseRange();
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }
  parseRange() {
    const start = this.parseAdditive();
    if (this.at(TT.COLON)) {
      this.advance();
      const second = this.parseAdditive();
      if (this.at(TT.COLON)) {
        this.advance();
        const third = this.parseAdditive();
        return { type: 'Range', start, step: second, stop: third };
      }
      return { type: 'Range', start, step: null, stop: second };
    }
    return start;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.cur().type === TT.OP && (this.cur().value === '+' || this.cur().value === '-')) {
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseUnary();
    const ops = new Set(['*', '/', '\\', '.*', './', '.\\']);
    while (this.cur().type === TT.OP && ops.has(this.cur().value)) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }
  parseUnary() {
    if (this.cur().type === TT.OP && (this.cur().value === '+' || this.cur().value === '-' || this.cur().value === '~')) {
      const op = this.advance().value;
      const expr = this.parseUnary();
      return { type: 'Unary', op, expr };
    }
    return this.parsePower();
  }
  parsePower() {
    let left = this.parsePostfix(this.parsePrimary());
    while (this.cur().type === TT.OP && (this.cur().value === '^' || this.cur().value === '.^')) {
      const op = this.advance().value;
      // MATLAB power is left-associative; the exponent itself may carry a
      // leading unary sign (2^-1) but not a further power chain directly.
      let right;
      if (this.cur().type === TT.OP && (this.cur().value === '+' || this.cur().value === '-' || this.cur().value === '~')) {
        right = this.parseUnary();
      } else {
        right = this.parsePostfix(this.parsePrimary());
      }
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }

  parsePostfix(node) {
    for (;;) {
      if (this.at(TT.OP, "'") || this.at(TT.OP, ".'")) {
        const conj = this.cur().value === "'";
        this.advance();
        node = { type: 'Transpose', expr: node, conjugate: conj };
        continue;
      }
      if (this.at(TT.LPAREN)) {
        this.advance();
        this.bracketStack.push('paren');
        const args = this.parseArgList(TT.RPAREN);
        this.bracketStack.pop();
        this.expect(TT.RPAREN);
        node = { type: 'Index', target: node, args };
        continue;
      }
      if (this.at(TT.LBRACE)) {
        this.advance();
        this.bracketStack.push('brace');
        const args = this.parseArgList(TT.RBRACE);
        this.bracketStack.pop();
        this.expect(TT.RBRACE);
        node = { type: 'CellIndex', target: node, args };
        continue;
      }
      if (this.at(TT.DOT)) {
        this.advance();
        const name = this.expect(TT.IDENT).value;
        node = { type: 'Field', target: node, name };
        continue;
      }
      break;
    }
    return node;
  }

  // Parses a comma-separated argument list, recognising a bare `:` as a
  // full-dimension selector distinct from the range operator.
  parseArgList(closerType) {
    const args = [];
    this.skipNLInParenOrBrace();
    while (!this.at(closerType)) {
      if (this.at(TT.COLON) && (this.peek(1).type === TT.COMMA || this.peek(1).type === closerType)) {
        this.advance();
        args.push({ type: 'FullColon' });
      } else {
        args.push(this.parseExpr());
      }
      this.skipNLInParenOrBrace();
      if (this.at(TT.COMMA)) { this.advance(); this.skipNLInParenOrBrace(); }
      else break;
    }
    return args;
  }

  parsePrimary() {
    const t = this.cur();

    if (t.type === TT.NUMBER) { this.advance(); return { type: 'Num', value: t.value }; }
    if (t.type === TT.IMAG_NUMBER) { this.advance(); return { type: 'ImagNum', value: t.value }; }
    if (t.type === TT.STRING) { this.advance(); return { type: 'Str', value: t.value }; }
    if (t.type === TT.KEYWORD && t.value === 'end') { this.advance(); return { type: 'End' }; }
    if (t.type === TT.KEYWORD && t.value === 'true') { this.advance(); return { type: 'Bool', value: true }; }
    if (t.type === TT.KEYWORD && t.value === 'false') { this.advance(); return { type: 'Bool', value: false }; }
    if (t.type === TT.IDENT) { this.advance(); return { type: 'Ident', name: t.value }; }

    if (t.type === TT.LPAREN) {
      this.advance();
      this.bracketStack.push('paren');
      const e = this.parseExpr();
      this.bracketStack.pop();
      this.expect(TT.RPAREN);
      return { type: 'Paren', expr: e };
    }

    if (t.type === TT.LBRACKET) {
      return this.parseMatrixLiteral();
    }

    if (t.type === TT.LBRACE) {
      throw new ParseError('Cell arrays ({...}) are not supported in this app', t);
    }

    if (t.type === TT.AT) {
      this.advance();
      if (this.at(TT.LPAREN)) {
        this.advance();
        const params = [];
        while (!this.at(TT.RPAREN)) {
          params.push(this.expect(TT.IDENT).value);
          if (this.at(TT.COMMA)) this.advance(); else break;
        }
        this.expect(TT.RPAREN);
        const body = this.parseExpr();
        return { type: 'AnonFunc', params, body };
      }
      const name = this.expect(TT.IDENT).value;
      return { type: 'FuncHandle', name };
    }

    throw new ParseError('Unexpected token in expression', t);
  }

  parseMatrixLiteral() {
    this.expect(TT.LBRACKET);
    this.bracketStack.push('bracket');
    const rows = [[]];
    // consume leading newlines/semicolons (blank rows before first element)
    while (this.at(TT.SEMI) || this.at(TT.NEWLINE)) this.advance();
    while (!this.at(TT.RBRACKET)) {
      const row = rows[rows.length - 1];
      const elemStartTok = this.cur();
      const elem = this.parseMatrixElement();
      row.push(elem);
      // Determine separator between elements: comma, whitespace-implied, or
      // row break (`;` or newline at bracket-depth).
      if (this.at(TT.COMMA)) { this.advance(); continue; }
      if (this.at(TT.SEMI)) {
        this.advance();
        while (this.at(TT.SEMI) || this.at(TT.NEWLINE)) this.advance();
        if (!this.at(TT.RBRACKET)) rows.push([]);
        continue;
      }
      if (this.at(TT.NEWLINE)) {
        this.advance();
        while (this.at(TT.SEMI) || this.at(TT.NEWLINE)) this.advance();
        if (!this.at(TT.RBRACKET)) rows.push([]);
        continue;
      }
      if (this.at(TT.RBRACKET)) break;
      // Otherwise: space-separated next element continues the same row
      // (handled by looping back; parseMatrixElement re-checks for a
      // leading unary sign vs. binary continuation using spaceBefore).
    }
    this.bracketStack.pop();
    this.expect(TT.RBRACKET);
    if (rows.length === 1 && rows[0].length === 0) return { type: 'MatrixLit', rows: [] };
    return { type: 'MatrixLit', rows };
  }

  // Parses one matrix element, applying MATLAB's whitespace-sensitive rule:
  // inside `[...]`, `a -b` (space before `-`, none after) starts a NEW
  // element (unary minus), while `a - b` or `a-b` continues the SAME
  // element as a binary subtraction.
  parseMatrixElement() {
    let left = this.parseRelationalInsideMatrix();
    return left;
  }

  // Re-implements the additive level with the space-sensitive split rule;
  // delegates everything above additive to the normal chain.
  parseRelationalInsideMatrix() {
    let left = this.parseRangeInsideMatrix();
    const relOps = new Set(['==', '~=', '<', '>', '<=', '>=']);
    while (this.cur().type === TT.OP && relOps.has(this.cur().value) && !this.looksLikeNewElement()) {
      const op = this.advance().value;
      const right = this.parseRangeInsideMatrix();
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }
  parseRangeInsideMatrix() {
    const start = this.parseAdditiveInsideMatrix();
    if (this.at(TT.COLON)) {
      this.advance();
      const second = this.parseAdditiveInsideMatrix();
      if (this.at(TT.COLON)) {
        this.advance();
        const third = this.parseAdditiveInsideMatrix();
        return { type: 'Range', start, step: second, stop: third };
      }
      return { type: 'Range', start, step: null, stop: second };
    }
    return start;
  }
  parseAdditiveInsideMatrix() {
    let left = this.parseMultiplicative();
    while (this.cur().type === TT.OP && (this.cur().value === '+' || this.cur().value === '-')) {
      if (this.looksLikeNewElement()) break;
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }
  // Heuristic: `+`/`-` has space before it but NOT after -> treat as the
  // start of a new element rather than a binary operator continuing this one.
  looksLikeNewElement() {
    const opTok = this.cur();
    const nextTok = this.peek(1);
    if (!opTok.spaceBefore) return false; // no space before -> definitely binary/unary-glued, continue
    if (nextTok && nextTok.spaceBefore) return false; // space on both sides -> binary
    return true; // space before, none after -> new element
  }
}

export function parse(source) {
  const tokens = tokenize(source);
  const p = new Parser(tokens);
  return p.parseProgram();
}

export { Parser };
