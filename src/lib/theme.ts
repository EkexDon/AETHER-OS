import { create } from "zustand";

/**
 * Theme handling for AETHER-OS.
 *
 * The user picks a *preference* (`system`, `light`, `dark`); the app renders
 * the *resolved* theme by setting `data-theme="light|dark"` on `<html>`. The
 * preference is persisted under {@link THEME_STORAGE_KEY}. With `system`, the
 * resolved theme follows `prefers-color-scheme` live.
 *
 * `index.html` runs a tiny inline copy of {@link resolveTheme} before first
 * paint so there is no flash of the wrong theme; this module takes over once
 * React boots.
 */

/** What the user chose. */
export type ThemePreference = "system" | "light" | "dark";
/** What is actually rendered. */
export type ResolvedTheme = "light" | "dark";

/** localStorage key for the theme preference. */
export const THEME_STORAGE_KEY = "aether-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Browser chrome / Tauri window tint per theme (matches `--color-surface`). */
export const THEME_CHROME_COLOR: Record<ResolvedTheme, string> = {
  dark: "#181817",
  light: "#f1efeb",
};

/** Parse a stored value; anything unknown falls back to `system`. */
export function parsePreference(raw: string | null | undefined): ThemePreference {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** Read the persisted preference (safe when storage is unavailable). */
export function readStoredPreference(): ThemePreference {
  try {
    return parsePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Persist the preference (ignores storage failures, e.g. private mode). */
export function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // storage unavailable — the choice still applies for this session
  }
}

/** The OS color scheme; dark when `matchMedia` is unavailable. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Resolve a preference against the current OS scheme. */
export function resolveTheme(preference: ThemePreference, system: ResolvedTheme): ResolvedTheme {
  return preference === "system" ? system : preference;
}

/**
 * Apply a resolved theme to the document: `data-theme`, `color-scheme` and
 * the `theme-color` meta tag.
 */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_CHROME_COLOR[theme];
}

interface ThemeState {
  /** The persisted user choice. */
  preference: ThemePreference;
  /** The theme currently on screen. */
  resolved: ResolvedTheme;
  /** Set and persist a preference, applying it immediately. */
  setPreference: (preference: ThemePreference) => void;
  /** Flip between light and dark (stores an explicit preference). */
  toggle: () => void;
  /** Re-resolve after an OS scheme change (only matters for `system`). */
  syncSystem: () => void;
}

const initialPreference = typeof window !== "undefined" ? readStoredPreference() : "system";

/** Global theme store. */
export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: initialPreference,
  resolved: resolveTheme(initialPreference, systemTheme()),
  setPreference: (preference) => {
    storePreference(preference);
    const resolved = resolveTheme(preference, systemTheme());
    applyTheme(resolved);
    set({ preference, resolved });
  },
  toggle: () => {
    const next: ResolvedTheme = get().resolved === "dark" ? "light" : "dark";
    get().setPreference(next);
  },
  syncSystem: () => {
    const { preference } = get();
    const resolved = resolveTheme(preference, systemTheme());
    if (resolved !== get().resolved) {
      applyTheme(resolved);
      set({ resolved });
    }
  },
}));

let initialized = false;

/**
 * Apply the stored theme and start following OS scheme changes. Idempotent;
 * returns a disposer (used by tests).
 */
export function initTheme(): () => void {
  if (typeof window === "undefined") return () => undefined;
  applyTheme(useThemeStore.getState().resolved);
  if (initialized || typeof window.matchMedia !== "function") return () => undefined;
  initialized = true;
  const query = window.matchMedia(DARK_QUERY);
  const onChange = () => useThemeStore.getState().syncSystem();
  query.addEventListener?.("change", onChange);
  return () => {
    query.removeEventListener?.("change", onChange);
    initialized = false;
  };
}

/** Human label for a preference (settings UI, command palette). */
export function preferenceLabel(preference: ThemePreference): string {
  return preference === "system" ? "System" : preference === "light" ? "Light" : "Dark";
}
