/** Launcher + Universal Search commands (`src-tauri/src/commands/search_commands.rs`). */
import type {
  AppEntry,
  IndexReport,
  KindReport,
  RecentHit,
  SearchHit,
  SearchKind,
  SearchSettings,
  SearchStatus,
} from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Emitted by the system-wide shortcut: bring up the launcher. */
export const LAUNCHER_OPEN_EVENT = "launcher-open";
/** Emitted after each kind of an indexing run (payload {@link KindReport}). */
export const SEARCH_INDEX_PROGRESS_EVENT = "search-index-progress";
/** Emitted when a background indexing run finished (payload {@link IndexReport}). */
export const SEARCH_INDEX_UPDATED_EVENT = "search-index-updated";

/** Options of {@link searchQuery}. */
export interface SearchQueryOptions {
  /** Restrict to these kinds (intersected with the kinds enabled in settings). */
  kinds?: SearchKind[] | null;
  /** Maximum hits (default 40, at most 500). */
  limit?: number;
  /** Maximum hits per kind (keeps one kind from crowding out the others). */
  perKind?: number | null;
  /** Fuse in semantic vector hits (needs the vault index). */
  semantic?: boolean;
}

/**
 * Search the index. A leading `#` in `q` searches tags only. With
 * `semantic: true` the call fails with a message containing "vault index"
 * when the vault has not been embedded yet.
 */
export const searchQuery = (q: string, options: SearchQueryOptions = {}) =>
  call<SearchHit[]>("cmd_search_query", {
    q,
    kinds: options.kinds && options.kinds.length > 0 ? options.kinds : null,
    limit: options.limit ?? 40,
    perKind: options.perKind ?? null,
    semantic: options.semantic ?? false,
  });
/** Rebuild the index for `kinds` (all when omitted); progress arrives as `search-index-progress`. */
export const searchReindex = (kinds?: SearchKind[]) =>
  call<IndexReport>("cmd_search_reindex", { kinds: kinds && kinds.length > 0 ? kinds : null });
/** Installed applications (cached for five minutes). */
export const searchApps = () => call<AppEntry[]>("cmd_search_apps");
/** Launch an application bundle from the application folders. */
export const launchApp = (path: string) => call<void>("cmd_launch_app", { path });
/** Remember that a result was opened (Recents + frecency ranking). */
export const recordSearchRecent = (id: string, kind: string, title?: string | null) =>
  call<void>("cmd_search_recents_record", { id, kind, title: title ?? null });
/** Recent results, most recent first. */
export const listSearchRecents = (limit = 20) => call<RecentHit[]>("cmd_search_recents_list", { limit });
/** Forget all recents. */
export const clearSearchRecents = () => call<void>("cmd_search_recents_clear");
/** Settings → Search. */
export const getSearchSettings = () => call<SearchSettings>("cmd_search_get_settings");
/** Validate and save search settings; resolves to the normalised value. */
export const setSearchSettings = (settings: SearchSettings) =>
  call<SearchSettings>("cmd_search_set_settings", { settings });
/** Document counts, last indexing run and global-shortcut state. */
export const getSearchStatus = () => call<SearchStatus>("cmd_search_status");

/** The system-wide shortcut fired (window already focused by the backend). */
export const onLauncherOpen = (handler: () => void): Promise<UnlistenFn> =>
  listenSafe<null>(LAUNCHER_OPEN_EVENT, () => handler());
/** Per-kind progress while the index is rebuilt. */
export const onSearchIndexProgress = (handler: (report: KindReport) => void): Promise<UnlistenFn> =>
  listenSafe<KindReport>(SEARCH_INDEX_PROGRESS_EVENT, handler);
/** A background indexing run (start-up or settings change) finished. */
export const onSearchIndexUpdated = (handler: (report: IndexReport) => void): Promise<UnlistenFn> =>
  listenSafe<IndexReport>(SEARCH_INDEX_UPDATED_EVENT, handler);
