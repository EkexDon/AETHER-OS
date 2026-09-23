import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Folder, Hash, Library } from "lucide-react";
import { Button, Checkbox, EmptyState, ListRow, SearchField, SegmentedControl, Spinner } from "../../ui";
import { exportListTags } from "../../lib/ipc";
import {
  emptyScope,
  filterNotes,
  folderList,
  relativeTo,
  SCOPE_KINDS,
  scopeKindsFor,
} from "../../lib/export/scope";
import type { ExportFlow, ExportScope, ExportScopeKind, TagCount, VaultNote } from "../../types";

/** Rows rendered at once in the note lists (search narrows the rest). */
const MAX_ROWS = 120;

export interface ScopePickerProps {
  flow: ExportFlow;
  scope: ExportScope;
  onChange: (scope: ExportScope) => void;
  notes: VaultNote[];
  vaultRoot: string | null;
  currentNote: string | null;
}

/** Choose what to export: a note, a folder, the vault, a tag or a selection. */
export function ScopePicker({ flow, scope, onChange, notes, vaultRoot, currentNote }: ScopePickerProps) {
  const kinds = scopeKindsFor(flow);
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);

  useEffect(() => {
    if (scope.kind !== "tag" || tags !== null) return;
    let alive = true;
    exportListTags()
      .then((t) => alive && setTags(t))
      .catch((e) => alive && setTagsError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [scope.kind, tags]);

  const rootRef = useRef<HTMLDivElement>(null);
  // Bring the pre-selected note or folder into view when the list appears.
  useEffect(() => {
    const selected = rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [scope.kind]);

  const matching = useMemo(() => filterNotes(notes, query, vaultRoot), [notes, query, vaultRoot]);
  const folders = useMemo(() => folderList(notes, vaultRoot), [notes, vaultRoot]);

  const setKind = (kind: ExportScopeKind) => {
    setQuery("");
    onChange(emptyScope(kind, currentNote));
  };

  return (
    <div className="export-scope" ref={rootRef}>
      {kinds.length > 1 && (
        <SegmentedControl
          aria-label="Export scope"
          size="sm"
          fullWidth
          value={scope.kind}
          onChange={setKind}
          options={SCOPE_KINDS.filter((k) => kinds.includes(k.kind)).map((k) => ({ value: k.kind, label: k.label }))}
        />
      )}

      {scope.kind === "note" && (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Find a note…" size="sm" aria-label="Find a note" />
          <div className="export-pick-list" role="listbox" aria-label="Notes">
            {matching.length === 0 ? (
              <EmptyState size="sm" icon={FileText} title="No matching notes" />
            ) : (
              matching.slice(0, MAX_ROWS).map((n) => (
                <ListRow
                  key={n.path}
                  role="option"
                  aria-selected={scope.value === n.path}
                  selected={scope.value === n.path}
                  icon={<FileText size={14} />}
                  title={n.name}
                  description={relativeTo(n.path, vaultRoot)}
                  onClick={() => onChange({ kind: "note", value: n.path })}
                />
              ))
            )}
          </div>
        </>
      )}

      {scope.kind === "folder" && (
        <div className="export-pick-list" role="listbox" aria-label="Folders">
          {folders.map((f) => (
            <ListRow
              key={f.path}
              role="option"
              aria-selected={scope.value === f.path}
              selected={scope.value === f.path}
              indent={f.depth}
              icon={<Folder size={14} />}
              title={f.rel ? f.name : `${f.name} (vault root)`}
              meta={<span className="tabular">{f.count}</span>}
              onClick={() => onChange({ kind: "folder", value: f.path })}
            />
          ))}
        </div>
      )}

      {scope.kind === "vault" && (
        <div className="export-scope-vault">
          <Library size={16} aria-hidden="true" />
          <span>
            Every note of the vault — <strong className="tabular">{notes.length}</strong> notes. Hidden folders such as{" "}
            <code>.obsidian</code> are skipped.
          </span>
        </div>
      )}

      {scope.kind === "tag" && (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Filter tags…" size="sm" aria-label="Filter tags" />
          <div className="export-pick-list" role="listbox" aria-label="Tags">
            {tagsError ? (
              <div className="ui-notice ui-notice-danger">{tagsError}</div>
            ) : tags === null ? (
              <div className="export-pick-loading">
                <Spinner size={14} label="Loading tags" />
              </div>
            ) : (
              (() => {
                const q = query.trim().replace(/^#/, "").toLowerCase();
                const visible = tags.filter((t) => t.tag.toLowerCase().includes(q));
                if (!visible.length) return <EmptyState size="sm" icon={Hash} title="No matching tags" />;
                return visible.slice(0, MAX_ROWS).map((t) => (
                  <ListRow
                    key={t.tag}
                    role="option"
                    aria-selected={scope.value.toLowerCase() === t.tag.toLowerCase()}
                    selected={scope.value.toLowerCase() === t.tag.toLowerCase()}
                    icon={<Hash size={14} />}
                    title={t.tag}
                    meta={<span className="tabular">{t.count}</span>}
                    onClick={() => onChange({ kind: "tag", value: t.tag })}
                  />
                ));
              })()
            )}
          </div>
        </>
      )}

      {scope.kind === "selection" && (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Find notes…" size="sm" aria-label="Find notes" />
          <div className="export-selection-bar">
            <span className="tabular">{scope.value.length} selected</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={matching.length === 0}
              onClick={() =>
                onChange({
                  kind: "selection",
                  value: [...new Set([...scope.value, ...matching.slice(0, MAX_ROWS).map((n) => n.path)])],
                })
              }
            >
              Select shown
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={scope.value.length === 0}
              onClick={() => onChange({ kind: "selection", value: [] })}
            >
              Clear
            </Button>
          </div>
          <div className="export-pick-list" aria-label="Notes to export">
            {matching.length === 0 ? (
              <EmptyState size="sm" icon={FileText} title="No matching notes" />
            ) : (
              matching.slice(0, MAX_ROWS).map((n) => {
                const checked = scope.value.includes(n.path);
                return (
                  <div key={n.path} className="export-check-row">
                    <Checkbox
                      checked={checked}
                      onChange={(v) =>
                        onChange({
                          kind: "selection",
                          value: v ? [...scope.value, n.path] : scope.value.filter((p) => p !== n.path),
                        })
                      }
                      label={n.name}
                      description={relativeTo(n.path, vaultRoot)}
                    />
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
