/**
 * Focus Mode plumbing: the `data-focus` flag on `<html>` (styled in
 * `src/styles/views/home.css`) and the "press Escape twice to exit"
 * detector.
 */

/** Attribute that home.css keys the focus-mode rules on. */
export const FOCUS_ATTRIBUTE = "data-focus";

/** Set or clear `data-focus="true"` on the root element. */
export function applyFocusMode(on: boolean, root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null): void {
  if (!root) return;
  if (on) root.setAttribute(FOCUS_ATTRIBUTE, "true");
  else root.removeAttribute(FOCUS_ATTRIBUTE);
}

/** Maximum gap between the two Escape presses. */
export const DOUBLE_ESCAPE_WINDOW_MS = 600;

/**
 * Returns a function to feed every Escape press with its timestamp; it
 * answers `true` for the second press within `windowMs` of the first (and
 * then starts over, so a third press does not count again).
 */
export function createDoubleEscapeDetector(windowMs: number = DOUBLE_ESCAPE_WINDOW_MS): (at: number) => boolean {
  let last: number | null = null;
  return (at: number) => {
    if (last !== null && at - last >= 0 && at - last <= windowMs) {
      last = null;
      return true;
    }
    last = at;
    return false;
  };
}
