/** Launcher + Universal Search types — mirror `engine/search_index.rs`
 *  and `commands/search_commands.rs`. */

/** Kinds held by the backend index. */
export type SearchKind = "note" | "project" | "file" | "app" | "event" | "task" | "memory" | "conversation";

/** One backend search result. */
export interface SearchHit {
  /** `<kind>:<natural id>`, e.g. `note:/Users/me/Vault/Garden.md`. */
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  /** Filesystem path for notes, files, projects and apps; empty otherwise. */
  path: string;
  /** Escaped text with `<mark>…</mark>` around matches. Render with `<Highlighted>`. */
  snippet_html: string;
  /** Relative relevance in (0, 1]; 1 is the best hit of the query. */
  score: number;
  /** Unix seconds (0 when unknown). */
  updated_at: number;
  /** Kind-specific data: `project_id`, `date`, `bundle_id`, `folder`, … */
  extra: Record<string, unknown> | null;
  /** Retrievers that found the hit. */
  matched: ("keyword" | "fuzzy" | "semantic")[];
}

/** Per-kind outcome of an indexing run. */
export interface KindReport {
  kind: SearchKind;
  count: number;
  changed: number;
  removed: number;
  ms: number;
  /** The 50 000-file cap was hit. */
  truncated: boolean;
  error: string | null;
}

/** Outcome of `cmd_search_reindex` (also the `search-index-updated` payload). */
export interface IndexReport {
  kinds: KindReport[];
  total: number;
  ms: number;
}

/** An installed application (`cmd_search_apps`). */
export interface AppEntry {
  name: string;
  path: string;
  bundle_id: string | null;
}

/** A recently opened result, resolved against the index where possible. */
export interface RecentHit {
  id: string;
  /** A {@link SearchKind} or a client kind (`command`, `bookmark`, `clip`). */
  kind: string;
  title: string | null;
  count: number;
  last_used: number;
  frecency: number;
  /** The indexed item; `null` for client kinds. */
  hit: SearchHit | null;
}

/** Settings → Search (`<data_dir>/search/settings.json`). */
export interface SearchSettings {
  global_shortcut_enabled: boolean;
  /** Accelerator such as `Alt+Space` or `CommandOrControl+Shift+Space`. */
  global_shortcut: string;
  kinds: SearchKind[];
  /** Folders whose files are indexed; empty = every project root. */
  file_roots: string[];
}

/** Documents per kind. */
export interface KindCount {
  kind: string;
  count: number;
}

/** Index health (`cmd_search_status`). */
export interface SearchStatus {
  counts: KindCount[];
  total: number;
  last_indexed_at: number | null;
  indexing: boolean;
  /** The registered global shortcut, if any. */
  shortcut: string | null;
  /** Why the configured global shortcut could not be registered. */
  shortcut_error: string | null;
}
