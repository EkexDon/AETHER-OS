import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AetherNote,
  AgentAction,
  Backlink,
  BrowserInfo,
  ChatMessageRecord,
  ClippedPage,
  Conversation,
  FsEntry,
  FileDiff,
  BranchInfo,
  CommitInfo,
  GraphData,
  RepoStatus,
  IndexingResult,
  MemoryFact,
  Project,
  SystemHealth,
  SystemMetrics,
  TerminalOutputEvent,
  TerminalSession,
  VaultIndex,
  VaultNote,
  VaultStats,
  VectorMatch,
} from "../types";

export class IpcUnavailableError extends Error {
  constructor() {
    super("AETHER-OS runs as a desktop application. Start it with: npm run app");
    this.name = "IpcUnavailableError";
  }
}

export const isDesktopRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopRuntime()) throw new IpcUnavailableError();
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw new Error(typeof reason === "string" ? reason : String(reason));
  }
}

export const getVaultPath = () => call<Option<string>>("cmd_get_vault_path");
export const setVaultPath = (path: string) => call<void>("cmd_set_vault_path", { path });
export const getVaultNotes = () => call<VaultNote[]>("cmd_get_vault_notes");
export const getNoteContent = (path: string) => call<string>("cmd_get_note_content", { path });
export const getVaultIndex = () => call<Option<VaultIndex>>("cmd_get_vault_index");
export const getVaultGraph = () => call<GraphData>("cmd_get_vault_graph");
export const getVaultStats = () => call<VaultStats>("cmd_get_vault_stats");
export const indexVault = () => call<IndexingResult>("cmd_index_vault");
export const semanticSearch = (query: string, limit = 10) => call<VectorMatch[]>("cmd_semantic_search", { query, limit });
export const agentQuery = (prompt: string, model: string) => call<string[]>("cmd_agent_query", { prompt, model });
export const agentQueryWithNotes = (prompt: string, notePaths: string[], model: string, provider?: "ollama" | "openrouter") =>
  call<void>("cmd_agent_query_with_notes", { prompt, notePaths, model, provider });
export const setOpenRouterKey = (key: string | null) => call<boolean>("cmd_set_openrouter_key", { key });
export const listCloudModels = () => call<string[]>("cmd_list_cloud_models");
export const listLocalModels = () => call<string[]>("cmd_list_local_models");
export const getHealth = () => call<SystemHealth>("cmd_get_health");
export const createAetherNote = (title: string, content: string, sourceQuery: string, relatedNotes: string[]) => call<AetherNote>("cmd_create_aether_note", { title, content, sourceQuery, relatedNotes });
export const getAetherNotes = () => call<AetherNote[]>("cmd_get_aether_notes");
export const deleteAetherNote = (id: string) => call<void>("cmd_delete_aether_note", { id });
export const scanProjects = (directories: string[]) => call<Project[]>("cmd_scan_projects", { directories });
export const openProject = (path: string, editor?: string) => call<void>("cmd_open_project", { path, editor });
export const openInTerminal = (path: string) => call<void>("cmd_open_in_terminal", { path });
export const openInFinder = (path: string) => call<void>("cmd_open_in_finder", { path });
export const getProjectDirs = () => call<string[]>("cmd_get_project_dirs");
export const addProjectDir = (dir: string) => call<string[]>("cmd_add_project_dir", { dir });
export const removeProjectDir = (dir: string) => call<string[]>("cmd_remove_project_dir", { dir });
export const saveConversation = (messages: ChatMessageRecord[], contextNotes: string[]) =>
  call<Conversation>("cmd_save_conversation", { messages, contextNotes });
export const getRecentConversations = (limit?: number) =>
  call<Conversation[]>("cmd_get_recent_conversations", { limit });
export const deleteConversation = (id: string) => call<void>("cmd_delete_conversation", { id });
export const saveMemoryFact = (fact: string, category: string) =>
  call<MemoryFact[]>("cmd_save_memory_fact", { fact, category });
