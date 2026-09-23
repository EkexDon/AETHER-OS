import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { onLauncherOpen } from "../../lib/ipc";
import { isCommandEnabled, useCommands } from "../../lib/commands/registry";
import { createCommandContext } from "../../lib/commands/context";
import { isMacPlatform } from "../../lib/shortcuts";
import { useSearchStore } from "../../lib/searchStore";
import { parseQuery, placeholderFor, QUERY_PREFIXES } from "../../lib/search/prefix";
import {
  bookmarkItems,
  clipItems,
  commandItems,
  FILES_FIRST_ORDER,
  flattenGroups,
  groupItems,
  helpItems,
  hitItems,
  recentItems,
  sectionJump,
  type LauncherItem,
} from "../../lib/search/launcherItems";
import { loadBookmarks, matchBookmarks } from "../../lib/search/sources";
import { editorLabel, openBookmark, openClip, openCommand, openHit } from "../../lib/search/actions";
import { Kbd, Modal, Spinner, cx } from "../../ui";
import { HighlightedSnippet, HighlightedText } from "../search/Highlighted";
import { LAUNCHER_PER_KIND, useLauncherSearch } from "./useLauncherSearch";

/** Props of {@link Launcher}: controlled by the shell (`launcherOpen` in the shell store). */
export interface LauncherProps {
  onClose: () => void;
  /** Render the palette (default `true`). When `false` only the global-shortcut listener is mounted. */
  open?: boolean;
}

/** Kinds whose rows show a second line with the matching snippet. */
const SNIPPET_KINDS = new Set(["note", "memory", "conversation", "event", "task"]);

/** Label of the Enter action for an item. */
export function primaryLabel(item: LauncherItem): string {
  const action = item.action;
  switch (action.type) {
    case "command":
      return "Run";
    case "bookmark":
      return "Open in browser";
    case "clip":
      return "Copy";
    case "prefix":
      return "Use prefix";
    case "hit":
      switch (action.hit.kind) {
        case "note":
          return "Open note";
        case "project":
        case "file":
          return "Open in IDE";
        case "app":
          return "Launch";
        case "event":
          return "Show day";
        case "task":
          return "Open task";
        case "memory":
          return "Open Memory";
        case "conversation":
          return "Open conversation";
      }
  }
}

/** Label of the `mod+Enter` action for an item, `null` when there is none. */
export function alternateLabel(item: LauncherItem, preferredEditor: string): string | null {
  const action = item.action;
  if (action.type === "clip") return "Open clipboard history";
  if (action.type !== "hit") return null;
  switch (action.hit.kind) {
    case "note":
      return "Open in IDE";
    case "project":
    case "file":
      return `Open in ${editorLabel(preferredEditor)}`;
    case "event":
      return "Show week";
    case "task":
      return "Show board";
    case "memory":
      return "Show in Search";
    case "conversation":
      return "Show transcript";
    default:
      return null;
  }
}

function emptyMessage(mode: ReturnType<typeof parseQuery>["mode"], text: string): { title: string; hint: string } {
  if (!text) {
    const prefix = QUERY_PREFIXES.find((p) => p.mode === mode);
    return { title: `Type to search ${prefix?.label.toLowerCase() ?? "everything"}`, hint: prefix?.description ?? "" };
  }
  return { title: `No results for “${text}”`, hint: "Type ? to see the search prefixes." };
}

/**
 * Quick Launcher (⌘K, system-wide ⌥Space). One input for commands, notes,
 * projects, files, apps, events, tasks, memory, conversations, bookmarks
 * and clipboard items, grouped by section. ↑/↓ move, Enter opens,
 * ⌘Enter opens in the alternate context, Tab / ⇧Tab jump between
 * sections, Escape clears the query and then closes.
 */
export function Launcher({ onClose, open = true }: LauncherProps) {
  // The system-wide shortcut arrives as an event even while the palette is closed.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onLauncherOpen(() => useSearchStore.getState().openLauncher("")).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!open) return null;
  return <LauncherPalette onClose={onClose} />;
}

