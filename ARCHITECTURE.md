# AETHER-OS Architecture

AETHER-OS is a local-first AI Homestation that integrates with NoPes, a local-first knowledge base. AETHER-OS reads the NoPes vault (Markdown files + `.nopes/index.json`), semantically indexes all notes, and provides context-aware AI responses. The Tauri shell keeps privileged storage and execution within Rust; the React webview communicates through typed IPC commands only.

## Components

```text
React UI → Typed IPC → Tauri Commands → Rust AppState
                                      ├─ Vault Reader (reads NoPes vault)
                                      ├─ Local vector store (indexes vault notes)
                                      ├─ Ollama client (localhost only)
                                      └─ AETHER Notes store (AI-generated notes)
```

## Data flow

1. On startup, AETHER-OS auto-detects the NoPes vault path (from config or by scanning for `.nopes/index.json`).
2. `cmd_get_vault_notes` scans the vault directory for all `.md` files. `cmd_get_vault_index` reads the parsed NoPes index (tasks, tags, wikilinks, cards, frontmatter).
3. `cmd_index_vault` generates embeddings for all vault notes via local Ollama (`nomic-embed-text`) and stores them in the local vector index. The dimension is defined by the model and locked per index.
4. `cmd_semantic_search` embeds the query locally, ranks persistent vectors by cosine similarity, and returns the highest scoring matches.
5. `cmd_agent_query` embeds the prompt, finds the top-5 relevant notes via semantic search, loads their content, builds a context-aware system prompt, and streams the AI response via the `llm-stream-chunk` event.
6. `cmd_create_aether_note` saves AI-generated responses as notes in AETHER-OS's own storage (not in the NoPes vault).

## IPC API

| Command | Input | Output |
| --- | --- | --- |
| `cmd_get_vault_path` | none | `Option<String>` |
| `cmd_set_vault_path` | path | none |
| `cmd_get_vault_notes` | none | `VaultNote[]` |
| `cmd_get_note_content` | path | `String` |
| `cmd_get_vault_index` | none | `Option<VaultIndex>` |
| `cmd_get_vault_graph` | none | `GraphData` |
| `cmd_get_vault_stats` | none | `VaultStats` |
| `cmd_index_vault` | none | `IndexingResult` |
| `cmd_semantic_search` | query, limit | `VectorMatch[]` |
| `cmd_agent_query` | prompt, model | `String[]` (context paths) + token events |
| `cmd_agent_query_with_notes` | prompt, note_paths, model | token events |
| `cmd_get_health` | none | `SystemHealth` |
| `cmd_create_aether_note` | title, content, source_query, related_notes | `AetherNote` |
| `cmd_get_aether_notes` | none | `AetherNote[]` |
| `cmd_delete_aether_note` | id | none |

## Security boundaries

- The UI has no direct filesystem, process, or shell access.
- AETHER-OS is **read-only** on the NoPes vault — it never writes to or modifies NoPes files.
- AI-generated notes are stored in AETHER-OS's own App Data directory, completely separate from the vault.
- Ollama requests are restricted to `localhost:11434`.
- Vectors must be finite and match the dimension already stored in the index; changing the embedding model requires re-indexing.
- Embedding calls support both the current `/api/embed` and legacy `/api/embeddings` endpoints, and report a missing model with the exact `ollama pull` command.
