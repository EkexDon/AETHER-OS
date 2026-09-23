/**
 * Mock handlers for `commands/ai_commands.rs`: indexing (≈1.5 s), ranked
 * fake semantic search, and a fake LLM that streams a plausible Markdown
 * answer word by word over `llm-stream-chunk` (~30 ms per chunk). Some
 * answers carry an ```action block so the agent-action UI can be exercised.
 */
import type { IndexingResult, SystemHealth } from "../../types";
import { firstSentence } from "./markdown";
import {
  argNumber,
  argOptString,
  argString,
  argStringArray,
  mockEvents,
  registerReset,
  sleep,
  type MockHandlerMap,
} from "./runtime";
import { mockVault } from "./vaultStore";

/** Event name used by the real backend for streamed tokens. */
export const STREAM_EVENT = "llm-stream-chunk";
/** Delay between streamed chunks. */
export const STREAM_CHUNK_MS = 30;
/** How long `cmd_index_vault` pretends to embed the vault. */
export const INDEX_DURATION_MS = 1500;

/** Models reported by the fake local Ollama. */
export const MOCK_LOCAL_MODELS = ["qwen2.5:7b", "llama3.2:1b", "gemma2:2b"];
const MOCK_CLOUD_MODELS = [
  "anthropic/claude-3.5-sonnet",
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.1-70b-instruct",
  "mistralai/mistral-small",
];
const MISSING_KEY = "OpenRouter API key is missing. Set it in Settings → AI Providers.";

interface AiState {
  openRouterKey: string | null;
  turns: number;
}

let state: AiState = { openRouterKey: null, turns: 0 };
registerReset(() => {
  state = { openRouterKey: null, turns: 0 };
});

/** Split text into stream chunks: one word plus its trailing whitespace. */
export function chunkText(text: string): string[] {
  return text.match(/\s*\S+\s*/g) ?? [];
}

/** Emit `text` over `llm-stream-chunk`, resolving after the last chunk. */
export async function streamText(text: string, chunkMs = STREAM_CHUNK_MS): Promise<void> {
  for (const chunk of chunkText(text)) {
    await sleep(chunkMs);
    mockEvents.emit(STREAM_EVENT, chunk);
  }
}

const GERMAN_HINT = /\b(und|ich|der|die|das|ist|wie|was|bitte|nicht|mit|meine?|heute|zusammen|fasse|welche|warum|kannst)\b/i;

interface ContextNote {
  name: string;
  path: string;
  content: string;
}

type ActionKind = "append_daily" | "add_memory_fact" | "create_note" | null;

/** Decide whether this answer carries an agent action. Explicit intents
 *  always do; otherwise every third turn appends to the daily note. */
export function pickAction(prompt: string, turn: number): ActionKind {
  const p = prompt.toLowerCase();
  if (/\b(remember|merk|merke|vergiss nicht)\b/.test(p)) return "add_memory_fact";
  if (/\b(create|new|neue|erstelle)\b.*\b(note|notiz)\b/.test(p)) return "create_note";
  if (/\b(daily|today|heute|todo|log)\b/.test(p)) return "append_daily";
  return turn % 3 === 0 ? "append_daily" : null;
}

function actionBlock(kind: Exclude<ActionKind, null>, prompt: string, german: boolean): string {
  const short = prompt.replace(/\s+/g, " ").trim().slice(0, 90);
  switch (kind) {
    case "add_memory_fact": {
      const fact = short.replace(/^(please\s+)?(remember|merk dir|merke dir|merke)( that| dass)?\s*/i, "");
      const action = { action: "add_memory_fact", fact: fact || short, category: "general" };
      return `${german ? "Das merke ich mir." : "I'll remember that for you."}\n\n\`\`\`action\n${JSON.stringify(action)}\n\`\`\``;
    }
    case "create_note": {
      const title = short.replace(/^.*?\b(note|notiz)\b\s*(about|über|zu)?\s*/i, "").slice(0, 60) || "AETHER idea";
      const action = {
        action: "create_note",
        title: `00-Inbox/${title.replace(/[/:]/g, "-")}`,
        content: `# ${title}\n\nCreated by AETHER from the chat.\n\n- [ ] Flesh this out\n`,
      };
      return `${german ? "Ich lege dafür eine neue Notiz an." : "I'll create a new note for this."}\n\n\`\`\`action\n${JSON.stringify(action)}\n\`\`\``;
    }
    case "append_daily": {
      const action = { action: "append_daily", content: `Asked AETHER: "${short}"` };
      return `${german ? "Ich notiere das in deiner Tagesnotiz." : "I'll log this in today's daily note."}\n\n\`\`\`action\n${JSON.stringify(action)}\n\`\`\``;
    }
  }
}

