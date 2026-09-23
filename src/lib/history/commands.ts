/**
 * Command palette contributions of note history (registered through the
 * `history` anchor in `src/lib/commands/registry.ts`).
 */
import { Camera, History, ToggleRight } from "lucide-react";
import type { CommandContext, CommandContribution } from "../commands/registry";
import { useHistoryStore } from "../historyStore";
import { useAetherStore } from "../store";
import { countLabel, noteTitle } from "./format";

/** Palette section label. */
export const HISTORY_GROUP = "History";

/**
 * Show the history of the current note: in the editor as a drawer over the
 * note, anywhere else by opening the History view focused on that note.
 */
export function showNoteHistory(ctx: Pick<CommandContext, "view" | "setView">): void {
  const path = useAetherStore.getState().selectedNotePath;
  const history = useHistoryStore.getState();
  if (path && ctx.view === "editor") {
    history.openDrawer(path);
    return;
  }
  if (path) history.selectNote(path);
  ctx.setView("history");
}

export const historyCommands: CommandContribution[] = [
  {
    id: "history.showNote",
    title: "History: show note history",
    group: HISTORY_GROUP,
    icon: History,
    shortcut: "mod+shift+h",
    keywords: ["versions", "time machine", "undo", "restore", "diff", "git", "changes"],
    run: (ctx) => showNoteHistory(ctx),
  },
  {
    id: "history.snapshot",
    title: "History: snapshot now",
    group: HISTORY_GROUP,
    icon: Camera,
    shortcut: "mod+alt+s",
    keywords: ["commit", "save version", "checkpoint", "git"],
    run: async (ctx) => {
      const activity = await useHistoryStore.getState().snapshotNow(null);
      if (!activity) {
        ctx.toast.info("Nothing to snapshot", { description: "Every note is already saved in history." });
        return;
      }
      const first = activity.files[0];
      ctx.toast.success("Snapshot saved", {
        description:
          activity.file_count === 1 && first
            ? `${noteTitle(first.rel_path)} is in history.`
            : `${countLabel(activity.file_count, "file")} saved in history.`,
      });
    },
  },
  {
    id: "history.toggleAuto",
    title: "History: toggle automatic versioning",
    group: HISTORY_GROUP,
    icon: ToggleRight,
    keywords: ["enable", "disable", "auto", "versioning", "git", "watcher"],
    run: async (ctx) => {
      const store = useHistoryStore.getState();
      if (!store.status) await store.refreshStatus();
      const current = useHistoryStore.getState().status?.enabled ?? true;
      const status = await useHistoryStore.getState().setEnabled(!current);
      if (status.enabled) {
        ctx.toast.success("Automatic versioning is on", { description: "Every note save is kept in history." });
      } else {
        ctx.toast.info("Automatic versioning is off", {
          description: "Existing versions stay available; new saves are not recorded.",
        });
      }
    },
  },
];
