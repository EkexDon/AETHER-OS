import { useEffect, useRef, useState } from "react";
import type { ClipItem, RecentHit, SearchHit } from "../../types";
import { isDesktopRuntime, listSearchRecents, searchQuery } from "../../lib/ipc";
import type { ParsedQuery } from "../../lib/search/prefix";
import { searchClipboard } from "../../lib/search/sources";

/** Debounce between the last keystroke and the backend query. */
export const LAUNCHER_DEBOUNCE_MS = 60;
/** Hits requested per query / per kind. */
export const LAUNCHER_LIMIT = 60;
export const LAUNCHER_PER_KIND = 6;

/** Backend state of the launcher. */
export interface LauncherSearchState {
  hits: SearchHit[];
  clips: ClipItem[];
  recents: RecentHit[];
  /** A query for the current input is in flight (previous hits stay visible). */
  loading: boolean;
  error: string | null;
}

/**
 * Debounced backend search for the launcher. Stale responses are
 * discarded (only the latest request may update the list) and the
 * previous results stay visible while a new query runs, so the list never
 * flickers. Recents are loaded once when the launcher opens.
 */
export function useLauncherSearch(parsed: ParsedQuery): LauncherSearchState {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [recents, setRecents] = useState<RecentHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const backend = isDesktopRuntime();

  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    listSearchRecents(12)
      .then((r) => {
        if (!cancelled) setRecents(r);
      })
      .catch(() => {
        // Recents are optional; the launcher still works without them.
      });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  const { backendQuery, includeExtras, text } = parsed;
  const kindsKey = parsed.kinds?.join(",") ?? "";

  useEffect(() => {
    const id = ++requestId.current;
    if (!backend || !backendQuery) {
      setHits([]);
      setClips([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const kinds = kindsKey ? (kindsKey.split(",") as SearchHit["kind"][]) : null;
      const hitsRequest = searchQuery(backendQuery, { kinds, limit: LAUNCHER_LIMIT, perKind: LAUNCHER_PER_KIND });
      const clipsRequest = includeExtras ? searchClipboard(text) : Promise.resolve([] as ClipItem[]);
      void Promise.allSettled([hitsRequest, clipsRequest]).then(([hitsResult, clipsResult]) => {
        if (id !== requestId.current) return; // a newer query superseded this one
        if (hitsResult.status === "fulfilled") {
          setHits(hitsResult.value);
          setError(null);
        } else {
          setHits([]);
          setError(hitsResult.reason instanceof Error ? hitsResult.reason.message : String(hitsResult.reason));
        }
        setClips(clipsResult.status === "fulfilled" ? clipsResult.value : []);
        setLoading(false);
      });
    }, LAUNCHER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [backend, backendQuery, kindsKey, includeExtras, text]);

  return { hits, clips, recents, loading, error };
}
