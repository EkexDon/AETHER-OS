/**
 * What wikilink chips and the `[[` autocomplete need from the app: the
 * vault's notes, a way to open a link and a way to create a missing note.
 * {@link storeWikilinkHost} wires them to the app store and IPC; tests pass
 * their own host.
 */
import type { VaultNote } from "../../types";
import { createNote, getNoteContent, getVaultNotes } from "../ipc";
import { findWikilinkNote } from "../markdown/links";
import { useAetherStore } from "../store";
import { useVaultTasksStore } from "../vaultTasksStore";
import { parseWikilink, type WikilinkParts } from "./obsidianSyntax";

/** The app services behind wikilinks in the editor. */
export interface WikilinkHost {
  /** Every note of the vault. */
  notes(): readonly VaultNote[];
  /** Absolute vault root, `null` when unknown. */
  vaultRoot(): string | null;
  /** The note open in the editor. */
  currentNotePath(): string | null;
  /** Follow a link: open (or create, when missing) the note it names. */
  open(link: WikilinkParts): void;
  /** Create a note by name; resolves to its path (`null` when it failed). */
  create(name: string): Promise<string | null>;
  /** Call `listener` whenever the note list changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** The note a link resolves to (the open note for `[[#Heading]]`). */
export function resolveWikilink(host: Pick<WikilinkHost, "notes" | "vaultRoot" | "currentNotePath">, raw: string): VaultNote | null {
  const { target } = parseWikilink(raw);
  if (!target) {
    const current = host.currentNotePath();
    return host.notes().find((n) => n.path === current) ?? null;
  }
  return findWikilinkNote(target, host.vaultRoot(), host.notes());
}

/** 0-based line of the heading named `heading` in `content`, or `null`. */
export function headingLine(content: string, heading: string): number | null {
  const wanted = heading.replace(/^\^/, "").trim().toLowerCase();
  if (!wanted) return null;
  const lines = content.split(/\r\n|\n|\r/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m && m[1].trim().toLowerCase() === wanted) return i;
    // Block references: `… ^block-id` at the end of a line.
    if (heading.startsWith("^") && line.trimEnd().endsWith(` ${heading}`)) return i;
  }
  return null;
}

async function revealHeading(path: string, heading: string): Promise<void> {
  try {
    const line = headingLine(await getNoteContent(path), heading);
    if (line !== null) useVaultTasksStore.setState({ pendingLine: { notePath: path, line } });
  } catch {
    // The note still opens, just not scrolled.
  }
}

/** A note name the vault can create (no link syntax, no characters file systems reject). */
export function isCreatableNoteName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 200 && !/[[\]#|^\\:*?"<>\n\r]/.test(n) && !/(^|\/)\.\.?(\/|$)/.test(n) && !n.startsWith("/");
}

/** The host backed by the app store and IPC. */
export const storeWikilinkHost: WikilinkHost = {
  notes: () => useAetherStore.getState().vaultNotes,
  vaultRoot: () => useAetherStore.getState().vaultPath,
  currentNotePath: () => useAetherStore.getState().selectedNotePath,
  open(link) {
    const store = useAetherStore.getState();
    if (!link.target) {
      if (link.heading && store.selectedNotePath) void revealHeading(store.selectedNotePath, link.heading);
      return;
    }
    const note = findWikilinkNote(link.target, store.vaultPath, store.vaultNotes);
    const show = (path: string) => {
      if (link.heading) void revealHeading(path, link.heading);
      const { selectNote, setView } = useAetherStore.getState();
      selectNote(path);
      setView("editor");
    };
    if (note) {
      show(note.path);
      return;
    }
    // Obsidian behaviour: following a link to a missing note creates it.
    void storeWikilinkHost.create(link.target).then((path) => {
      if (path) show(path);
    });
  },
  async create(name) {
    const clean = name.trim().replace(/\.md$/i, "");
    if (!isCreatableNoteName(clean)) return null;
    try {
      const title = clean.split("/").pop() ?? clean;
      const path = await createNote(clean, `# ${title}\n\n`);
      useAetherStore.getState().setVaultNotes(await getVaultNotes());
      return path;
    } catch {
      return null;
    }
  },
  subscribe(listener) {
    return useAetherStore.subscribe((state, prev) => {
      if (state.vaultNotes !== prev.vaultNotes || state.vaultPath !== prev.vaultPath) listener();
    });
  },
};
