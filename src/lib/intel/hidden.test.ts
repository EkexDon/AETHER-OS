import { describe, expect, it } from "vitest";
import { codePointLabel, hasHiddenCharacters, revealHidden } from "./hidden";

describe("revealHidden", () => {
  it("keeps ordinary text, newlines and tabs as they are", () => {
    expect(revealHidden("npm test\n\tdone")).toEqual([{ kind: "text", text: "npm test\n\tdone" }]);
    expect(revealHidden("")).toEqual([{ kind: "text", text: "" }]);
    expect(hasHiddenCharacters("ls -la ~/D\u00e9veloppement")).toBe(false);
  });

  it("marks bidi overrides, zero-width and control characters", () => {
    const trojan = "rm -rf /tmp/x\u202e#gnirts\u202c";
    expect(revealHidden(trojan)).toEqual([
      { kind: "text", text: "rm -rf /tmp/x" },
      { kind: "hidden", code: "U+202E", name: "right-to-left override" },
      { kind: "text", text: "#gnirts" },
      { kind: "hidden", code: "U+202C", name: "pop directional formatting" },
    ]);
    expect(revealHidden("a\u200bb\u001b[2Kc\r").filter((p) => p.kind === "hidden").map((p) => p.kind === "hidden" && p.code)).toEqual([
      "U+200B",
      "U+001B",
      "U+000D",
    ]);
    expect(hasHiddenCharacters("safe\u2066")).toBe(true);
    // The global regex must not keep state between calls.
    expect(hasHiddenCharacters("x\u200b")).toBe(true);
    expect(hasHiddenCharacters("x\u200b")).toBe(true);
  });

  it("formats code points", () => {
    expect(codePointLabel("\u0007")).toBe("U+0007");
    expect(codePointLabel("\ufeff")).toBe("U+FEFF");
  });
});
