# AETHER-OS MASTER EXECUTION DIRECTIVE
## The Complete, Uncompromising Production-Grade Blueprint

## OPERATIONAL MANDATE FOR THE AI AGENT:
You are operating as a Principal Systems Architect and Lead Engineer. You do not write stubs, mock implementations, todo! macros, or placehold comments. Every single function must be fully written, wired, error-handled, tested, and documented. You will build AETHER-OS to completion across 8 sequential, self-contained phases.

## SYSTEM ARCHITECTURE OVERVIEW
```
+-----------------------------------------------------------------------+
|                         AETHER UI (React + TS)                        |
|  [ Knowledge Graph ]   [ Block Editor ]   [ Agent Console ] [ Health ]|
+-----------------------------------+-----------------------------------+
                                    | (Tauri v2 IPC Events / Streams)
+-----------------------------------v-----------------------------------+
|                        RUST CORE ENGINE (Tauri)                       |
|  +--------------------------+     +--------------------------------+  |
|  | SqliteEngine             |     | VectorEngine                   |  |
|  | (rusqlite + r2d2)        |     | (LanceDB + FastEmbed 384-dim)  |  |
|  +--------------------------+     +--------------------------------+  |
|  +--------------------------+     +--------------------------------+  |
|  | LocalAiEngine            |     | WasmSandboxEngine              |  |
|  | (Ollama Stream + ONNX)   |     | (Wasmtime Fuel/Mem Limits)     |  |
|  +--------------------------+     +--------------------------------+  |
|  +-----------------------------------------------------------------+  |
|  | CrdtEngine (Automerge State & Binary Patch Sync)                |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------------------------------------------+
```

