/** PTY terminal commands (`src-tauri/src/commands/terminal_commands.rs`). */
import type { TerminalOutputEvent, TerminalSession } from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Spawn a shell in a PTY. Output arrives via {@link onTerminalOutput}. */
export const terminalSpawn = (cwd?: string, shell?: string, cols?: number, rows?: number) =>
  call<TerminalSession>("cmd_terminal_spawn", { cwd, shell, cols, rows });
/** Write keyboard input to a session. */
export const terminalWrite = (id: string, data: string) =>
  call<void>("cmd_terminal_write", { id, data });
/** Resize a session's PTY. */
export const terminalResize = (id: string, cols: number, rows: number) =>
  call<void>("cmd_terminal_resize", { id, cols, rows });
/** Kill a session. */
export const terminalKill = (id: string) => call<void>("cmd_terminal_kill", { id });
/** All sessions. */
export const terminalList = () => call<TerminalSession[]>("cmd_terminal_list");

/** Subscribe to PTY output of all sessions (base64 payloads). */
export function onTerminalOutput(handler: (event: TerminalOutputEvent) => void): Promise<UnlistenFn> {
  return listenSafe<TerminalOutputEvent>("terminal-output", handler);
}
