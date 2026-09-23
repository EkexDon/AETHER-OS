import { useEffect, useState } from "react";
import { useThemeStore } from "./theme";
import { useAppearanceStore } from "./appearance";

/**
 * Bridge from CSS design tokens to JavaScript for surfaces that cannot use
 * CSS variables directly (canvas renderers, xterm, Monaco, SVG attributes).
 * Values are read from the computed style of `<html>`, so they always match
 * the active theme and accent.
 */

/** Read one custom property (e.g. `--color-accent`) as a trimmed string. */
export function readToken(name: string, root: HTMLElement = document.documentElement): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/** Read several custom properties at once. */
export function readTokens<T extends string>(names: readonly T[]): Record<T, string> {
  const out = {} as Record<T, string>;
  if (typeof window === "undefined") {
    for (const n of names) out[n] = "";
    return out;
  }
  const style = getComputedStyle(document.documentElement);
  for (const n of names) out[n] = style.getPropertyValue(n).trim();
  return out;
}

/**
 * Subscribe to "the tokens changed" — fires after the theme or accent
 * changes (on the next frame, once the new attribute has been applied).
 */
export function onTokensChange(listener: () => void): () => void {
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      listener();
    });
  };
  const offTheme = useThemeStore.subscribe((s, prev) => {
    if (s.resolved !== prev.resolved) schedule();
  });
  const offAccent = useAppearanceStore.subscribe((s, prev) => {
    if (s.accent !== prev.accent) schedule();
  });
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    offTheme();
    offAccent();
  };
}

/**
 * React hook returning resolved token values that update whenever the theme
 * or accent changes. Pass a stable (module-level) array of names.
 */
export function useTokens<T extends string>(names: readonly T[]): Record<T, string> {
  const resolved = useThemeStore((s) => s.resolved);
  const accent = useAppearanceStore((s) => s.accent);
  const [values, setValues] = useState(() => readTokens(names));
  useEffect(() => {
    // `names` is expected to be a stable, module-level constant.
    setValues(readTokens(names));
  }, [resolved, accent]);
  return values;
}

/**
 * Convert a token value (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`) to `#rrggbb`
 * or `#rrggbbaa` — the format Monaco themes require. Unknown input is
 * returned unchanged.
 */
export function toHex(color: string): string {
  const c = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c.toLowerCase();
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (!rgb) return c;
  const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
  const [r, g, b] = parts.slice(0, 3).map((p) => Math.max(0, Math.min(255, Math.round(Number(p)))));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  let out = `#${hex(r)}${hex(g)}${hex(b)}`;
  if (parts[3] !== undefined) {
    const a = parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
    if (Number.isFinite(a) && a < 1) out += hex(Math.round(Math.max(0, a) * 255));
  }
  return out;
}

/** Convert `#rrggbb` (or `rgb()/rgba()`) into `rgba(r, g, b, alpha)`. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((p) => p.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return c;
}
