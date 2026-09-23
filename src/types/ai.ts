/** AI, search and AETHER Notes types — mirror `commands/ai_commands.rs`,
 *  `engine/vector_db.rs` and `engine/aether_notes.rs`. */

/** One semantic search hit. `id` is the note path, `text` its indexed content. */
export interface VectorMatch {
  id: string;
  text: string;
  score: number;
}

/** Backend connectivity summary. */
export interface SystemHealth {
  ollama_online: boolean;
  openrouter_configured: boolean;
  vault_connected: boolean;
}

/** Outcome of `cmd_index_vault`. */
export interface IndexingResult {
  total: number;
  indexed: number;
  skipped: number;
}

/** An AI-generated note stored in AETHER's own library (not the vault). */
export interface AetherNote {
  id: string;
  title: string;
  content: string;
  source_query: string;
  related_notes: string[];
  created_at: string;
}
