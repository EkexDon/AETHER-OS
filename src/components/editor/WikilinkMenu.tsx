/**
 * The popup of the `[[` autocomplete in the note editor. Rows are vault
 * notes (fuzzy-ranked by `wikilinkSuggestions`) plus "Create note …";
 * ↑/↓ move, Enter or Tab insert, Esc closes (handled by the suggestion
 * plugin). The editor keeps focus the whole time: rows never take it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import { FilePlus, FileText } from "lucide-react";
import { Kbd, ListRow } from "../../ui";
import { moveIndex, splitLinkQuery, type WikilinkSuggestionItem } from "../../lib/editor/wikilinkSuggest";
import type { WikilinkSuggestionOptions } from "../../lib/editor/wikilinkSuggest";

export interface WikilinkMenuProps {
  items: WikilinkSuggestionItem[];
  query: string;
  command: (item: WikilinkSuggestionItem) => void;
}

export interface WikilinkMenuHandle {
  /** Handle a key while the menu is open; `true` when it was used. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** `name` with the part that matches `query` emphasised. */
function highlight(name: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return name;
  const at = name.toLowerCase().indexOf(q);
  if (at !== -1) {
    return (
      <>
        {name.slice(0, at)}
        <mark className="wikilink-menu-match">{name.slice(at, at + q.length)}</mark>
        {name.slice(at + q.length)}
      </>
    );
  }
  return name;
}

export const WikilinkMenu = forwardRef<WikilinkMenuHandle, WikilinkMenuProps>(function WikilinkMenu({ items, query, command }, ref) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { name } = splitLinkQuery(query);

  useEffect(() => setActive(0), [items]);

  // Keep the active row visible by scrolling the list only (never the page behind it).
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [active]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (items.length === 0) return false;
          setActive((i) => moveIndex(i, event.key === "ArrowDown" ? 1 : -1, items.length));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[active] ?? items[0];
          if (!item) return false;
          command(item);
          return true;
        }
        return false;
      },
    }),
    [items, active, command]
  );

  return (
    <div className="wikilink-menu" role="listbox" aria-label="Link to note" ref={listRef}>
      {items.length === 0 ? (
        <div className="wikilink-menu-empty">{name.trim() ? "No matching notes" : "Type a note name"}</div>
      ) : (
        items.map((item, i) => (
          <ListRow
            key={item.kind === "create" ? "__create" : item.path}
            role="option"
            aria-selected={i === active}
            data-index={i}
            selected={i === active}
            className={item.kind === "create" ? "wikilink-menu-create" : undefined}
            icon={item.kind === "create" ? <FilePlus size={14} /> : <FileText size={14} />}
            title={item.kind === "create" ? <>Create note “{item.name}”</> : highlight(item.name, name)}
            meta={item.kind === "note" && item.folder ? <span className="wikilink-menu-folder">{item.folder}</span> : undefined}
            onMouseDown={(event) => event.preventDefault()}
            // Only a real pointer move selects: a popup appearing under a resting pointer must not.
            onMouseMove={(event) => {
              if ((event.movementX || event.movementY) && i !== active) setActive(i);
            }}
            onClick={() => command(item)}
          />
        ))
      )}
      <div className="wikilink-menu-hint" aria-hidden="true">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> select
        </span>
        <span>
          <Kbd>↵</Kbd> insert
        </span>
        <span>
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </div>
  );
});

type MenuProps = SuggestionProps<WikilinkSuggestionItem, WikilinkSuggestionItem>;

function menuProps(props: MenuProps): WikilinkMenuProps {
  return { items: props.items, query: props.query, command: (item) => props.command(item) };
}

/** Suggestion renderer that shows {@link WikilinkMenu} at the caret. */
export function createWikilinkMenuRenderer(): NonNullable<WikilinkSuggestionOptions["render"]> {
  return () => {
    let renderer: ReactRenderer<WikilinkMenuHandle, WikilinkMenuProps> | null = null;
    let unmount: (() => void) | null = null;
    return {
      onStart: (props) => {
        renderer = new ReactRenderer(WikilinkMenu, { props: menuProps(props), editor: props.editor, className: "wikilink-menu-layer" });
        unmount = props.mount(renderer.element as HTMLElement);
      },
      onUpdate: (props) => {
        renderer?.updateProps(menuProps(props));
      },
      onKeyDown: ({ event }) => renderer?.ref?.onKeyDown(event) ?? false,
      onExit: () => {
        unmount?.();
        unmount = null;
        renderer?.destroy();
        renderer = null;
      },
    };
  };
}