/** Compose a plausible Markdown answer grounded in the given notes. */
export function composeAnswer(
  prompt: string,
  context: ContextNote[],
  turn: number,
  model: string
): string {
  const german = GERMAN_HINT.test(prompt);
  const top = context.slice(0, 3);
  const parts: string[] = [];

  if (top.length === 0) {
    parts.push(
      german
        ? `Dazu habe ich in deinen Notizen nichts Passendes gefunden. Allgemein gilt: Zerlege die Frage in kleine Schritte und halte das Ergebnis in einer Notiz fest.`
        : `I couldn't find anything about that in your notes. In general: break the question into small steps and capture the outcome in a note.`
    );
  } else {
    parts.push(
      german
        ? `**Kurz gesagt:** ${firstSentence(top[0].content) || `Die wichtigsten Infos stehen in [[${top[0].name}]].`}`
        : `**Short answer:** ${firstSentence(top[0].content) || `The key details are in [[${top[0].name}]].`}`
    );
    parts.push(german ? "Das steht in deinen Notizen:" : "Here's what your notes say:");
    parts.push(
      top
        .map((n) => `- **[[${n.name}]]** — ${firstSentence(n.content) || (german ? "enthält relevante Details." : "has relevant details.")}`)
        .join("\n")
    );
    const openTasks = top
      .flatMap((n) => n.content.split("\n").filter((l) => /^\s*- \[ \]/.test(l)).map((l) => l.replace(/^\s*- \[ \]\s*/, "")))
      .slice(0, 3);
    if (openTasks.length > 0) {
      parts.push(`### ${german ? "Offene Punkte" : "Open items"}\n${openTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);
    }
  }

  if (/\b(code|rust|typescript|function|funktion|beispiel|example)\b/i.test(prompt)) {
    parts.push(
      "```ts\n// Keep pure logic outside components so it is easy to test\nexport function summarize(notes: string[]): string {\n  return notes.map((n) => n.split(\"\\n\")[0]).join(\"; \");\n}\n```"
    );
  }

  parts.push(german ? `_Antwort von ${model} (Mock-Modus)._` : `_Answered by ${model} (mock mode)._`);

  const kind = pickAction(prompt, turn);
  if (kind) parts.push(actionBlock(kind, prompt, german));
  return parts.join("\n\n");
}

function contextFor(prompt: string, paths: string[] | null): ContextNote[] {
  const matches = mockVault.search(prompt, 5, paths ?? undefined).filter((m) => m.score > 0.32);
  return matches.map((m) => ({
    path: m.id,
    content: m.text,
    name: m.id.slice(m.id.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
  }));
}

function health(): SystemHealth {
  return {
    ollama_online: true,
    openrouter_configured: state.openRouterKey !== null,
    vault_connected: mockVault.root !== null,
  };
}

export const aiHandlers: MockHandlerMap = {
  cmd_index_vault: async (): Promise<IndexingResult> => {
    const notes = mockVault.list();
    await sleep(INDEX_DURATION_MS);
    const skipped = notes.filter((n) => mockVault.read(n.path).trim().length < 10).length;
    return { total: notes.length, indexed: notes.length - skipped, skipped };
  },
  cmd_semantic_search: (args) =>
    mockVault.search(argString(args, "query"), Math.min(argNumber(args, "limit"), 100)),
  cmd_agent_query: async (args) => {
    const prompt = argString(args, "prompt");
    const model = argString(args, "model");
    const context = contextFor(prompt, null);
    state.turns += 1;
    await streamText(composeAnswer(prompt, context, state.turns, model));
    return context.map((c) => c.path);
  },
  cmd_agent_query_with_notes: async (args) => {
    const prompt = argString(args, "prompt");
    const model = argString(args, "model");
    const notePaths = argStringArray(args, "notePaths");
    const provider = argOptString(args, "provider");
    if (provider === "openrouter" && state.openRouterKey === null) throw new Error(MISSING_KEY);
    state.turns += 1;
    await streamText(composeAnswer(prompt, contextFor(prompt, notePaths), state.turns, model));
  },
  cmd_set_openrouter_key: (args) => {
    const key = argOptString(args, "key");
    state.openRouterKey = key && key.trim() ? key.trim() : null;
    return state.openRouterKey !== null;
  },
  cmd_list_cloud_models: () => {
    if (state.openRouterKey === null) throw new Error(MISSING_KEY);
    return MOCK_CLOUD_MODELS;
  },
  cmd_list_local_models: () => MOCK_LOCAL_MODELS,
  cmd_get_health: () => health(),
};
