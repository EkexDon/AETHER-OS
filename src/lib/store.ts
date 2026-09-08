import { create } from "zustand";
import type {
  AetherNote,
  CalendarEvent,
  CalendarView,
  Conversation,
  GraphData,
  IcsImportResult,
  MemoryFact,
  Project,
  ReminderSettings,
  SystemHealth,
  VaultNote,
  VaultStats,
  VectorMatch,
} from "../types";

export type ViewMode = "dashboard" | "search" | "graph" | "notes" | "projects" | "memory" | "terminal" | "monitor" | "browser" | "editor" | "ide" | "calendar";

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

function loadReminderSettings(): ReminderSettings {
  try {
    const raw = localStorage.getItem("aether-calendar-reminders");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.enabled === "boolean" && Array.isArray(parsed?.lead_times_minutes)) {
        return parsed;
      }
    }
  } catch {
    // ignore storage errors (e.g. private mode)
  }
  return { enabled: false, lead_times_minutes: [15, 0] };
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
  openNoteTabs: string[];
  chatOpen: boolean;

  // Calendar
  calendarEvents: CalendarEvent[];
  calendarView: CalendarView;
  calendarDate: string;            // ISO "YYYY-MM-DD" of the focused day
  calendarImportExportOpen: boolean;
  calendarRemindersOpen: boolean;
  reminderSettings: ReminderSettings;
  setCalendarEvents: (events: CalendarEvent[]) => void;
  upsertCalendarEvent: (event: CalendarEvent) => void;
  removeCalendarEvent: (id: string) => void;
  setCalendarView: (v: CalendarView) => void;
  setCalendarDate: (d: string) => void;
  setCalendarImportExportOpen: (open: boolean) => void;
  setCalendarRemindersOpen: (open: boolean) => void;
  setReminderSettings: (settings: ReminderSettings) => void;

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
  closeNoteTab: (path: string) => void;
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
  openNoteTabs: [],
  chatOpen: loadChatOpen(),

  // Calendar
  calendarEvents: [],
  calendarView: "month",
  calendarDate: new Date().toISOString().slice(0, 10),
  calendarImportExportOpen: false,
  calendarRemindersOpen: false,
  reminderSettings: loadReminderSettings(),

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
  selectNote: (selectedNotePath) => set((state) => {
    if (!selectedNotePath) return { selectedNotePath: null };
    const tabs = state.openNoteTabs.includes(selectedNotePath)
      ? state.openNoteTabs
      : [...state.openNoteTabs, selectedNotePath];
    return { selectedNotePath, openNoteTabs: tabs };
  }),
  closeNoteTab: (path) => set((state) => {
    const remaining = state.openNoteTabs.filter((t) => t !== path);
    let nextActive = state.selectedNotePath;
    if (state.selectedNotePath === path) {
      nextActive = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    return { openNoteTabs: remaining, selectedNotePath: nextActive };
  }),
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
  setCalendarEvents: (calendarEvents) => set({ calendarEvents }),
  upsertCalendarEvent: (event) => set((state) => {
    const existing = state.calendarEvents.findIndex((e) => e.id === event.id);
    if (existing >= 0) {
      const next = [...state.calendarEvents];
      next[existing] = event;
      return { calendarEvents: next };
    }
    return { calendarEvents: [...state.calendarEvents, event] };
  }),
  removeCalendarEvent: (id) => set((state) => ({
    calendarEvents: state.calendarEvents.filter((e) => e.id !== id),
  })),
  setCalendarView: (calendarView) => set({ calendarView }),
  setCalendarDate: (calendarDate) => set({ calendarDate }),
  setCalendarImportExportOpen: (calendarImportExportOpen) => set({ calendarImportExportOpen }),
  setCalendarRemindersOpen: (calendarRemindersOpen) => set({ calendarRemindersOpen }),
  setReminderSettings: (reminderSettings) => {
    try {
      localStorage.setItem("aether-calendar-reminders", JSON.stringify(reminderSettings));
    } catch {
      // ignore storage errors (e.g. private mode)
    }
    set({ reminderSettings });
  },
}));
