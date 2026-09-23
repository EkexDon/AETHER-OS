/**
 * What the onboarding feature does once per app launch: apply the start
 * preferences (start view, agent panel), decide between the setup wizard
 * and the "What's new" note, and run the daily update check when enabled.
 * Every step is independent — a failure in one never blocks the others,
 * and nothing here throws.
 */
import { getOnboardingState, setOnboardingState } from "../ipc";
import { useAetherStore } from "../store";
import { useOnboardingStore } from "../onboardingStore";
import { useShellStore } from "../../shell/shellStore";
import { toast } from "../../ui/Toast";
import type { ViewMode } from "../../views/modes";
import { APP_VERSION } from "./appVersion";
import { isUpdateCheckDue, launchDecision } from "./version";

/** Apply the start view and the agent-panel preference. `knownViews` guards against removed views. */
export function applyStartPreferences(knownViews: readonly ViewMode[]): void {
  const { startView, agentPanelOnStart } = useOnboardingStore.getState().prefs;
  const aether = useAetherStore.getState();
  if (startView && knownViews.includes(startView) && aether.view !== startView) aether.setView(startView);
  if (agentPanelOnStart === "open" && !aether.chatOpen) aether.setChatOpen(true);
  if (agentPanelOnStart === "closed" && aether.chatOpen) aether.setChatOpen(false);
}

/**
 * Load the wizard state and open the wizard (first run) or "What's new"
 * (after an update); records the running version as seen. Resolves to the
 * overlay that was opened.
 */
export async function runLaunchDecision(version: string = APP_VERSION): Promise<"wizard" | "whats-new" | null> {
  const store = useOnboardingStore.getState();
  let state;
  try {
    state = await getOnboardingState();
  } catch (e) {
    console.warn("[onboarding] could not read the setup state:", e);
    return null;
  }
  store.setOnboarding(state);
  const decision = launchDecision(state, version, store.prefs.showWhatsNew);
  if (decision.show === "wizard") store.openWizard({ restart: true });
  if (decision.show === "whats-new") store.openWhatsNew();
  if (decision.markSeen) {
    try {
      store.setOnboarding(await setOnboardingState({ ...state, version_seen: version }));
    } catch (e) {
      console.warn("[onboarding] could not record the seen version:", e);
    }
  }
  return decision.show;
}

/** Run the automatic update check when it is enabled and due; toasts when a newer release exists. */
export async function runAutoUpdateCheck(now: number = Date.now()): Promise<boolean> {
  const store = useOnboardingStore.getState();
  if (!isUpdateCheckDue(store.prefs.autoCheckUpdates, store.prefs.lastUpdateCheckAt, now)) return false;
  try {
    const info = await store.checkUpdates();
    if (info.update_available) {
      toast.info(`AETHER-OS ${info.latest} is available`, {
        description: `You are on ${info.current}.`,
        duration: 0,
        action: { label: "View", onClick: () => useShellStore.getState().openSettings("updates") },
      });
    }
  } catch (e) {
    // Offline or rate-limited: stay quiet; Settings → Updates shows the error.
    console.warn("[onboarding] automatic update check failed:", e);
  }
  return true;
}

let started = false;

/**
 * Run the launch sequence once per page load (safe under React StrictMode's
 * double effects). `knownViews` are the registered view modes.
 */
export async function runOnboardingStartup(knownViews: readonly ViewMode[]): Promise<void> {
  if (started) return;
  started = true;
  applyStartPreferences(knownViews);
  await runLaunchDecision();
  await runAutoUpdateCheck();
}

/** Allow {@link runOnboardingStartup} to run again (tests). */
export function resetOnboardingStartup(): void {
  started = false;
}
