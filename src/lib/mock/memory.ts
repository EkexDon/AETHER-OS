/** Mock handlers for `commands/memory_commands.rs`, plus the shared fact
 *  store used by the agent-action router mock. */
import type { ChatMessageRecord, Conversation, MemoryFact } from "../../types";
import {
  argOptNumber,
  argString,
  argStringArray,
  mockUuid,
  nowSeconds,
  registerReset,
  type MockArgs,
  type MockHandlerMap,
} from "./runtime";

interface MemoryState {
  facts: MemoryFact[];
  conversations: Conversation[];
}

function seed(): MemoryState {
  const now = nowSeconds();
  const conv = (
    ageHours: number,
    user: string,
    assistant: string,
    context: string[] = []
  ): Conversation => ({
    id: mockUuid(),
    timestamp: now - ageHours * 3600,
    messages: [
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ],
    context_notes: context,
    summary: summarize(user),
  });
  return {
    facts: [
      { fact: "Prefers answers in English, notes are mixed German/English", category: "preferences", created_at: now - 20 * 86_400 },
      { fact: "Is writing a master's thesis on RAG for personal knowledge bases", category: "projects", created_at: now - 14 * 86_400 },
      { fact: "Moves to Berlin-Friedrichshain next month", category: "personal", created_at: now - 6 * 86_400 },
      { fact: "Runs Ollama on a home lab GPU box", category: "work", created_at: now - 2 * 86_400 },
    ],
    conversations: [
      conv(3, "What should I focus on today?", "Based on your daily note: finish the mock backend and two pomodoros on the thesis."),
      conv(26, "Fasse meine Notizen zum Umzug zusammen", "Offen sind: Umzugsfirma buchen, Internet beantragen und die Ummeldung beim Bürgeramt."),
      conv(75, "Explain Rust lifetimes with an example from my notes", "Your note [[Rust Ownership]] has a `longest` function — the lifetime `'a` ties both inputs to the output."),
    ],
  };
}

let state = seed();
registerReset(() => {
  state = seed();
});

function summarize(text: string): string {
  const chars = [...text];
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : text;
}

/** Append a fact and return all facts (like `MemoryStore::save_fact`). */
export function saveFact(fact: string, category: string): MemoryFact[] {
  state.facts.push({ fact, category, created_at: nowSeconds() });
  return state.facts.map((f) => ({ ...f }));
}

function parseMessages(args: MockArgs): ChatMessageRecord[] {
  const value = args.messages;
  if (!Array.isArray(value)) {
    throw new Error("invalid args `messages` for command: command missing required key messages");
  }
  return value.map((m) => {
    const record = m as Partial<ChatMessageRecord>;
    return { role: String(record.role ?? ""), content: String(record.content ?? "") };
  });
}

export const memoryHandlers: MockHandlerMap = {
  cmd_save_conversation: (args) => {
    const messages = parseMessages(args);
    const conversation: Conversation = {
      id: mockUuid(),
      timestamp: nowSeconds(),
      messages,
      context_notes: argStringArray(args, "contextNotes"),
      summary: messages[0] ? summarize(messages[0].content) : "",
    };
    state.conversations.push(conversation);
    return conversation;
  },
  cmd_get_recent_conversations: (args) => {
    const limit = argOptNumber(args, "limit") ?? 20;
    return [...state.conversations].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  },
  cmd_delete_conversation: (args) => {
    const id = argString(args, "id");
    state.conversations = state.conversations.filter((c) => c.id !== id);
  },
  cmd_save_memory_fact: (args) => saveFact(argString(args, "fact"), argString(args, "category")),
  cmd_get_memory_facts: () => state.facts,
  cmd_delete_memory_fact: (args) => {
    const fact = argString(args, "fact");
    state.facts = state.facts.filter((f) => f.fact !== fact);
    return state.facts;
  },
};
