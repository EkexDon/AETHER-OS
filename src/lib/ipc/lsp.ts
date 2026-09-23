/** Language server sidecar commands (`src-tauri/src/commands/lsp_commands.rs`). */
import { call, listenSafe, type UnlistenFn } from "./core";

/** A running language server session. */
export interface LspSessionInfo {
  key: string;
  language: string;
  command: string;
}

/** Start (or attach to) the server for `language` at `rootPath`; `null` when none is installed. */
export const lspStart = (rootPath: string, language: string) =>
  call<LspSessionInfo | null>("cmd_lsp_start", { rootPath, language });
/** Forward one JSON-RPC message to a server. */
export const lspSend = (key: string, message: unknown) =>
  call<void>("cmd_lsp_send", { key, message });
/** Stop one server. */
export const lspStop = (key: string) => call<void>("cmd_lsp_stop", { key });
/** Stop every server. */
export const lspStopAll = () => call<void>("cmd_lsp_stop_all", {});

/** Subscribe to every message the backend forwards from any LSP server. */
export const onLspMessage = (
  handler: (payload: { key: string; message: unknown }) => void
): Promise<UnlistenFn> => listenSafe<{ key: string; message: unknown }>("lsp-message", handler);