export const getMemoryFacts = () => call<MemoryFact[]>("cmd_get_memory_facts");
export const deleteMemoryFact = (fact: string) =>
  call<MemoryFact[]>("cmd_delete_memory_fact", { fact });

export const terminalSpawn = (cwd?: string, shell?: string, cols?: number, rows?: number) =>
  call<TerminalSession>("cmd_terminal_spawn", { cwd, shell, cols, rows });
export const terminalWrite = (id: string, data: string) =>
  call<void>("cmd_terminal_write", { id, data });
export const terminalResize = (id: string, cols: number, rows: number) =>
  call<void>("cmd_terminal_resize", { id, cols, rows });
export const terminalKill = (id: string) =>
  call<void>("cmd_terminal_kill", { id });
export const terminalList = () =>
  call<TerminalSession[]>("cmd_terminal_list");

export const getSystemMetrics = () =>
  call<SystemMetrics>("cmd_get_system_metrics");

// Embedded IDE — all paths are sandboxed to the configured project dirs + vault
export const ideRoots = () => call<string[]>("cmd_ide_roots");
export const ideListDir = (path: string) => call<FsEntry[]>("cmd_ide_list_dir", { path });
export const ideReadFile = (path: string) => call<string>("cmd_ide_read_file", { path });
export const ideWriteFile = (path: string, content: string) =>
  call<void>("cmd_ide_write_file", { path, content });
export const ideCreateFile = (path: string, content: string) =>
  call<string>("cmd_ide_create_file", { path, content });
export const ideCreateDir = (path: string) => call<string>("cmd_ide_create_dir", { path });

// ── Git (Source Control) ─────────────────────────────────────

export const gitStatus = (path: string) => call<RepoStatus>("cmd_git_status", { path });
export const gitStage = (path: string, files: string[]) =>
  call<void>("cmd_git_stage", { path, files });
export const gitUnstage = (path: string, files: string[]) =>
  call<void>("cmd_git_unstage", { path, files });
export const gitDiscard = (path: string, files: string[]) =>
  call<void>("cmd_git_discard", { path, files });
export const gitCommit = (path: string, message: string) =>
  call<string>("cmd_git_commit", { path, message });
export const gitBranches = (path: string) =>
  call<BranchInfo[]>("cmd_git_branches", { path });
export const gitSwitchBranch = (path: string, branch: string) =>
  call<void>("cmd_git_switch_branch", { path, branch });
export const gitCreateBranch = (path: string, branch: string) =>
  call<void>("cmd_git_create_branch", { path, branch });
export const gitLog = (path: string, limit?: number) =>
  call<CommitInfo[]>("cmd_git_log", { path, limit });
export const gitDiffFile = (path: string, file: string, staged: boolean) =>
  call<FileDiff>("cmd_git_diff_file", { path, file, staged });

// ── LSP (Language Server sidecars) ───────────────────────────

export interface LspSessionInfo {
  key: string;
  language: string;
  command: string;
}

export const lspStart = (rootPath: string, language: string) =>
  call<LspSessionInfo | null>("cmd_lsp_start", { rootPath, language });
export const lspSend = (key: string, message: unknown) =>
  call<void>("cmd_lsp_send", { key, message });
export const lspStop = (key: string) => call<void>("cmd_lsp_stop", { key });
export const lspStopAll = () => call<void>("cmd_lsp_stop_all", {});

/** Subscribe to every message the backend forwards from any LSP server. */
export const onLspMessage = (
  handler: (payload: { key: string; message: unknown }) => void
): Promise<UnlistenFn> =>
  listen<{ key: string; message: unknown }>("lsp-message", (e) => handler(e.payload));

export const getBrowserInfo = () =>
  call<BrowserInfo>("cmd_browser_info");
export const browserOpen = (url: string) =>
  call<void>("cmd_browser_open", { url });
export const browserOpenLibreWolf = (url: string) =>
  call<void>("cmd_browser_open_librewolf", { url });

// Embedded native webviews (subviews of the main window)
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const browserWebviewOpen = (url: string, rect: BrowserRect) =>
  call<string>("cmd_browser_webview_open", { url, ...rect });
