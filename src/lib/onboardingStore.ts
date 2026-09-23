import { create } from "zustand";
import type { OnboardingState, PullOutcome, UpdateInfo } from "../types";
import {
  cancelOllamaPull,
  checkForUpdates,
  listLocalModels,
  onOllamaPullProgress,
  pullOllamaModel,
  setOnboardingState,
  type UnlistenFn,
} from "./ipc";
import { toast } from "../ui/Toast";
import { initialWizardState, wizardReducer, type WizardAction, type WizardState } from "./onboarding/wizard";
import { APP_VERSION } from "./onboarding/appVersion";
import { DEFAULT_VIEW, type ViewMode } from "../views/modes";

/**
 * State of the onboarding feature: the first-run wizard, "What's new", the
 * Ollama guidance modal, model downloads (which outlive the component that
 * started them) and the update check — plus the preferences this feature
 * owns (start view, agent panel on start, automatic update check, editor
 * typography). Preferences persist in localStorage under
 * {@link PREFS_STORAGE_KEY}; the wizard state itself lives in Rust
 * (`<data_dir>/onboarding.json`).
 */

/** localStorage key of {@link OnboardingPrefs}. */
export const PREFS_STORAGE_KEY = "aether-onboarding-prefs";

/** What the agent panel does when the app starts. */
export type AgentPanelOnStart = "remember" | "open" | "closed";

/** Preferences owned by this feature. */
export interface OnboardingPrefs {
  /** View shown when the app starts. */
  startView: ViewMode;
  agentPanelOnStart: AgentPanelOnStart;
  /** Check GitHub for a new release once a day on launch. */
  autoCheckUpdates: boolean;
  /** Epoch ms of the last update check (manual or automatic). */
  lastUpdateCheckAt: number | null;
  /** Show the "What's new" note once after an update. */
  showWhatsNew: boolean;
  /** Note editor body text size in px. */
  editorFontSize: number;
  /** Maximum width of the note editor column in px. */
  editorLineWidth: number;
}

/** Allowed editor font sizes. */
export const EDITOR_FONT_SIZE = { min: 13, max: 22, default: 15 } as const;
/** Allowed editor column widths. */
export const EDITOR_LINE_WIDTH = { min: 560, max: 1120, step: 40, default: 760 } as const;

/** Defaults for a first launch. The update check stays off until the user opts in (wizard or settings). */
export const DEFAULT_PREFS: OnboardingPrefs = {
  startView: DEFAULT_VIEW,
  agentPanelOnStart: "remember",
  autoCheckUpdates: false,
  lastUpdateCheckAt: null,
  showWhatsNew: true,
  editorFontSize: EDITOR_FONT_SIZE.default,
  editorLineWidth: EDITOR_LINE_WIDTH.default,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

/** Parse stored preferences; unknown or invalid fields fall back to the defaults. */
export function parsePrefs(raw: string | null | undefined): OnboardingPrefs {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  const agent = data.agentPanelOnStart;
  return {
    startView: typeof data.startView === "string" && data.startView ? (data.startView as ViewMode) : DEFAULT_PREFS.startView,
    agentPanelOnStart: agent === "open" || agent === "closed" || agent === "remember" ? agent : DEFAULT_PREFS.agentPanelOnStart,
    autoCheckUpdates: typeof data.autoCheckUpdates === "boolean" ? data.autoCheckUpdates : DEFAULT_PREFS.autoCheckUpdates,
    lastUpdateCheckAt:
      typeof data.lastUpdateCheckAt === "number" && Number.isFinite(data.lastUpdateCheckAt) ? data.lastUpdateCheckAt : null,
    showWhatsNew: typeof data.showWhatsNew === "boolean" ? data.showWhatsNew : DEFAULT_PREFS.showWhatsNew,
    editorFontSize: clampInt(data.editorFontSize, EDITOR_FONT_SIZE.min, EDITOR_FONT_SIZE.max, EDITOR_FONT_SIZE.default),
    editorLineWidth: clampInt(data.editorLineWidth, EDITOR_LINE_WIDTH.min, EDITOR_LINE_WIDTH.max, EDITOR_LINE_WIDTH.default),
  };
}

function loadPrefs(): OnboardingPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(PREFS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs: OnboardingPrefs): void {
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode): the prefs still apply this session.
  }
}

/**
 * Apply the editor typography as CSS variables on `<html>`
 * (`--editor-font-size`, `--editor-line-width`), read by
 * `src/styles/views/onboarding.css`.
 */
export function applyEditorPrefs(
  prefs: Pick<OnboardingPrefs, "editorFontSize" | "editorLineWidth">,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null
): void {
  if (!root) return;
  root.style.setProperty("--editor-font-size", `${prefs.editorFontSize}px`);
  root.style.setProperty("--editor-line-width", `${prefs.editorLineWidth}px`);
}

/** Progress of one model download. */
export interface PullState {
  name: string;
  /** Ollama's latest status line (`starting` before the first event). */
  status: string;
  completed: number | null;
  total: number | null;
  phase: "running" | "done" | "error" | "cancelled";
  error: string | null;
}

interface OnboardingStore {
  prefs: OnboardingPrefs;
  setPrefs: (patch: Partial<OnboardingPrefs>) => void;

  /** Wizard state from the backend (`null` until loaded). */
  onboarding: OnboardingState | null;
  setOnboarding: (state: OnboardingState) => void;

  wizardOpen: boolean;
  /** Hidden while the user tries a command from the tour. */
  wizardMinimized: boolean;
  wizard: WizardState;
  /** Open the wizard; `restart` starts over at the welcome step. */
  openWizard: (options?: { restart?: boolean }) => void;
  closeWizard: () => void;
  minimizeWizard: () => void;
  resumeWizard: () => void;
  dispatchWizard: (action: WizardAction) => void;
  /** Persist completion (or a skip) and close the wizard. */
  finishWizard: (skippedSteps: string[]) => Promise<OnboardingState>;

