# MASTER SYSTEM DIRECTIVE: BUILD AETHER-OS (PRODUCTION-GRADE MVP)

## SYSTEM OPERATIONAL MANDATE
You are acting as a World-Class Principal Systems Engineer and Full-Stack Rust/TypeScript Architect.
Your task is to implement **AETHER-OS** — a local-first, zero-cost cognitive operating system and autonomous multi-agent workspace.

### NON-NEGOTIABLE EXECUTION RULES ("BOIL THE OCEAN"):
1. NO STUBS. NO MOCKS. NO PLACEHOLDERS. NO `// TODO: implement later`. 
2. EVERY function must be fully implemented down to its concrete error handling (`Result<T, E>` in Rust, strict `try/catch` with custom error types in TypeScript).
3. STRICT TEST-DRIVEN QUALITY: Write exhaustive unit tests for every module. Rust tests must be in `#[cfg(test)]` blocks. Frontend tests must use Vitest.
4. ZERO WARNINGS POLICY: Rust code MUST pass `cargo clippy -- -D warnings`. TypeScript code MUST pass `tsc --noEmit --strict`.
5. ARCHITECTURAL SOUVEREIGNTY: 100% Local-First. Zero paid external API keys. Zero cloud dependencies.

---

## REPOSITORY MATRIX & TARGET ARCHITECTURE

Initialize and build out the following exact repository layout:

```text
AETHER-OS/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── engine/
│       │   ├── mod.rs
│       │   ├── error.rs           # Unified Rust error enum with `thiserror` 
│       │   ├── sqlite_db.rs       # Relational & Knowledge Graph storage
│       │   ├── vector_db.rs       # Embedded LanceDB & HNSW vector indices
│       │   ├── local_ai.rs        # Ollama streaming client & ONNX/FastEmbed local pipeline
│       │   ├── crdt_store.rs      # Automerge offline state engine
│       │   └── sandbox.rs         # Wasmtime secure execution runtime
│       └── commands/
│           ├── mod.rs
│           ├── db_commands.rs     # Tauri IPC commands for SQLite/Graph
│           ├── ai_commands.rs     # Tauri IPC commands for AI & Vector search
│           └── system_commands.rs # System health & Sandbox commands
├── src/
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── types/
│   │   │   └── index.ts          # Mirroring all Rust IPC data structures
│   │   ├── lib/
│   │   │   ├── ipc.ts            # Typed wrapper around Tauri `@tauri-apps/api/core` 
│   │   │   └── store.ts          # Zustand state store with CRDT binding
│   │   └── components/
│   │       ├── KnowledgeGraph.tsx # WebGPU/Canvas rendered graph view
│   │       ├── BlockEditor.tsx    # Modern markdown block editor
│   │       ├── AgentConsole.tsx   # Live stream terminal for local AI responses
│   │       └── SystemHealth.tsx   # Diagnostics dashboard
TASK BREAKDOWN & IMPLEMENTATION REQUIREMENTS
PHASE 0: DEPENDENCIES & INITIALIZATION
Rust Dependencies (src-tauri/Cargo.toml):
tauri = { version = "2.0", features = [] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
rusqlite = { version = "0.31", features = ["bundled", "r2d2"] }
r2d2 = "0.8"
lancedb = "0.10"
automerge = "0.5"
wasmtime = "20.0"
reqwest = { version = "0.12", features = ["json", "stream"] }
thiserror = "1.0"
fastembed = "3.0"
futures-util = "0.3"
Frontend Dependencies (package.json):
react, react-dom
@tauri-apps/api (v2)
lucide-react
zustand
@xyflow/react (React Flow)
tailwindcss, postcss, autoprefixer
vitest, @testing-library/react, typescript
PHASE 1: RUST ENGINE IMPLEMENTATION
1. Unified Error Handling (src-tauri/src/engine/error.rs)
Implement an AetherError enum using thiserror:
DatabaseError(#[from] rusqlite::Error)
VectorError(#[from] lancedb::Error)
AiEngineError(String)
SandboxError(#[from] wasmtime::Error)
CrdtError(#[from] automerge::AutomergeError)
Ensure custom serde::Serialize implementation for Tauri IPC error serialization.
2. SQLite & Graph Engine (src-tauri/src/engine/sqlite_db.rs)
Implement SqliteEngine managing a thread-safe r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>:
Tables:
nodes: id (TEXT PRIMARY KEY), title (TEXT), content (TEXT), tags (TEXT), created_at (INTEGER), updated_at (INTEGER).
edges: source_id (TEXT), target_id (TEXT), relation (TEXT), weight (REAL), PRIMARY KEY (source_id, target_id, relation).
agent_logs: id (TEXT PRIMARY KEY), agent_name (TEXT), prompt (TEXT), response (TEXT), latency_ms (INTEGER), timestamp (INTEGER).
Methods:
pub fn new(db_path: &Path) -> Result<Self, AetherError> (Auto-runs migrations).
pub fn create_node(&self, title: &str, content: &str, tags: Vec<String>) -> Result<Node, AetherError>
pub fn connect_nodes(&self, source: &str, target: &str, relation: &str, weight: f64) -> Result<(), AetherError>
pub fn get_graph(&self) -> Result<GraphData, AetherError> (Returns all nodes and edges).
pub fn log_agent_execution(&self, log: AgentLog) -> Result<(), AetherError>
Tests: Write unit tests verifying atomic transaction handling and graph edge insertion.
3. Embedded Vector Database (src-tauri/src/engine/vector_db.rs)
Implement VectorEngine wrapping lancedb::Connection:
Initialize persistent table aether_vectors with 384-dimensional float vectors.
Methods:
pub async fn new(storage_dir: &Path) -> Result<Self, AetherError>
pub async fn upsert_vector(&self, id: &str, vector: Vec<f32>, text: &str) -> Result<(), AetherError>
pub async fn search_similar(&self, query_vector: Vec<f32>, top_k: usize) -> Result<Vec<VectorMatch>, AetherError>
Tests: Write async unit tests verifying vector insertion and nearest-neighbor search.
4. Local AI & Embedding Pipeline (src-tauri/src/engine/local_ai.rs)
Implement LocalAiEngine:
Ollama Integration: Connects to http://localhost:11434.
Healthcheck function checking /api/tags.
Stream completion support sending chunks over Tauri events.
Embedded FastEmbed Pipeline: Fallback local embedding generator using fastembed crate (BAAI/bge-small-en-v1.5, producing 384-dim vector).
Methods:
pub fn generate_embedding(&self, text: &str) -> Result<Vec<f32>, AetherError>
pub async fn stream_llm_response<F>(&self, prompt: &str, model: &str, callback: F) -> Result<(), AetherError>
Tests: Write unit tests checking local fallback embedding vector dimension equality (exactly 384 elements).
5. WebAssembly Secure Sandbox (src-tauri/src/engine/sandbox.rs)
Implement WasmSandboxEngine using wasmtime:
Configure wasmtime::Engine with strict fuel metering (execution step caps) and memory limit (max 64MB).
No host filesystem access, no environment variable leaks.
Methods:
pub fn execute_plugin(wasm_bytes: &[u8], input_json: &str) -> Result<String, AetherError>
Tests: Test with a simple compiled WASM module ensuring execution limits work and abort on memory overflow.
6. CRDT Sync Engine (src-tauri/src/engine/crdt_store.rs)
Implement CrdtEngine using automerge:
Manages local document state with automatic conflict resolution.
Methods:
pub fn create_doc() -> Self
pub fn update_text(&mut self, text: &str) -> Result<Vec<u8>, AetherError> (Returns binary sync patch).
pub fn merge_changes(&mut self, patch: &[u8]) -> Result<(), AetherError>
Tests: Write tests simulating two concurrent clients editing text and asserting deterministic convergence.
PHASE 2: TAURI IPC COMMAND BRIDGE (src-tauri/src/commands/)
Expose all Rust core features safely to the React frontend via typed Tauri commands:
cmd_get_graph_data(state: State<AppState>) -> Result<GraphData, String>
cmd_create_node(state: State<AppState>, title: String, content: String, tags: Vec<String>) -> Result<Node, String>
cmd_search_semantic(state: State<AppState>, query: String, limit: usize) -> Result<Vec<VectorMatch>, String>
cmd_stream_agent_prompt(app_handle: AppHandle, state: State<AppState>, prompt: String, model: String) -> Result<(), String>
cmd_execute_wasm_tool(state: State<AppState>, wasm_hex: String, input: String) -> Result<String, String>
cmd_get_system_health(state: State<AppState>) -> Result<SystemHealth, String>
PHASE 3: FRONTEND UI DEVELOPMENT (REACT + TYPESCRIPT)
Build a clean, high-density dashboard UI with dark-mode styling (Tailwind CSS):
KnowledgeGraph.tsx: Interactive graph viewer using @xyflow/react or Canvas API. Renders nodes, edges, allows clicking nodes to open them in the Block Editor.
BlockEditor.tsx: Auto-saving note editor. Triggers auto-indexing in SQLite and local Vector embeddings on every save.
AgentConsole.tsx: Live terminal window streaming LLM output line-by-line using Tauri event listeners (appHandle.emit). Includes controls for switching models.
SystemHealth.tsx: Diagnostic bar showing local Ollama status (Online/Offline), total indexed vectors, SQLite database size, and WASM memory limits.
VERIFICATION & DELIVERY SUITE
Before completing execution, you MUST execute and pass all verification checks:
Execute cargo check & cargo clippy -- -D warnings inside src-tauri.
Run cargo test inside src-tauri. Verify 100% test pass rate.
Run npx tsc --noEmit and npm run test in the root folder.
Execute ./test_runner.sh and ensure exit code 0.
BEGIN EXECUTION NOW. BUILD THE COMPLETE CODE BASE. BOIL THE OCEAN.

---

### Instructions to start:

1. **Datei anlegen**: Kopiere den Text oben in deine `PROMPT_AGENT.md` Datei.
2. **Loop starten**: Führe in deinem Terminal folgenden Befehl aus:
   ```bash
   ./run_agent_loop.sh 10
   ```