export const browserWebviewClose = (label: string) =>
  call<void>("cmd_browser_webview_close", { label });
export const browserWebviewNavigate = (label: string, url: string) =>
  call<void>("cmd_browser_webview_navigate", { label, url });
export const browserWebviewBack = (label: string) =>
  call<void>("cmd_browser_webview_back", { label });
export const browserWebviewForward = (label: string) =>
  call<void>("cmd_browser_webview_forward", { label });
export const browserWebviewReload = (label: string) =>
  call<void>("cmd_browser_webview_reload", { label });
export const browserWebviewList = () =>
  call<[string, string][]>("cmd_browser_webview_list");
export const browserWebviewSetBounds = (label: string, rect: BrowserRect) =>
  call<void>("cmd_browser_webview_set_bounds", { label, ...rect });
export const browserWebviewShow = (label: string) =>
  call<void>("cmd_browser_webview_show", { label });
export const browserWebviewHide = (label: string) =>
  call<void>("cmd_browser_webview_hide", { label });
export const browserWebviewHideAll = () =>
  call<void>("cmd_browser_webview_hide_all");

export interface BrowserNavEvent {
  label: string;
  url: string;
}

export interface BrowserTitleEvent {
  label: string;
  title: string;
}

export async function onBrowserWebviewNav(
  handler: (event: BrowserNavEvent) => void
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<BrowserNavEvent>("browser-webview-nav", (e) => handler(e.payload));
}

export async function onBrowserWebviewTitle(
  handler: (event: BrowserTitleEvent) => void
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<BrowserTitleEvent>("browser-webview-title", (e) => handler(e.payload));
}

type Option<T> = T | null;

export async function onStreamChunk(handler: (chunk: string) => void): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<string>("llm-stream-chunk", event => handler(event.payload));
}

export async function onTerminalOutput(handler: (event: TerminalOutputEvent) => void): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<TerminalOutputEvent>("terminal-output", event => handler(event.payload));
}

// ── Note editing ──────────────────────────────────────────────
export const writeNote = (path: string, content: string) =>
  call<void>("cmd_write_note", { path, content });
export const createNote = (relPath: string, content: string) =>
  call<string>("cmd_create_note", { relPath, content });
export const appendNote = (path: string, content: string) =>
  call<void>("cmd_append_note", { path, content });
export const getBacklinks = (noteName: string) =>
  call<Backlink[]>("cmd_get_backlinks", { noteName });
export const dailyNote = () =>
  call<string>("cmd_daily_note");
export const appendDaily = (text: string) =>
  call<string>("cmd_append_daily", { text });
export const clipUrl = (url: string) =>
  call<ClippedPage>("cmd_clip_url", { url });
export const executeAgentAction = (action: AgentAction) =>
  call<string>("cmd_execute_agent_action", { action });

/** Router commands for agent-action variants that need more than the
 *  synchronous vault path. Each returns a tagged `AgentActionResult`. */
export interface AgentActionResultOpened { kind: "opened"; url: string }
export interface AgentActionResultClipped { kind: "clipped_page"; path: ClippedPage }
export interface AgentActionResultFact { kind: "fact_saved"; fact: { id: string; fact: string; category: string; created_at: number } }
export interface AgentActionResultAether { kind: "aether_note_saved"; note: { id: string; title: string; content: string; created_at: number; source_query: string; related_notes: string[] } }
export type AgentActionResult =
  | AgentActionResultOpened
  | AgentActionResultClipped
  | AgentActionResultFact
  | AgentActionResultAether;

export const agentOpenUrl = (url: string) =>
  call<AgentActionResult>("cmd_agent_open_url", { url });
export const agentClipUrl = (url: string) =>
  call<AgentActionResult>("cmd_agent_clip_url", { url });
export const agentAddMemoryFact = (fact: string, category: string) =>
  call<AgentActionResult>("cmd_agent_add_memory_fact", { fact, category });
export const agentSaveAetherNote = (title: string, content: string) =>
  call<AgentActionResult>("cmd_agent_save_aether_note", { title, content });
