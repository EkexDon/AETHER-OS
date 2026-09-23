/** Agent memory types — mirror `engine/memory_store.rs`. */

/** One chat message as persisted in a conversation. */
export interface ChatMessageRecord {
  role: string;
  content: string;
}

/** A saved chat conversation. */
export interface Conversation {
  id: string;
  /** Seconds since the Unix epoch. */
  timestamp: number;
  messages: ChatMessageRecord[];
  context_notes: string[];
  summary: string;
}

/** A long-term fact the agent remembers about the user. */
export interface MemoryFact {
  fact: string;
  category: string;
  /** Seconds since the Unix epoch. */
  created_at: number;
}
