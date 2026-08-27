import { useCallback, useEffect, useRef } from "react";

export type DragAxis = "x" | "y";

interface UsePanelDragOptions {
  axis: DragAxis;
  /** Persist under this localStorage key (sizes survive restarts). */
  storageKey?: string;
  defaultSize: number;
  min: number;
  max: number;
  onChange: (size: number) => void;
  /**
   * Set for panels anchored at the bottom/right edge of the window: there,
   * moving the divider UP (negative delta) makes the panel BIGGER, so the
   * pointer delta must be negated.
   */
  invert?: boolean;
}

/**
 * Shared drag-to-resize behaviour for panel dividers.
 *
 * Returns an `onMouseDown` handler for the divider element. While dragging,
 * the body gets `user-select: none` and the matching resize cursor; the
 * size is clamped to [min, max] and persisted to localStorage on release.
 */
export function usePanelDrag({
  axis,
  storageKey,
  defaultSize,
  min,
  max,
  onChange,
  invert = false,
}: UsePanelDragOptions) {
  const sizeRef = useRef(defaultSize);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    // Restore persisted size once on mount.
    if (!storageKey) return;
    const raw = window.localStorage.getItem(storageKey);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        onChangeRef.current(Math.max(min, Math.min(max, parsed)));
      }
    }
    // min/max are constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startPos = axis === "x" ? e.clientX : e.clientY;
      const startSize = sizeRef.current;
      const cursor = axis === "x" ? "col-resize" : "row-resize";
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";

      const onMove = (move: MouseEvent) => {
        const rawDelta = (axis === "x" ? move.clientX : move.clientY) - startPos;
        const delta = invert ? -rawDelta : rawDelta;
        const next = Math.max(min, Math.min(max, startSize + delta));
        sizeRef.current = next;
        onChangeRef.current(next);
      };

      const onUp = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (storageKey) {
          window.localStorage.setItem(storageKey, String(sizeRef.current));
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [axis, invert, min, max, storageKey]
  );

  return onMouseDown;
}
