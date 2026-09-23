/**
 * Command palette / shortcut contributions of the clipboard history.
 * `mod+shift+v` opens the history from anywhere. The plain-key commands
 * (↵, P, ⌫, /) only apply inside the history view — the view handles the
 * keys itself; listing them here makes them discoverable in the palette and
 * the shortcuts overlay (the global handler only fires modifier combos).
 */
import { ClipboardList, ClipboardPaste, Copy, Pause, Pin, Search, Trash2, X } from "lucide-react";
import type { CommandContribution, CommandContext } from "../commands/registry";
import { selectedClip, useClipboardStore } from "../clipboardStore";
import { displayPreview } from "./format";
import { formatShortcut } from "../shortcuts";

/** Palette section label. */
export const CLIPBOARD_GROUP = "Clipboard";

const inHistory = (ctx: CommandContext) => ctx.view === "clipboard";
const hasSelection = (ctx: CommandContext) => inHistory(ctx) && selectedClip(useClipboardStore.getState()) !== null;

/** Copy the latest clip and tell the user how to paste it. */
async function pasteLastClip(ctx: CommandContext): Promise<void> {
  const item = await useClipboardStore.getState().copyLatest();
  if (!item) {
    ctx.toast.info("Clipboard history is empty", { description: "Copy something first — it shows up here." });
    return;
  }
  const preview = displayPreview(item);
  ctx.toast.success("Latest clip is ready to paste", {
    description: `${preview.length > 60 ? `${preview.slice(0, 59)}…` : preview} — press ${formatShortcut("mod+v")} in your note.`,
    ...(ctx.view !== "editor" ? { action: { label: "Open notes", onClick: () => ctx.setView("editor") } } : {}),
  });
}

export const clipboardCommands: CommandContribution[] = [
  {
    id: "clipboard.open",
    title: "Clipboard: open history",
    group: CLIPBOARD_GROUP,
    icon: ClipboardList,
    shortcut: "mod+shift+v",
    keywords: ["paste", "history", "copy", "clips", "maccy", "pasteboard"],
    run: (ctx) => {
      ctx.setView("clipboard");
      useClipboardStore.getState().requestSearchFocus();
    },
  },
  {
    id: "clipboard.togglePause",
    title: "Clipboard: pause / resume capture",
    group: CLIPBOARD_GROUP,
    icon: Pause,
    keywords: ["privacy", "stop", "record", "incognito", "resume"],
    run: () => useClipboardStore.getState().togglePaused(),
  },
  {
    id: "clipboard.clear",
    title: "Clipboard: clear history…",
    group: CLIPBOARD_GROUP,
    icon: Trash2,
    keywords: ["delete", "wipe", "erase", "remove", "clips"],
    run: (ctx) => {
      ctx.setView("clipboard");
      useClipboardStore.getState().requestClear(true);
    },
  },
  {
    id: "clipboard.pasteLast",
    title: "Paste last clip into note",
    group: CLIPBOARD_GROUP,
    icon: ClipboardPaste,
    keywords: ["clipboard", "latest", "recent", "insert", "note"],
    run: pasteLastClip,
  },
  {
    id: "clipboard.copySelected",
    title: "Clipboard: copy selected clip",
    group: CLIPBOARD_GROUP,
    icon: Copy,
    shortcut: "enter",
    keywords: ["copy", "paste"],
    when: hasSelection,
    run: async () => {
      const clip = selectedClip(useClipboardStore.getState());
      if (clip) await useClipboardStore.getState().copy(clip.id);
    },
  },
  {
    id: "clipboard.pinSelected",
    title: "Clipboard: pin / unpin selected clip",
    group: CLIPBOARD_GROUP,
    icon: Pin,
    shortcut: "p",
    keywords: ["favorite", "keep", "star"],
    when: hasSelection,
    run: async () => {
      const clip = selectedClip(useClipboardStore.getState());
      if (clip) await useClipboardStore.getState().togglePin(clip.id);
    },
  },
  {
    id: "clipboard.deleteSelected",
    title: "Clipboard: delete selected clip",
    group: CLIPBOARD_GROUP,
    icon: X,
    shortcut: "backspace",
    keywords: ["remove", "forget"],
    when: hasSelection,
    run: () => {
      const clip = selectedClip(useClipboardStore.getState());
      if (clip) useClipboardStore.getState().deleteWithUndo(clip.id);
    },
  },
  {
    id: "clipboard.search",
    title: "Clipboard: search history",
    group: CLIPBOARD_GROUP,
    icon: Search,
    shortcut: "/",
    keywords: ["find", "filter"],
    when: inHistory,
    run: () => useClipboardStore.getState().requestSearchFocus(),
  },
];
