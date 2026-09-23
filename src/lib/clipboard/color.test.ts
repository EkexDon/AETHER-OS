import { describe, expect, it } from "vitest";
import { parseColor, toCss, toHex, toHsl, toRgb } from "./color";

describe("parseColor", () => {
  it("parses hex forms", () => {
    expect(parseColor("#3fb0a3")).toEqual({ r: 63, g: 176, b: 163, a: 1 });
    expect(parseColor("#FFF")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0008")?.a).toBeCloseTo(0.533, 2);
    expect(parseColor(" #3fb0a380 ")?.a).toBeCloseTo(0.5, 2);
  });

  it("parses rgb() and hsl() in comma and space syntax", () => {
    expect(parseColor("rgb(63, 176, 163)")).toEqual({ r: 63, g: 176, b: 163, a: 1 });
    expect(parseColor("rgba(63,176,163,0.5)")).toEqual({ r: 63, g: 176, b: 163, a: 0.5 });
    expect(parseColor("rgb(63 176 163 / 50%)")).toEqual({ r: 63, g: 176, b: 163, a: 0.5 });
    expect(parseColor("rgb(100% 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("hsl(120deg 100% 25%)")).toEqual({ r: 0, g: 128, b: 0, a: 1 });
    expect(parseColor("hsla(0.5turn 100% 50% / .25)")).toEqual({ r: 0, g: 255, b: 255, a: 0.25 });
  });

  it("rejects everything else", () => {
    for (const bad of ["red", "#12", "#ggg", "rgb(1,2)", "rgb(1 2 3 4 5)", "rgb(1 2 / 3)", "url(x)", "rgb(1,2,3); background: red", ""]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });
});

describe("formatting", () => {
  it("round-trips through hex, rgb and hsl", () => {
    const teal = parseColor("#3fb0a3")!;
    expect(toHex(teal)).toBe("#3fb0a3");
    expect(toRgb(teal)).toBe("rgb(63 176 163)");
    expect(toHsl(teal)).toBe("hsl(173 47% 47%)");
    const translucent = { r: 63, g: 176, b: 163, a: 0.5 };
    expect(toHex(translucent)).toBe("#3fb0a380");
    expect(toRgb(translucent)).toBe("rgb(63 176 163 / 0.5)");
    expect(toHsl(translucent)).toBe("hsl(173 47% 47% / 0.5)");
    expect(toHsl({ r: 128, g: 128, b: 128, a: 1 })).toBe("hsl(0 0% 50%)");
  });

  it("produces a safe CSS value", () => {
    expect(toCss({ r: 1, g: 2, b: 3, a: 0.25 })).toBe("rgba(1, 2, 3, 0.25)");
  });
});
