/**
 * The TipTap extension set of the note editor, shared by `NoteEditor` and
 * the tests that check how Markdown lines map onto editor blocks.
 */
import { Extension, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import LinkExtension from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";
import { LineFlash } from "./lineFlash";
import { VaultImage } from "./vaultImage";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      /** Apply a CSS font size (`"18px"`) to the selection. */
      setFontSize: (fontSize: string) => ReturnType;
      /** Remove the font size from the selection. */
      unsetFontSize: () => ReturnType;
    };
  }
}

/** Inline font size as a `textStyle` attribute. */
export const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize?.replace(/['"]+/g, "") || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run(),
    };
  },
});

/**
 * tiptap-markdown only tracks "tight" (no blank lines between items) for
 * bullet and ordered lists, so every task list was written back loose —
 * a blank line between each `- [ ]` item after the first edit. This gives
 * task lists the same `tight` attribute, parsed the same way.
 */
const TaskListTightness = Extension.create({
  name: "taskListTightness",
  addGlobalAttributes() {
    return [
      {
        types: ["taskList"],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-tight") === "true" || !element.querySelector("p"),
            renderHTML: (attributes: Record<string, unknown>) => (attributes.tight ? { "data-tight": "true" } : {}),
          },
        },
      },
    ];
  },
});

/** Options of {@link noteEditorExtensions}. */
export interface NoteEditorExtensionOptions {
  /** Empty-canvas hint. */
  placeholder?: string;
}

/**
 * Every extension the note canvas uses. StarterKit's own link and underline
 * are disabled because the configured standalone versions replace them.
 */
export function noteEditorExtensions(options: NoteEditorExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
      underline: false,
    }),
    TaskList,
    TaskListTightness,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Underline,
    TextStyle,
    FontSize,
    Color,
    VaultImage.configure({ allowBase64: true }),
    LinkExtension.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder: options.placeholder ?? "Start writing markdown, thoughts, or ideas…" }),
    Markdown.configure({
      html: true,
      transformCopiedText: false,
      transformPastedText: false,
    }),
    LineFlash,
  ];
}
