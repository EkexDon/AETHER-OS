import { describe, expect, it } from "vitest";
import { computeWindow, nearEnd, scrollTopToReveal, shouldWindow, WINDOWING_THRESHOLD } from "./windowing";

describe("computeWindow", () => {
  it("renders only the rows around the viewport", () => {
    const range = computeWindow({ count: 1000, rowHeight: 50, scrollTop: 5000, viewportHeight: 500, overscan: 5 });
    expect(range.start).toBe(95);
    expect(range.end).toBe(116);
    expect(range.offsetTop).toBe(95 * 50);
    expect(range.totalHeight).toBe(50_000);
  });

  it("clamps at both ends", () => {
    expect(computeWindow({ count: 10, rowHeight: 50, scrollTop: -40, viewportHeight: 200 })).toMatchObject({ start: 0, end: 10 });
    const bottom = computeWindow({ count: 300, rowHeight: 50, scrollTop: 999_999, viewportHeight: 500, overscan: 0 });
    expect(bottom.end).toBe(300);
    expect(bottom.start).toBe(290);
  });

  it("handles empty lists", () => {
    expect(computeWindow({ count: 0, rowHeight: 50, scrollTop: 0, viewportHeight: 500 })).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it("windows only long lists", () => {
    expect(shouldWindow(WINDOWING_THRESHOLD)).toBe(false);
    expect(shouldWindow(WINDOWING_THRESHOLD + 1)).toBe(true);
  });
});

describe("scrolling helpers", () => {
  it("reveals rows above and below the viewport", () => {
    expect(scrollTopToReveal(2, 50, 200, 300)).toBe(100);
    expect(scrollTopToReveal(12, 50, 0, 300)).toBe(350);
    expect(scrollTopToReveal(4, 50, 100, 300)).toBeNull();
    expect(scrollTopToReveal(-1, 50, 0, 300)).toBeNull();
  });

  it("detects the end of the list", () => {
    expect(nearEnd({ count: 200, rowHeight: 50, scrollTop: 9000, viewportHeight: 500 })).toBe(true);
    expect(nearEnd({ count: 200, rowHeight: 50, scrollTop: 0, viewportHeight: 500 })).toBe(false);
  });
});
