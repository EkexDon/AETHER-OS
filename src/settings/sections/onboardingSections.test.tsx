import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "../../lib/commands/registry";
import { mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import { DEFAULT_PREFS, useOnboardingStore } from "../../lib/onboardingStore";
import { useAetherStore } from "../../lib/store";
import { useToastStore } from "../../ui";
import type { OnboardingState } from "../../types";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { DataPrivacySettings, clearAppStorage, frontendLines, previewReload } from "./DataPrivacySettings";
import { UpdatesSettings, formatLastCheck } from "./UpdatesSettings";
import { GeneralSettings } from "./GeneralSettings";
import { EditorSettings } from "./EditorSettings";
import { VaultSettings, previewDailyName } from "./VaultSettings";
import { AiProviderSettings } from "./AiProviderSettings";
import { AboutSettings, CREDITS } from "./AboutSettings";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useToastStore.getState().clear();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useOnboardingStore.setState({ prefs: { ...DEFAULT_PREFS }, update: null, updateError: null, installedModels: null, pulls: {} });
  useAetherStore.setState({
    vaultPath: "/Users/demo/Documents/Second-Brain",
    vaultStats: { note_count: 33, total_tasks: 10, open_tasks: 4, total_cards: 2, total_tags: 12, total_links: 40 },
    health: { ollama_online: true, openrouter_configured: false, vault_connected: true },
    provider: "ollama",
    modelByProvider: { ollama: "gemma2:2b", openrouter: "anthropic/claude-sonnet-4" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Shortcuts section", () => {
  it("lists registry commands, filters them and copies the cheat sheet", async () => {
    render(<ShortcutsSettings />);
    expect(screen.getByRole("button", { name: /Command palette/ })).toBeInTheDocument();
    expect(screen.getByText("Notes editor")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter shortcuts" }), { target: { value: "theme" } });
    expect(screen.queryByRole("button", { name: /Command palette/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Toggle light \/ dark theme/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy cheat sheet" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const md = writeText.mock.calls[0][0];
    expect(md).toMatch(/^# AETHER-OS keyboard shortcuts/);
    expect(md).toContain("| Command palette |");
  });

  it("saves the cheat sheet as a vault note", async () => {
    render(<ShortcutsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Save as note" }));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === "Cheat sheet saved to your vault")).toBe(true));
    const content = await mockInvoke<string>("cmd_get_note_content", { path: "/Users/demo/Documents/Second-Brain/AETHER-OS shortcuts.md" });
    expect(content).toContain("## General");
  });
});

describe("Data & Privacy section", () => {
  it("shows data locations, crash reports and the log", async () => {
    render(<DataPrivacySettings />);
    expect(await screen.findByText("vectors/")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "View crash report" })).toBeInTheDocument();
    expect(screen.getAllByText(/Cannot read properties of undefined/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No account, no analytics, no telemetry/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Application log").textContent).toContain("[frontend]"));

    fireEvent.click(screen.getByRole("switch", { name: "Frontend errors only" }));
    expect(screen.getByLabelText("Application log").textContent).not.toContain("[vault]");

    fireEvent.click(screen.getByRole("button", { name: "View crash report" }));
    const dialog = await screen.findByRole("dialog", { name: "Crash report" });
    expect(within(dialog).getByText(/AETHER-OS crash report/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("kind: frontend")));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(await screen.findByText("No crash reports")).toBeInTheDocument();
  });

  it("resets only after a double confirmation", async () => {
    const reload = vi.spyOn(previewReload, "run").mockImplementation(() => undefined);
    await mockInvoke("cmd_onboarding_set_state", {
      onboarding: { completed_at: "2026-09-01T00:00:00Z", version_seen: "0.1.0", skipped_steps: [] },
    });
    localStorage.setItem("aether-theme", "dark");
    localStorage.setItem("other-app", "keep");
    render(<DataPrivacySettings />);

    fireEvent.click(screen.getByRole("button", { name: "Reset app data…" }));
    const first = await screen.findByRole("dialog", { name: "Reset app data?" });
    const cont = within(first).getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    fireEvent.click(within(first).getByRole("checkbox"));
    fireEvent.click(cont);

    const second = await screen.findByRole("dialog", { name: "Confirm the reset" });
    const go = within(second).getByRole("button", { name: "Reset and restart" });
    expect(go).toBeDisabled();
    fireEvent.change(within(second).getByLabelText("Type RESET"), { target: { value: "RESET" } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(go);

    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === "App data moved to a backup")).toBe(true));
    expect(localStorage.getItem("aether-theme")).toBeNull();
    expect(localStorage.getItem("other-app")).toBe("keep");
    expect((await mockInvoke<OnboardingState>("cmd_onboarding_get_state")).completed_at).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("helpers filter frontend lines and clear only app keys", () => {
    expect(frontendLines("a [frontend] x\nb [vault] y\nc [frontend] z")).toBe("a [frontend] x\nc [frontend] z");
    localStorage.setItem("aether-a", "1");
    localStorage.setItem("x", "2");
    expect(clearAppStorage()).toBe(1);
    expect(localStorage.getItem("x")).toBe("2");
  });
});

describe("Updates section", () => {
  it("checks for updates and shows the release card", async () => {
    render(<UpdatesSettings />);
    expect(screen.getByText("Never checked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/is available/, undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open release page" })).toBeInTheDocument();
    expect(screen.getByText("Checked just now")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Check for updates once a day" }));
    expect(useOnboardingStore.getState().prefs.autoCheckUpdates).toBe(true);
  });

  it("formats the last check time", () => {
    const now = Date.UTC(2026, 8, 23, 12);
    expect(formatLastCheck(null, now)).toBe("Never checked");
    expect(formatLastCheck(now - 5 * 60_000, now)).toBe("Checked 5 minutes ago");
    expect(formatLastCheck(now - 3 * 3600_000, now)).toBe("Checked 3 hours ago");
    expect(formatLastCheck(now - 26 * 3600_000, now)).toBe("Checked yesterday");
  });
});

describe("General, Editor, Vault, AI and About sections", () => {
  it("stores startup preferences", async () => {
    render(<GeneralSettings />);
    const select = await screen.findByRole("combobox", { name: "Start view" });
    await waitFor(() => expect(select).toBeEnabled(), { timeout: 5000 });
    fireEvent.change(select, { target: { value: "tasks" } });
    expect(useOnboardingStore.getState().prefs.startView).toBe("tasks");
    fireEvent.click(screen.getByRole("radio", { name: "Open" }));
    expect(useOnboardingStore.getState().prefs.agentPanelOnStart).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Run setup again" }));
    expect(useOnboardingStore.getState().wizardOpen).toBe(true);
  }, 10_000);

  it("applies the note editor typography", () => {
    render(<EditorSettings />);
    fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "18" } });
    expect(useOnboardingStore.getState().prefs.editorFontSize).toBe(18);
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("18px");
    fireEvent.click(screen.getByRole("button", { name: "Reset text size" }));
    expect(useOnboardingStore.getState().prefs.editorFontSize).toBe(15);
  });

  it("creates a starter vault and saves daily note prefs", async () => {
    render(<VaultSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Create new vault" }));
    const input = await screen.findByRole("textbox", { name: "New vault folder" });
    await waitFor(() => expect(input).toHaveValue("/Users/demo/Documents/AETHER Vault"));
    fireEvent.click(screen.getByRole("button", { name: "Create & connect" }));
    await waitFor(() => expect(useAetherStore.getState().vaultPath).toBe("/Users/demo/Documents/AETHER Vault"));

    const pattern = await screen.findByLabelText("File name pattern");
    await waitFor(() => expect(pattern).toHaveValue("YYYY-MM-DD"));
    fireEvent.change(pattern, { target: { value: "DD.MM.YYYY" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect(await mockInvoke("cmd_onboarding_get_vault_prefs")).toEqual({ daily_folder: "daily", daily_filename_pattern: "DD.MM.YYYY" })
    );
    expect(previewDailyName("YYYY-MM-DD", new Date(2026, 0, 5))).toBe("2026-01-05.md");
  });

  it("switches the default provider and model", async () => {
    render(<AiProviderSettings />);
    const select = await screen.findByRole("combobox", { name: "Default model" });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: "qwen2.5:7b" } });
    expect(useAetherStore.getState().modelByProvider.ollama).toBe("qwen2.5:7b");
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    expect(useAetherStore.getState().provider).toBe("openrouter");
    expect(screen.getByText(/nomic-embed-text/)).toBeInTheDocument();
  });

  it("credits the open-source projects", () => {
    render(<AboutSettings />);
    for (const c of CREDITS.slice(0, 3)) expect(screen.getByText(c.name)).toBeInTheDocument();
    expect(screen.getByText(/not yet open-sourced/)).toBeInTheDocument();
  });
});
