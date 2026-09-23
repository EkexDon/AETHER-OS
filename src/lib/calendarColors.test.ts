import { describe, expect, it } from "vitest";
import { CALENDAR_COLORS, DEFAULT_CALENDAR_COLOR } from "./calendarColors";

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Canvas and card/modal surfaces of both themes (see docs/dev/DESIGN-SYSTEM.md §2).
const SURFACES = { darkBg: "#131312", darkElevated: "#1e1e1c", lightBg: "#f8f7f4", lightElevated: "#fdfcfa" };

describe("calendar colours", () => {
  it("defaults to the teal the backend uses", () => {
    expect(DEFAULT_CALENDAR_COLOR).toBe("#0f9d8a");
    expect(CALENDAR_COLORS[0]).toBe(DEFAULT_CALENDAR_COLOR);
  });

  it("offers eight distinct #rrggbb swatches without the old purple", () => {
    expect(CALENDAR_COLORS).toHaveLength(8);
    expect(new Set(CALENDAR_COLORS.map((c) => c.toLowerCase())).size).toBe(8);
    for (const c of CALENDAR_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(CALENDAR_COLORS).not.toContain("#7c3aed");
  });

  it("keeps every swatch at 3:1 or more on dark and light surfaces", () => {
    for (const color of CALENDAR_COLORS) {
      for (const [name, surface] of Object.entries(SURFACES)) {
        expect(contrast(color, surface), `${color} on ${name}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
