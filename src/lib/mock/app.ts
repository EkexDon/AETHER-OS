/**
 * Mock handlers for `commands/app_commands.rs`. The browser preview cannot
 * quit, so `cmd_quit_confirmed` only counts confirmations;
 * `window.__AETHER_MOCK__.requestQuit()` emits `quit-requested` to try the
 * confirmation dialog.
 */
import { registerReset, type MockHandlerMap } from "./runtime";

let quitConfirmations = 0;
registerReset(() => {
  quitConfirmations = 0;
});

/** How often `cmd_quit_confirmed` was called. */
export function mockQuitConfirmations(): number {
  return quitConfirmations;
}

export const appHandlers: MockHandlerMap = {
  cmd_quit_confirmed: () => {
    quitConfirmations += 1;
    console.info("[mock] quit confirmed — the desktop app would exit now");
  },
};
