import { useEffect, useState, type RefObject } from "react";

/**
 * Current time in ms, refreshed every `intervalMs` so relative labels
 * ("2m ago") stay current without re-rendering on every tick.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Width of an element, tracked with `ResizeObserver`; `null` until measured
 * (and in environments without layout, e.g. tests).
 */
export function useElementWidth(ref: RefObject<HTMLElement>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === "number" && next > 0) setWidth(Math.round(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
