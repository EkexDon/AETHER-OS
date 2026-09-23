import { useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Command as CommandIcon,
  Settings,
  Keyboard,
  SunMoon,
  Sun,
  Moon,
  Monitor,
  PanelLeft,
  Rows3,
  Bot,
  Zap,
  Scissors,
  FilePlus2,
} from "lucide-react";
import { createCommandContext, type CommandContext } from "./context";
import { matchesShortcut, type KeyLike } from "../shortcuts";
import type { ViewMode } from "../../views/modes";
// Feature command imports go directly above your anchor:
// @anchor:command-import:clipboard
// @anchor:command-import:search
// @anchor:command-import:history
// @anchor:command-import:home
// @anchor:command-import:vaulttasks
// @anchor:command-import:intel
// @anchor:command-import:plugins
// @anchor:command-import:export
// @anchor:command-import:sync
// @anchor:command-import:onboarding

export type { CommandContext } from "./context";

/**
 * One entry of the command palette / shortcuts overlay. Every primary action
 * in the app should be a command so it is discoverable and has a shortcut.
 */
export interface CommandContribution {
  /** `"<feature>.<verb>"`, globally unique. */
  id: string;
  title: string;
  /** Section label in the palette and shortcuts overlay. */
  group: string;
  icon?: LucideIcon;
  /** e.g. `mod+shift+n`; see `src/lib/shortcuts.ts`. */
  shortcut?: string;
  /** Extra search terms. */
  keywords?: string[];
  run: (ctx: CommandContext) => void | Promise<void>;
  /** Hide/disable the command unless this returns true. */
  when?: (ctx: CommandContext) => boolean;
}

/** Palette group names used by the built-in commands. */
export const COMMAND_GROUPS = {
  navigation: "Navigation",
  general: "General",
  capture: "Capture",
  appearance: "Appearance",
  agent: "AI Agent",
} as const;

const registry = new Map<string, CommandContribution>();
const listeners = new Set<() => void>();
let snapshot: CommandContribution[] = [];

function emit() {
  snapshot = Array.from(registry.values());
  listeners.forEach((l) => l());
}

/**
 * Register commands (replacing any with the same id). Returns a function that
 * removes exactly these registrations again.
 */
export function registerCommands(commands: CommandContribution[]): () => void {
  for (const c of commands) registry.set(c.id, c);
  emit();
  return () => {
    let changed = false;
    for (const c of commands) {
      if (registry.get(c.id) === c) {
        registry.delete(c.id);
        changed = true;
      }
    }
    if (changed) emit();
  };
}

