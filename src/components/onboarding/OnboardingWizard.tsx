import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Play } from "lucide-react";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { useAetherStore } from "../../lib/store";
import { isEditableTarget } from "../../lib/shortcuts";
import {
  SKIPPABLE_STEPS,
  WIZARD_STEPS,
  WIZARD_STEP_TITLES,
  canGoTo,
  canSkip,
  currentStep,
  isLastStep,
  wizardProgress,
  type WizardStepId,
} from "../../lib/onboarding/wizard";
import { BrandMark } from "../../shell/BrandMark";
import { Button, Kbd, Modal, Portal, cx, useToast } from "../../ui";
import { StepIllustration } from "./Illustrations";
import { WelcomeStep } from "./steps/WelcomeStep";
import { VaultStep } from "./steps/VaultStep";
import { AiStep } from "./steps/AiStep";
import { EmbeddingsStep } from "./steps/EmbeddingsStep";
import { TourStep } from "./steps/TourStep";
import { DoneStep } from "./steps/DoneStep";
import "../../styles/views/onboarding.css";

/** Heading and one-paragraph explanation per step. */
export const STEP_COPY: Record<WizardStepId, { title: string; lead: string }> = {
  welcome: {
    title: "Welcome to AETHER-OS",
    lead: "A local-first workspace for your thoughts, projects and AI. Let's get you to a working setup.",
  },
  vault: {
    title: "Connect your notes",
    lead: "A vault is a folder of Markdown notes. Use one you already have — Obsidian and NoPes vaults work as they are — or start fresh with a starter vault.",
  },
  ai: {
    title: "Choose your AI",
    lead: "AETHER answers with your notes as context. Local models run privately through Ollama; cloud models via OpenRouter are optional.",
  },
  embeddings: {
    title: "Turn on semantic search",
    lead: "Semantic search finds notes by meaning instead of exact words. It needs a small local embedding model and a one-time index of your vault.",
  },
  tour: {
    title: "The 30-second tour",
    lead: "Six things worth knowing on day one. “Try it” pauses the setup — you can come right back.",
  },
  done: {
    title: "You're all set",
    lead: "Here is what's ready. Everything can be changed later in Settings.",
  },
};

const PRIMARY_LABEL: Record<WizardStepId, string> = {
  welcome: "Get started",
  vault: "Continue",
  ai: "Continue",
  embeddings: "Continue",
  tour: "Continue",
  done: "Open Home",
};

/** Keys inside these widgets belong to the widget, not to wizard navigation. */
const OWN_ARROW_KEYS = '[role="radiogroup"],[role="tablist"],[role="listbox"],[role="slider"],select';

function stepBody(step: WizardStepId, skipped: WizardStepId[]): ReactNode {
  switch (step) {
    case "welcome":
      return <WelcomeStep />;
    case "vault":
      return <VaultStep />;
    case "ai":
      return <AiStep />;
    case "embeddings":
      return <EmbeddingsStep />;
    case "tour":
      return <TourStep />;
    case "done":
      return <DoneStep skipped={skipped} />;
  }
}

/** Steps to record as skipped when the whole setup is skipped from `index`. */
export function stepsSkippedFrom(index: number, alreadySkipped: WizardStepId[]): WizardStepId[] {
  return WIZARD_STEPS.filter(
    (s) => SKIPPABLE_STEPS.includes(s) && (WIZARD_STEPS.indexOf(s) >= index || alreadySkipped.includes(s))
  );
}

/** Floating "Resume setup" pill shown while the wizard is paused by a tour "Try it". */
function ResumePill() {
  const resume = useOnboardingStore((s) => s.resumeWizard);
  const wizard = useOnboardingStore((s) => s.wizard);
  const { current, total } = wizardProgress(wizard);
  return (
    <Portal>
      <div className="ob-resume" role="status">
        <span className="ob-resume-text">
          Setup paused · step {current} of {total}
        </span>
        <Button size="sm" variant="primary" iconLeft={<Play size={12} />} onClick={resume}>
          Resume setup
        </Button>
      </div>
    </Portal>
  );
}

/**
 * The first-run wizard: a near full-screen modal over the shell with a step
 * rail, an illustration per step, progress dots and Back / Skip / Continue.
 * It can only be dismissed through "Skip setup" (with confirmation) or by
 * finishing. Keyboard: ← / → move between steps (outside text fields),
 * ⌘↵ continues, Esc asks to skip.
 */
