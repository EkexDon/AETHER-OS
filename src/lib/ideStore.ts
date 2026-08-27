import { create } from "zustand";
import { languageForPath } from "./language";

export interface OpenFile {
  path: string;
  name: string;
  /** The live editor buffer. */
  content: string;
  /** The content as last read from or written to disk. */
  savedContent: string;
  language: string;
}

/**
 * Dirty state is derived rather than stored, so a tab can never be marked
 * clean while its buffer still differs from what is on disk.
 */
export function isDirty(file: OpenFile): boolean {
  return file.content !== file.savedContent;
}

export interface IdeState {
  rootPath: string | null;
  tabs: OpenFile[];
  activePath: string | null;

  setRoot: (path: string | null) => void;
  openFile: (path: string, content: string) => void;
  closeFile: (path: string) => void;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  markSaved: (path: string) => void;
  closeAll: () => void;
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export const useIdeStore = create<IdeState>((set) => ({
  rootPath: null,
  tabs: [],
  activePath: null,

  setRoot: (rootPath) => set({ rootPath }),

  // Opening an already-open file focuses its tab instead of reloading it,
  // which would silently discard unsaved edits.
  openFile: (path, content) =>
    set((state) => {
      const existing = state.tabs.find((t) => t.path === path);
      if (existing) return { activePath: path };
      const tab: OpenFile = {
        path,
        name: fileName(path),
        content,
        savedContent: content,
        language: languageForPath(path),
      };
      return { tabs: [...state.tabs, tab], activePath: path };
    }),

  closeFile: (path) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.path === path);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.path !== path);
      let activePath = state.activePath;
      if (activePath === path) {
        // Focus the neighbour that visually takes the closed tab's place.
        const next = tabs[index] ?? tabs[index - 1];
        activePath = next ? next.path : null;
      }
      return { tabs, activePath };
    }),

  setActive: (activePath) => set({ activePath }),

  updateContent: (path, content) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.path === path ? { ...t, content } : t)),
    })),

  markSaved: (path) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.path === path ? { ...t, savedContent: t.content } : t
      ),
    })),

  closeAll: () => set({ tabs: [], activePath: null }),
}));
