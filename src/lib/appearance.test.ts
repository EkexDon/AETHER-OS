import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCENTS,
  ACCENT_STORAGE_KEY,
  DENSITY_STORAGE_KEY,
  RAIL_EXPANDED_STORAGE_KEY,
  applyAppearance,
  initAppearance,
  parseAccent,
  parseDensity,
  useAppearanceStore,
} from "./appearance";

describe("appearance", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppearanceStore.setState({ accent: "teal", density: "comfortable", railExpanded: false });
  });

  it("offers 3–4 curated accents with no purple default", () => {
    expect(ACCENTS.length).toBeGreaterThanOrEqual(3);
    expect(ACCENTS.length).toBeLessThanOrEqual(4);
    expect(ACCENTS[0].id).toBe("teal");
  });

  it("parses stored values defensively", () => {
    expect(parseAccent("ember")).toBe("ember");
    expect(parseAccent("violet")).toBe("teal");
    expect(parseAccent(null)).toBe("teal");
    expect(parseDensity("compact")).toBe("compact");
    expect(parseDensity("tiny")).toBe("comfortable");
  });

  it("applies accent and density to <html>", () => {
    applyAppearance({ accent: "cobalt", density: "compact" });
    expect(document.documentElement.dataset.accent).toBe("cobalt");
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("persists accent and density changes", () => {
    useAppearanceStore.getState().setAccent("graphite");
    useAppearanceStore.getState().setDensity("compact");
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("graphite");
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("compact");
    expect(document.documentElement.dataset.accent).toBe("graphite");
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("toggles and persists the rail label mode", () => {
    useAppearanceStore.getState().toggleRailExpanded();
    expect(useAppearanceStore.getState().railExpanded).toBe(true);
    expect(localStorage.getItem(RAIL_EXPANDED_STORAGE_KEY)).toBe("true");
    useAppearanceStore.getState().toggleRailExpanded();
    expect(localStorage.getItem(RAIL_EXPANDED_STORAGE_KEY)).toBe("false");
  });

  it("initAppearance mirrors the store onto the document", () => {
    useAppearanceStore.setState({ accent: "ember", density: "comfortable" });
    initAppearance();
    expect(document.documentElement.dataset.accent).toBe("ember");
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });
});
