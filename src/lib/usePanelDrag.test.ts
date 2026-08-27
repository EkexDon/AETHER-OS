import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePanelDrag } from "./usePanelDrag";

describe("usePanelDrag", () => {
  const mouseEvent = (x: number, y: number) =>
    ({ clientX: x, clientY: y, preventDefault: () => undefined }) as React.MouseEvent;

  it("clamps horizontal drags to [min, max] and reports via onChange", () => {
    const sizes: number[] = [];
    const { result } = renderHook(() =>
      usePanelDrag({
        axis: "x",
        defaultSize: 240,
        min: 170,
        max: 400,
        onChange: (size) => sizes.push(size),
      })
    );

    result.current(mouseEvent(500, 0)); // start at 500
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 640, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientY: 0 }));

    // 640-500 = +140 → clamped to 400; 200-500 = -300 → clamped to 170.
    expect(sizes).toEqual([380, 170]);
  });

  it("supports vertical drags for the terminal divider", () => {
    const sizes: number[] = [];
    const { result } = renderHook(() =>
      usePanelDrag({
        axis: "y",
        defaultSize: 220,
        min: 120,
        max: 720,
        onChange: (size) => sizes.push(size),
      })
    );

    result.current(mouseEvent(0, 300));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 380 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientY: 0 }));

    expect(sizes).toEqual([300]);
  });

  it("inverts the delta for bottom-anchored panels: up grows, down shrinks", () => {
    const sizes: number[] = [];
    const { result } = renderHook(() =>
      usePanelDrag({
        axis: "y",
        defaultSize: 220,
        min: 120,
        max: 720,
        invert: true,
        onChange: (size) => sizes.push(size),
      })
    );

    result.current(mouseEvent(0, 300));
    // Dragging UP (clientY decreases) must GROW the panel: 220 + 60 = 280.
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 240 }));
    // Dragging DOWN must SHRINK it: 220 - 180 = 40 → clamped to min 120.
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 480 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientY: 0 }));

    expect(sizes).toEqual([280, 120]);
  });

  it("restores a persisted size on mount", () => {
    window.localStorage.setItem("test-panel-size", "321");
    const sizes: number[] = [];
    renderHook(() =>
      usePanelDrag({
        axis: "x",
        storageKey: "test-panel-size",
        defaultSize: 240,
        min: 170,
        max: 400,
        onChange: (size) => sizes.push(size),
      })
    );
    expect(sizes).toContain(321);
    window.localStorage.removeItem("test-panel-size");
  });

  it("persists the final size on mouse-up", () => {
    const { result } = renderHook(() =>
      usePanelDrag({
        axis: "x",
        storageKey: "test-panel-persist",
        defaultSize: 240,
        min: 170,
        max: 400,
        onChange: () => undefined,
      })
    );

    result.current(mouseEvent(100, 0));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 160, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientY: 0 }));

    expect(window.localStorage.getItem("test-panel-persist")).toBe("300");
    window.localStorage.removeItem("test-panel-persist");
  });
});
