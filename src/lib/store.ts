import { create } from "zustand";
import type { AetherNote, Conversation, GraphData, MemoryFact, Project, SystemHealth, VaultNote, VaultStats, VectorMatch } from "../types";

export type ViewMode = "dashboard" | "search" | "graph" | "notes" | "projects" | "memory" | "terminal";

const EDITOR_STORAGE_KEY = "aether-preferred-editor";

function loadPreferredEditor(): string {
  try {
    return localStorage.getItem(EDITOR_STORAGE_KEY) ?? "devin";
  } catch {
    return "devin";
  }
}

interface AetherState {
  vaultPath: string | null;
  vaultNotes: VaultNote[];
  vaultStats: VaultStats | null;
  graph: GraphData;
  agentOutput: string;
  agentContext: string[];
  contextNotes: Set<string>;
  allNotesInContext: boolean;
  health: SystemHealth | null;
  searchResults: VectorMatch[];
  aetherNotes: AetherNote[];
  projects: Project[];
  conversations: Conversation[];
  memoryFacts: MemoryFact[];
  view: ViewMode;
  selectedNotePath: string | null;
  noteContent: string | null;
  indexing: boolean;
  busy: boolean;
  preferredEditor: string;

  setVaultPath: (path: string | null) => void;
  setVaultNotes: (notes: VaultNote[]) => void;
  setVaultStats: (stats: VaultStats | null) => void;
  setGraph: (graph: GraphData) => void;
  appendAgentOutput: (chunk: string) => void;
  clearAgentOutput: () => void;
  setAgentContext: (paths: string[]) => void;
  toggleContextNote: (path: string) => void;
  setAllNotesInContext: (v: boolean) => void;
  resetContextToAll: () => void;
  setHealth: (health: SystemHealth) => void;
  setSearchResults: (results: VectorMatch[]) => void;
  setAetherNotes: (notes: AetherNote[]) => void;
  setProjects: (projects: Project[]) => void;
  setConversations: (conversations: Conversation[]) => void;
  setMemoryFacts: (facts: MemoryFact[]) => void;
  setView: (view: ViewMode) => void;
  selectNote: (path: string | null) => void;
  setNoteContent: (content: string | null) => void;
  setIndexing: (v: boolean) => void;
  setBusy: (v: boolean) => void;
  setPreferredEditor: (editor: string) => void;
}

export const useAetherStore = create<AetherState>((set) => ({
  vaultPath: null,
  vaultNotes: [],
  vaultStats: null,
  graph: { nodes: [], edges: [] },
  agentOutput: "",
  agentContext: [],
  contextNotes: new Set<string>(),
  allNotesInContext: true,
  health: null,
  searchResults: [],
  aetherNotes: [],
  projects: [],
  conversations: [],
  memoryFacts: [],
  view: "dashboard",
  selectedNotePath: null,
  noteContent: null,
  indexing: false,
  busy: false,
  preferredEditor: loadPreferredEditor(),

  setVaultPath: (vaultPath) => set({ vaultPath }),
  setVaultNotes: (vaultNotes) => set({ vaultNotes }),
  setVaultStats: (vaultStats) => set({ vaultStats }),
  setGraph: (graph) => set({ graph }),
  appendAgentOutput: (chunk) => set((state) => ({ agentOutput: state.agentOutput + chunk })),
  clearAgentOutput: () => set({ agentOutput: "" }),
  setAgentContext: (agentContext) => set({ agentContext }),
  toggleContextNote: (path) => set((state) => {
    const next = new Set(state.contextNotes);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { contextNotes: next, allNotesInContext: false };
  }),
  setAllNotesInContext: (allNotesInContext) => set({ allNotesInContext }),
  resetContextToAll: () => set({ contextNotes: new Set<string>(), allNotesInContext: true }),
  setHealth: (health) => set({ health }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setAetherNotes: (aetherNotes) => set({ aetherNotes }),
  setProjects: (projects) => set({ projects }),
  setConversations: (conversations) => set({ conversations }),
  setMemoryFacts: (memoryFacts) => set({ memoryFacts }),
  setView: (view) => set({ view }),
  selectNote: (selectedNotePath) => set({ selectedNotePath }),
  setNoteContent: (noteContent) => set({ noteContent }),
  setIndexing: (indexing) => set({ indexing }),
  setBusy: (busy) => set({ busy }),
  setPreferredEditor: (preferredEditor) => {
    try {
      localStorage.setItem(EDITOR_STORAGE_KEY, preferredEditor);
    } catch {
      // ignore storage errors (e.g. private mode)
    }
    set({ preferredEditor });
  },
}));
