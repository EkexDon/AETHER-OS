/**
 * Chat-level orchestration of the `intel` feature, independent of any
 * component so it keeps working while the agent panel is closed:
 *
 * - `processAgentActions`: run the actions of one assistant reply in order —
 *   safe ones immediately, gated ones after the approval dialog decided
 *   (all gated actions of a reply are queued at once so "Approve all" works).
 * - `compactSession`: summarise the older part of the chat.
 * - `persistSession`: save the session (one memory-store record per chat).
 */
import type { AgentAction, CompactionResult, Conversation } from "../../types";
import { intelCompact, saveIntelConversation } from "../ipc";
import { activeMessages, useIntelStore, type ActionRun, type ApprovalDecision } from "../intelStore";
import { useAetherStore, type AiProvider } from "../store";
import { needsApproval } from "./risk";
import { estimateConversationTokens, needsCompaction } from "./tokens";
import { recordDenied, runAgentAction } from "./executeAction";

/** Run the actions of one reply. Resolves when every action finished. */
export async function processAgentActions(actions: AgentAction[]): Promise<ActionRun[]> {
  const store = useIntelStore.getState();
  const runs = store.addRuns(actions);
  const decisions = new Map<string, Promise<ApprovalDecision>>();
  for (const run of runs) {
    if (needsApproval(run.action) && !useIntelStore.getState().isAllowed(run.action)) {
      store.updateRun(run.id, { status: "awaiting" });
      decisions.set(run.id, store.requestApproval(run));
    }
  }
  for (const run of runs) {
    const pending = decisions.get(run.id);
    if (pending) {
      const decision = await pending;
      if (decision === "denied") {
        useIntelStore.getState().updateRun(run.id, { status: "denied", message: "Denied — nothing was changed" });
        recordDenied(run.action);
        continue;
      }
    }
    useIntelStore.getState().updateRun(run.id, { status: "running" });
    try {
      const outcome = await runAgentAction(run.action);
      useIntelStore.getState().updateRun(run.id, { status: "done", message: outcome.message, output: outcome.output });
    } catch (e) {
      useIntelStore.getState().updateRun(run.id, {
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const byId = new Map(useIntelStore.getState().runs.map((r) => [r.id, r]));
  return runs.map((r) => byId.get(r.id) ?? r);
}

/** Save the session (replacing its previous record) and update the history list. */
export async function persistSession(contextNotes: string[]): Promise<Conversation | null> {
  const { session } = useIntelStore.getState();
  if (session.messages.length === 0) return null;
  const conversation = await saveIntelConversation({
    id: session.conversationId,
    messages: session.messages,
    contextNotes,
    summary: session.compaction?.summary ?? null,
  });
  useIntelStore.getState().setConversationId(conversation.id);
  const aether = useAetherStore.getState();
  aether.setConversations([conversation, ...aether.conversations.filter((c) => c.id !== conversation.id)].slice(0, 20));
  return conversation;
}

/** Estimated tokens of what the next prompt carries. */
export function sessionTokens(): number {
  const { session } = useIntelStore.getState();
  return estimateConversationTokens(session.compaction?.summary, activeMessages(session));
}

/** True when auto mode should compact now. */
export function shouldAutoCompact(): boolean {
  const { settings, session, compacting } = useIntelStore.getState();
  if (!settings.auto_compact || compacting) return false;
  return needsCompaction(
    sessionTokens(),
    settings.compact_threshold_tokens,
    activeMessages(session).length,
    settings.keep_recent_messages
  );
}

/** True when there is something older than the kept window to summarise. */
export function canCompact(): boolean {
  const { settings, session, compacting } = useIntelStore.getState();
  return !compacting && activeMessages(session).length > Math.max(1, settings.keep_recent_messages);
}

/**
 * Compact the session with the current model; the summary replaces
 * everything but the last `keep_recent_messages` messages in the prompt
 * window (the transcript itself is kept and saved).
 */
export async function compactSession(model: string, provider: AiProvider): Promise<CompactionResult | null> {
  const state = useIntelStore.getState();
  if (!canCompact()) return null;
  const session = state.session;
  const previousCompacted = session.compaction?.compactedCount ?? 0;
  state.setCompacting(true);
  try {
    const result = await intelCompact({
      messages: activeMessages(session),
      model,
      provider,
      previousSummary: session.compaction?.summary ?? null,
      keepRecent: state.settings.keep_recent_messages,
    });
    useIntelStore.getState().applyCompaction(result, previousCompacted);
    return result;
  } finally {
    useIntelStore.getState().setCompacting(false);
  }
}
