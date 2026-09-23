/** App lifecycle commands (`src-tauri/src/commands/app_commands.rs`). */
import type { QuitRequest } from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/**
 * Event the backend emits instead of quitting while terminal sessions run
 * (and "Confirm on quit with running terminals" is on). A second quit
 * request within 5 s of the prompt goes through without asking.
 */
export const QUIT_REQUESTED_EVENT = "quit-requested";

/** Quit for real after the user confirmed (ends the running terminal sessions). */
export const confirmQuit = () => call<void>("cmd_quit_confirmed");

/** Subscribe to quit requests that need the user's confirmation. */
export function onQuitRequested(handler: (request: QuitRequest) => void): Promise<UnlistenFn> {
  return listenSafe<QuitRequest>(QUIT_REQUESTED_EVENT, handler);
}
