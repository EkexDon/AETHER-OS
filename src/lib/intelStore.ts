/**
 * State of the `intel` feature: settings, the current chat session (with its
 * compaction), agent action runs, the approval queue and "always allow"
 * rules, and per-note related suggestions.
 *
 * The chat session lives here (not in `AgentChat`) so it survives closing
 * and reopening the agent panel, and so approvals keep working when the
 * panel is closed while an action waits for a decision.
 */
import { create } from "zustand";
import type {
  ActionRisk,
  AgentAction,
  CommandOutput,
  CompactionResult,
  Conversation,
  IntelSettings,
  RelatedSuggestion,
  SummarySource,
} from "../types";
import { getIntelSettings, setIntelSettings } from "./ipc";
import { actionRisk, ruleMatches, ruleScope, type AllowRule } from "./intel/risk";
import { isCompactionSummary } from "./intel/summary";
import { DEFAULT_KEEP_RECENT, DEFAULT_THRESHOLD_TOKENS } from "./intel/tokens";

/** Defaults until the backend answered (same as Rust `IntelSettings::default`). */
export const DEFAULT_INTEL_SETTINGS: IntelSettings = {
  auto_compact: true,
  compact_threshold_tokens: DEFAULT_THRESHOLD_TOKENS,
  keep_recent_messages: DEFAULT_KEEP_RECENT,
  related_suggestions: true,
  llm_tag_suggestions: false,
  command_timeout_secs: 60,
};

/** localStorage key of persisted ("confirm"-level) allow rules. */
export const ALLOW_RULES_KEY = "aether-intel-allow-rules";

/** One chat message in the current session. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The session's compaction state. */
export interface CompactionState {
  summary: string;
  /** Messages at the start of the transcript covered by the summary. */
  compactedCount: number;
  source: SummarySource;
  tokensBefore: number;
  tokensAfter: number;
  modelError: string | null;
  /** Epoch ms of the last compaction (0 when restored from history). */
  at: number;
}

/** The chat session shown in the agent panel. */
export interface ChatSession {
  /** Memory-store conversation id once saved. */
  conversationId: string | null;
  /** Full transcript (what the user sees). */
  messages: ChatMessage[];
  compaction: CompactionState | null;
}

/** Lifecycle of one agent action. */
export type ActionRunStatus = "queued" | "awaiting" | "running" | "done" | "error" | "denied";

/** One agent action and its outcome. */
export interface ActionRun {
  id: string;
  action: AgentAction;
  risk: ActionRisk;
  status: ActionRunStatus;
  /** Result or error text. */
  message?: string;
  /** Shell output of `run_command`. */
  output?: CommandOutput;
}

/** A decision in the approval dialog. */
export type ApprovalDecision = "approved" | "denied";

/** An action waiting in the approval dialog. */
export interface ApprovalItem {
  runId: string;
  action: AgentAction;
  risk: ActionRisk;
}

/** Cached suggestions for one note. */
export interface RelatedEntry {
  /** Hash of the text the suggestions were computed for. */
  key: string;
  loading: boolean;
  suggestions: RelatedSuggestion[];
  tags: string[];
  error: string | null;
  updatedAt: number;
}

interface IntelState {
  settings: IntelSettings;
  settingsLoaded: boolean;
  loadSettings: () => Promise<IntelSettings>;
  updateSettings: (patch: Partial<IntelSettings>) => Promise<IntelSettings>;

  session: ChatSession;
  compacting: boolean;
  setCompacting: (v: boolean) => void;
  appendTurn: (user: string, assistant: string) => void;
  setConversationId: (id: string | null) => void;
  applyCompaction: (result: CompactionResult, previousCompacted: number) => void;
  loadConversation: (conversation: Conversation) => void;
  resetSession: () => void;

  runs: ActionRun[];
  addRuns: (actions: AgentAction[]) => ActionRun[];
  updateRun: (id: string, patch: Partial<Omit<ActionRun, "id" | "action">>) => void;
  clearRuns: () => void;

  approvals: ApprovalItem[];
  requestApproval: (run: ActionRun) => Promise<ApprovalDecision>;
  resolveApproval: (runId: string, decision: ApprovalDecision, remember?: boolean) => void;
  approveAll: () => void;
  denyAll: () => void;

  allowRules: AllowRule[];
  isAllowed: (action: AgentAction) => boolean;
  addAllowRule: (action: AgentAction) => AllowRule;
  removeAllowRule: (id: string) => void;

  related: Record<string, RelatedEntry>;
  relatedOpen: boolean;
  setRelatedOpen: (open: boolean) => void;
  toggleRelated: () => void;
  setRelated: (path: string, patch: Partial<RelatedEntry>) => void;
}

const resolvers = new Map<string, (decision: ApprovalDecision) => void>();
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

function loadPersistedRules(): AllowRule[] {
  try {
    const raw = localStorage.getItem(ALLOW_RULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is AllowRule =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as AllowRule).id === "string" &&
        typeof (r as AllowRule).kind === "string" &&
        // Dangerous rules must never survive a restart, even if tampered in.
        (r as AllowRule).risk === "confirm"
    );
  } catch {
    return [];
  }
}

function persistRules(rules: AllowRule[]): void {
  try {
    localStorage.setItem(ALLOW_RULES_KEY, JSON.stringify(rules.filter((r) => r.risk === "confirm")));
  } catch {
    // storage unavailable — rules still apply for this session
  }
}

