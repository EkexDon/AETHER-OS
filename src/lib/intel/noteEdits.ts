/**
 * Safe edits to a note that may be open in the editor.
 *
 * The note editor (TipTap) keeps its own copy of the open note and
 * autosaves it 1.2 s after the last keystroke. Writing the same file from
 * outside while the editor has unsaved changes would be overwritten by that
 * autosave, and a clean editor would keep showing stale content. So every
 * external write (insert link, add tag, agent actions on the open note)
 * first waits for the editor to be clean and afterwards makes it reload.
 */
import { useAetherStore } from "../store";

/** Last path component without `.md`. */
export function noteNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/** True when `content` already links to `name` (case-insensitive, alias-aware). */
export function hasWikilink(content: string, name: string): boolean {
  const target = name.trim().toLowerCase();
  for (const m of content.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    if (m[1].split(/[|#]/)[0].trim().toLowerCase() === target) return true;
  }
  return false;
}

/**
 * The text to hand to `appendNote` (which adds a trailing newline) so that
 * `[[name]]` ends up at the end of the note: as another list item after a
 * list of links, on its own line after a link-only line, otherwise as a new
 * paragraph.
 */
export function linkAppendText(existing: string, name: string): string {
  const link = `[[${name}]]`;
  const lines = existing.replace(/\s+$/, "").split(/\r?\n/);
  const last = lines[lines.length - 1] ?? "";
  if (/^\s*[-*]\s+\[\[[^\]]+\]\]\s*$/.test(last)) {
    const bullet = /^(\s*[-*])/.exec(last)?.[1] ?? "-";
    return `${bullet} ${link}`;
  }
  if (/^(\s*\[\[[^\]]+\]\])+\s*$/.test(last)) return link;
  if (!existing.trim() || /\n\s*\n$/.test(existing)) return link;
  return `\n${link}`;
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });

/**
 * Resolve once the editor has no unsaved changes for `path` (immediately
 * when the note is not the one being edited). Rejects after `timeoutMs`.
 */
export function waitForCleanNote(path: string, timeoutMs = 4_000): Promise<void> {
  const isDirty = () => {
    const s = useAetherStore.getState();
    return s.selectedNotePath === path && s.noteDirty;
  };
  if (!isDirty()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("The note has unsaved changes — wait a moment and try again."));
    }, timeoutMs);
    const unsubscribe = useAetherStore.subscribe(() => {
      if (!isDirty()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Make the editor re-read `path` from disk if it is the open note (it loads
 * content whenever the selected path changes, so briefly deselect it).
 */
export async function reloadOpenNote(path: string): Promise<void> {
  const { selectedNotePath, selectNote } = useAetherStore.getState();
  if (selectedNotePath !== path) return;
  selectNote(null);
  await nextFrame();
  if (useAetherStore.getState().selectedNotePath === null) selectNote(path);
}
