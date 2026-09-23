/**
 * Tiny event bus between features and the note editor.
 *
 * Features that change a note on disk behind the editor's back (history
 * restore, sync, agent actions) call `requestNoteReload(path)`; the editor
 * re-reads that note if it is the one currently open. Keeping this out of
 * the global store avoids a render of every store consumer for a signal
 * only one component cares about.
 */

export type NoteReloadHandler = (path: string) => void;

const handlers = new Set<NoteReloadHandler>();

/** Ask the editor to re-read `path` from disk if it is open. */
export function requestNoteReload(path: string): void {
  for (const handler of Array.from(handlers)) {
    try {
      handler(path);
    } catch {
      // A misbehaving subscriber must not block the others.
    }
  }
}

/** Subscribe to reload requests. Returns an unsubscribe function. */
export function subscribeNoteReload(handler: NoteReloadHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Number of active subscribers (for tests). */
export function noteReloadSubscriberCount(): number {
  return handlers.size;
}