  whatsNewOpen: boolean;
  openWhatsNew: () => void;
  closeWhatsNew: () => void;

  ollamaGuideOpen: boolean;
  openOllamaGuide: () => void;
  closeOllamaGuide: () => void;

  /** Installed Ollama models (`null` = not loaded / Ollama offline). */
  installedModels: string[] | null;
  refreshModels: () => Promise<string[] | null>;

  pulls: Record<string, PullState>;
  /** Download a model; resolves `null` when that model is already downloading. */
  startPull: (name: string) => Promise<PullOutcome | null>;
  cancelPull: (name: string) => Promise<void>;
  dismissPull: (name: string) => void;

  update: UpdateInfo | null;
  updateError: string | null;
  checkingUpdates: boolean;
  checkUpdates: () => Promise<UpdateInfo>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let pullListener: Promise<UnlistenFn> | null = null;

/** One app-wide subscription to `ollama-pull-progress`, created on the first pull. */
function ensurePullListener(): Promise<UnlistenFn> {
  pullListener ??= onOllamaPullProgress((p) => {
    useOnboardingStore.setState((s) => {
      const prev = s.pulls[p.name];
      if (!prev || prev.phase !== "running") return s;
      return { pulls: { ...s.pulls, [p.name]: { ...prev, status: p.status, completed: p.completed, total: p.total } } };
    });
  }).catch(() => {
    pullListener = null;
    return () => undefined;
  });
  return pullListener;
}

const initialPrefs = loadPrefs();
applyEditorPrefs(initialPrefs);

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  prefs: initialPrefs,
  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    savePrefs(prefs);
    if ("editorFontSize" in patch || "editorLineWidth" in patch) applyEditorPrefs(prefs);
    set({ prefs });
  },

  onboarding: null,
  setOnboarding: (onboarding) => set({ onboarding }),

  wizardOpen: false,
  wizardMinimized: false,
  wizard: initialWizardState(),
  openWizard: (options) =>
    set((s) => ({
      wizardOpen: true,
      wizardMinimized: false,
      wizard: options?.restart || !s.wizardOpen ? initialWizardState() : s.wizard,
    })),
  closeWizard: () => set({ wizardOpen: false, wizardMinimized: false }),
  minimizeWizard: () => set((s) => (s.wizardOpen ? { wizardMinimized: true } : s)),
  resumeWizard: () => set((s) => (s.wizardOpen ? { wizardMinimized: false } : s)),
  dispatchWizard: (action) => set((s) => ({ wizard: wizardReducer(s.wizard, action) })),
  finishWizard: async (skippedSteps) => {
    const stored = await setOnboardingState({
      completed_at: new Date().toISOString(),
      version_seen: APP_VERSION,
      skipped_steps: skippedSteps,
    });
    set({ onboarding: stored, wizardOpen: false, wizardMinimized: false, wizard: initialWizardState() });
    return stored;
  },

  whatsNewOpen: false,
  openWhatsNew: () => set({ whatsNewOpen: true }),
  closeWhatsNew: () => set({ whatsNewOpen: false }),

  ollamaGuideOpen: false,
  openOllamaGuide: () => set({ ollamaGuideOpen: true }),
  closeOllamaGuide: () => set({ ollamaGuideOpen: false }),

  installedModels: null,
  refreshModels: async () => {
    try {
      const models = await listLocalModels();
      set({ installedModels: models });
      return models;
    } catch {
      // Ollama offline: the guidance UI explains it; keep the list unknown.
      set({ installedModels: null });
      return null;
    }
  },

  pulls: {},
  startPull: async (rawName) => {
    const name = rawName.trim();
    if (get().pulls[name]?.phase === "running") return null;
    set((s) => ({
      pulls: { ...s.pulls, [name]: { name, status: "starting", completed: null, total: null, phase: "running", error: null } },
    }));
    await ensurePullListener();
    const finish = (patch: Partial<PullState>) =>
      set((s) => ({ pulls: { ...s.pulls, [name]: { ...(s.pulls[name] ?? { name, completed: null, total: null }), ...patch } as PullState } }));
    try {
      const outcome = await pullOllamaModel(name);
      if (outcome.cancelled) {
        finish({ phase: "cancelled", status: "cancelled", error: null });
        toast.info(`Download of ${name} cancelled`);
      } else {
        finish({ phase: "done", status: "success", error: null });
        toast.success(`${name} is ready`, { description: "The model is installed in Ollama." });
        await get().refreshModels();
      }
      return outcome;
    } catch (e) {
      const text = message(e);
      finish({ phase: "error", error: text });
      toast.error(`Could not download ${name}`, { description: text });
      throw new Error(text);
    }
  },
  cancelPull: async (name) => {
    try {
      await cancelOllamaPull(name.trim());
    } catch (e) {
      toast.error("Could not cancel the download", { description: message(e) });
    }
  },
  dismissPull: (name) =>
    set((s) => {
      if (!s.pulls[name] || s.pulls[name].phase === "running") return s;
      const pulls = { ...s.pulls };
      delete pulls[name];
      return { pulls };
    }),

  update: null,
  updateError: null,
  checkingUpdates: false,
  checkUpdates: async () => {
    set({ checkingUpdates: true, updateError: null });
    try {
      const info = await checkForUpdates();
      set({ update: info, checkingUpdates: false });
      get().setPrefs({ lastUpdateCheckAt: Date.now() });
      return info;
    } catch (e) {
      const text = message(e);
      set({ updateError: text, checkingUpdates: false });
      throw new Error(text);
    }
  },
}));
