import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState, setMockLatency } from "./mock/backend";
import { MOCK_PULL_DURATION_MS } from "./mock/onboarding";
import {
  DEFAULT_PREFS,
  EDITOR_FONT_SIZE,
  PREFS_STORAGE_KEY,
  applyEditorPrefs,
  parsePrefs,
  useOnboardingStore,
} from "./onboardingStore";

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useOnboardingStore.setState({ prefs: { ...DEFAULT_PREFS }, pulls: {}, installedModels: null, update: null, updateError: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("onboarding preferences", () => {
  it("parses stored prefs defensively", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("[1,2]")).toEqual(DEFAULT_PREFS);
    const parsed = parsePrefs(
      JSON.stringify({ startView: "tasks", agentPanelOnStart: "closed", autoCheckUpdates: true, editorFontSize: 99, editorLineWidth: "x" })
    );
    expect(parsed).toMatchObject({ startView: "tasks", agentPanelOnStart: "closed", autoCheckUpdates: true });
    expect(parsed.editorFontSize).toBe(EDITOR_FONT_SIZE.max);
    expect(parsed.editorLineWidth).toBe(DEFAULT_PREFS.editorLineWidth);
    expect(parsePrefs(JSON.stringify({ agentPanelOnStart: "sideways" })).agentPanelOnStart).toBe("remember");
  });

  it("persists prefs and applies the editor typography to <html>", () => {
    useOnboardingStore.getState().setPrefs({ editorFontSize: 18, editorLineWidth: 880 });
    expect(JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? "{}")).toMatchObject({ editorFontSize: 18, editorLineWidth: 880 });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("18px");
    expect(document.documentElement.style.getPropertyValue("--editor-line-width")).toBe("880px");

    const el = document.createElement("div");
    applyEditorPrefs({ editorFontSize: 14, editorLineWidth: 600 }, el);
    expect(el.style.getPropertyValue("--editor-font-size")).toBe("14px");
  });
});

describe("wizard lifecycle", () => {
  it("opens, pauses, resumes and finishes the wizard", async () => {
    const store = useOnboardingStore.getState();
    store.openWizard();
    store.dispatchWizard({ type: "next" });
    expect(useOnboardingStore.getState().wizard.index).toBe(1);
    store.openWizard(); // already open: keeps the position
    expect(useOnboardingStore.getState().wizard.index).toBe(1);
    store.minimizeWizard();
    expect(useOnboardingStore.getState().wizardMinimized).toBe(true);
    store.resumeWizard();
    expect(useOnboardingStore.getState().wizardMinimized).toBe(false);

    const stored = await store.finishWizard(["ai"]);
    expect(stored.completed_at).not.toBeNull();
    expect(stored.skipped_steps).toEqual(["ai"]);
    const after = useOnboardingStore.getState();
    expect(after.wizardOpen).toBe(false);
    expect(after.onboarding).toEqual(stored);
    expect(after.wizard.index).toBe(0);
  });
});

describe("model downloads", () => {
  it("tracks progress from events and refreshes the installed models", async () => {
    vi.useFakeTimers();
    const pull = useOnboardingStore.getState().startPull("nomic-embed-text");
    await vi.advanceTimersByTimeAsync(MOCK_PULL_DURATION_MS / 2);
    const running = useOnboardingStore.getState().pulls["nomic-embed-text"];
    expect(running.phase).toBe("running");
    expect(running.status).toMatch(/downloading/);
    expect(running.total).toBeGreaterThan(0);
    // A second start while running is ignored.
    await expect(useOnboardingStore.getState().startPull("nomic-embed-text")).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(MOCK_PULL_DURATION_MS);
    await expect(pull).resolves.toEqual({ name: "nomic-embed-text", cancelled: false });
    const state = useOnboardingStore.getState();
    expect(state.pulls["nomic-embed-text"].phase).toBe("done");
    expect(state.installedModels).toContain("nomic-embed-text");

    state.dismissPull("nomic-embed-text");
    expect(useOnboardingStore.getState().pulls["nomic-embed-text"]).toBeUndefined();
  });

  it("marks failed and cancelled downloads", async () => {
    vi.useFakeTimers();
    const failing = useOnboardingStore.getState().startPull("does-not-exist");
    const failed = expect(failing).rejects.toThrow(/no model called/);
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    expect(useOnboardingStore.getState().pulls["does-not-exist"]).toMatchObject({ phase: "error" });

    const cancelling = useOnboardingStore.getState().startPull("llama3.2:1b");
    await vi.advanceTimersByTimeAsync(200);
    await useOnboardingStore.getState().cancelPull("llama3.2:1b");
    await vi.advanceTimersByTimeAsync(MOCK_PULL_DURATION_MS);
    await expect(cancelling).resolves.toEqual({ name: "llama3.2:1b", cancelled: true });
    expect(useOnboardingStore.getState().pulls["llama3.2:1b"].phase).toBe("cancelled");
  });
});

describe("update check", () => {
  it("stores the result and the check time", async () => {
    vi.useFakeTimers();
    const check = useOnboardingStore.getState().checkUpdates();
    expect(useOnboardingStore.getState().checkingUpdates).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    const info = await check;
    expect(info.update_available).toBe(true);
    const state = useOnboardingStore.getState();
    expect(state.update).toEqual(info);
    expect(state.checkingUpdates).toBe(false);
    expect(state.prefs.lastUpdateCheckAt).not.toBeNull();
  });
});
