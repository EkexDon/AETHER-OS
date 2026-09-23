/** Terminal types — mirror `engine/terminal.rs` / `commands/terminal_commands.rs`. */

/** A PTY session. */
export interface TerminalSession {
  id: string;
  cwd: string;
  shell: string;
  alive: boolean;
}

/** Payload of the `terminal-output` event. */
export interface TerminalOutputEvent {
  id: string;
  /** PTY bytes, base64-encoded so they arrive byte-exact (never lossy UTF-8). */
  dataBase64: string;
}
