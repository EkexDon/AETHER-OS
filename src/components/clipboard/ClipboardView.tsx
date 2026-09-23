import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Braces, ClipboardList, Image as ImageIcon, Layers, Link2, Palette, Pause, Pin, Play, Search, Settings2, TriangleAlert, Type } from "lucide-react";
import type { ClipItem } from "../../types";
import { attachClipboardView, useClipboardStore, visibleClips } from "../../lib/clipboardStore";
import { KIND_FILTERS, statsSummary, type ClipKindFilter } from "../../lib/clipboard/format";
import { isEditableTarget } from "../../lib/shortcuts";
import { useShellStore } from "../../shell/shellStore";
import { Button, EmptyState, IconButton, SearchField, SegmentedControl, Spinner, ViewHeader, cx } from "../../ui";
import { ClipList } from "./ClipList";
import { ClipDetail } from "./ClipDetail";
import { SaveAsNoteModal } from "./SaveAsNoteModal";
import { ClearHistoryModal } from "./ClearHistoryModal";
import { useNow } from "./useNow";
import "../../styles/views/clipboard.css";

const FILTER_ICONS: Record<ClipKindFilter, JSX.Element> = {
  all: <Layers size={13} />,
  text: <Type size={13} />,
  url: <Link2 size={13} />,
  code: <Braces size={13} />,
  image: <ImageIcon size={13} />,
  color: <Palette size={13} />,
};

/** Page size for PageUp / PageDown. */
const PAGE_STEP = 10;

/**
 * Clipboard history: searchable, filterable list of everything copied on
 * this machine with a detail pane. Keyboard: ↑/↓ select, ↵ copy, P pin,
 * ⌫ delete (undo for 5 s), / search, Esc clear the search.
 */
