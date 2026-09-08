// lexer.js — Tokenizer for the MATLAB-compatible language subset.
//
// Notable design decisions (documented further in README):
//  - `'` is context-sensitive: transpose operator after a value-producing
//    token (identifier, number, `)`, `]`, `}`, or another transpose),
//    otherwise the start of a string literal. This mirrors real MATLAB.
//  - `.'`, `.*`, `./`, `.^`, `.\` are lexed as single two-character operator
//    tokens. A bare `.` (struct field access) is lexed as DOT; the parser
//    accepts it so we can raise a clear "structs are not supported" error
//    later instead of a raw syntax error.
//  - Numbers with a trailing `i`/`j` (optionally with a preceding space,
//    e.g. `3i`, `4.5e2j`) are tokenized as IMAG_NUMBER.
//  - `%{ ... %}` block comments require the delimiters to be alone on their
//    own line (whitespace aside), matching MATLAB's rule.
//  - Line continuation `...` swallows the rest of the line and the newline.
//  - Newlines and `;`/`,` are significant and are emitted as tokens; the
//    parser decides statement boundaries and output-suppression.

export const TT = Object.freeze({
  NUMBER: 'NUMBER',
  IMAG_NUMBER: 'IMAG_NUMBER',
  STRING: 'STRING',
  IDENT: 'IDENT',
  KEYWORD: 'KEYWORD',
  OP: 'OP',
  LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  LBRACKET: 'LBRACKET', RBRACKET: 'RBRACKET',
  LBRACE: 'LBRACE', RBRACE: 'RBRACE',
  COMMA: 'COMMA', SEMI: 'SEMI', COLON: 'COLON', DOT: 'DOT',
  AT: 'AT', EQUALS: 'EQUALS',
  NEWLINE: 'NEWLINE',
  EOF: 'EOF',
});

const KEYWORDS = new Set([
  'if', 'elseif', 'else', 'end', 'for', 'while', 'switch', 'case',
  'otherwise', 'break', 'continue', 'return', 'function', 'global',
  'persistent', 'true', 'false',
]);

// Tokens after which a `'` means transpose rather than "start a string".
function endsValue(tok) {
  if (!tok) return false;
  if (tok.type === TT.IDENT) return true;
  if (tok.type === TT.NUMBER || tok.type === TT.IMAG_NUMBER) return true;
  if (tok.type === TT.RPAREN || tok.type === TT.RBRACKET || tok.type === TT.RBRACE) return true;
  if (tok.type === TT.OP && (tok.value === "'" || tok.value === ".'")) return true;
  if (tok.type === TT.KEYWORD && tok.value === 'end') return true;
  return false;
}

