/**
 * Command palette contributions of the Home feature (pins, Pomodoro,
 * Focus Mode, daily note). Registered through `CORE_COMMANDS` in
 * `src/lib/commands/registry.ts` at the `home` anchor.
 */
import {
  Bookmark,
  CalendarCheck,
  Focus,
  Pin,
  PinOff,
  Settings2,
  SkipForward,
  Square,
  Timer,
} from "lucide-react";
import type { CommandContribution } from "../commands/registry";
import { useAetherStore } from "../store";
import { findPin, usePinsStore } from "../pinsStore";
import { useFocusStore } from "../focusStore";
import { useHomeStore } from "../homeStore";
import { dailyNote } from "../ipc";
import { noteTitleFromPath } from "./format";

/** Palette groups used by Home commands. */
export const HOME_COMMAND_GROUPS = { pins: "Pins", focus: "Focus", home: "Home" } as const;

/** Settings section id (`ctx.openSettings("home")`). */
export const HOME_SETTINGS_ID = "home";

const currentNote = () => useAetherStore.getState().selectedNotePath;

/** Pin the note open in the editor; returns whether a new pin was created. */
export function pinCurrentNote(): { pinned: boolean; label: string; path: string } | null {
  const path = currentNote();
  if (!path) return null;
  const label = noteTitleFromPath(path);
  const pins = usePinsStore.getState();
  const existed = findPin(pins.groups, "note", path) !== undefined;
  pins.addPin({ kind: "note", ref: path, label });
  return { pinned: !existed, label, path };
}

export const homeCommands: CommandContribution[] = [
  {
    id: "home.pinCurrentNote",
    title: "Pins: pin current note",
    group: HOME_COMMAND_GROUPS.pins,
    icon: Pin,
    shortcut: "mod+shift+d",
    keywords: ["bookmark", "favorite", "star", "pin", "note"],
    when: () => currentNote() !== null,
    run: (ctx) => {
      const result = pinCurrentNote();
      if (!result) return;
      if (!result.pinned) {
        ctx.toast.info("Already pinned", { description: result.label });
        return;
      }
      ctx.toast.success("Pinned", {
        description: result.label,
        action: {
          label: "Undo",
          onClick: () => {
            usePinsStore.getState().removePinByRef("note", result.path);
          },
        },
      });
    },
  },
  {
    id: "home.unpinCurrentNote",
    title: "Pins: unpin current note",
    group: HOME_COMMAND_GROUPS.pins,
    icon: PinOff,
    keywords: ["bookmark", "remove", "unpin", "note"],
    when: () => {
      const path = currentNote();
      return path !== null && findPin(usePinsStore.getState().groups, "note", path) !== undefined;
    },
    run: (ctx) => {
      const path = currentNote();
      if (path && usePinsStore.getState().removePinByRef("note", path)) {
        ctx.toast.success("Unpinned", { description: noteTitleFromPath(path) });
      }
    },
  },
  {
    id: "home.togglePinsDrawer",
    title: "Pins: show pins",
    group: HOME_COMMAND_GROUPS.pins,
    icon: Bookmark,
    shortcut: "mod+alt+b",
    keywords: ["bookmarks", "favorites", "pinned", "drawer"],
    run: (ctx) => {
      ctx.closeLauncher();
      useHomeStore.getState().togglePinsDrawer();
    },
  },
  {
    id: "home.toggleFocusMode",
    title: "Focus: toggle focus mode",
    group: HOME_COMMAND_GROUPS.focus,
    icon: Focus,
    shortcut: "mod+shift+f",
    keywords: ["zen", "distraction free", "concentrate", "hide"],
    run: (ctx) => {
      ctx.closeLauncher();
      const focus = useFocusStore.getState();
      focus.toggleFocusMode();
      if (useFocusStore.getState().focusMode) {
        ctx.toast.info("Focus mode on", { description: "Press Esc twice to exit." });
      }
    },
  },
  {
    id: "home.toggleTimer",
    title: "Focus: start or pause Pomodoro",
    group: HOME_COMMAND_GROUPS.focus,
    icon: Timer,
    shortcut: "mod+alt+t",
    keywords: ["pomodoro", "timer", "focus", "start", "pause", "resume"],
    run: (ctx) => {
      ctx.closeLauncher();
      useFocusStore.getState().toggle();
    },
  },
  {
    id: "home.skipPhase",
    title: "Focus: skip to next phase",
    group: HOME_COMMAND_GROUPS.focus,
    icon: SkipForward,
    keywords: ["pomodoro", "break", "next"],
    when: () => {
      const { phase, status } = useFocusStore.getState().timer;
      return phase !== "idle" && !(phase === "work" && status === "ready");
    },
    run: () => useFocusStore.getState().skip(),
  },
  {
    id: "home.stopTimer",
    title: "Focus: stop Pomodoro",
    group: HOME_COMMAND_GROUPS.focus,
    icon: Square,
    keywords: ["pomodoro", "reset", "cancel", "end"],
    when: () => useFocusStore.getState().timer.phase !== "idle",
    run: () => useFocusStore.getState().stop(),
  },
  {
    id: "home.focusSettings",
    title: "Focus: Pomodoro settings",
    group: HOME_COMMAND_GROUPS.focus,
    icon: Settings2,
    keywords: ["pomodoro", "durations", "notifications", "sound"],
    run: (ctx) => ctx.openSettings(HOME_SETTINGS_ID),
  },
  {
    id: "home.openDailyNote",
    title: "Home: open today's daily note",
    group: HOME_COMMAND_GROUPS.home,
    icon: CalendarCheck,
    keywords: ["daily", "journal", "today", "diary"],
    run: async (ctx) => {
      const path = await dailyNote();
      const aether = useAetherStore.getState();
      if (!aether.vaultNotes.some((n) => n.path === path)) {
        await useHomeStore.getState().refreshVault().catch(() => undefined);
      }
      useAetherStore.getState().selectNote(path);
      ctx.setView("editor");
    },
  },
];
