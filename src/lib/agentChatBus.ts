/**
 * Public entry points into the agent chat for other features (Home's
 * "Continue" list, conversation pins, the command palette). They only touch
 * stores, never components, so callers do not need to import `AgentChat`.
 *
 * ```ts
 * import { openConversation } from "../lib/agentChatBus";
 * await openConversation(conversation.id); // opens the panel with that chat
 * ```
 */
import type { Conversation } from "../types";
import { getRecentConversations } from "./ipc";
import { useIntelStore } from "./intelStore";
import { useAetherStore } from "./store";

/** How many recent conversations are searched for an id. */
export const OPEN_CONVERSATION_LOOKUP = 100;

/**
 * Open the agent panel with the saved conversation `id` loaded (its
 * compaction summary included); following messages continue that
 * conversation. Looks in the loaded history first, then in the most recent
 * saved conversations. Rejects when the conversation no longer exists or
 * the agent is still answering.
 */
export async function openConversation(id: string): Promise<Conversation> {
  const aether = useAetherStore.getState();
  if (aether.busy) throw new Error("The agent is still answering — try again when it is done.");
  let conversation = aether.conversations.find((c) => c.id === id);
  if (!conversation) {
    const recent = await getRecentConversations(OPEN_CONVERSATION_LOOKUP);
    useAetherStore.getState().setConversations(recent.slice(0, 20));
    conversation = recent.find((c) => c.id === id);
  }
  if (!conversation) throw new Error("That conversation no longer exists — it may have been deleted.");
  useIntelStore.getState().loadConversation(conversation);
  useAetherStore.getState().clearAgentOutput();
  useAetherStore.getState().setChatOpen(true);
  return conversation;
}

/** Open the agent panel with an empty chat. */
export function startNewConversation(): void {
  if (useAetherStore.getState().busy) return;
  useIntelStore.getState().resetSession();
  useAetherStore.getState().clearAgentOutput();
  useAetherStore.getState().setChatOpen(true);
}