/** Current commands, in registration order. */
export function getCommands(): CommandContribution[] {
  return snapshot;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: all registered commands (re-renders on registration changes). */
export function useCommands(): CommandContribution[] {
  return useSyncExternalStore(subscribe, getCommands, getCommands);
}

/** Is the command currently available in this context? */
export function isCommandEnabled(command: CommandContribution, ctx: CommandContext): boolean {
  try {
    return command.when ? command.when(ctx) : true;
  } catch {
    return false;
  }
}

/**
 * Run a command by id. Resolves `true` when a command ran, `false` when it
 * is unknown or disabled. Errors are surfaced as a toast and re-thrown.
 */
export async function runCommand(id: string, ctx: CommandContext = createCommandContext()): Promise<boolean> {
  const command = registry.get(id);
  if (!command || !isCommandEnabled(command, ctx)) return false;
  try {
    await command.run(ctx);
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.toast.error(`${command.title} failed`, { description: message });
    throw e;
  }
}

/** The enabled command whose shortcut matches the keyboard event, if any. */
export function findCommandForEvent(
  event: KeyLike,
  ctx: CommandContext,
  commands: CommandContribution[] = snapshot
): CommandContribution | undefined {
  for (const c of commands) {
    if (!c.shortcut) continue;
    if (matchesShortcut(event, c.shortcut) && isCommandEnabled(c, ctx)) return c;
  }
  return undefined;
}

/** Group commands by `group`, preserving first-seen group order. */
export function groupCommands(commands: CommandContribution[]): { group: string; commands: CommandContribution[] }[] {
  const map = new Map<string, CommandContribution[]>();
  for (const c of commands) {
    const list = map.get(c.group);
    if (list) list.push(c);
    else map.set(c.group, [c]);
  }
  return Array.from(map, ([group, list]) => ({ group, commands: list }));
}

/** Minimal view shape needed to derive navigation commands. */
export interface NavigableView {
  mode: ViewMode;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
}

/** One "Go to <view>" command per registered view. */
export function viewNavigationCommands(views: NavigableView[]): CommandContribution[] {
  return views.map((v) => ({
    id: `view.${v.mode}`,
    title: `Go to ${v.label}`,
    group: COMMAND_GROUPS.navigation,
    icon: v.icon,
    shortcut: v.shortcut,
    keywords: [v.label, v.mode, "open", "view", "workspace"],
    run: (ctx) => ctx.setView(v.mode),
  }));
}

/** Built-in commands. Feature agents add `...yourCommands,` above their anchor. */
export const CORE_COMMANDS: CommandContribution[] = [
  {
    id: "app.commandPalette",
    title: "Command palette",
    group: COMMAND_GROUPS.general,
    icon: CommandIcon,
    shortcut: "mod+k",
    keywords: ["search", "launcher", "find", "run"],
    run: (ctx) => ctx.toggleCommandBar(),
  },
  {
    id: "note.new",
    title: "New note",
    group: COMMAND_GROUPS.capture,
    icon: FilePlus2,
    shortcut: "mod+n",
    keywords: ["create", "page", "document"],
    run: (ctx) => ctx.openNewNote(),
  },
  {
    id: "capture.quick",
    title: "Quick capture to daily note",
    group: COMMAND_GROUPS.capture,
    icon: Zap,
    shortcut: "mod+shift+n",
    keywords: ["thought", "inbox", "daily", "jot"],
    run: (ctx) => ctx.openQuickCapture(),
  },
  {
    id: "capture.webClip",
    title: "Clip a web page",
    group: COMMAND_GROUPS.capture,
    icon: Scissors,
    shortcut: "mod+shift+c",
    keywords: ["url", "clipper", "save", "article", "bookmark"],
    run: (ctx) => ctx.openWebClipper(),
  },
  {
    id: "agent.toggle",
    title: "Toggle AI agent panel",
    group: COMMAND_GROUPS.agent,
    icon: Bot,
    shortcut: "mod+j",
    keywords: ["chat", "assistant", "ai", "ollama", "openrouter"],
    run: (ctx) => ctx.toggleAgentPanel(),
  },
  {
    id: "app.settings",
    title: "Open settings",
    group: COMMAND_GROUPS.general,
    icon: Settings,
    shortcut: "mod+,",
    keywords: ["preferences", "config", "vault", "api key"],
    run: (ctx) => ctx.openSettings(),
  },
  {
    id: "app.shortcuts",
    title: "Keyboard shortcuts",
    group: COMMAND_GROUPS.general,
    icon: Keyboard,
    shortcut: "mod+/",
    keywords: ["help", "keys", "hotkeys", "cheatsheet"],
    run: (ctx) => ctx.openShortcuts(),
  },
  {
    id: "theme.toggle",
    title: "Toggle light / dark theme",
    group: COMMAND_GROUPS.appearance,
    icon: SunMoon,
    shortcut: "mod+shift+l",
    keywords: ["theme", "dark mode", "light mode", "appearance"],
    run: (ctx) => ctx.toggleTheme(),
  },
  {
    id: "theme.light",
    title: "Use light theme",
    group: COMMAND_GROUPS.appearance,
    icon: Sun,
    keywords: ["theme", "appearance"],
    run: (ctx) => ctx.setThemePreference("light"),
  },
  {
    id: "theme.dark",
    title: "Use dark theme",
    group: COMMAND_GROUPS.appearance,
    icon: Moon,
    keywords: ["theme", "appearance"],
    run: (ctx) => ctx.setThemePreference("dark"),
  },
  {
    id: "theme.system",
    title: "Match system theme",
    group: COMMAND_GROUPS.appearance,
    icon: Monitor,
    keywords: ["theme", "appearance", "auto", "os"],
    run: (ctx) => ctx.setThemePreference("system"),
  },
  {
    id: "appearance.toggleRailLabels",
    title: "Toggle navigation labels",
    group: COMMAND_GROUPS.appearance,
    icon: PanelLeft,
    shortcut: "mod+\\",
    keywords: ["sidebar", "rail", "expand", "collapse", "labels"],
    run: (ctx) => ctx.toggleRailLabels(),
  },
  {
    id: "appearance.toggleDensity",
    title: "Toggle compact density",
    group: COMMAND_GROUPS.appearance,
    icon: Rows3,
    keywords: ["compact", "comfortable", "spacing", "dense"],
    run: (ctx) => ctx.toggleDensity(),
  },
  // @anchor:command:clipboard
  // @anchor:command:search
  // @anchor:command:history
  // @anchor:command:home
  // @anchor:command:vaulttasks
  // @anchor:command:intel
  // @anchor:command:plugins
  // @anchor:command:export
  // @anchor:command:sync
  // @anchor:command:onboarding
];

registerCommands(CORE_COMMANDS);
