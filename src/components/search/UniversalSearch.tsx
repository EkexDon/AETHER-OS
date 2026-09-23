import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Database, RefreshCw, ScanSearch, SearchX, Sparkles } from "lucide-react";
import type { RecentHit, SearchHit, SearchStatus } from "../../types";
import {
  getSearchStatus,
  indexVault,
  isDesktopRuntime,
  listSearchRecents,
  onSearchIndexUpdated,
  searchQuery,
} from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { useSearchStore, type SearchTab } from "../../lib/searchStore";
import { parseQuery, QUERY_PREFIXES } from "../../lib/search/prefix";
import { SECTION_META, SEARCH_KINDS } from "../../lib/search/kinds";
import { commandItems } from "../../lib/search/launcherItems";
import { openCommand, openHit } from "../../lib/search/actions";
import { isCommandEnabled, useCommands } from "../../lib/commands/registry";
import { createCommandContext } from "../../lib/commands/context";
import { isMacPlatform } from "../../lib/shortcuts";
import { Button, EmptyState, Kbd, ListRow, SearchField, Switch, Tabs, ViewHeader, cx, useToast } from "../../ui";
import { SearchPreview } from "./SearchPreview";
import { SearchResultCard, relativeAge } from "./SearchResultCard";
import { HighlightedText } from "./Highlighted";

/** Debounce of the Search view (slower than the launcher: bigger result sets). */
export const VIEW_DEBOUNCE_MS = 150;
/** Results requested per query and per kind (tab counts are capped at this). */
export const VIEW_LIMIT = 400;
export const VIEW_PER_KIND = 50;

/** Does a backend error mean "the vault has not been embedded yet"? */
export function isMissingVaultIndex(message: string): boolean {
  return /vault index/i.test(message);
}

function statusLine(status: SearchStatus | null): string {
  if (!status) return "Everything in one place — notes, projects, files, apps, events, tasks and memory.";
  const updated = status.last_indexed_at ? ` · updated ${relativeAge(status.last_indexed_at)}` : "";
  return `${status.total.toLocaleString()} items indexed${updated}${status.indexing ? " · indexing…" : ""}`;
}

/**
 * Universal Search: full results page with category tabs (with counts),
 * hybrid keyword + semantic ranking, highlighted snippets, a preview pane
 * and the same prefixes as the launcher (`>`, `#`, `/`, `@`, `?`).
 */
