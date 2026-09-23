import { useEffect, useRef } from "react";
import { isDesktopRuntime } from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { detectOllamaIssue } from "../../lib/onboarding/models";
import { runOnboardingStartup } from "../../lib/onboarding/startup";
import { toast } from "../../ui";
import { OnboardingWizard } from "./OnboardingWizard";
import { WhatsNewModal } from "./WhatsNewModal";
import { OllamaGuideModal } from "./OllamaGuideModal";
import "../../styles/views/onboarding.css";

let ollamaToastShown = false;

/** Allow the once-per-session Ollama toast again (tests). */
export function resetOllamaToast(): void {
  ollamaToastShown = false;
}

/**
 * Mounts the onboarding overlays (wizard, "What's new", Ollama guidance) and
 * runs the launch sequence. Registered as an invisible status bar item so
 * it lives exactly as long as the shell; everything it renders is portaled
 * to `document.body`. Does nothing without a backend (plain browser, tests).
 */
export function OnboardingHost() {
  const health = useAetherStore((s) => s.health);
  const provider = useAetherStore((s) => s.provider);
  const defaultModel = useAetherStore((s) => s.modelByProvider.ollama);
  const installed = useOnboardingStore((s) => s.installedModels);
  const refreshModels = useOnboardingStore((s) => s.refreshModels);
  const wizardOpen = useOnboardingStore((s) => s.wizardOpen);
  const modelsLoaded = useRef(false);
  const desktop = isDesktopRuntime();

  useEffect(() => {
    if (!desktop) return;
    void import("../../views/registry")
      .then(({ VIEWS }) => runOnboardingStartup(VIEWS.map((v) => v.mode)))
      .catch((e) => console.warn("[onboarding] startup failed:", e));
  }, [desktop]);

  // Load the installed models once Ollama is known to be online, so a missing
  // default model can be detected.
  useEffect(() => {
    if (!desktop || !health?.ollama_online || modelsLoaded.current) return;
    modelsLoaded.current = true;
    void refreshModels();
  }, [desktop, health?.ollama_online, refreshModels]);

  // One toast per session when local AI is not usable (not during the
  // wizard, which covers the same ground).
  useEffect(() => {
    if (!desktop || ollamaToastShown || wizardOpen) return;
    const issue = detectOllamaIssue(health, installed, provider, defaultModel);
    if (!issue) return;
    ollamaToastShown = true;
    const open = () => useOnboardingStore.getState().openOllamaGuide();
    if (issue.kind === "offline") {
      toast.info("Ollama isn't running", {
        description: "Local chat and semantic search need it.",
        action: { label: "Fix", onClick: open },
      });
    } else {
      toast.info(`${issue.model} isn't installed`, {
        description: "Download it or pick another model.",
        action: { label: "Fix", onClick: open },
      });
    }
  }, [desktop, health, installed, provider, defaultModel, wizardOpen]);

  if (!desktop) return null;
  return (
    <>
      <OnboardingWizard />
      <WhatsNewModal />
      <OllamaGuideModal />
    </>
  );
}
