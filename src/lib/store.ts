import { create } from "zustand";
import type { AetherNote, Conversation, GraphData, MemoryFact, Project, SystemHealth, VaultNote, VaultStats, VectorMatch } from "../types";

export type ViewMode = "dashboard" | "search" | "graph" | "notes" | "projects" | "memory" | "terminal" | "monitor" | "browser" | "editor" | "ide";

export type AiProvider = "ollama" | "openrouter";

const EDITOR_STORAGE_KEY = "aether-preferred-editor";
const PROVIDER_STORAGE_KEY = "aether-ai-provider";
const MODEL_STORAGE_PREFIX = "aether-model-";
const CHAT_OPEN_STORAGE_KEY = "aether-chat-open";

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  ollama: "gemma2:2b",
  openrouter: "anthropic/claude-sonnet-4",
};

function loadProvider(): AiProvider {
  try {
    return localStorage.getItem(PROVIDER_STORAGE_KEY) === "openrouter" ? "openrouter" : "ollama";
  } catch {
    return "ollama";
  }
}

function loadModel(provider: AiProvider): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_PREFIX + provider) ?? DEFAULT_MODELS[provider];
  } catch {
    return DEFAULT_MODELS[provider];
  }
}

function loadModelByProvider(): Record<AiProvider, string> {
  return { ollama: loadModel("ollama"), openrouter: loadModel("openrouter") };
}

function loadChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

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
  noteDirty: boolean;
  showQuickCapture: boolean;
  provider: AiProvider;
  modelByProvider: Record<AiProvider, string>;
  chatOpen: boolean;

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
  setNoteDirty: (v: boolean) => void;
  setShowQuickCapture: (v: boolean) => void;
  setProvider: (provider: AiProvider) => void;
  setModelForProvider: (provider: AiProvider, model: string) => void;
  setChatOpen: (open: boolean) => void;
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
  noteDirty: false,
  showQuickCapture: false,
  provider: loadProvider(),
  modelByProvider: loadModelByProvider(),
  chatOpen: loadChatOpen(),

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
  setNoteDirty: (noteDirty) => set({ noteDirty }),
  setShowQuickCapture: (showQuickCapture) => set({ showQuickCapture }),
  setProvider: (provider) => {
    try {
      localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    } catch {
      // ignore storage errors (e.g. private mode)
    }
    set({ provider });
  },
  setModelForProvider: (provider, model) => {
    try {
      localStorage.setItem(MODEL_STORAGE_PREFIX + provider, model);
    } catch {
      // ignore storage errors (e.g. private mode)
    }
    set((state) => ({
      modelByProvider: { ...state.modelByProvider, [provider]: model },
    }));
  },
  setChatOpen: (chatOpen) => {
    try {
      localStorage.setItem(CHAT_OPEN_STORAGE_KEY, String(chatOpen));
    } catch {
      // ignore storage errors (e.g. private mode)
    }
    set({ chatOpen });
  },
}));
