import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  parsePreference,
  preferenceLabel,
  readStoredPreference,
  resolveTheme,
  systemTheme,
  useThemeStore,
} from "./theme";

function mockMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });
  return {
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((l) => l());
    },
  };
}

describe("theme helpers", () => {
  it("parses stored preferences and falls back to system", () => {
    expect(parsePreference("light")).toBe("light");
    expect(parsePreference("dark")).toBe("dark");
    expect(parsePreference("system")).toBe("system");
    expect(parsePreference("sepia")).toBe("system");
    expect(parsePreference(null)).toBe("system");
  });

  it("resolves system against the OS scheme", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("reads the stored preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readStoredPreference()).toBe("light");
    localStorage.removeItem(THEME_STORAGE_KEY);
    expect(readStoredPreference()).toBe("system");
  });

  it("applies data-theme, color-scheme and theme-color", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(meta.content).toBe("#f1efeb");
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    meta.remove();
  });

  it("labels preferences", () => {
    expect(preferenceLabel("system")).toBe("System");
    expect(preferenceLabel("light")).toBe("Light");
  });
});

describe("useThemeStore", () => {
  let media: ReturnType<typeof mockMatchMedia>;
  beforeEach(() => {
    localStorage.clear();
    media = mockMatchMedia(true);
    useThemeStore.setState({ preference: "system", resolved: "dark" });
  });
  afterEach(() => {
    // @ts-expect-error — restore jsdom's default (no matchMedia)
    delete window.matchMedia;
  });

  it("persists and applies an explicit preference", () => {
    useThemeStore.getState().setPreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggle flips the resolved theme and stores it", () => {
    useThemeStore.getState().setPreference("dark");
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().preference).toBe("light");
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().preference).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("follows the OS while the preference is system", () => {
    expect(systemTheme()).toBe("dark");
    const dispose = initTheme();
    useThemeStore.getState().setPreference("system");
    expect(useThemeStore.getState().resolved).toBe("dark");
    media.set(false);
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    dispose();
  });

  it("ignores OS changes for an explicit preference", () => {
    const dispose = initTheme();
    useThemeStore.getState().setPreference("dark");
    media.set(false);
    expect(useThemeStore.getState().resolved).toBe("dark");
    dispose();
  });
});
