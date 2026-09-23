/**
 * A tiny, language-agnostic code tokenizer for the clipboard detail pane.
 * It recognises comments (`//`, `/* *\/`, `#`, `--`, `<!-- -->`), strings,
 * numbers, keywords of the common languages, function calls and
 * punctuation — enough for readable highlighting without shipping a real
 * grammar. Tokens are rendered as React text, never as HTML.
 */

/** Token categories (each maps to a CSS class `clip-tok-<type>`). */
export type TokenType = "keyword" | "string" | "comment" | "number" | "function" | "punct" | "plain";

/** A run of source text with one category. */
export interface Token {
  type: TokenType;
  text: string;
}

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue crate def default defer del do elif else enum " +
    "except export extends false final finally fn for from func function go if impl import in instanceof interface " +
    "is lambda let loop match mod module mut namespace new nil none None not null of or and package pass private " +
    "protected pub public raise readonly ref return self Self static struct super switch this throw throws trait " +
    "true True False try type typeof undefined unsafe use using var void where while with yield " +
    "SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX JOIN LEFT RIGHT INNER OUTER ON " +
    "GROUP BY ORDER LIMIT OFFSET AND OR NOT NULL AS DISTINCT PRIMARY KEY REFERENCES"
  ).split(" ")
);

const PUNCT = new Set("{}[]();,.:<>=+-*/%!&|^~?@".split(""));

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/** `#`/`--` start a comment only after whitespace (or at line start) and before a space. */
function startsLineComment(code: string, i: number): number {
  const prev = i === 0 ? "\n" : code[i - 1];
  if (!/\s/.test(prev)) return 0;
  if (code[i] === "#" && (code[i + 1] === " " || code[i + 1] === "!" || code[i + 1] === "\n" || i + 1 === code.length)) {
    return 1;
  }
  if (code.startsWith("-- ", i)) return 2;
  return 0;
}

/** Split `code` into highlighted tokens. Adjacent plain text is merged. */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const push = (type: TokenType, text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type && (type === "plain" || type === "punct")) last.text += text;
    else tokens.push({ type, text });
  };

  let i = 0;
  while (i < code.length) {
    const c = code[i];

    // Comments.
    if (code.startsWith("//", i) || startsLineComment(code, i) > 0) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (code.startsWith("/*", i) || code.startsWith("<!--", i)) {
      const close = code.startsWith("/*", i) ? "*/" : "-->";
      const end = code.indexOf(close, i + 2);
      const stop = end === -1 ? code.length : end + close.length;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Strings (single/double quotes end at the line; backticks may span lines).
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j += 1;
        else if (code[j] === "\n" && c !== "`") break;
        j += 1;
      }
      const stop = Math.min(code.length, j + (code[j] === c ? 1 : 0));
      push("string", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Numbers.
    if (/[0-9]/.test(c) && (i === 0 || !isIdentPart(code[i - 1]))) {
      const match = /^(0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)[a-zA-Z0-9]*/.exec(code.slice(i, i + 64));
      const text = match ? match[0] : c;
      push("number", text);
      i += text.length;
      continue;
    }

    // Identifiers, keywords and calls.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < code.length && isIdentPart(code[j])) j += 1;
      const word = code.slice(i, j);
      let k = j;
      while (k < code.length && (code[k] === " " || code[k] === "\t")) k += 1;
      const type: TokenType = KEYWORDS.has(word) ? "keyword" : code[k] === "(" || code[j] === "!" ? "function" : "plain";
      push(type, word);
      i = j;
      continue;
    }

    push(PUNCT.has(c) ? "punct" : "plain", c);
    i += 1;
  }
  return tokens;
}
