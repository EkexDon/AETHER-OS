/**
 * The first-run wizard as a pure state machine, so navigation rules are
 * testable without a DOM. Steps run in a fixed order; users can go back to
 * any step they have already seen, skip the optional ones and never jump
 * ahead of the furthest step reached.
 */

/** Wizard steps in order. */
export const WIZARD_STEPS = ["welcome", "vault", "ai", "embeddings", "tour", "done"] as const;

/** One wizard step id. */
export type WizardStepId = (typeof WIZARD_STEPS)[number];

/** Short titles for progress dots and screen readers. */
export const WIZARD_STEP_TITLES: Record<WizardStepId, string> = {
  welcome: "Welcome",
  vault: "Vault",
  ai: "AI model",
  embeddings: "Semantic search",
  tour: "Tour",
  done: "Done",
};

/** Steps that may be skipped (the first and last never are). */
export const SKIPPABLE_STEPS: readonly WizardStepId[] = ["vault", "ai", "embeddings", "tour"];

/** Wizard navigation state. */
export interface WizardState {
  /** Index into {@link WIZARD_STEPS}. */
  index: number;
  /** Furthest index reached so far. */
  furthest: number;
  /** Steps the user skipped (and has not completed since), in step order. */
  skipped: WizardStepId[];
}

/** Everything the wizard can do. */
export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "skip" }
  | { type: "goto"; step: WizardStepId }
  | { type: "reset" };

const LAST = WIZARD_STEPS.length - 1;

/** A fresh wizard on the welcome step. */
export function initialWizardState(): WizardState {
  return { index: 0, furthest: 0, skipped: [] };
}

/** The step currently shown. */
export function currentStep(state: WizardState): WizardStepId {
  return WIZARD_STEPS[Math.max(0, Math.min(LAST, state.index))];
}

/** Whether the current step can be skipped. */
export function canSkip(state: WizardState): boolean {
  return SKIPPABLE_STEPS.includes(currentStep(state));
}

/** Whether `step` may be jumped to (already seen). */
export function canGoTo(state: WizardState, step: WizardStepId): boolean {
  return WIZARD_STEPS.indexOf(step) <= state.furthest;
}

/** Whether the wizard shows its final step. */
export function isLastStep(state: WizardState): boolean {
  return state.index >= LAST;
}

/** 1-based position and total, for "Step 2 of 6". */
export function wizardProgress(state: WizardState): { current: number; total: number } {
  return { current: Math.min(LAST, state.index) + 1, total: WIZARD_STEPS.length };
}

function sortSteps(steps: Iterable<WizardStepId>): WizardStepId[] {
  const set = new Set(steps);
  return WIZARD_STEPS.filter((s) => set.has(s));
}

function advance(state: WizardState, skipped: WizardStepId[]): WizardState {
  const index = Math.min(LAST, state.index + 1);
  return { index, furthest: Math.max(state.furthest, index), skipped };
}

/** Pure reducer for {@link WizardAction}s. */
export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  const step = currentStep(state);
  switch (action.type) {
    case "next": {
      if (isLastStep(state)) return state;
      // Finishing a step clears an earlier "skip" of it.
      return advance(
        state,
        state.skipped.filter((s) => s !== step)
      );
    }
    case "skip": {
      if (!canSkip(state)) return state;
      return advance(state, sortSteps([...state.skipped, step]));
    }
    case "back":
      return state.index <= 0 ? state : { ...state, index: state.index - 1 };
    case "goto": {
      if (!canGoTo(state, action.step)) return state;
      return { ...state, index: WIZARD_STEPS.indexOf(action.step) };
    }
    case "reset":
      return initialWizardState();
  }
}
