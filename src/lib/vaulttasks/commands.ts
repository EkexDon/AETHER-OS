/**
 * Command palette contributions of the Note Tasks feature. "Go to Note
 * Tasks" (⌘⌥C) comes from the view registry; these add quick capture,
 * rescanning, due presets and in-view shortcuts.
 */
import { AlarmClock, CalendarCheck, Columns3, LayoutList, ListPlus, NotebookText, RefreshCw, Search } from "lucide-react";
import type { CommandContribution } from "../commands/registry";
import { useVaultTasksStore, type VaultTasksMode } from "../vaultTasksStore";

const GROUP = "Note Tasks";
const inView = (ctx: { view: string }) => ctx.view === "vaulttasks";

const modeCommand = (mode: VaultTasksMode, title: string, shortcut: string, icon: CommandContribution["icon"]): CommandContribution => ({
  id: `vaulttasks.mode.${mode}`,
  title,
  group: GROUP,
  icon,
  shortcut,
  keywords: ["note tasks", "layout", mode],
  when: inView,
  run: () => useVaultTasksStore.getState().setMode(mode),
});

/** All Note Tasks commands (spread into `CORE_COMMANDS`). */
export const vaultTasksCommands: CommandContribution[] = [
  {
    id: "vaulttasks.addToDaily",
    title: "Add task to today's daily note",
    group: GROUP,
    icon: ListPlus,
    shortcut: "mod+shift+t",
    keywords: ["todo", "checkbox", "capture", "daily", "task"],
    run: (ctx) => {
      const store = useVaultTasksStore.getState();
      ctx.closeLauncher();
      if (!store.openQuickAdd()) {
        // No dialog host mounted (status bar hidden): use the view's field.
        ctx.setView("vaulttasks");
        store.requestQuickAddFocus();
      }
    },
  },
  {
    id: "vaulttasks.rescan",
    title: "Rescan notes for tasks",
    group: GROUP,
    icon: RefreshCw,
    shortcut: "mod+alt+r",
    keywords: ["refresh", "reload", "checkbox", "todo"],
    run: async (ctx) => {
      const count = await useVaultTasksStore.getState().rescan();
      ctx.toast.success("Tasks rescanned", { description: `${count} task${count === 1 ? "" : "s"} across your notes.` });
    },
  },
  {
    id: "vaulttasks.dueToday",
    title: "Show tasks due today",
    group: GROUP,
    icon: CalendarCheck,
    keywords: ["today", "agenda", "todo", "checkbox"],
    run: (ctx) => {
      useVaultTasksStore.getState().showDuePreset("today");
      ctx.setView("vaulttasks");
    },
  },
  {
    id: "vaulttasks.overdue",
    title: "Show overdue tasks",
    group: GROUP,
    icon: AlarmClock,
    keywords: ["late", "missed", "todo", "checkbox"],
    run: (ctx) => {
      useVaultTasksStore.getState().showDuePreset("overdue");
      ctx.setView("vaulttasks");
    },
  },
  {
    id: "vaulttasks.search",
    title: "Search note tasks",
    group: GROUP,
    icon: Search,
    shortcut: "mod+f",
    keywords: ["find", "filter"],
    when: inView,
    run: () => useVaultTasksStore.getState().requestSearchFocus(),
  },
  modeCommand("board", "Note Tasks: board", "mod+alt+1", Columns3),
  modeCommand("list", "Note Tasks: list by due date", "mod+alt+2", LayoutList),
  modeCommand("notes", "Note Tasks: group by note", "mod+alt+3", NotebookText),
];
