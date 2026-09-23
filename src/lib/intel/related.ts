/**
 * Related-note suggestions for the note being written: cached per path and
 * keyed by a hash of the text the backend sees (the first 2,000
 * characters), so re-renders and unchanged notes never refetch.
 */
import { addNoteTag, appendNote, getNoteContent, suggestRelated, suggestTags } from "../ipc";
import { useIntelStore, type RelatedEntry } from "../intelStore";
import { useAetherStore } from "../store";
import { QUERY_CHARS } from "./keywords";
import { hasWikilink, linkAppendText, reloadOpenNote, waitForCleanNote } from "./noteEdits";

/** Debounce between the last edit and a refresh. */
export const RELATED_DEBOUNCE_MS = 1_500;
/** Suggestions fetched per note. */
export const RELATED_LIMIT = 8;
/** Tag chips fetched per note. */
export const TAG_LIMIT = 6;

/** Stable hash (djb2) of the query part of a note. */
export function textKey(text: string): string {
  const query = Array.from(text).slice(0, QUERY_CHARS).join("");
  let h = 5381;
  for (let i = 0; i < query.length; i++) h = ((h << 5) + h + query.charCodeAt(i)) | 0;
  return `${query.length}:${(h >>> 0).toString(36)}`;
}

const inflight = new Map<string, string>();

/**
 * Fetch suggestions + tags for `path` unless the cache already has them for
 * this text (or `force`). Errors land in the cache entry, never throw.
 */
export async function refreshRelated(path: string, text: string, force = false): Promise<void> {
  const key = textKey(text);
  const intel = useIntelStore.getState();
  const cached = intel.related[path];
  if (!force && cached && cached.key === key && !cached.error) return;
  if (inflight.get(path) === key) return;
  inflight.set(path, key);
  intel.setRelated(path, { loading: true, error: null });
  const { provider, modelByProvider } = useAetherStore.getState();
  const useLlm = useIntelStore.getState().settings.llm_tag_suggestions;
  try {
    const [suggestions, tags] = await Promise.all([
      suggestRelated(text, path, RELATED_LIMIT),
      suggestTags(text, TAG_LIMIT, useLlm ? modelByProvider[provider] : null, useLlm ? provider : null),
    ]);
    if (inflight.get(path) !== key) return; // a newer refresh superseded this one
    useIntelStore.getState().setRelated(path, { key, loading: false, suggestions, tags, error: null, updatedAt: Date.now() });
  } catch (e) {
    if (inflight.get(path) !== key) return;
    useIntelStore.getState().setRelated(path, {
      key,
      loading: false,
      error: e instanceof Error ? e.message : String(e),
      updatedAt: Date.now(),
    });
  } finally {
    if (inflight.get(path) === key) inflight.delete(path);
  }
}

/** Mark a suggestion as linked / drop a tag in the cache after an edit. */
function patchEntry(path: string, fn: (entry: RelatedEntry) => void) {
  const entry = useIntelStore.getState().related[path];
  if (!entry) return;
  const next = { ...entry, suggestions: [...entry.suggestions], tags: [...entry.tags] };
  fn(next);
  useIntelStore.getState().setRelated(path, next);
}

/**
 * Append `[[name]]` to the end of `notePath` (via `appendNote`), waiting
 * for unsaved editor changes first and reloading the editor afterwards.
 * Resolves `false` when the note already links there.
 */
export async function insertLink(notePath: string, name: string): Promise<boolean> {
  await waitForCleanNote(notePath);
  const content = await getNoteContent(notePath);
  if (hasWikilink(content, name)) {
    patchEntry(notePath, (e) => {
      e.suggestions = e.suggestions.map((s) => (s.name === name ? { ...s, linked: true } : s));
    });
    return false;
  }
  await appendNote(notePath, linkAppendText(content, name));
  patchEntry(notePath, (e) => {
    e.suggestions = e.suggestions.map((s) => (s.name === name ? { ...s, linked: true } : s));
  });
  await reloadOpenNote(notePath);
  return true;
}

/** Add a tag (frontmatter-aware, in Rust) and reload the editor. */
export async function applyTag(notePath: string, tag: string): Promise<boolean> {
  await waitForCleanNote(notePath);
  const result = await addNoteTag(notePath, tag);
  patchEntry(notePath, (e) => {
    e.tags = e.tags.filter((t) => t.toLowerCase() !== result.tag.toLowerCase());
  });
  if (result.changed) await reloadOpenNote(notePath);
  return result.changed;
}
