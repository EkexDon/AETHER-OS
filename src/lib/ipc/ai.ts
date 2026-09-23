/** AI, indexing and search commands (`src-tauri/src/commands/ai_commands.rs`). */
import type { IndexingResult, SystemHealth, VectorMatch } from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Embed every vault note with the local model and store the vectors. */
export const indexVault = () => call<IndexingResult>("cmd_index_vault");
/** Rank indexed notes by semantic similarity to `query`. */
export const semanticSearch = (query: string, limit = 10) =>
  call<VectorMatch[]>("cmd_semantic_search", { query, limit });
/** Ask the agent with automatic top-5 note retrieval; the answer streams
 *  over `llm-stream-chunk`, the resolved value lists the context paths. */
export const agentQuery = (prompt: string, model: string) =>
  call<string[]>("cmd_agent_query", { prompt, model });
/** Ask the agent with explicitly selected notes as context. Resolves when
 *  the streamed answer (`llm-stream-chunk`) is complete. */
export const agentQueryWithNotes = (
  prompt: string,
  notePaths: string[],
  model: string,
  provider?: "ollama" | "openrouter"
) => call<void>("cmd_agent_query_with_notes", { prompt, notePaths, model, provider });
/** Store (or clear with `null`) the OpenRouter API key. Returns whether a key is configured. */
export const setOpenRouterKey = (key: string | null) => call<boolean>("cmd_set_openrouter_key", { key });
/** OpenRouter model ids (requires a configured key). */
export const listCloudModels = () => call<string[]>("cmd_list_cloud_models");
/** Installed Ollama models. */
export const listLocalModels = () => call<string[]>("cmd_list_local_models");
/** Ollama / OpenRouter / vault connectivity. */
export const getHealth = () => call<SystemHealth>("cmd_get_health");

/** Subscribe to streamed LLM answer chunks. */
export function onStreamChunk(handler: (chunk: string) => void): Promise<UnlistenFn> {
  return listenSafe<string>("llm-stream-chunk", handler);
}
