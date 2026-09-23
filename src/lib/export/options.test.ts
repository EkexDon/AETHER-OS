import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_OPTIONS,
  loadFlowOptions,
  loadLastDir,
  sanitizeOptions,
  saveFlowOptions,
  saveLastDir,
} from "./options";

describe("export options", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps only well-typed fields", () => {
    const clean = sanitizeOptions({
      include_attachments: false,
      theme: "dark",
      site_title: "Garden",
      cname: 42,
      convert_wikilinks: "yes",
      bogus: true,
    });
    expect(clean).toEqual({
      ...DEFAULT_EXPORT_OPTIONS,
      include_attachments: false,
      theme: "dark",
      site_title: "Garden",
    });
    expect(sanitizeOptions({ theme: "neon" }).theme).toBe("auto");
    expect(sanitizeOptions(null)).toEqual(DEFAULT_EXPORT_OPTIONS);
  });

  it("never persists the inside-the-vault override", () => {
    saveFlowOptions("site", { ...DEFAULT_EXPORT_OPTIONS, allow_inside_vault: true, site_title: "X" });
    const loaded = loadFlowOptions("site");
    expect(loaded.allow_inside_vault).toBe(false);
    expect(loaded.site_title).toBe("X");
    expect(loadFlowOptions("bundle")).toEqual(DEFAULT_EXPORT_OPTIONS);
  });

  it("survives corrupt storage", () => {
    window.localStorage.setItem("aether-export-options-html", "{not json");
    expect(loadFlowOptions("html")).toEqual(DEFAULT_EXPORT_OPTIONS);
  });

  it("remembers the last absolute folder per flow", () => {
    expect(loadLastDir("html")).toBeNull();
    saveLastDir("html", "/Users/demo/Exports");
    expect(loadLastDir("html")).toBe("/Users/demo/Exports");
    window.localStorage.setItem("aether-export-dir-site", "relative/path");
    expect(loadLastDir("site")).toBeNull();
  });
});
