import { describe, expect, it } from "vitest";
import { DAY_MS, compareVersions, isUpdateCheckDue, launchDecision, parseVersion } from "./version";

describe("version helpers", () => {
  it("parses SemVer with prefixes, pre-releases and build metadata", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseVersion("0.2.0-rc.1+build.7")).toEqual({ major: 0, minor: 2, patch: 0, pre: ["rc", 1] });
    for (const bad of ["", "1.2", "01.2.3", "1.2.3.4", "latest", null, undefined]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  it("orders versions by SemVer precedence", () => {
    const sorted = ["1.0.0", "0.2.0", "1.0.0-rc.2", "0.10.0", "1.0.0-alpha", "1.0.0-rc.10", "0.2.1"].sort(compareVersions);
    expect(sorted).toEqual(["0.2.0", "0.2.1", "0.10.0", "1.0.0-alpha", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0"]);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0+a", "0.2.0+b")).toBe(0);
    expect(compareVersions("garbage", "0.0.1")).toBeLessThan(0);
  });
});

describe("launch decision", () => {
  const done = { completed_at: "2026-09-01T10:00:00Z", skipped_steps: [] };

  it("shows the wizard on a first run", () => {
    expect(launchDecision({ completed_at: null, version_seen: null, skipped_steps: [] }, "0.2.0")).toEqual({
      show: "wizard",
      markSeen: false,
    });
    // Even with a stale version, an unfinished setup wins.
    expect(launchDecision({ completed_at: null, version_seen: "0.1.0", skipped_steps: [] }, "0.2.0").show).toBe("wizard");
  });

  it("shows what's new once after an upgrade", () => {
    expect(launchDecision({ ...done, version_seen: "0.1.0" }, "0.2.0")).toEqual({ show: "whats-new", markSeen: true });
    expect(launchDecision({ ...done, version_seen: "0.2.0" }, "0.2.0")).toEqual({ show: null, markSeen: false });
  });

  it("records downgrades, missing versions and disabled notes silently", () => {
    expect(launchDecision({ ...done, version_seen: "0.3.0" }, "0.2.0")).toEqual({ show: null, markSeen: true });
    expect(launchDecision({ ...done, version_seen: null }, "0.2.0")).toEqual({ show: null, markSeen: true });
    expect(launchDecision({ ...done, version_seen: "0.1.0" }, "0.2.0", false)).toEqual({ show: null, markSeen: true });
  });
});

describe("automatic update check", () => {
  const now = Date.UTC(2026, 8, 23, 12);

  it("runs once a day when enabled", () => {
    expect(isUpdateCheckDue(false, null, now)).toBe(false);
    expect(isUpdateCheckDue(true, null, now)).toBe(true);
    expect(isUpdateCheckDue(true, now - DAY_MS + 60_000, now)).toBe(false);
    expect(isUpdateCheckDue(true, now - DAY_MS, now)).toBe(true);
  });

  it("re-checks when the clock went backwards", () => {
    expect(isUpdateCheckDue(true, now + 3_600_000, now)).toBe(true);
  });
});
