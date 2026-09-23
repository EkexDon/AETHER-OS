import { create } from "zustand";
import type { IndexReport, KindReport, SearchKind } from "../types";
import { onSearchIndexProgress, searchReindex } from "./ipc";
import { useShellStore } from "../shell/shellStore";
import { toast } from "../ui/Toast";
import { SECTION_META } from "./search/kinds";

/** Category tab of the Universal Search view (`all` or one backend kind). */
export type SearchTab = "all" | SearchKind;

interface SearchState {
  /** Query the launcher should adopt the next time it renders (`null` = keep). */
  pendingQuery: string | null;
  /** Universal Search view: query, tab, semantic toggle, selected result. */
  viewQuery: string;
  viewTab: SearchTab;
  viewSemantic: boolean;
  viewSelectedId: string | null;
  /** A reindex started from the UI is running. */
  reindexing: boolean;
  /** Per-kind reports of the running (or last) reindex. */
  progress: KindReport[];

  /** Open the launcher, optionally pre-filled (e.g. `/` for "Go to file"). */
  openLauncher: (query?: string) => void;
  /** Forget {@link SearchState.pendingQuery} once the launcher adopted it. */
  clearPendingQuery: () => void;
  setViewQuery: (query: string) => void;
  setViewTab: (tab: SearchTab) => void;
  setViewSemantic: (on: boolean) => void;
  setViewSelectedId: (id: string | null) => void;
  /** Show `query` in the Universal Search view (and preselect a result). */
  showInSearchView: (query: string, selectId?: string | null, tab?: SearchTab) => void;
  /** Rebuild the index; resolves to the report (or `null` if one is running). */
  reindex: (kinds?: SearchKind[]) => Promise<IndexReport | null>;
}

/** Human summary of an index report for toasts: "412 notes · 3 180 files · 12 apps". */
export function describeReport(report: IndexReport): string {
  const parts = report.kinds
    .filter((k) => !k.error && k.count > 0)
    .map((k) => `${k.count.toLocaleString()} ${SECTION_META[k.kind].label.toLowerCase()}`);
  const failed = report.kinds.filter((k) => k.error).map((k) => SECTION_META[k.kind].label);
  const summary = parts.length > 0 ? parts.join(" · ") : "Nothing to index yet";
  const truncated = report.kinds.some((k) => k.truncated) ? " (file limit reached)" : "";
  const failures = failed.length > 0 ? ` — failed: ${failed.join(", ")}` : "";
  return `${summary}${truncated}${failures} · ${(report.ms / 1000).toFixed(1)} s`;
}

/** State of the launcher and the Universal Search view. */
export const useSearchStore = create<SearchState>((set, get) => ({
  pendingQuery: null,
  viewQuery: "",
  viewTab: "all",
  viewSemantic: false,
  viewSelectedId: null,
  reindexing: false,
  progress: [],

  openLauncher: (query = "") => {
    set({ pendingQuery: query });
    useShellStore.getState().setLauncherOpen(true);
  },
  clearPendingQuery: () => {
    if (get().pendingQuery !== null) set({ pendingQuery: null });
  },
  setViewQuery: (viewQuery) => set({ viewQuery }),
  setViewTab: (viewTab) => set({ viewTab }),
  setViewSemantic: (viewSemantic) => set({ viewSemantic }),
  setViewSelectedId: (viewSelectedId) => set({ viewSelectedId }),
  showInSearchView: (query, selectId = null, tab = "all") =>
    set({ viewQuery: query, viewSelectedId: selectId, viewTab: tab }),

  reindex: async (kinds) => {
    if (get().reindexing) return null;
    set({ reindexing: true, progress: [] });
    const pending = toast.info("Reindexing search…", {
      description: "Notes, projects, files, apps and more",
      duration: 0,
    });
    const unlisten = await onSearchIndexProgress((report) =>
      set((s) => ({ progress: [...s.progress.filter((p) => p.kind !== report.kind), report] }))
    );
    try {
      const report = await searchReindex(kinds);
      set({ progress: report.kinds });
      toast.dismiss(pending);
      const failed = report.kinds.filter((k) => k.error);
      if (failed.length > 0) {
        toast.error("Search index partly updated", {
          description: `${describeReport(report)}. ${failed.map((f) => `${SECTION_META[f.kind].label}: ${f.error}`).join("; ")}`,
        });
      } else {
        toast.success("Search index updated", { description: describeReport(report) });
      }
      return report;
    } catch (e) {
      toast.dismiss(pending);
      toast.error("Reindex failed", { description: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      unlisten();
      set({ reindexing: false });
    }
  },
}));
