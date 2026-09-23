/**
 * Export feature state: which export wizard is open (so commands can open
 * it from anywhere) and the recent exports list.
 */
import { create } from "zustand";
import type { ExportFlow, ExportScope, RecentExport } from "../types";
import { exportClearRecent, exportListRecent } from "./ipc";

/** An open export wizard. */
export interface ExportWizardState {
  flow: ExportFlow;
  /** Initial scope (`null` → the flow's default). */
  scope: ExportScope | null;
  /** Changes on every open so the wizard remounts with fresh state. */
  key: number;
}

interface ExportStoreState {
  wizard: ExportWizardState | null;
  recents: RecentExport[];
  recentsStatus: "idle" | "loading" | "ready" | "error";
  recentsError: string | null;
  /** Open the wizard for `flow`, optionally with a scope. */
  openWizard: (flow: ExportFlow, scope?: ExportScope | null) => void;
  closeWizard: () => void;
  /** (Re)load the recent exports list. */
  loadRecents: () => Promise<void>;
  /** Forget the recent exports (files stay on disk). */
  clearRecents: () => Promise<void>;
}

let openCounter = 0;

export const useExportStore = create<ExportStoreState>((set) => ({
  wizard: null,
  recents: [],
  recentsStatus: "idle",
  recentsError: null,
  openWizard: (flow, scope = null) => {
    openCounter += 1;
    set({ wizard: { flow, scope, key: openCounter } });
  },
  closeWizard: () => set({ wizard: null }),
  loadRecents: async () => {
    set((s) => ({ recentsStatus: s.recents.length ? s.recentsStatus : "loading", recentsError: null }));
    try {
      const recents = await exportListRecent();
      set({ recents, recentsStatus: "ready" });
    } catch (e) {
      set({ recentsStatus: "error", recentsError: e instanceof Error ? e.message : String(e) });
    }
  },
  clearRecents: async () => {
    await exportClearRecent();
    set({ recents: [], recentsStatus: "ready", recentsError: null });
  },
}));
