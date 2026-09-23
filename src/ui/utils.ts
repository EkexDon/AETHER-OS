import type { MutableRefObject, Ref, RefCallback } from "react";

/** Join truthy class names. */
export function cx(...parts: Array<string | number | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

/** Merge several refs (object or callback) into one callback ref. */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (value: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(value);
      else (ref as MutableRefObject<T | null>).current = value;
    }
  };
}

/** Placement of a floating element relative to its anchor. */
export type Placement =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-start"
  | "top-end"
  | "bottom-start"
  | "bottom-end";

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Position {
  top: number;
  left: number;
  placement: Placement;
}

const VIEWPORT_MARGIN = 8;

function side(p: Placement): "top" | "bottom" | "left" | "right" {
  return p.split("-")[0] as "top" | "bottom" | "left" | "right";
}

function opposite(p: Placement): Placement {
  const [s, align] = p.split("-");
  const flipped = s === "top" ? "bottom" : s === "bottom" ? "top" : s === "left" ? "right" : "left";
  return (align ? `${flipped}-${align}` : flipped) as Placement;
}

function place(anchor: RectLike, size: { width: number; height: number }, p: Placement, offset: number) {
  const [s, align] = p.split("-");
  let top = 0;
  let left = 0;
  if (s === "top" || s === "bottom") {
    top = s === "top" ? anchor.top - size.height - offset : anchor.top + anchor.height + offset;
    if (align === "start") left = anchor.left;
    else if (align === "end") left = anchor.left + anchor.width - size.width;
    else left = anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    left = s === "left" ? anchor.left - size.width - offset : anchor.left + anchor.width + offset;
    top = anchor.top + anchor.height / 2 - size.height / 2;
  }
  return { top, left };
}

function fits(pos: { top: number; left: number }, size: { width: number; height: number }, vp: { width: number; height: number }, s: string) {
  if (s === "top") return pos.top >= VIEWPORT_MARGIN;
  if (s === "bottom") return pos.top + size.height <= vp.height - VIEWPORT_MARGIN;
  if (s === "left") return pos.left >= VIEWPORT_MARGIN;
  return pos.left + size.width <= vp.width - VIEWPORT_MARGIN;
}

/**
 * Compute where to put a floating element (tooltip, popover). Flips to the
 * opposite side when the preferred side overflows, then clamps into the
 * viewport so it is never cut off.
 */
export function computePosition(
  anchor: RectLike,
  size: { width: number; height: number },
  placement: Placement,
  viewport: { width: number; height: number },
  offset = 6
): Position {
  let chosen = placement;
  let pos = place(anchor, size, chosen, offset);
  if (!fits(pos, size, viewport, side(chosen))) {
    const alt = opposite(chosen);
    const altPos = place(anchor, size, alt, offset);
    if (fits(altPos, size, viewport, side(alt))) {
      chosen = alt;
      pos = altPos;
    }
  }
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - size.width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - size.height - VIEWPORT_MARGIN);
  return {
    top: Math.round(Math.min(Math.max(pos.top, VIEWPORT_MARGIN), maxTop)),
    left: Math.round(Math.min(Math.max(pos.left, VIEWPORT_MARGIN), maxLeft)),
    placement: chosen,
  };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** All keyboard-focusable descendants, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true"
  );
}