## 🔒 GLOBAL EXECUTION GUARDRAILS (STRICT ENFORCEMENT)
NO SHORTCUTS: Never use todo!(), unimplemented!(), // TODO, or mock responses. Write real, functioning algorithms.
ZERO COMPILER WARNINGS: Rust must pass cargo clippy -- -D warnings and cargo check. TypeScript must pass npx tsc --noEmit --strict.
TEST-DRIVEN INTEGRITY: Every phase must include dedicated unit and integration tests. No phase is marked complete until its test suite passes 100%.
UNIFIED ERROR HANDLING: All Rust errors must map to a custom AetherError enum via thiserror. All frontend IPC calls must handle typed errors gracefully.
SELF-DOCUMENTING CODE: All public Rust modules and TypeScript interfaces must carry clean, concise inline docstrings (/// in Rust, /** */ in TS).

## PHASE 1: PROJECT SCAFFOLDING & UNIFIED ERROR SYSTEM

### Objective
Establish the foundational workspace, setup Rust Tauri v2 backend configurations, configure Node dependencies, and build the centralized error-handling engine.

### Instructions for Agent:
Initialize a Tauri v2 workspace with React, Vite, TypeScript, and TailwindCSS.
Create src-tauri/Cargo.toml with the exact following dependencies:

```ini
[package]
name = "aether-core"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2.0", features = [] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
rusqlite = { version = "0.31", features = ["bundled"] }
r2d2 = "0.8"
r2d2_sqlite = "0.24"
lancedb = "0.10"
automerge = "0.5"
wasmtime = "20.0"
reqwest = { version = "0.12", features = ["json", "stream"] }
thiserror = "1.0"
fastembed = "3.0"
futures-util = "0.3"
uuid = { version = "1.8", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }

[dev-dependencies]
tempfile = "3.8"
```

Implement src-tauri/src/engine/error.rs:
Create AetherError enum using thiserror:

```rust
Database(#[from] rusqlite::Error)
Pool(#[from] r2d2::Error)
Vector(#[from] lancedb::Error)
AiEngine(String)
Sandbox(#[from] wasmtime::Error)
Crdt(#[from] automerge::AutomergeError)
Io(#[from] std::io::Error)
```

Implement serde::Serialize manually for AetherError so it can be passed across Tauri's IPC bridge seamlessly as String JSON error objects.
Write unit tests in src-tauri/src/engine/error.rs checking serialization and string conversions.

## PHASE 2: RELATIONAL & KNOWLEDGE GRAPH ENGINE (sqlite_db.rs)

### Objective
Build a robust, thread-safe SQLite engine managing relational data, knowledge-graph connections, and agent execution logs using an r2d2 connection pool.

### Instructions for Agent:
Implement src-tauri/src/engine/sqlite_db.rs.
Define Rust structs with Serialize / Deserialize:
Node: id (String), title (String), content (String), tags (Vec), created_at (i64), updated_at (i64).
Edge: source_id (String), target_id (String), relation (String), weight (f64).
AgentLog: id (String), agent_name (String), prompt (String), response (String), latency_ms (i64), timestamp (i64).
GraphData: nodes (Vec), edges (Vec).

Implement SqliteEngine:

```rust
pub fn new(db_path: &std::path::Path) -> Result<Self, AetherError>
```

Creates r2d2::Pool<SqliteConnectionManager>, enables WAL mode (PRAGMA journal_mode=WAL;), and runs auto-migrations for tables: nodes, edges, agent_logs.

```rust
pub fn create_node(&self, title: &str, content: &str, tags: Vec<String>) -> Result<Node, AetherError>
pub fn update_node(&self, id: &str, title: &str, content: &str, tags: Vec<String>) -> Result<Node, AetherError>
pub fn delete_node(&self, id: &str) -> Result<(), AetherError>
pub fn connect_nodes(&self, source: &str, target: &str, relation: &str, weight: f64) -> Result<(), AetherError>
pub fn get_graph(&self) -> Result<GraphData, AetherError>
pub fn log_agent_execution(&self, log: AgentLog) -> Result<(), AetherError>
```

`delete_node` ensures cascading deletion of connected edges.

Write exhaustive unit tests in sqlite_db.rs (using temporary in-memory/tempfile SQLite DBs):
- Test full CRUD lifecycle for nodes.
- Test node linking and graph data extraction.
- Test cascading deletion of edges when a node is removed.

## PHASE 3: EMBEDDED VECTOR DB & LOCAL AI PIPELINE

### Objective
Create a zero-dependency local vector store using LanceDB and an embedded embedding pipeline (fastembed), combined with a streaming LLM client for local Ollama instances.

### Instructions for Agent:
Implement src-tauri/src/engine/vector_db.rs:
Define VectorMatch: id (String), text (String), score (f32).

Implement VectorEngine:

```rust
pub async fn new(storage_dir: &std::path::Path) -> Result<Self, AetherError>
pub async fn upsert_vector(&self, id: &str, vector: Vec<f32>, text: &str) -> Result<(), AetherError>
pub async fn search_similar(&self, query_vector: Vec<f32>, top_k: usize) -> Result<Vec<VectorMatch>, AetherError>
```

Implement src-tauri/src/engine/local_ai.rs:
Implement LocalAiEngine:
Initialize fastembed::TextEmbedding model (BAAI/bge-small-en-v1.5, producing 384-dimensional vectors).

```rust
pub fn generate_embedding(&self, text: &str) -> Result<Vec<f32>, AetherError>
pub async fn check_ollama_status(&self) -> bool
pub async fn stream_llm_response<F>(&self, prompt: &str, model: &str, chunk_callback: F) -> Result<(), AetherError> where F: Fn(String) + Send + 'static
```

`check_ollama_status` pings http://localhost:11434/api/tags. `stream_llm_response` uses reqwest::Client to handle NDJSON streams from Ollama's /api/generate.

Write unit tests in vector_db.rs and local_ai.rs:
- Test embedding generation and verify array length is exactly 384.
- Test vector upsertion and nearest-neighbor retrieval score consistency.

## PHASE 4: WASM SANDBOX & AUTOMERGE CRDT STORE

### Objective
Build a secure WebAssembly runtime with CPU/memory resource limits for custom user tools, and implement an offline-first CRDT engine for state synchronization.

### Instructions for Agent:
Implement src-tauri/src/engine/sandbox.rs:
Implement WasmSandboxEngine:
Setup wasmtime::Engine with fuel consumption enabled (Config::consume_fuel(true)).
Set default fuel limit (e.g., 1,000,000 instructions) and max memory limit (64MB).
No host filesystem access, no environment variable leaks.

```rust
pub fn execute_plugin(&self, wasm_bytes: &[u8], input_json: &str) -> Result<String, AetherError>
```

Implement src-tauri/src/engine/crdt_store.rs:
Implement CrdtEngine:
Manages an automerge::AutoCommit document structure.

```rust
pub fn new() -> Self
pub fn set_content(&mut self, text: &str) -> Result<Vec<u8>, AetherError>
pub fn merge_patch(&mut self, patch: &[u8]) -> Result<String, AetherError>
```

`set_content` updates text state and returns a binary sync patch (save()). `merge_patch` merges external patches deterministically and returns the updated text.

Write unit tests:
- Test WASM sandbox execution and verify fuel exhaustion aborts long loops.
- Test CRDT two-way state merging to prove offline conflict resolution works.

## PHASE 5: TAURI IPC COMMAND BRIDGE & STATE MANAGEMENT

### Objective
Expose all backend engines safely to the frontend layer through typed Tauri command handlers and streaming channels.

### Instructions for Agent:
Implement src-tauri/src/commands/mod.rs and submodules:

`db_commands.rs`:

```rust
cmd_get_graph(state: State<AppState>) -> Result<GraphData, String>
cmd_create_node(state: State<AppState>, title: String, content: String, tags: Vec<String>) -> Result<Node, String>
cmd_delete_node(state: State<AppState>, id: String) -> Result<(), String>
cmd_connect_nodes(state: State<AppState>, source: String, target: String, relation: String, weight: f64) -> Result<(), String>
```

`ai_commands.rs`:

```rust
cmd_index_document(state: State<AppState>, id: String, content: String) -> Result<(), String>
cmd_semantic_search(state: State<AppState>, query: String, limit: usize) -> Result<Vec<VectorMatch>, String>
cmd_stream_prompt(app_handle: AppHandle, state: State<AppState>, prompt: String, model: String) -> Result<(), String>
```

`cmd_stream_prompt` emits chunks over Tauri event channel `llm-stream-chunk`.

`system_commands.rs`:

```rust
cmd_run_wasm_tool(state: State<AppState>, wasm_hex: String, input: String) -> Result<String, String>
cmd_get_health(state: State<AppState>) -> Result<SystemHealth, String>
```

Setup AppState in src-tauri/src/lib.rs holding thread-safe references (Arc/Mutex) to all engines, initialize Tauri application builder, and register all command handlers.

## PHASE 6: FRONTEND TYPES, IPC CLIENT & ZUSTAND STORE

### Objective
Create strict TypeScript type definitions mirroring Rust data structures, build a wrapper for Tauri IPC calls, and implement unified state management.

### Instructions for Agent:
Create src/types/index.ts:
Explicit interfaces matching Rust models: Node, Edge, GraphData, VectorMatch, AgentLog, SystemHealth.

Create src/lib/ipc.ts:
Strongly typed async wrapper functions around @tauri-apps/api/core invoke calls.
Channel listener wrappers using @tauri-apps/api/event for streaming LLM responses.

Create src/lib/store.ts:
Zustand store (useAetherStore) managing active node selection, graph state, streaming agent output logs, search results, and system health status.

Write Vitest tests in src/lib/store.test.ts checking Zustand state mutations.

## PHASE 7: FRONTEND UI COMPONENTS & DASHBOARD LAYOUT

### Objective
Construct an interactive UI featuring a Knowledge Graph view, Block Editor, Agent Console, and Health Monitor.

### Instructions for Agent:
Setup Tailwind CSS styling with dark theme support.

Build components:
- src/components/KnowledgeGraph.tsx: Interactive graph visualizer utilizing @xyflow/react (React Flow). Renders nodes and edges, clicking a node opens it in the editor.
- src/components/BlockEditor.tsx: Text editor with auto-save feature. Automatically triggers document re-indexing (cmd_index_document) on change.
- src/components/AgentConsole.tsx: Real-time streaming terminal. Listens to llm-stream-chunk events, renders markdown outputs live, and logs performance metrics.
- src/components/SystemHealth.tsx: Status widget displaying local Ollama connectivity, indexed vector counts, and WASM memory limits.

Assemble main view in src/App.tsx with a responsive grid layout.

## PHASE 8: INTEGRATION TESTING, QUALITY ASSURANCE & DOCUMENTATION

### Objective
Validate the entire application end-to-end, enforce strict code compliance, and generate architectural documentation.

### Instructions for Agent:
Run quality validation pipeline:
- Executing cargo check and cargo clippy -- -D warnings inside src-tauri.
- Executing cargo test -- --nocapture inside src-tauri.
- Executing npx tsc --noEmit and npm run test in the root folder.

Create ARCHITECTURE.md in the project root containing:
- System component diagrams.
- Detailed data flow descriptions (Document creation → SQLite insertion → Embedding pipeline → LanceDB vector indexing).
- IPC Command API documentation.

## EXECUTION ORDER FOR THE AGENT:
Start immediately with PHASE 1. Proceed phase by phase. Validate each phase by running tests before moving to the next. BOIL THE OCEAN.
