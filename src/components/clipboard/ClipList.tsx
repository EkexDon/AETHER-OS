import { useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { Pin, PinOff } from "lucide-react";
import type { ClipItem } from "../../types";
import { absoluteTime, displayPreview, relativeTime, rowDescription } from "../../lib/clipboard/format";
import { computeWindow, nearEnd, scrollTopToReveal, shouldWindow } from "../../lib/clipboard/windowing";
import { IconButton, ListRow, Spinner, cx } from "../../ui";
import { ClipThumb } from "./ClipThumb";

/** Fixed row height (px); windowing relies on it. */
export const CLIP_ROW_HEIGHT = 50;

export interface ClipListProps {
  items: ClipItem[];
  selectedId: string | null;
  now: Date;
  hasMore: boolean;
  loadingMore: boolean;
  listRef: RefObject<HTMLDivElement>;
  onSelect: (id: string) => void;
  /** Double click: copy. */
  onActivate: (id: string) => void;
  onTogglePin: (id: string) => void;
  onLoadMore: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** DOM id of a row, referenced by `aria-activedescendant`. */
export const clipRowId = (id: string) => `clip-row-${id}`;

/**
 * The history as a keyboard-driven listbox. Focus stays on the list; the
 * active row is announced via `aria-activedescendant`. Lists longer than
 * 200 rows are windowed; scrolling near the end loads the next page.
 */
export function ClipList({
  items,
  selectedId,
  now,
  hasMore,
  loadingMore,
  listRef,
  onSelect,
  onActivate,
  onTogglePin,
  onLoadMore,
  onKeyDown,
}: ClipListProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const windowed = shouldWindow(items.length);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight || 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [listRef]);

  // Keep the selected row in view (keyboard navigation, live inserts).
  const selectedIndex = useMemo(() => items.findIndex((item) => item.id === selectedId), [items, selectedId]);
  useEffect(() => {
    const el = listRef.current;
    if (!el || selectedIndex < 0) return;
    const next = scrollTopToReveal(selectedIndex, CLIP_ROW_HEIGHT, el.scrollTop, el.clientHeight || viewportHeight);
    if (next !== null) {
      el.scrollTop = next;
      setScrollTop(next);
    }
  }, [selectedIndex, listRef, viewportHeight]);

  const range = windowed
    ? computeWindow({ count: items.length, rowHeight: CLIP_ROW_HEIGHT, scrollTop, viewportHeight })
    : { start: 0, end: items.length, offsetTop: 0, totalHeight: items.length * CLIP_ROW_HEIGHT };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (hasMore && !loadingMore && nearEnd({ count: items.length, rowHeight: CLIP_ROW_HEIGHT, scrollTop: el.scrollTop, viewportHeight: el.clientHeight })) {
      onLoadMore();
    }
  };

  const rows = items.slice(range.start, range.end).map((item) => {
    const selected = item.id === selectedId;
    const mono = item.kind === "code" || item.kind === "color";
    return (
      <ListRow
        key={item.id}
        id={clipRowId(item.id)}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        className={cx("clip-row", `clip-row-${item.kind}`)}
        style={{ height: CLIP_ROW_HEIGHT }}
        selected={selected}
        icon={<ClipThumb item={item} />}
        title={<span className={cx("clip-row-title", mono && "mono")}>{displayPreview(item) || "Blank text"}</span>}
        description={rowDescription(item)}
        meta={
          <span className="clip-row-meta">
            {item.pinned && <Pin size={12} className="clip-row-pin" aria-label="Pinned" />}
            <time dateTime={item.last_copied_at} title={absoluteTime(item.last_copied_at)}>
              {relativeTime(item.last_copied_at, now)}
            </time>
          </span>
        }
        actions={
          <IconButton
            size="sm"
            tabIndex={-1}
            tooltip={false}
            label={item.pinned ? "Unpin clip" : "Pin clip"}
            icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            active={item.pinned}
            onClick={() => onTogglePin(item.id)}
          />
        }
        // Keep focus on the listbox so the keyboard keeps working.
        onMouseDown={(e) => {
          e.preventDefault();
          listRef.current?.focus({ preventScroll: true });
        }}
        onClick={() => onSelect(item.id)}
        onDoubleClick={() => onActivate(item.id)}
      />
    );
  });

  return (
    <div
      ref={listRef}
      className="clip-list"
      role="listbox"
      aria-label="Clipboard history"
      tabIndex={0}
      aria-activedescendant={selectedIndex >= 0 ? clipRowId(items[selectedIndex].id) : undefined}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      {windowed ? (
        <div className="clip-list-spacer" style={{ height: range.totalHeight }}>
          <div className="clip-list-window" style={{ transform: `translateY(${range.offsetTop}px)` }}>
            {rows}
          </div>
        </div>
      ) : (
        rows
      )}
      {loadingMore && (
        <div className="clip-list-more" role="status">
          <Spinner size={12} /> Loading more…
        </div>
      )}
    </div>
  );
}
