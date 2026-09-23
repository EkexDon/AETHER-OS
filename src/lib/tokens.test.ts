import { describe, expect, it } from "vitest";
import { readToken, readTokens, toHex, withAlpha } from "./tokens";

describe("token conversion", () => {
  it("normalises colors to hex for Monaco", () => {
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("#1B7A70")).toBe("#1b7a70");
    expect(toHex("rgb(255, 0, 16)")).toBe("#ff0010");
    expect(toHex("rgba(236, 232, 222, 0.5)")).toBe("#ece8de80");
    expect(toHex("rgba(10, 9, 8, 1)")).toBe("#0a0908");
    expect(toHex("var(--x)")).toBe("var(--x)");
  });

  it("adds alpha to hex and rgb colors", () => {
    expect(withAlpha("#3fb0a3", 0.25)).toBe("rgba(63, 176, 163, 0.25)");
    expect(withAlpha("#fff", 0.1)).toBe("rgba(255, 255, 255, 0.1)");
    expect(withAlpha("rgba(1, 2, 3, 0.9)", 0.2)).toBe("rgba(1, 2, 3, 0.2)");
  });

  it("reads custom properties from the root element", () => {
    document.documentElement.style.setProperty("--color-test", " #123456 ");
    expect(readToken("--color-test")).toBe("#123456");
    expect(readTokens(["--color-test", "--color-missing"])).toEqual({
      "--color-test": "#123456",
      "--color-missing": "",
    });
    document.documentElement.style.removeProperty("--color-test");
  });
});
