/** App lifecycle types — mirror `src-tauri/src/commands/app_commands.rs`. */

/** Payload of the `quit-requested` event: a quit waits for confirmation because terminals run. */
export interface QuitRequest {
  /** Terminal sessions that quitting would end. */
  terminals: number;
}