const emptySession = (): ChatSession => ({ conversationId: null, messages: [], compaction: null });

export const useIntelStore = create<IntelState>((set, get) => ({
  settings: DEFAULT_INTEL_SETTINGS,
  settingsLoaded: false,
  loadSettings: async () => {
    const settings = await getIntelSettings();
    set({ settings, settingsLoaded: true });
    return settings;
  },
  updateSettings: async (patch) => {
    const next = { ...get().settings, ...patch };
    const stored = await setIntelSettings(next);
    set({ settings: stored, settingsLoaded: true });
    return stored;
  },

  session: emptySession(),
  compacting: false,
  setCompacting: (compacting) => set({ compacting }),
  appendTurn: (user, assistant) =>
    set((s) => ({
      session: {
        ...s.session,
        messages: [...s.session.messages, { role: "user", content: user }, { role: "assistant", content: assistant }],
      },
    })),
  setConversationId: (conversationId) => set((s) => ({ session: { ...s.session, conversationId } })),
  applyCompaction: (result, previousCompacted) =>
    set((s) => ({
      session: {
        ...s.session,
        compaction: {
          summary: result.summary,
          compactedCount: Math.min(s.session.messages.length, previousCompacted + result.dropped_count),
          source: result.source,
          tokensBefore: result.tokens_before,
          tokensAfter: result.tokens_after,
          modelError: result.model_error,
          at: Date.now(),
        },
      },
    })),
  loadConversation: (conversation) => {
    const messages: ChatMessage[] = conversation.messages.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
    const keep = get().settings.keep_recent_messages;
    const compaction: CompactionState | null = isCompactionSummary(conversation.summary)
      ? {
          summary: conversation.summary,
          compactedCount: Math.max(0, messages.length - keep),
          source: "model",
          tokensBefore: 0,
          tokensAfter: 0,
          modelError: null,
          at: 0,
        }
      : null;
    set({ session: { conversationId: conversation.id, messages, compaction }, runs: [] });
  },
  resetSession: () => set({ session: emptySession(), runs: [] }),

  runs: [],
  addRuns: (actions) => {
    const runs = actions.map<ActionRun>((action) => ({
      id: nextId("run"),
      action,
      risk: actionRisk(action),
      status: "queued",
    }));
    set((s) => ({ runs: [...s.runs, ...runs] }));
    return runs;
  },
  updateRun: (id, patch) => set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  clearRuns: () => set({ runs: [] }),

  approvals: [],
  requestApproval: (run) =>
    new Promise<ApprovalDecision>((resolve) => {
      resolvers.set(run.id, resolve);
      set((s) => ({ approvals: [...s.approvals, { runId: run.id, action: run.action, risk: run.risk }] }));
    }),
  resolveApproval: (runId, decision, remember = false) => {
    const item = get().approvals.find((a) => a.runId === runId);
    if (!item) return;
    const settle = (id: string, d: ApprovalDecision) => {
      resolvers.get(id)?.(d);
      resolvers.delete(id);
    };
    settle(runId, decision);
    let remaining = get().approvals.filter((a) => a.runId !== runId);
    if (decision === "approved" && remember) {
      const rule = get().addAllowRule(item.action);
      const covered = remaining.filter((a) => ruleMatches(rule, a.action));
      covered.forEach((a) => settle(a.runId, "approved"));
      remaining = remaining.filter((a) => !covered.includes(a));
    }
    set({ approvals: remaining });
  },
  approveAll: () => {
    get().approvals.forEach((a) => {
      resolvers.get(a.runId)?.("approved");
      resolvers.delete(a.runId);
    });
    set({ approvals: [] });
  },
  denyAll: () => {
    get().approvals.forEach((a) => {
      resolvers.get(a.runId)?.("denied");
      resolvers.delete(a.runId);
    });
    set({ approvals: [] });
  },

  allowRules: loadPersistedRules(),
  isAllowed: (action) => get().allowRules.some((rule) => ruleMatches(rule, action)),
  addAllowRule: (action) => {
    const existing = get().allowRules.find(
      (r) => r.kind === action.action && r.scope === ruleScope(action)
    );
    if (existing) return existing;
    const rule: AllowRule = {
      id: nextId("rule"),
      kind: action.action,
      scope: ruleScope(action),
      risk: actionRisk(action),
      createdAt: Date.now(),
    };
    const rules = [...get().allowRules, rule];
    set({ allowRules: rules });
    persistRules(rules);
    return rule;
  },
  removeAllowRule: (id) => {
    const rules = get().allowRules.filter((r) => r.id !== id);
    set({ allowRules: rules });
    persistRules(rules);
  },

  related: {},
  relatedOpen: false,
  setRelatedOpen: (relatedOpen) => set({ relatedOpen }),
  toggleRelated: () => set((s) => ({ relatedOpen: !s.relatedOpen })),
  setRelated: (path, patch) =>
    set((s) => {
      const previous: RelatedEntry = s.related[path] ?? {
        key: "",
        loading: false,
        suggestions: [],
        tags: [],
        error: null,
        updatedAt: 0,
      };
      return { related: { ...s.related, [path]: { ...previous, ...patch } } };
    }),
}));

/** Messages after the compaction point — what is sent verbatim. */
export function activeMessages(session: ChatSession): ChatMessage[] {
  return session.messages.slice(session.compaction?.compactedCount ?? 0);
}
