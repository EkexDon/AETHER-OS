import { useEffect } from "react";
import { createCommandContext } from "../lib/commands/context";
import { findCommandForEvent, runCommand } from "../lib/commands/registry";

/**
 * One window-level key handler for every command that declares a shortcut.
 *
 * Only modifier combos are global (plain keys belong to whatever has
 * focus). Events already handled by an editor (`defaultPrevented`, e.g.
 * Monaco's ⌘/ or TipTap's ⌘⇧B) are left alone — except inside the terminal,
 * where xterm swallows keys it does not actually use.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey || e.altKey)) return;
      const target = e.target instanceof Element ? e.target : null;
      const inTerminal = !!target?.closest(".xterm");
      if (e.defaultPrevented && !inTerminal) return;

      const ctx = createCommandContext();
      const command = findCommandForEvent(e, ctx);
      if (command) {
        e.preventDefault();
        void runCommand(command.id, ctx).catch(() => undefined);
        return;
      }
      // Views handle ⌘S themselves; never show the browser's "Save page".
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
