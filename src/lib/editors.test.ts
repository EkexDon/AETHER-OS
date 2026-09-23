import { describe, expect, it } from "vitest";
import { editorLabel, editorNameProblem } from "./editors";

describe("editors", () => {
  it("labels known keys, custom app names and legacy paths", () => {
    expect(editorLabel("code")).toBe("VS Code");
    expect(editorLabel("CURSOR")).toBe("Cursor");
    expect(editorLabel("Sublime Text")).toBe("Sublime Text");
    expect(editorLabel("/Applications/Zed.app")).toBe("Zed");
    expect(editorLabel("")).toBe("your editor");
    expect(editorLabel("constructor")).toBe("constructor");
  });

  it("accepts only plain macOS application names, like Rust", () => {
    expect(editorNameProblem("Zed")).toBeNull();
    expect(editorNameProblem("Sublime Text")).toBeNull();
    expect(editorNameProblem("/Applications/Zed.app")).toMatch(/not a path/);
    expect(editorNameProblem("C:\\Tools\\code.exe")).toMatch(/not a path/);
    expect(editorNameProblem("--args")).toMatch(/cannot start/);
    expect(editorNameProblem(".hidden")).toMatch(/cannot start/);
    expect(editorNameProblem("Zed\u0007")).toMatch(/control/);
    expect(editorNameProblem("   ")).toMatch(/Enter/);
    expect(editorNameProblem("x".repeat(101))).toMatch(/100/);
  });
});