export function UniversalSearch() {
  const toast = useToast();
  const query = useSearchStore((s) => s.viewQuery);
  const setQuery = useSearchStore((s) => s.setViewQuery);
  const tab = useSearchStore((s) => s.viewTab);
  const setTab = useSearchStore((s) => s.setViewTab);
  const semantic = useSearchStore((s) => s.viewSemantic);
  const setSemantic = useSearchStore((s) => s.setViewSemantic);
  const selectedId = useSearchStore((s) => s.viewSelectedId);
  const setSelectedId = useSearchStore((s) => s.setViewSelectedId);
  const reindexing = useSearchStore((s) => s.reindexing);
  const progress = useSearchStore((s) => s.progress);
  const reindex = useSearchStore((s) => s.reindex);
  const vaultIndexing = useAetherStore((s) => s.indexing);
  const setVaultIndexing = useAetherStore((s) => s.setIndexing);
  const commands = useCommands();

  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [semanticMissing, setSemanticMissing] = useState(false);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [recents, setRecents] = useState<RecentHit[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const backend = isDesktopRuntime();

  const parsed = useMemo(() => parseQuery(query), [query]);

  const refreshStatus = useCallback(() => {
    if (!backend) return;
    void getSearchStatus()
      .then(setStatus)
      .catch(() => undefined);
    void listSearchRecents(8)
      .then(setRecents)
      .catch(() => undefined);
  }, [backend]);

  useEffect(() => {
    refreshStatus();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onSearchIndexUpdated(() => {
      refreshStatus();
      setRefreshKey((k) => k + 1);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshStatus]);

  // Debounced, cancel-stale backend query; previous results stay visible.
  const { backendQuery } = parsed;
  const kindsKey = parsed.kinds?.join(",") ?? "";
  useEffect(() => {
    const id = ++requestId.current;
    if (!backend || !backendQuery) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const kinds = kindsKey ? (kindsKey.split(",") as SearchHit["kind"][]) : null;
      const run = (withSemantic: boolean) =>
        searchQuery(backendQuery, { kinds, limit: VIEW_LIMIT, perKind: VIEW_PER_KIND, semantic: withSemantic });
      void run(semantic)
        .then((result) => ({ result, missing: false }))
        .catch(async (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          if (semantic && isMissingVaultIndex(message)) {
            return { result: await run(false), missing: true };
          }
          throw e;
        })
        .then(({ result, missing }) => {
          if (id !== requestId.current) return;
          setHits(result);
          setSemanticMissing(missing);
          setError(null);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (id !== requestId.current) return;
          setHits([]);
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    }, VIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [backend, backendQuery, kindsKey, semantic, refreshKey]);

  useEffect(() => {
    if (!semantic) setSemanticMissing(false);
  }, [semantic]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of hits) map.set(h.kind, (map.get(h.kind) ?? 0) + 1);
    return map;
  }, [hits]);

  const displayed = useMemo(() => (tab === "all" ? hits : hits.filter((h) => h.kind === tab)), [hits, tab]);
  const selectedIndex = Math.max(0, displayed.findIndex((h) => h.id === selectedId));
  const selected = displayed[selectedIndex] ?? null;

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, displayed]);

  const commandResults = useMemo(() => {
    if (parsed.mode !== "commands") return [];
    const ctx = createCommandContext();
    return commandItems(
      commands.filter((c) => isCommandEnabled(c, ctx)),
      parsed.text
    ).slice(0, 60);
  }, [commands, parsed]);

  const open = useCallback((hit: SearchHit, alternate: boolean) => {
    void openHit(hit, { alternate }).catch(() => undefined);
  }, []);

  const select = useCallback((index: number) => setSelectedId(displayed[index]?.id ?? null), [displayed, setSelectedId]);

  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (displayed.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(Math.min(displayed.length - 1, selectedIndex + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(Math.max(0, selectedIndex - 1));
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      open(selected, isMacPlatform() ? e.metaKey : e.ctrlKey);
    }
  };

  const runVaultIndex = async () => {
    if (vaultIndexing) return;
    setVaultIndexing(true);
    try {
      const result = await indexVault();
      toast.success("Vault indexed", {
        description: `${result.indexed} of ${result.total} notes embedded${result.skipped ? `, ${result.skipped} skipped` : ""}.`,
      });
      setSemanticMissing(false);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error("Indexing failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setVaultIndexing(false);
    }
  };

  const onReindex = async () => {
    const report = await reindex();
    if (report) {
      refreshStatus();
      setRefreshKey((k) => k + 1);
    }
  };

  const tabs = [
    { id: "all" as SearchTab, label: "All", count: hits.length },
    ...SEARCH_KINDS.filter((k) => (counts.get(k) ?? 0) > 0 || tab === k).map((k) => ({
      id: k as SearchTab,
      label: SECTION_META[k].label,
      count: counts.get(k) ?? 0,
    })),
  ];

  const progressLine =
    reindexing && progress.length > 0
      ? `Indexed ${progress.map((p) => SECTION_META[p.kind].label.toLowerCase()).join(" · ")}…`
      : reindexing
        ? "Reindexing…"
        : null;

  const showResults = parsed.mode !== "commands" && parsed.mode !== "help" && !!parsed.backendQuery;

  return (
    <div className="view universal-search">
      <ViewHeader
        title="Search"
        subtitle={progressLine ?? statusLine(status)}
        bordered
        actions={
          <>
            <Switch
              size="sm"
              checked={semantic}
              onChange={setSemantic}
              label="Semantic"
              aria-label="Semantic search (by meaning)"
            />
            <Button
              size="sm"
              iconLeft={<RefreshCw size={14} />}
              loading={reindexing}
              disabled={!backend}
              onClick={() => void onReindex()}
            >
              Reindex
            </Button>
          </>
        }
        tabs={
          showResults ? (
            <Tabs aria-label="Result categories" value={tab} onChange={setTab} items={tabs} idPrefix="usearch-tab" />
          ) : undefined
        }
      />
      <div className="view-body universal-search-body">
        <div className="usearch-bar">
          <SearchField
            size="lg"
            value={query}
            onChange={(v) => {
              setQuery(v);
              setSelectedId(null);
            }}
            onKeyDown={onFieldKeyDown}
            placeholder="Search everything — # tags, / files, @ people, > commands"
            aria-label="Search everything"
            aria-controls="usearch-results"
            aria-activedescendant={selected && showResults ? `usearch-result-${selectedIndex}` : undefined}
            autoFocus
          />
          <div className="usearch-prefixes" aria-label="Prefixes">
            {QUERY_PREFIXES.filter((p) => p.mode !== "help").map((p) => (
              <button
                key={p.prefix}
                type="button"
                className={cx("usearch-prefix", parsed.prefix === p.prefix && "is-active")}
                onClick={() => setQuery(`${p.prefix}${parsed.text ? parsed.text : ""}`)}
                title={p.description}
              >
                <span className="mono">{p.prefix}</span> {p.label}
              </button>
            ))}
          </div>
        </div>

        {semantic && semanticMissing && (
          <div className="ui-notice ui-notice-warning usearch-notice" role="status">
            <Sparkles size={14} />
            <span>Semantic search needs the vault index. Showing keyword results until the vault is embedded.</span>
            <Button size="sm" iconLeft={<Database size={14} />} loading={vaultIndexing} onClick={() => void runVaultIndex()}>
              Index vault
            </Button>
          </div>
        )}
        {error && (
          <div className="ui-notice ui-notice-danger usearch-notice" role="alert">
            {error}
          </div>
        )}

        {parsed.mode === "help" ? (
          <div className="usearch-list">
            {QUERY_PREFIXES.filter((p) => p.mode !== "help").map((p) => (
              <ListRow
                key={p.prefix}
                icon={<span className="usearch-prefix-glyph mono">{p.prefix}</span>}
                title={p.label}
                description={`${p.description} — e.g. ${p.example}`}
                onClick={() => setQuery(p.prefix)}
              />
            ))}
          </div>
        ) : parsed.mode === "commands" ? (
          commandResults.length === 0 ? (
            <EmptyState icon={SearchX} title={`No command matches “${parsed.text}”`} description="Try another word." />
          ) : (
            <div className="usearch-list">
              {commandResults.map((item) => {
                const Icon = item.icon;
                return (
                  <ListRow
                    key={item.key}
                    icon={<Icon size={14} />}
                    title={<HighlightedText text={item.title} positions={item.titlePositions} />}
                    description={item.subtitle}
                    meta={item.shortcut ? <Kbd shortcut={item.shortcut} /> : undefined}
                    onClick={() => item.action.type === "command" && void openCommand(item.action.id, item.action.title)}
                  />
                );
              })}
            </div>
          )
        ) : !showResults ? (
          <div className="usearch-start">
            <EmptyState
              icon={ScanSearch}
              title={
                parsed.prefix
                  ? `Type to search ${QUERY_PREFIXES.find((p) => p.prefix === parsed.prefix)?.label.toLowerCase() ?? "everything"}`
                  : "Search everything"
              }
              description="Notes, projects, files, apps, events, tasks, memory and AI conversations — ranked by keywords, fuzzy titles and (with Semantic on) meaning."
            />
            {recents.some((r) => r.hit) && (
              <section className="usearch-recents">
                <h3 className="ui-section-label">Recent</h3>
                <div className="usearch-list">
                  {recents
                    .filter((r): r is RecentHit & { hit: SearchHit } => r.hit !== null)
                    .map((r) => {
                      const Icon = SECTION_META[r.hit.kind].icon;
                      return (
                        <ListRow
                          key={r.id}
                          icon={<Icon size={14} />}
                          title={r.hit.title}
                          description={r.hit.subtitle}
                          meta={relativeAge(r.last_used)}
                          onClick={() => open(r.hit, false)}
                        />
                      );
                    })}
                </div>
              </section>
            )}
          </div>
        ) : displayed.length === 0 && !loading ? (
          <EmptyState
            icon={SearchX}
            title={`No results for “${parsed.text}”`}
            description={
              semantic
                ? "Try fewer words or another category."
                : "Try fewer words, a prefix, or turn on Semantic to search by meaning."
            }
          />
        ) : (
          <div className={cx("usearch-layout", loading && "is-loading")}>
            <div className="usearch-results" id="usearch-results" role="listbox" aria-label="Search results" ref={listRef}>
              {displayed.map((hit, index) => (
                <SearchResultCard
                  key={hit.id}
                  hit={hit}
                  query={parsed.text}
                  index={index}
                  selected={index === selectedIndex}
                  onSelect={select}
                  onOpen={open}
                />
              ))}
              {displayed.length >= VIEW_PER_KIND && tab !== "all" && (
                <p className="usearch-cap-note">Showing the best {VIEW_PER_KIND}. Refine the query to see others.</p>
              )}
            </div>
            <aside className="usearch-preview" aria-label="Preview">
              <SearchPreview hit={selected} onOpen={open} />
            </aside>
          </div>
        )}

        {showResults && displayed.length > 0 && (
          <div className="usearch-footer">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> Select
            </span>
            <span>
              <Kbd>↵</Kbd> Open
            </span>
            <span>
              <Kbd shortcut="mod+enter" /> Alternate
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
