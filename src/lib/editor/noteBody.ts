/**
 * Load a note body into the editor and turn the edited document back into
 * the body to save — the original bytes wherever the user did not edit
 * (see `sourceMerge.ts`).
 */
import { createDocument, type Editor } from "@tiptap/core";
import { mergeSource, type SourceBase } from "./sourceMerge";

interface MarkdownStorage {
  getMarkdown: () => string;
  parser: { parse: (content: string) => string };
  serializer: { serialize: (content: unknown) => string };
}

function markdownStorage(editor: Editor): MarkdownStorage | null {
  return (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown ?? null;
}

/** The document as Markdown, written by the editor's serializer. */
export function editorMarkdown(editor: Editor): string {
  return markdownStorage(editor)?.getMarkdown() ?? "";
}

/** How the editor would write `markdown` after reading it (parse → serialize, without touching the editor). */
export function canonicalMarkdown(editor: Editor, markdown: string): string {
  const storage = markdownStorage(editor);
  if (!storage) return markdown;
  const doc = createDocument(storage.parser.parse(markdown), editor.schema, editor.options.parseOptions);
  return storage.serializer.serialize(doc);
}

/** An empty base (no note open). */
export const EMPTY_BASE: SourceBase = { source: "", canonical: "" };

/** Show `body` in the editor (no update event) and remember it as the save base. */
export function loadBody(editor: Editor, body: string): SourceBase {
  editor.commands.setContent(body, { emitUpdate: false });
  return { source: body, canonical: editorMarkdown(editor) };
}

/**
 * The body to save for the editor's current document: `base.source` with
 * the user's edits applied. A merge that meets differently formatted source
 * is accepted only when it reads back as the edited document.
 */
export function bodyToSave(editor: Editor, base: SourceBase): string {
  const next = editorMarkdown(editor);
  let expected: string | null = null;
  return mergeSource(base, next, (candidate) => {
    expected ??= canonicalMarkdown(editor, next);
    return canonicalMarkdown(editor, candidate) === expected;
  });
}
