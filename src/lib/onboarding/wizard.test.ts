import { describe, expect, it } from "vitest";
import {
  WIZARD_STEPS,
  canGoTo,
  canSkip,
  currentStep,
  initialWizardState,
  isLastStep,
  wizardProgress,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from "./wizard";

const run = (actions: WizardAction[], from: WizardState = initialWizardState()) => actions.reduce(wizardReducer, from);

describe("wizard state machine", () => {
  it("starts on the welcome step and walks all six steps in order", () => {
    let state = initialWizardState();
    expect(currentStep(state)).toBe("welcome");
    expect(wizardProgress(state)).toEqual({ current: 1, total: 6 });
    const seen = [currentStep(state)];
    for (let i = 0; i < 10; i++) {
      state = wizardReducer(state, { type: "next" });
      if (seen[seen.length - 1] !== currentStep(state)) seen.push(currentStep(state));
    }
    expect(seen).toEqual([...WIZARD_STEPS]);
    expect(isLastStep(state)).toBe(true);
    expect(wizardProgress(state)).toEqual({ current: 6, total: 6 });
    // "next" on the last step is a no-op.
    expect(wizardReducer(state, { type: "next" })).toBe(state);
  });

  it("goes back but never before the first step", () => {
    const state = run([{ type: "next" }, { type: "next" }, { type: "back" }]);
    expect(currentStep(state)).toBe("vault");
    expect(state.furthest).toBe(2);
    const first = initialWizardState();
    expect(wizardReducer(first, { type: "back" })).toBe(first);
  });

  it("only skips optional steps and records them in step order", () => {
    const welcome = initialWizardState();
    expect(canSkip(welcome)).toBe(false);
    expect(wizardReducer(welcome, { type: "skip" })).toBe(welcome);

    const state = run([{ type: "next" }, { type: "next" }, { type: "skip" }]);
    expect(currentStep(state)).toBe("embeddings");
    expect(state.skipped).toEqual(["ai"]);

    const more = run([{ type: "back" }, { type: "back" }, { type: "skip" }], state);
    expect(more.skipped).toEqual(["vault", "ai"]);

    const done = run([{ type: "goto", step: "embeddings" }, { type: "skip" }, { type: "skip" }], more);
    expect(currentStep(done)).toBe("done");
    expect(done.skipped).toEqual(["vault", "ai", "embeddings", "tour"]);
    expect(canSkip(done)).toBe(false);
  });

  it("clears a skip when the step is completed later", () => {
    const skipped = run([{ type: "next" }, { type: "skip" }]);
    expect(skipped.skipped).toEqual(["vault"]);
    const completed = run([{ type: "back" }, { type: "next" }], skipped);
    expect(completed.skipped).toEqual([]);
  });

  it("jumps only to steps already reached", () => {
    const state = run([{ type: "next" }, { type: "next" }]);
    expect(canGoTo(state, "welcome")).toBe(true);
    expect(canGoTo(state, "ai")).toBe(true);
    expect(canGoTo(state, "tour")).toBe(false);
    expect(wizardReducer(state, { type: "goto", step: "tour" })).toBe(state);
    expect(currentStep(wizardReducer(state, { type: "goto", step: "welcome" }))).toBe("welcome");
  });

  it("resets to a fresh wizard", () => {
    const state = run([{ type: "next" }, { type: "skip" }, { type: "reset" }]);
    expect(state).toEqual(initialWizardState());
  });
});
