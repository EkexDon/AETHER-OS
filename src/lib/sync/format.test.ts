import { describe, expect, it } from "vitest";
import type { SyncReport, SyncStatus } from "../../types";
import {
  baseName,
  describeReport,
  displayPath,
  errorText,
  formatBytes,
  humanizeError,
  intervalLabel,
  progressPercent,
  progressText,
  relativeTime,
  statusSummary,
} from "./format";

const status = (patch: Partial<SyncStatus> = {}): SyncStatus => ({
  state: "idle",
  enabled: true,
  configured: true,
  unlocked: true,
  initialized: true,
  remembered: false,
  last_sync_at: null,
  pending_uploads: 0,
  pending_downloads: 0,
  conflicts: 0,
  message: null,
  device_id: "d",
  device_name: "Mac",
  last_backup_at: null,
  next_backup_at: null,
  progress: null,
  ...patch,
});

const report = (patch: Partial<SyncReport> = {}): SyncReport => ({
  started_at: "",
  finished_at: "",
  duration_ms: 0,
  uploaded: 0,
  downloaded: 0,
  deleted_local: 0,
  deleted_remote: 0,
  adopted: 0,
  conflicts: 0,
  pending_uploads: 0,
  pending_downloads: 0,
  bytes_up: 0,
  bytes_down: 0,
  devices: 1,
  files: 0,
  issues: [],
  ...patch,
});

describe("paths and sizes", () => {
  it("strips namespaces", () => {
    expect(displayPath("vault/Notes/a.md")).toBe("Notes/a.md");
    expect(displayPath("app/memory/facts.json")).toBe("memory/facts.json");
    expect(displayPath("app-conflicts/memory/x.json")).toBe("memory/x.json");
    expect(displayPath("other")).toBe("other");
    expect(baseName("/Users/me/Vault/")).toBe("Vault");
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  it("covers past and future", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("2026-09-22T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-22T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-09-22T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-21T10:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-09-18T12:00:00Z", now)).toBe("4 days ago");
    expect(relativeTime("2026-09-22T14:00:00Z", now)).toBe("in 2 h");
    expect(relativeTime("garbage", now)).toBe("unknown");
  });
});

describe("statusSummary", () => {
  it("maps states to labels and tones", () => {
    expect(statusSummary(null).label).toBe("Loading");
    expect(statusSummary(status({ enabled: false, configured: false })).label).toBe("Not set up");
    expect(statusSummary(status({ enabled: false })).label).toBe("Paused");
    expect(statusSummary(status({ state: "locked" })).tone).toBe("warning");
    expect(statusSummary(status({ state: "error", message: "invalid input: sync folder gone" })).detail).toBe(
      "Sync folder gone"
    );
    expect(statusSummary(status({ conflicts: 2 })).label).toBe("2 conflicts");
    expect(statusSummary(status({ last_sync_at: new Date().toISOString() })).tone).toBe("success");
    const busy = statusSummary(status({ state: "syncing", progress: { operation: "backup", done: 3, total: 10 } }));
    expect(busy.label).toBe("Backing up");
    expect(busy.detail).toBe("3 of 10");
  });
});

describe("progress and reports", () => {
  it("computes progress", () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ operation: "sync", done: 0, total: 0 })).toBeNull();
    expect(progressPercent({ operation: "sync", done: 5, total: 20 })).toBe(25);
    expect(progressText({ operation: "sync", done: 0, total: 0 })).toBe("Preparing…");
  });

  it("describes a report", () => {
    expect(describeReport(report())).toBe("Everything was already in sync");
    expect(describeReport(report({ uploaded: 1, downloaded: 2, conflicts: 1, issues: [{ path: "x", message: "y" }] }))).toBe(
      "1 upload · 2 downloads · 1 conflict · 1 skipped"
    );
  });

  it("labels intervals", () => {
    expect(intervalLabel(30)).toBe("every 30 seconds");
    expect(intervalLabel(60)).toBe("every minute");
    expect(intervalLabel(900)).toBe("every 15 minutes");
    expect(intervalLabel(3600)).toBe("every hour");
    expect(intervalLabel(7200)).toBe("every 2 hours");
  });

  it("humanises backend errors", () => {
    expect(humanizeError("invalid input: wrong passphrase")).toBe("Wrong passphrase");
    expect(humanizeError("I/O error: disk full")).toBe("Disk full");
    expect(errorText(new Error("vault error: no vault"))).toBe("No vault");
    expect(errorText("plain")).toBe("Plain");
  });
});