export function ClipboardView() {
  const items = useClipboardStore((s) => s.items);
  const pendingDeletes = useClipboardStore((s) => s.pendingDeletes);
  const selectedId = useClipboardStore((s) => s.selectedId);
  const query = useClipboardStore((s) => s.query);
  const kind = useClipboardStore((s) => s.kind);
  const pinnedOnly = useClipboardStore((s) => s.pinnedOnly);
  const stats = useClipboardStore((s) => s.stats);
  const settings = useClipboardStore((s) => s.settings);
  const loaded = useClipboardStore((s) => s.loaded);
  const error = useClipboardStore((s) => s.error);
  const hasMore = useClipboardStore((s) => s.hasMore);
  const loadingMore = useClipboardStore((s) => s.loadingMore);
  const focusSearchToken = useClipboardStore((s) => s.focusSearchToken);
  const clearRequested = useClipboardStore((s) => s.clearRequested);
  const actions = useClipboardStore.getState();
  const openSettings = useShellStore((s) => s.openSettings);

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState<ClipItem | null>(null);
  const now = useNow();

  useEffect(() => attachClipboardView(), []);

  useEffect(() => {
    if (focusSearchToken > 0) searchRef.current?.focus();
  }, [focusSearchToken]);

  const visible = useMemo(() => visibleClips({ items, pendingDeletes }), [items, pendingDeletes]);
  const selected = useMemo(() => visible.find((item) => item.id === selectedId) ?? null, [visible, selectedId]);
  const filtered = query.trim() !== "" || kind !== "all" || pinnedOnly;
  const paused = !!stats?.paused;
  const disabled = settings ? !settings.enabled : stats ? !stats.enabled : false;

  const subtitle = useMemo(() => {
    const parts = [statsSummary(stats)];
    if (stats && stats.skipped_secrets > 0) {
      parts.push(`${stats.skipped_secrets} likely secret${stats.skipped_secrets === 1 ? "" : "s"} skipped`);
    }
    return parts.join(" · ");
  }, [stats]);

  const clearFilters = () => {
    actions.setQuery("");
    actions.setKind("all");
    actions.setPinnedOnly(false);
  };

  const selectAt = (index: number) => {
    const target = visible[Math.min(visible.length - 1, Math.max(0, index))];
    if (target) actions.select(target.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    // Portaled modals bubble through React; only handle keys from the view itself.
    if (!rootRef.current?.contains(target)) return;
    const inSearch = target === searchRef.current;
    const inList = target === listRef.current;
    if (isEditableTarget(target) && !inSearch) return;
    const onControl = !inSearch && !inList && target.closest("button, a, [role='radio'], [role='switch'], select") !== null;
    if (onControl) return;

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        actions.moveSelection(e.key === "ArrowDown" ? 1 : -1);
        return;
      case "PageDown":
      case "PageUp":
        if (inSearch) return;
        e.preventDefault();
        actions.moveSelection(e.key === "PageDown" ? PAGE_STEP : -PAGE_STEP);
        return;
      case "Enter":
        if (!selected) return;
        e.preventDefault();
        void actions.copy(selected.id);
        return;
      case "Escape":
        if (inSearch) {
          // Empty search: hand the keyboard to the list instead of blurring into nothing.
          if (!query) {
            e.preventDefault();
            listRef.current?.focus();
          }
          return;
        }
        if (query) {
          e.preventDefault();
          actions.setQuery("");
        }
        return;
    }
    if (inSearch) return;
    switch (e.key) {
      case "p":
      case "P":
        if (!selected) return;
        e.preventDefault();
        void actions.togglePin(selected.id);
        return;
      case "Backspace":
      case "Delete":
        if (!selected) return;
        e.preventDefault();
        actions.deleteWithUndo(selected.id);
        return;
      case "/":
        e.preventDefault();
        searchRef.current?.focus();
        return;
      case "Home":
        e.preventDefault();
        selectAt(0);
        return;
      case "End":
        e.preventDefault();
        selectAt(visible.length - 1);
        return;
    }
  };

  const togglePaused = () => void actions.setPaused(!paused);
  const enable = async () => {
    if (!settings) return;
    try {
      await actions.saveSettings({ ...settings, enabled: true });
    } catch {
      openSettings("clipboard");
    }
  };

  let body: JSX.Element;
  if (!loaded) {
    body = (
      <div className="view-loading">
        <Spinner size={14} /> Loading clipboard history…
      </div>
    );
  } else if (visible.length === 0) {
    body = filtered ? (
      <EmptyState
        icon={Search}
        title="No matching clips"
        description="Try another word, a different kind, or clear the filters."
        action={<Button onClick={clearFilters}>Clear filters</Button>}
      />
    ) : (
      <EmptyState
        icon={ClipboardList}
        title="Nothing copied yet"
        description="Copy text, links, code, colors or images anywhere on your Mac — they show up here. Passwords and API keys are skipped automatically."
      />
    );
  } else {
    body = (
      <div className="clip-split">
        <div className="clip-list-panel">
          <ClipList
            items={visible}
            selectedId={selectedId}
            now={now}
            hasMore={hasMore}
            loadingMore={loadingMore}
            listRef={listRef}
            onSelect={actions.select}
            onActivate={(id) => void actions.copy(id)}
            onTogglePin={(id) => void actions.togglePin(id)}
            onLoadMore={() => void actions.loadMore()}
          />
        </div>
        <ClipDetail
          item={selected}
          now={now}
          onCopy={(id) => void actions.copy(id)}
          onTogglePin={(id) => void actions.togglePin(id)}
          onDelete={actions.deleteWithUndo}
          onSaveAsNote={setSaving}
        />
      </div>
    );
  }

  return (
    <div className="view clipboard-view" ref={rootRef} onKeyDown={onKeyDown}>
      <ViewHeader
        title="Clipboard"
        subtitle={subtitle}
        actions={
          <>
            <Button
              size="sm"
              variant={paused ? "primary" : "secondary"}
              iconLeft={paused ? <Play size={14} /> : <Pause size={14} />}
              aria-pressed={paused}
              disabled={!stats || disabled}
              onClick={togglePaused}
            >
              {paused ? "Resume capture" : "Pause capture"}
            </Button>
            <IconButton label="Clipboard settings" icon={<Settings2 size={16} />} onClick={() => openSettings("clipboard")} />
          </>
        }
        tabs={
          <div className="clip-toolbar">
            <SearchField
              ref={searchRef}
              className="clip-search"
              size="sm"
              value={query}
              onChange={actions.setQuery}
              placeholder="Search clips…"
              shortcutHint="/"
              aria-label="Search clipboard history"
            />
            <SegmentedControl<ClipKindFilter>
              aria-label="Filter by kind"
              className="clip-kind-filter"
              size="sm"
              value={kind}
              onChange={actions.setKind}
              options={KIND_FILTERS.map((f) => ({ value: f.value, label: f.label, icon: FILTER_ICONS[f.value], "aria-label": f.label }))}
            />
            <Button
              size="sm"
              variant="ghost"
              className={cx("clip-filter-toggle", pinnedOnly && "is-active")}
              iconLeft={<Pin size={13} />}
              aria-pressed={pinnedOnly}
              onClick={() => actions.setPinnedOnly(!pinnedOnly)}
            >
              Pinned
            </Button>
          </div>
        }
      />
      <div className="view-body clipboard-body">
        {disabled ? (
          <div className="ui-notice ui-notice-warning clip-notice" role="status">
            <Pause size={14} />
            <span className="clip-notice-text">Clipboard history is turned off — nothing you copy is recorded.</span>
            <Button size="sm" onClick={() => void enable()}>
              Turn on
            </Button>
          </div>
        ) : paused ? (
          <div className="ui-notice ui-notice-warning clip-notice" role="status">
            <Pause size={14} />
            <span className="clip-notice-text">Capture is paused. Copies you make now are not recorded.</span>
            <Button size="sm" onClick={togglePaused}>
              Resume
            </Button>
          </div>
        ) : null}
        {stats?.watcher_error && (
          <div className="ui-notice ui-notice-danger clip-notice" role="alert">
            <TriangleAlert size={14} />
            <span className="clip-notice-text">Can't read the system clipboard: {stats.watcher_error}</span>
          </div>
        )}
        {error && (
          <div className="ui-notice ui-notice-danger clip-notice" role="alert">
            <TriangleAlert size={14} />
            <span className="clip-notice-text">{error}</span>
            <Button size="sm" onClick={() => void actions.refresh()}>
              Retry
            </Button>
          </div>
        )}
        {body}
      </div>
      <SaveAsNoteModal item={saving} onClose={() => setSaving(null)} />
      <ClearHistoryModal open={clearRequested} onClose={() => actions.requestClear(false)} />
    </div>
  );
}
