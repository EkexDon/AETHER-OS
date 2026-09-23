import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { FileText } from "lucide-react";
import { matchNotes, noteFolder, relativeToVault } from "../../lib/history/format";
import { useAetherStore } from "../../lib/store";
import { SearchField, cx } from "../../ui";

export interface NotePickerProps {
  /** A note was chosen (absolute path). */
  onPick: (path: string) => void;
  autoFocus?: boolean;
}

/** Search field over the vault's notes; ↑/↓ to move, Enter to pick. */
export function NotePicker({ onPick, autoFocus }: NotePickerProps) {
  const notes = useAetherStore((s) => s.vaultNotes);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => matchNotes(notes, query), [notes, query]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onPick(path);
    setQuery("");
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    }
  };

  const open = query.trim().length > 0;
  return (
    <div className="history-picker">
      <SearchField
        size="sm"
        value={query}
        onChange={(value) => {
          setQuery(value);
          setActive(0);
        }}
        onSubmit={() => pick(results[active]?.path)}
        onKeyDown={onKeyDown}
        placeholder="Find a note…"
        aria-label="Find a note"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        autoFocus={autoFocus}
      />
      {open && (
        <ul id={listId} className="history-picker-results" role="listbox" aria-label="Matching notes">
          {results.length === 0 ? (
            <li className="history-picker-empty">No matching notes</li>
          ) : (
            results.map((note, i) => {
              const folder = noteFolder(relativeToVault(note.path, vaultPath) ?? note.path);
              return (
                <li
                  key={note.path}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={cx("history-picker-option", i === active && "is-active")}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(note.path)}
                >
                  <FileText size={14} aria-hidden="true" />
                  <span className="history-picker-name">{note.name}</span>
                  {folder && <span className="history-picker-folder">{folder}</span>}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
