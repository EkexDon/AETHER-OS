import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke, resetMockState, setMockLatency } from "../mock/backend";
import { DEFAULT_PREFS, useOnboardingStore } from "../onboardingStore";
import { useAetherStore } from "../store";
import { useToastStore } from "../../ui";
import type { OnboardingState } from "../../types";
import { APP_VERSION } from "./appVersion";
import { applyStartPreferences, resetOnboardingStartup, runAutoUpdateCheck, runLaunchDecision, runOnboardingStartup } from "./startup";

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  resetOnboardingStartup();
  useOnboardingStore.setState({
    prefs: { ...DEFAULT_PREFS },
    onboarding: null,
    wizardOpen: false,
    whatsNewOpen: false,
    update: null,
  });
  useAetherStore.setState({ view: "dashboard", chatOpen: true });
  useToastStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const setState = (onboarding: OnboardingState) => mockInvoke("cmd_onboarding_set_state", { onboarding });

describe("launch sequence", () => {
  it("opens the wizard on a first run", async () => {
    await expect(runLaunchDecision("0.2.0")).resolves.toBe("wizard");
    const state = useOnboardingStore.getState();
    expect(state.wizardOpen).toBe(true);
    expect(state.onboarding?.completed_at).toBeNull();
  });

  it("shows what's new once after an upgrade and records the version", async () => {
    await setState({ completed_at: "2026-09-01T00:00:00Z", version_seen: "0.1.0", skipped_steps: [] });
    await expect(runLaunchDecision("0.2.0")).resolves.toBe("whats-new");
    expect(useOnboardingStore.getState().whatsNewOpen).toBe(true);
    expect((await mockInvoke<OnboardingState>("cmd_onboarding_get_state")).version_seen).toBe("0.2.0");

    useOnboardingStore.setState({ whatsNewOpen: false });
    await expect(runLaunchDecision("0.2.0")).resolves.toBeNull();
    expect(useOnboardingStore.getState().whatsNewOpen).toBe(false);
  });

  it("applies the start view and agent panel preference", () => {
    useOnboardingStore.getState().setPrefs({ startView: "tasks", agentPanelOnStart: "closed" });
    applyStartPreferences(["dashboard", "tasks"]);
    expect(useAetherStore.getState().view).toBe("tasks");
    expect(useAetherStore.getState().chatOpen).toBe(false);

    useOnboardingStore.getState().setPrefs({ startView: "removed-view" as never, agentPanelOnStart: "open" });
    useAetherStore.setState({ view: "dashboard" });
    applyStartPreferences(["dashboard", "tasks"]);
    expect(useAetherStore.getState().view).toBe("dashboard");
    expect(useAetherStore.getState().chatOpen).toBe(true);
  });

  it("checks for updates once a day when enabled and announces new releases", async () => {
    vi.useFakeTimers();
    await expect(runAutoUpdateCheck()).resolves.toBe(false);

    useOnboardingStore.getState().setPrefs({ autoCheckUpdates: true });
    const run = runAutoUpdateCheck();
    await vi.advanceTimersByTimeAsync(700);
    await expect(run).resolves.toBe(true);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => /is available/.test(String(t.title)))).toBe(true);

    await expect(runAutoUpdateCheck()).resolves.toBe(false);
  });

  it("runs only once per page load", async () => {
    await runOnboardingStartup(["dashboard"]);
    expect(useOnboardingStore.getState().wizardOpen).toBe(true);
    useOnboardingStore.setState({ wizardOpen: false });
    await runOnboardingStartup(["dashboard"]);
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
