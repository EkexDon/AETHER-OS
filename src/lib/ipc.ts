import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AetherNote,
  ChatMessageRecord,
  Conversation,
  GraphData,
  IndexingResult,
  MemoryFact,
  Project,
  SystemHealth,
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
export const agentQueryWithNotes = (prompt: string, notePaths: string[], model: string) => call<void>("cmd_agent_query_with_notes", { prompt, notePaths, model });
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

type Option<T> = T | null;

export async function onStreamChunk(handler: (chunk: string) => void): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<string>("llm-stream-chunk", event => handler(event.payload));
}