export function OnboardingWizard() {
  const toast = useToast();
  const open = useOnboardingStore((s) => s.wizardOpen);
  const minimized = useOnboardingStore((s) => s.wizardMinimized);
  const wizard = useOnboardingStore((s) => s.wizard);
  const dispatch = useOnboardingStore((s) => s.dispatchWizard);
  const finishWizard = useOnboardingStore((s) => s.finishWizard);
  const closeWizard = useOnboardingStore((s) => s.closeWizard);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);

  const step = currentStep(wizard);
  const { current, total } = wizardProgress(wizard);
  const copy = STEP_COPY[step];
  const primaryDisabled = step === "vault" && !vaultPath;

  // Keep keyboard navigation alive when the focused element disappears with
  // the previous step.
  useEffect(() => {
    if (!open || minimized) return;
    const frame = requestAnimationFrame(() => {
      const layout = layoutRef.current;
      if (layout && !layout.contains(document.activeElement)) titleRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step, open, minimized]);

  if (!open) return null;
  if (minimized) return <ResumePill />;

  const persist = async (skipped: WizardStepId[]) => {
    setFinishing(true);
    try {
      await finishWizard(skipped);
      return true;
    } catch (e) {
      // Never trap the user in the wizard because the state file is not writable.
      closeWizard();
      toast.error("Setup progress could not be saved", {
        description: `${e instanceof Error ? e.message : String(e)} — the setup may show again next launch.`,
      });
      return false;
    } finally {
      setFinishing(false);
    }
  };

  const complete = async () => {
    const saved = await persist(wizard.skipped);
    useAetherStore.getState().setView("dashboard");
    if (saved) toast.success("Setup complete", { description: "Press ⌘K any time to find anything." });
  };

  const skipAll = async () => {
    setConfirmSkip(false);
    const saved = await persist(stepsSkippedFrom(wizard.index, wizard.skipped));
    if (saved) toast.info("Setup skipped", { description: "Run “Help: run setup again” from the command palette any time." });
  };

  const primary = () => {
    if (primaryDisabled || finishing) return;
    if (isLastStep(wizard)) void complete();
    else dispatch({ type: "next" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (confirmSkip || e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setConfirmSkip(true);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      primary();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (isEditableTarget(target) || target?.closest(OWN_ARROW_KEYS)) return;
    e.preventDefault();
    if (e.key === "ArrowLeft") dispatch({ type: "back" });
    else primary();
  };

  return (
    <>
      <Modal
        open
        onClose={() => setConfirmSkip(true)}
        dismissible={false}
        hideCloseButton
        flush
        size="xl"
        className="ob-wizard"
        aria-label="Set up AETHER-OS"
        initialFocusRef={primaryRef}
      >
        <div className="ob-wizard-layout" ref={layoutRef} onKeyDown={onKeyDown}>
          <aside className="ob-wizard-rail">
            <div className="ob-wizard-brand">
              <span className="ob-wizard-mark">
                <BrandMark size={18} />
              </span>
              <span>Set up AETHER-OS</span>
            </div>
            <ol className="ob-steps" aria-label="Setup steps">
              {WIZARD_STEPS.map((s, i) => {
                const reachable = canGoTo(wizard, s);
                const isCurrent = i === wizard.index;
                const skipped = wizard.skipped.includes(s);
                const done = i < wizard.furthest && !skipped && !isCurrent;
                return (
                  <li key={s}>
                    <button
                      type="button"
                      className={cx("ob-step", isCurrent && "is-current", done && "is-done", skipped && "is-skipped")}
                      disabled={!reachable}
                      aria-current={isCurrent ? "step" : undefined}
                      onClick={() => dispatch({ type: "goto", step: s })}
                    >
                      <span className="ob-step-index" aria-hidden="true">
                        {done ? <Check size={11} strokeWidth={3} /> : i + 1}
                      </span>
                      <span className="ob-step-name">{WIZARD_STEP_TITLES[s]}</span>
                      {skipped && <span className="ob-step-tag">Skipped</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="ob-wizard-rail-foot">
              <Button variant="ghost" size="sm" onClick={() => setConfirmSkip(true)} disabled={finishing}>
                Skip setup
              </Button>
              <p className="ob-key-hint">
                <Kbd>←</Kbd> <Kbd>→</Kbd> steps · <Kbd>Esc</Kbd> skip
              </p>
            </div>
          </aside>

          <section className="ob-wizard-main" aria-labelledby="ob-step-title">
            <div className="ob-wizard-scroll" key={step}>
              <StepIllustration step={step} />
              <p className="ob-step-eyebrow">
                Step {current} of {total}
              </p>
              <h2 id="ob-step-title" className="ob-step-title" ref={titleRef} tabIndex={-1}>
                {copy.title}
              </h2>
              <p className="ob-step-lead">{copy.lead}</p>
              {stepBody(step, wizard.skipped)}
            </div>
            <footer className="ob-wizard-footer">
              <div className="ob-dots" aria-hidden="true">
                {WIZARD_STEPS.map((s, i) => (
                  <span
                    key={s}
                    className={cx("ob-dot", i === wizard.index && "is-current", i < wizard.index && "is-past")}
                  />
                ))}
              </div>
              <div className="ob-wizard-actions">
                {wizard.index > 0 && (
                  <Button variant="ghost" iconLeft={<ArrowLeft size={14} />} onClick={() => dispatch({ type: "back" })} disabled={finishing}>
                    Back
                  </Button>
                )}
                {canSkip(wizard) && (
                  <Button variant="ghost" onClick={() => dispatch({ type: "skip" })} disabled={finishing}>
                    Skip this step
                  </Button>
                )}
                <Button
                  ref={primaryRef}
                  variant="primary"
                  iconRight={isLastStep(wizard) ? undefined : <ArrowRight size={14} />}
                  onClick={primary}
                  loading={finishing}
                  disabled={primaryDisabled}
                  title={primaryDisabled ? "Connect or create a vault first — or skip this step" : undefined}
                >
                  {PRIMARY_LABEL[step]}
                </Button>
              </div>
            </footer>
          </section>
        </div>
      </Modal>

      <Modal
        open={confirmSkip}
        onClose={() => setConfirmSkip(false)}
        size="sm"
        title="Skip setup?"
        description="You can run it again any time: command palette → “Help: run setup again”, or Settings → General."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmSkip(false)}>
              Keep setting up
            </Button>
            <Button variant="primary" onClick={() => void skipAll()} autoFocus>
              Skip setup
            </Button>
          </>
        }
      >
        <p className="ob-muted">
          {vaultPath
            ? "Your vault stays connected. AI and semantic search can be set up later in Settings → AI Providers."
            : "Without a vault AETHER-OS has no notes to show. Connect one later in Settings → Vault."}
        </p>
      </Modal>
    </>
  );
}
