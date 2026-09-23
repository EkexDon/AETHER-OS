import { create } from "zustand";

/**
 * Appearance preferences besides the theme: accent color, UI density and
 * whether the navigation rail shows labels. Each is persisted in
 * localStorage and mirrored onto `<html>` as a data attribute so the design
 * tokens in `src/styles/tokens.css` can react to it.
 */

/** The curated accent palette. Exactly one accent is active at a time. */
export const ACCENTS = [
  { id: "teal", label: "Teal", swatch: "#3fb0a3" },
  { id: "ember", label: "Ember", swatch: "#e27a4e" },
  { id: "cobalt", label: "Cobalt", swatch: "#6d9cf0" },
  { id: "graphite", label: "Graphite", swatch: "#8f8c84" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];
export type Density = "comfortable" | "compact";

export const ACCENT_STORAGE_KEY = "aether-accent";
export const DENSITY_STORAGE_KEY = "aether-density";
export const RAIL_EXPANDED_STORAGE_KEY = "aether-rail-expanded";

export const DEFAULT_ACCENT: AccentId = "teal";

/** Parse a stored accent id; unknown values fall back to the default. */
export function parseAccent(raw: string | null | undefined): AccentId {
  return ACCENTS.some((a) => a.id === raw) ? (raw as AccentId) : DEFAULT_ACCENT;
}

/** Parse a stored density; unknown values fall back to comfortable. */
export function parseDensity(raw: string | null | undefined): Density {
  return raw === "compact" ? "compact" : "comfortable";
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — keep the in-memory value
  }
}

/** Mirror appearance values onto the root element. */
export function applyAppearance(
  values: { accent: AccentId; density: Density },
  root: HTMLElement = document.documentElement
): void {
  root.dataset.accent = values.accent;
  root.dataset.density = values.density;
}

interface AppearanceState {
  accent: AccentId;
  density: Density;
  railExpanded: boolean;
  setAccent: (accent: AccentId) => void;
  setDensity: (density: Density) => void;
  setRailExpanded: (expanded: boolean) => void;
  toggleRailExpanded: () => void;
}

const hasWindow = typeof window !== "undefined";

/** Global appearance store. */
export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  accent: hasWindow ? parseAccent(read(ACCENT_STORAGE_KEY)) : DEFAULT_ACCENT,
  density: hasWindow ? parseDensity(read(DENSITY_STORAGE_KEY)) : "comfortable",
  railExpanded: hasWindow ? read(RAIL_EXPANDED_STORAGE_KEY) === "true" : false,
  setAccent: (accent) => {
    write(ACCENT_STORAGE_KEY, accent);
    applyAppearance({ accent, density: get().density });
    set({ accent });
  },
  setDensity: (density) => {
    write(DENSITY_STORAGE_KEY, density);
    applyAppearance({ accent: get().accent, density });
    set({ density });
  },
  setRailExpanded: (railExpanded) => {
    write(RAIL_EXPANDED_STORAGE_KEY, String(railExpanded));
    set({ railExpanded });
  },
  toggleRailExpanded: () => get().setRailExpanded(!get().railExpanded),
}));

/** Apply the persisted appearance to the document (idempotent). */
export function initAppearance(): void {
  if (!hasWindow) return;
  const { accent, density } = useAppearanceStore.getState();
  applyAppearance({ accent, density });
}
