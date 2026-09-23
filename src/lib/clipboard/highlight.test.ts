import { describe, expect, it } from "vitest";
import { tokenize, type TokenType } from "./highlight";

const typesOf = (code: string, type: TokenType) =>
  tokenize(code)
    .filter((t) => t.type === type)
    .map((t) => t.text);

describe("tokenize", () => {
  it("round-trips the source exactly", () => {
    const code = 'fn main() {\n    let x = "hi"; // greet\n    println!("{x}", 0x1F);\n}\n';
    expect(
      tokenize(code)
        .map((t) => t.text)
        .join("")
    ).toBe(code);
  });

  it("finds keywords, strings, numbers, comments and calls", () => {
    const code = 'const total = sum(items, 42.5); // done\n/* block */ return "ok";';
    expect(typesOf(code, "keyword")).toEqual(["const", "return"]);
    expect(typesOf(code, "string")).toEqual(['"ok"']);
    expect(typesOf(code, "number")).toEqual(["42.5"]);
    expect(typesOf(code, "comment")).toEqual(["// done", "/* block */"]);
    expect(typesOf(code, "function")).toEqual(["sum"]);
  });

  it("treats # and -- as comments only after whitespace", () => {
    expect(typesOf("x = 1 # note\ncolor: #fff", "comment")).toEqual(["# note"]);
    expect(typesOf("SELECT 1 -- why\nfoo--bar", "comment")).toEqual(["-- why"]);
    expect(typesOf("#include <stdio.h>", "comment")).toEqual([]);
  });

  it("handles escapes and unterminated strings", () => {
    expect(typesOf('"a \\" b" c', "string")).toEqual(['"a \\" b"']);
    expect(typesOf("'open\nnext", "string")).toEqual(["'open"]);
    expect(typesOf("`multi\nline`", "string")).toEqual(["`multi\nline`"]);
  });

  it("does not split identifiers containing digits", () => {
    expect(typesOf("v2 = h264", "number")).toEqual([]);
  });
});