function LauncherPalette({ onClose }: { onClose: () => void }) {
  const commands = useCommands();
  const preferredEditor = useAetherStore((s) => s.preferredEditor);
  const pendingQuery = useSearchStore((s) => s.pendingQuery);
  // Read (not consume) the pending query here: StrictMode runs initializers twice.
  const [query, setQueryState] = useState(() => useSearchStore.getState().pendingQuery ?? "");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // A new query always starts at the top of the list.
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setSelectedKey(null);
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Adopt a requested query ("Go to file", "Run a command", also while open).
  useEffect(() => {
    if (pendingQuery === null) return;
    setQuery(pendingQuery);
    useSearchStore.getState().clearPendingQuery();
    inputRef.current?.focus();
  }, [pendingQuery, setQuery]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const { hits, clips, recents, loading, error } = useLauncherSearch(parsed);
  const bookmarks = useMemo(() => loadBookmarks(), []);
  const frecencyById = useMemo(() => new Map(recents.map((r) => [r.id, r.frecency])), [recents]);

  const groups = useMemo(() => {
    const ctx = createCommandContext();
    const enabled = commands.filter((c) => isCommandEnabled(c, ctx));
    const text = parsed.text;
    if (parsed.mode === "help") return groupItems(helpItems(), {}, 10, { commands: "Search prefixes" });
    if (parsed.mode === "commands") {
      return groupItems(commandItems(enabled, text, frecencyById), { commands: 200 });
    }
    if (parsed.mode === "all" && !text) {
      return groupItems([...recentItems(recents, enabled), ...commandItems(enabled, "", frecencyById)], {
        recents: 8,
        commands: 200,
      });
    }
    const items: LauncherItem[] = [];
    if (parsed.includeCommands) items.push(...commandItems(enabled, text, frecencyById));
    items.push(...hitItems(hits, text));
    if (parsed.includeExtras) {
      items.push(...bookmarkItems(matchBookmarks(bookmarks, text), text));
      items.push(...clipItems(clips, text));
    }
    return groupItems(
      items,
      { commands: 6, bookmark: 4, clipboard: 4 },
      LAUNCHER_PER_KIND,
      {},
      parsed.mode === "files" ? FILES_FIRST_ORDER : undefined
    );
  }, [commands, parsed, hits, clips, recents, bookmarks, frecencyById]);

  const flat = useMemo(() => flattenGroups(groups), [groups]);
  const selectedIndex = Math.max(0, selectedKey === null ? 0 : flat.findIndex((i) => i.key === selectedKey));
  const selected = flat[selectedIndex];

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, groups]);

  const select = useCallback((index: number) => setSelectedKey(flat[index]?.key ?? null), [flat]);

  const run = useCallback(
    (item: LauncherItem, alternate: boolean) => {
      const action = item.action;
      if (action.type === "prefix") {
        setQuery(action.prefix);
        inputRef.current?.focus();
        return;
      }
      onClose();
      switch (action.type) {
        case "command":
          void openCommand(action.id, action.title);
          break;
        case "hit":
          void openHit(action.hit, { alternate }).catch(() => undefined);
          break;
        case "bookmark":
          void openBookmark(action.url, action.title);
          break;
        case "clip":
          void openClip(action.id, action.preview, { alternate });
          break;
      }
    },
    [onClose, setQuery]
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const mod = isMacPlatform() ? e.metaKey : e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (flat.length > 0) select((selectedIndex + 1) % flat.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (flat.length > 0) select((selectedIndex - 1 + flat.length) % flat.length);
        break;
      case "Enter":
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (selected) run(selected, mod);
        break;
      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        if (groups.length > 0) select(sectionJump(groups, selectedIndex, e.shiftKey ? -1 : 1));
        break;
      case "Escape":
        if (query) {
          e.preventDefault();
          e.stopPropagation();
          setQuery("");
        }
        break;
    }
  };

  const onRowClick = (item: LauncherItem, e: MouseEvent) => {
    run(item, isMacPlatform() ? e.metaKey : e.ctrlKey);
  };

  const alternate = selected ? alternateLabel(selected, preferredEditor) : null;
  const prefixMeta = QUERY_PREFIXES.find((p) => p.prefix === parsed.prefix && p.mode !== "help");
  const empty = flat.length === 0 ? emptyMessage(parsed.mode, parsed.text) : null;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      position="top"
      hideCloseButton
      flush
      aria-label="Launcher"
      className="launcher"
      initialFocusRef={inputRef as RefObject<HTMLElement>}
    >
      <div className="launcher-input-row">
        <span className="launcher-input-icon" aria-hidden="true">
          {loading ? <Spinner size={16} label="Searching" /> : <Search size={18} />}
        </span>
        {prefixMeta && <span className="launcher-prefix">{prefixMeta.label}</span>}
        <input
          ref={inputRef}
          type="text"
          className="launcher-input"
          placeholder={placeholderFor(parsed.mode)}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="launcher-results"
          aria-autocomplete="list"
          aria-activedescendant={selected ? `launcher-item-${selectedIndex}` : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        <Kbd>Esc</Kbd>
      </div>

      {error && (
        <div className="launcher-error ui-notice ui-notice-danger" role="alert">
          Search failed: {error}
        </div>
      )}

      <div className="launcher-results" id="launcher-results" role="listbox" aria-label="Results" ref={listRef}>
        {empty ? (
          <div className="launcher-empty">
            <p className="launcher-empty-title">{loading ? "Searching…" : empty.title}</p>
            {!loading && empty.hint && <p className="launcher-empty-hint">{empty.hint}</p>}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.section} role="group" aria-labelledby={`launcher-section-${group.section}`}>
              <div className="launcher-section" id={`launcher-section-${group.section}`}>
                {group.label}
              </div>
              {group.items.map((item, offset) => {
                const index = group.start + offset;
                const active = index === selectedIndex;
                const Icon = item.icon;
                const snippet =
                  item.snippetHtml && item.action.type === "hit" && SNIPPET_KINDS.has(item.action.hit.kind)
                    ? item.snippetHtml
                    : null;
                return (
                  <div
                    key={item.key}
                    id={`launcher-item-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={active}
                    className={cx("launcher-item", active && "is-active", snippet && "has-snippet")}
                    onMouseMove={() => {
                      if (!active) select(index);
                    }}
                    onClick={(e) => onRowClick(item, e)}
                  >
                    <span className="launcher-item-icon" aria-hidden="true">
                      <Icon size={16} />
                    </span>
                    <span className="launcher-item-main">
                      <span className="launcher-item-line">
                        <HighlightedText className="launcher-item-title" text={item.title} positions={item.titlePositions} />
                        {item.subtitle && <span className="launcher-item-subtitle">{item.subtitle}</span>}
                      </span>
                      {snippet && <HighlightedSnippet className="launcher-item-snippet" html={snippet} />}
                    </span>
                    <span className="launcher-item-meta">
                      {item.shortcut ? (
                        <Kbd shortcut={item.shortcut} />
                      ) : (
                        active && (
                          <span className="launcher-item-action">
                            {primaryLabel(item)}
                            <CornerDownLeft size={14} />
                          </span>
                        )
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="launcher-footer">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> Navigate
        </span>
        <span>
          <Kbd>↵</Kbd> {selected ? primaryLabel(selected) : "Open"}
        </span>
        {alternate && (
          <span>
            <Kbd shortcut="mod+enter" /> {alternate}
          </span>
        )}
        <span className="launcher-footer-spacer" />
        <span>
          <Kbd>Tab</Kbd> Sections
        </span>
        <span>
          <Kbd>?</Kbd> Prefixes
        </span>
      </div>
    </Modal>
  );
}
