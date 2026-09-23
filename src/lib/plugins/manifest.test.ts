import { describe, expect, it } from "vitest";
import wordCount from "../../../plugins/examples/word-count/manifest.json?raw";
import dailyReview from "../../../plugins/examples/daily-review/manifest.json?raw";
import randomNote from "../../../plugins/examples/random-note/manifest.json?raw";
import { compareSemver, defaultSettingValue, parseSemver, pluginIdProblem, settingValueProblem, validateManifest } from "./manifest";

const base = {
  id: "com.example.test",
  name: "Test",
  version: "1.0.0",
  permissions: ["vault:read"],
  settings: [{ key: "limit", type: "number", label: "Limit", default: 5, min: 1, max: 10 }],
};

const withField = (field: string, value: unknown) => ({ ...base, [field]: value });

describe("validateManifest", () => {
  it("accepts the bundled examples", () => {
    for (const raw of [wordCount, dailyReview, randomNote]) {
      const manifest = validateManifest(raw, "0.1.0");
      expect(manifest.id.startsWith("aether.")).toBe(true);
      expect(manifest.main).toBe("main.js");
    }
  });

  it("fills defaults for optional fields", () => {
    const manifest = validateManifest({ id: "abc", name: "Minimal", version: "0.1.0" }, "0.1.0");
    expect(manifest).toMatchObject({ description: "", author: "", main: "main.js", minAppVersion: null, permissions: [], settings: [] });
  });

  it("rejects what the Rust validator rejects", () => {
    const cases: [unknown, string][] = [
      [withField("id", "Bad.ID"), "invalid plugin id"],
      [withField("id", "a..b"), "separators"],
      [withField("id", "state.json"), "reserved"],
      [withField("version", "1.0"), "SemVer"],
      [withField("version", "v1.0.0"), "SemVer"],
      [withField("main", "../main.js"), "main must"],
      [withField("main", "main.ts"), ".js or .mjs"],
      [withField("permissions", ["root"]), "unknown permission"],
      [withField("permissions", ["ui:panel", "ui:panel"]), "duplicate permission"],
      [withField("minAppVersion", "99.0.0"), "requires AETHER-OS 99.0.0"],
      [withField("homepage", "https://x"), "unknown field"],
      [withField("settings", [{ key: "a", type: "select", label: "A" }]), "select needs"],
      [withField("settings", [{ key: "a", type: "number", label: "A", default: 50, max: 10 }]), "default must be between"],
      [withField("settings", [{ key: "a", type: "boolean", label: "A" }, { key: "a", type: "string", label: "B" }]), "duplicate setting"],
      ["{ not json", "invalid plugin manifest"],
    ];
    for (const [input, message] of cases) {
      expect(() => validateManifest(input, "0.1.0"), JSON.stringify(input)).toThrow(message);
    }
  });
});

describe("semver", () => {
  it("parses strictly and orders by precedence", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseSemver("01.2.3")).toBeNull();
    expect(parseSemver("1.2.3-")).toBeNull();
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1"];
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareSemver(parseSemver(order[i])!, parseSemver(order[i + 1])!), `${order[i]} < ${order[i + 1]}`).toBeLessThan(0);
    }
    expect(compareSemver(parseSemver("1.0.0+build")!, parseSemver("1.0.0")!)).toBe(0);
  });

  it("validates ids", () => {
    expect(pluginIdProblem("com.example.test")).toBeNull();
    expect(pluginIdProblem("ab")).not.toBeNull();
    expect(pluginIdProblem("-ab")).not.toBeNull();
  });
});

describe("settings values", () => {
  const number = { key: "n", type: "number" as const, label: "N", min: 1, max: 10 };
  const select = { key: "s", type: "select" as const, label: "S", options: [{ value: "a", label: "A" }] };

  it("checks types and bounds", () => {
    expect(settingValueProblem(number, 5)).toBeNull();
    expect(settingValueProblem(number, 11)).toContain("between 1 and 10");
    expect(settingValueProblem(number, Number.NaN)).toContain("finite");
    expect(settingValueProblem(select, "b")).toContain("listed options");
    expect(settingValueProblem({ key: "b", type: "boolean", label: "B" }, "true")).toContain("true or false");
  });

  it("derives defaults", () => {
    expect(defaultSettingValue(number)).toBe(1);
    expect(defaultSettingValue(select)).toBe("a");
    expect(defaultSettingValue({ key: "t", type: "string", label: "T" })).toBe("");
    expect(defaultSettingValue({ key: "t", type: "string", label: "T", default: "x" })).toBe("x");
  });
});
