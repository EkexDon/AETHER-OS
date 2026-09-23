/**
 * Fixed-row-height windowing for long clipboard lists: only the rows in (or
 * near) the viewport are rendered once the history exceeds
 * {@link WINDOWING_THRESHOLD} items.
 */

/** Lists longer than this are windowed. */
export const WINDOWING_THRESHOLD = 200;

/** Rows rendered above and below the viewport. */
export const DEFAULT_OVERSCAN = 8;

/** Which slice of the list to render and where to place it. */
export interface WindowRange {
  /** First rendered index (inclusive). */
  start: number;
  /** Last rendered index (exclusive). */
  end: number;
  /** Top offset (px) of the first rendered row. */
  offsetTop: number;
  /** Height (px) of the full list. */
  totalHeight: number;
}

/** Should a list of `count` rows be windowed? */
export function shouldWindow(count: number): boolean {
  return count > WINDOWING_THRESHOLD;
}

/** The rows to render for the current scroll position. */
export function computeWindow(opts: {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): WindowRange {
  const { count, rowHeight, scrollTop, viewportHeight, overscan = DEFAULT_OVERSCAN } = opts;
  const totalHeight = Math.max(0, count) * rowHeight;
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  const maxTop = Math.max(0, totalHeight - viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), maxTop);
  const first = Math.floor(top / rowHeight);
  const visible = Math.ceil(Math.max(viewportHeight, rowHeight) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, offsetTop: start * rowHeight, totalHeight };
}

/**
 * The `scrollTop` that brings row `index` fully into view, or `null` when
 * it is already visible.
 */
export function scrollTopToReveal(index: number, rowHeight: number, scrollTop: number, viewportHeight: number): number | null {
  if (index < 0) return null;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return null;
}

/** Load the next page when fewer than this many rows remain below the viewport. */
export const LOAD_MORE_THRESHOLD_ROWS = 12;

/** Is the viewport close enough to the end of the list to fetch more? */
export function nearEnd(opts: { count: number; rowHeight: number; scrollTop: number; viewportHeight: number }): boolean {
  const { count, rowHeight, scrollTop, viewportHeight } = opts;
  const remaining = count * rowHeight - (scrollTop + viewportHeight);
  return remaining < LOAD_MORE_THRESHOLD_ROWS * rowHeight;
}
