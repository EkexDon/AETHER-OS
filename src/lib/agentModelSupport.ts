/**
 * Heuristic registry of which models reliably emit the ````action`
 * JSON-fenced-block format. The system prompt instructs the model how to
 * emit tool calls, but smaller/weaker models sometimes ignore the
 * instruction. Knowing the capability up-front lets the UI:
 *
 *  1. Warn the user ("tools may be unreliable with this model")
 *  2. Still attempt parsing on every response (the parser is cheap)
 *  3. Not block UX if the model fails to emit — the agent stays in chat mode
 *
 * Update this list as you test new models. Family prefixes match the
 * Ollama `name:tag` and OpenRouter `vendor/name:tag` slugs.
 */
const KNOWN_GOOD_OLLAMA_FAMILIES: string[] = [
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "qwen2",
  "qwen2.5",
  "mistral-nemo",
  "mistral-large",
  "command-r",
  "gemma2",
  "phi3.5",
  "deepseek-v2",
  "mixtral",
];

const KNOWN_GOOD_CLOUD_FAMILIES: string[] = [
  "openai/gpt-4",
  "openai/gpt-4o",
  "openai/gpt-3.5",
  "anthropic/claude-3",
  "anthropic/claude-3.5",
  "anthropic/claude-3.7",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-opus-4",
  "google/gemini",
  "google/gemini-2",
  "google/gemini-1.5",
  "mistralai/mistral-large",
  "mistralai/mistral-nemo",
  "qwen/qwen-2.5-72b",
  "meta-llama/llama-3.1",
  "meta-llama/llama-3.3",
];

const KNOWN_BAD_FAMILIES: string[] = [
  "tinyllama",
  "gemma:2b",
  "qwen:0.5b",
  "llama2",
  "phi",
  "stablelm",
];

/** Returns true if the model is trusted to emit ````action` blocks. */
export function supportsAgentActions(model: string, provider: "ollama" | "openrouter"): boolean {
  const m = model.toLowerCase();
  const families = provider === "ollama" ? KNOWN_GOOD_OLLAMA_FAMILIES : KNOWN_GOOD_CLOUD_FAMILIES;
  if (families.some((f) => m.startsWith(f))) return true;
  if (KNOWN_BAD_FAMILIES.some((f) => m.startsWith(f))) return false;
  // Default: assume yes for any model we haven't classified. The system
  // prompt gives instructions, and the parser is forgiving — so the worst
  // case is a model that ignores the instruction, in which case no
  // action blocks appear and the user sees a normal chat reply.
  return true;
}