export class LexError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = 'LexError';
    this.line = line;
    this.col = col;
  }
}

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;
  let line = 1, col = 1;

  function peekCh(off = 0) { return source[i + off]; }
  function advance() {
    const c = source[i++];
    if (c === '\n') { line++; col = 1; } else { col++; }
    return c;
  }
  let sawSpace = false;
  function push(type, value) {
    tokens.push({ type, value, line, col, spaceBefore: sawSpace });
    sawSpace = false;
  }
  function lastReal() {
    for (let k = tokens.length - 1; k >= 0; k--) {
      if (tokens[k].type !== TT.NEWLINE) return tokens[k];
    }
    return null;
  }

  while (i < n) {
    const c = peekCh();
    const startLine = line, startCol = col;

    // Line continuation "..."
    if (c === '.' && peekCh(1) === '.' && peekCh(2) === '.') {
      advance(); advance(); advance();
      while (i < n && peekCh() !== '\n') advance();
      if (i < n) advance(); // consume the newline itself (continuation, no NEWLINE token)
      sawSpace = true;
      continue;
    }

    // Whitespace (not newline)
    if (c === ' ' || c === '\t' || c === '\r') { advance(); sawSpace = true; continue; }

    if (c === '\n') {
      advance();
      // Collapse consecutive blank lines into one NEWLINE token
      if (tokens.length && tokens[tokens.length - 1].type !== TT.NEWLINE) {
        tokens.push({ type: TT.NEWLINE, value: '\n', line: startLine, col: startCol });
      }
      continue;
    }

    // Block comment %{ / %} must be alone on their line
    if (c === '%' && peekCh(1) === '{') {
      const restOfLine = source.slice(i + 2).split('\n')[0];
      if (restOfLine.trim() === '') {
        // consume until a line that is exactly %} (trimmed)
        while (i < n) {
          // skip to end of current line
          while (i < n && peekCh() !== '\n') advance();
          if (i < n) advance();
          // check this new line
          let j = i;
          while (j < n && (source[j] === ' ' || source[j] === '\t')) j++;
          if (source.slice(j, j + 2) === '%}') {
            const restAfter = source.slice(j + 2).split('\n')[0];
            if (restAfter.trim() === '') {
              // consume up to and including this line
              while (i < j) advance();
              advance(); advance(); // consume %}
              while (i < n && peekCh() !== '\n') advance();
              break;
            }
          }
          if (i >= n) break;
        }
        continue;
      }
    }

    // Line comment
    if (c === '%') {
      while (i < n && peekCh() !== '\n') advance();
      continue;
    }

    // Numbers (including leading-dot decimals like .5)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(peekCh(1) || ''))) {
      let s = '';
      while (/[0-9]/.test(peekCh() || '')) s += advance();
      if (peekCh() === '.' && !(peekCh(1) === '.' && peekCh(2) === '.')) {
        s += advance();
        while (/[0-9]/.test(peekCh() || '')) s += advance();
      }
      if (peekCh() === 'e' || peekCh() === 'E') {
        let look = 1;
        let exp = peekCh();
        let sign = '';
        if (peekCh(1) === '+' || peekCh(1) === '-') { sign = peekCh(1); look = 2; }
        if (/[0-9]/.test(peekCh(look) || '')) {
          s += advance(); // e
          if (sign) s += advance(); // sign
          while (/[0-9]/.test(peekCh() || '')) s += advance();
        }
      }
      if (peekCh() === 'i' || peekCh() === 'j' || peekCh() === 'I' || peekCh() === 'J') {
        // only treat as imaginary suffix if not immediately followed by more
        // identifier characters (so `ix` stays an identifier lexed separately)
        const nxt = peekCh(1);
        if (!(nxt && /[A-Za-z0-9_]/.test(nxt))) {
          advance();
          push(TT.IMAG_NUMBER, parseFloat(s));
          continue;
        }
      }
      push(TT.NUMBER, parseFloat(s));
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (/[A-Za-z0-9_]/.test(peekCh() || '')) s += advance();
      if (KEYWORDS.has(s)) push(TT.KEYWORD, s);
      else push(TT.IDENT, s);
      continue;
    }

    // String literal (single-quoted char array) vs transpose
    if (c === "'") {
      if (endsValue(lastReal())) {
        advance();
        push(TT.OP, "'");
        continue;
      }
      advance(); // opening quote
      let s = '';
      while (true) {
        if (i >= n) throw new LexError('Unterminated string literal', startLine, startCol);
        if (peekCh() === "'") {
          if (peekCh(1) === "'") { s += "'"; advance(); advance(); continue; }
          advance();
          break;
        }
        if (peekCh() === '\n') throw new LexError('Unterminated string literal', startLine, startCol);
        s += advance();
      }
      push(TT.STRING, s);
      continue;
    }

    // Double-quoted strings are not part of the supported subset.
    if (c === '"') {
      throw new LexError(
        'Double-quoted strings ("...") are not supported; use single quotes (\'...\') for char arrays',
        startLine, startCol);
    }

    // Two/three character operators
    const two = c + (peekCh(1) || '');
    if (two === '.*' || two === './' || two === ".'" || two === '.^' || two === '.\\') {
      advance(); advance();
      push(TT.OP, two);
      continue;
    }
    if (two === '==' || two === '~=' || two === '<=' || two === '>=' ||
        two === '&&' || two === '||') {
      advance(); advance();
      push(TT.OP, two);
      continue;
    }

    switch (c) {
      case '(': advance(); push(TT.LPAREN, '('); continue;
      case ')': advance(); push(TT.RPAREN, ')'); continue;
      case '[': advance(); push(TT.LBRACKET, '['); continue;
      case ']': advance(); push(TT.RBRACKET, ']'); continue;
      case '{': advance(); push(TT.LBRACE, '{'); continue;
      case '}': advance(); push(TT.RBRACE, '}'); continue;
      case ',': advance(); push(TT.COMMA, ','); continue;
      case ';': advance(); push(TT.SEMI, ';'); continue;
      case ':': advance(); push(TT.COLON, ':'); continue;
      case '@': advance(); push(TT.AT, '@'); continue;
      case '.': advance(); push(TT.DOT, '.'); continue;
      case '=': advance(); push(TT.EQUALS, '='); continue;
      case '+': case '-': case '*': case '/': case '^': case '\\':
      case '<': case '>': case '~': case '&': case '|':
        advance(); push(TT.OP, c); continue;
      default:
        throw new LexError(`Unexpected character '${c}'`, startLine, startCol);
    }
  }

  push(TT.EOF, null);
  return tokens;
}
