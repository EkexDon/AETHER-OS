import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OllamaPullProgress, OnboardingState, PullOutcome, VaultInfo } from "../../types";
import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "./backend";
import { MOCK_LOCAL_MODELS } from "./ai";
import { MOCK_DETECTED_VAULTS, MOCK_ONBOARDING_STORAGE_KEY, MOCK_PULL_DURATION_MS } from "./onboarding";

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("onboarding mock", () => {
  it("starts as a first run and persists a finished setup across reloads", async () => {
    const first = await invoke<OnboardingState>("cmd_onboarding_get_state");
    expect(first).toEqual({ completed_at: null, version_seen: null, skipped_steps: [] });

    const stored = await invoke<OnboardingState>("cmd_onboarding_set_state", {
      onboarding: { completed_at: "2026-09-23T08:00:00.000Z", version_seen: "0.2.0", skipped_steps: ["ai", "ai"] },
    });
    expect(stored.skipped_steps).toEqual(["ai"]);
    expect(JSON.parse(localStorage.getItem(MOCK_ONBOARDING_STORAGE_KEY) ?? "{}").version_seen).toBe("0.2.0");

    await expect(
      invoke("cmd_onboarding_set_state", { onboarding: { completed_at: "nope", version_seen: null, skipped_steps: [] } })
    ).rejects.toMatch(/RFC 3339/);
    await expect(
      invoke("cmd_onboarding_set_state", { onboarding: { completed_at: null, version_seen: null, skipped_steps: ["../x"] } })
    ).rejects.toMatch(/invalid wizard step/);

    resetMockState();
    expect(localStorage.getItem(MOCK_ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it("detects two fake vaults and creates starter vaults inside the home folder only", async () => {
    const found = await invoke<VaultInfo[]>("cmd_onboarding_detect_vaults");
    expect(found).toHaveLength(2);
    expect(found.map((v) => v.kind)).toEqual(["obsidian", "plain"]);
    expect(found).toEqual(MOCK_DETECTED_VAULTS);

    const suggested = await invoke<string>("cmd_onboarding_suggest_vault_path");
    expect(suggested).toBe("/Users/demo/Documents/AETHER Vault");
    const created = await invoke<VaultInfo>("cmd_onboarding_create_vault", { path: suggested });
    expect(created).toMatchObject({ name: "AETHER Vault", note_count: 5, kind: "plain" });
    expect(await invoke<string>("cmd_onboarding_suggest_vault_path")).toBe("/Users/demo/Documents/AETHER Vault 2");

    await expect(invoke("cmd_onboarding_create_vault", { path: suggested })).rejects.toMatch(/not empty/);
    await expect(invoke("cmd_onboarding_create_vault", { path: "/etc/vault" })).rejects.toMatch(/inside your home/);
    await expect(invoke("cmd_onboarding_create_vault", { path: "/Users/demo/../root" })).rejects.toMatch(/'\.\.'/);
    await expect(invoke("cmd_onboarding_create_vault", { path: "relative" })).rejects.toMatch(/absolute/);
  });

  it("streams fake pull progress over about three seconds and installs the model", async () => {
    vi.useFakeTimers();
    const events: OllamaPullProgress[] = [];
    const off = mockEvents.listen<OllamaPullProgress>("ollama-pull-progress", (p) => events.push(p));
    const done = invoke<PullOutcome>("cmd_onboarding_pull_model", { name: "nomic-embed-text" });
    await vi.advanceTimersByTimeAsync(MOCK_PULL_DURATION_MS / 2);
    expect(events.length).toBeGreaterThan(2);
    expect(events.some((e) => e.status === "success")).toBe(false);
    await vi.advanceTimersByTimeAsync(MOCK_PULL_DURATION_MS);
    await expect(done).resolves.toEqual({ name: "nomic-embed-text", cancelled: false });
    off();

    expect(events[0].status).toBe("pulling manifest");
    expect(events[events.length - 1].status).toBe("success");
    const downloads = events.filter((e) => e.status.startsWith("downloading"));
    expect(downloads.every((e) => (e.completed ?? 0) <= (e.total ?? 0))).toBe(true);
    expect(await invoke<string[]>("cmd_list_local_models")).toContain("nomic-embed-text");

    resetMockState();
    expect(MOCK_LOCAL_MODELS).not.toContain("nomic-embed-text");
  });

  it("cancels running pulls and rejects duplicates, bad and unknown names", async () => {
    vi.useFakeTimers();
    const pull = invoke<PullOutcome>("cmd_onboarding_pull_model", { name: "llama3.2:3b" });
    await vi.advanceTimersByTimeAsync(10);
    await expect(invoke("cmd_onboarding_pull_model", { name: "llama3.2:3b" })).rejects.toMatch(/already downloading/);
    expect(await invoke<boolean>("cmd_onboarding_cancel_pull", { name: "llama3.2:3b" })).toBe(true);
    await vi.advanceTimersByTimeAsync(MOCK_PULL_DURATION_MS);
    await expect(pull).resolves.toEqual({ name: "llama3.2:3b", cancelled: true });
    expect(await invoke<boolean>("cmd_onboarding_cancel_pull", { name: "llama3.2:3b" })).toBe(false);

    await expect(invoke("cmd_onboarding_pull_model", { name: "bad name" })).rejects.toMatch(/not a valid Ollama model name/);
    const unknown = invoke("cmd_onboarding_pull_model", { name: "does-not-exist" });
    const assertion = expect(unknown).rejects.toMatch(/no model called/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("validates vault prefs, lists data, tails the log and resets", async () => {
    expect(await invoke("cmd_onboarding_get_vault_prefs")).toEqual({ daily_folder: "daily", daily_filename_pattern: "YYYY-MM-DD" });
    expect(
      await invoke("cmd_onboarding_set_vault_prefs", { prefs: { daily_folder: "/Journal/", daily_filename_pattern: "DD.MM.YYYY" } })
    ).toEqual({ daily_folder: "Journal", daily_filename_pattern: "DD.MM.YYYY" });
    await expect(
      invoke("cmd_onboarding_set_vault_prefs", { prefs: { daily_folder: "../x", daily_filename_pattern: "YYYY-MM-DD" } })
    ).rejects.toMatch(/invalid daily note folder/);
    await expect(
      invoke("cmd_onboarding_set_vault_prefs", { prefs: { daily_folder: "d", daily_filename_pattern: "YYYY" } })
    ).rejects.toMatch(/must contain MM/);

    const locations = await invoke<{ name: string }[]>("cmd_onboarding_data_locations");
    expect(locations.map((l) => l.name)).toContain("vectors");
    const log = await invoke<{ content: string; truncated: boolean }>("cmd_onboarding_read_app_log", { maxBytes: 1024 });
    expect(log.content).toContain("[frontend]");
    expect(await invoke<string>("cmd_onboarding_read_changelog")).toContain("## Unreleased");
    expect((await invoke<{ ram: number }>("cmd_onboarding_system_profile")) as unknown).toMatchObject({ total_ram_gb: 16 });

    await invoke("cmd_onboarding_set_state", {
      onboarding: { completed_at: "2026-09-23T08:00:00.000Z", version_seen: "0.2.0", skipped_steps: [] },
    });
    const outcome = await invoke<{ backup_path: string; kept: string[]; restarting: boolean }>("cmd_onboarding_reset_app_data", {
      keepVault: true,
    });
    expect(outcome.backup_path).toMatch(/com\.ekin\.aetheros-backup-\d{8}-\d{6}$/);
    expect(outcome).toMatchObject({ kept: ["config.json"], restarting: false });
    expect((await invoke<OnboardingState>("cmd_onboarding_get_state")).completed_at).toBeNull();
  });
});
