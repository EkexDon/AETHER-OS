/** Agent memory commands (`src-tauri/src/commands/memory_commands.rs`). */
import type { ChatMessageRecord, Conversation, MemoryFact } from "../../types";
import { call } from "./core";

/** Persist a chat conversation. */
export const saveConversation = (messages: ChatMessageRecord[], contextNotes: string[]) =>
  call<Conversation>("cmd_save_conversation", { messages, contextNotes });
/** Most recent conversations, newest first (default limit 20). */
export const getRecentConversations = (limit?: number) =>
  call<Conversation[]>("cmd_get_recent_conversations", { limit });
/** Delete a conversation by id. */
export const deleteConversation = (id: string) => call<void>("cmd_delete_conversation", { id });
/** Remember a fact; returns all facts. */
export const saveMemoryFact = (fact: string, category: string) =>
  call<MemoryFact[]>("cmd_save_memory_fact", { fact, category });
/** All remembered facts, oldest first. */
export const getMemoryFacts = () => call<MemoryFact[]>("cmd_get_memory_facts");
/** Forget a fact (matched by text); returns the remaining facts. */
export const deleteMemoryFact = (fact: string) =>
  call<MemoryFact[]>("cmd_delete_memory_fact", { fact });
