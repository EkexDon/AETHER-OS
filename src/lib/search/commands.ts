import { FileCode2, RefreshCw, ScanSearch, Search, TerminalSquare } from "lucide-react";
import type { CommandContribution } from "../commands/registry";
import { useSearchStore } from "../searchStore";

/** Palette group of the search commands. */
export const SEARCH_COMMAND_GROUP = "Search";

/**
 * Launcher + Universal Search commands (registered at `@anchor:command:search`).
 * `mod+k` itself is bound by the core "Command palette" command, which
 * toggles the same launcher; this entry makes the launcher discoverable
 * under "Search" and opens it with an empty query. It carries no shortcut
 * of its own so the shortcuts overlay lists ⌘K only once.
 */
export const searchCommands: CommandContribution[] = [
  {
    id: "search.launcher",
    title: "Search: open launcher",
    group: SEARCH_COMMAND_GROUP,
    icon: Search,
    keywords: ["find", "launcher", "spotlight", "quick open", "everything"],
    run: () => useSearchStore.getState().openLauncher(""),
  },
  {
    id: "search.view",
    title: "Search: universal search view",
    group: SEARCH_COMMAND_GROUP,
    icon: ScanSearch,
    shortcut: "mod+shift+k",
    keywords: ["find", "full text", "semantic", "results", "everything"],
    run: (ctx) => ctx.setView("search"),
  },
  {
    id: "search.reindex",
    title: "Search: reindex",
    group: SEARCH_COMMAND_GROUP,
    icon: RefreshCw,
    keywords: ["index", "rebuild", "refresh", "rescan", "files", "apps"],
    run: async () => {
      await useSearchStore.getState().reindex();
    },
  },
  {
    id: "search.goToFile",
    title: "Go to file",
    group: SEARCH_COMMAND_GROUP,
    icon: FileCode2,
    shortcut: "mod+p",
    keywords: ["open file", "quick open", "path", "project files"],
    run: () => useSearchStore.getState().openLauncher("/"),
  },
  {
    id: "search.commandMode",
    title: "Run a command",
    group: SEARCH_COMMAND_GROUP,
    icon: TerminalSquare,
    shortcut: "mod+shift+p",
    keywords: ["command palette", "actions", ">"],
    run: () => useSearchStore.getState().openLauncher(">"),
  },
];
