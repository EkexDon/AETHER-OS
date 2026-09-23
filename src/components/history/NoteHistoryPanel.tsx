import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Camera,
  Columns2,
  FilePen,
  FilePlus2,
  FileText,
  Flag,
  History,
  RotateCcw,
  Rows2,
  Trash2,
} from "lucide-react";
import { historyDiff, historyList } from "../../lib/ipc";
import {
  commitKind,
  formatClock,
  formatDateTime,
  noteFolder,
  noteTitle,
  relativeTime,
  relativeToVault,
  versionLabel,
} from "../../lib/history/format";
import { useHistoryStore, type CompareMode, type DiffLayout } from "../../lib/historyStore";
import { useAetherStore } from "../../lib/store";
import type { FileDiff, NoteVersion } from "../../types";
import { Badge, Button, EmptyState, IconButton, ListRow, SegmentedControl, Spinner, cx, useToast } from "../../ui";
import { HistoryDiffView } from "./HistoryDiffView";
import { RestoreDialog } from "./RestoreDialog";
import { useNow } from "./hooks";

/** Versions loaded per note. */
const VERSION_LIMIT = 200;

export interface NoteHistoryPanelProps {
  /** Absolute note path (as in `VaultNote.path`). */
  path: string;
  /** `columns`: versions and diff side by side; `stacked`: versions above the diff. */
  variant?: "columns" | "stacked";
  /** Render only one half (narrow layouts); default both. */
  show?: "both" | "versions" | "diff";
  /** Extra content at the top of the versions column (note picker). */
  versionsHeader?: ReactNode;
  /** A version was picked by the user. */
  onVersionSelected?: (version: NoteVersion) => void;
  /** Show an "Open note" action. */
  onOpenNote?: (path: string) => void;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function VersionIcon({ version }: { version: NoteVersion }) {
  const kind = commitKind(version.message);
  if (kind === "restore") return <RotateCcw size={14} />;
  if (kind === "initial") return <Flag size={14} />;
  if (version.change === "added") return <FilePlus2 size={14} />;
  if (version.change === "deleted") return <Trash2 size={14} />;
  return <FilePen size={14} />;
}

/** "+12 −3" with success/danger tints. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="history-stat" aria-label={`${added} lines added, ${removed} lines removed`}>
      <span className="history-stat-add">+{added}</span>
      <span className="history-stat-remove">−{removed}</span>
    </span>
  );
}

/**
 * Versions of one note with a diff of the selected version and "Restore
 * this version". Used by the History view (columns) and the drawer over the
 * editor (stacked).
 */
export function NoteHistoryPanel({
  path,
  variant = "columns",
  show = "both",
  versionsHeader,
  onVersionSelected,
  onOpenNote,
}: NoteHistoryPanelProps) {
  const toast = useToast();
  const revision = useHistoryStore((s) => s.revision);
  const layout = useHistoryStore((s) => s.layout);
  const compare = useHistoryStore((s) => s.compare);
  const setLayout = useHistoryStore((s) => s.setLayout);
  const setCompare = useHistoryStore((s) => s.setCompare);
  const enabled = useHistoryStore((s) => s.status?.enabled ?? true);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const now = useNow();

  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const loadedPath = useRef<string | null>(null);
  /** Version to select after the next reload (the commit a restore created). */
  const pendingSelect = useRef<string | null>(null);
  /** Move focus to the selected row once it renders (after a restore). */
  const focusSelected = useRef(false);

  // Versions of the note; reloaded when the note changes or a commit lands.
  useEffect(() => {
    let cancelled = false;
    if (loadedPath.current !== path) {
      loadedPath.current = path;
      setVersions(null);
      setSelectedId(null);
      setDiff(null);
    }
    setLoadError(null);
    historyList(path, VERSION_LIMIT)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        const store = useHistoryStore.getState();
        const wanted = pendingSelect.current ?? store.requestedVersion;
        pendingSelect.current = null;
        if (store.requestedVersion) store.clearRequestedVersion();
        setSelectedId((prev) => {
          const match = wanted ? list.find((v) => v.id === wanted || v.id.startsWith(wanted)) : undefined;
          if (match) return match.id;
          if (prev && list.some((v) => v.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setVersions([]);
        setLoadError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, revision]);

  // A version requested while this note is already loaded (activity click).
  const requestedVersion = useHistoryStore((s) => s.requestedVersion);
  useEffect(() => {
    if (!requestedVersion || !versions) return;
    const match = versions.find((v) => v.id === requestedVersion || v.id.startsWith(requestedVersion));
    if (!match) return;
    setSelectedId(match.id);
    useHistoryStore.getState().clearRequestedVersion();
  }, [requestedVersion, versions]);

  const selected = versions?.find((v) => v.id === selectedId) ?? null;
  const latestId = versions?.[0]?.id ?? null;

  useEffect(() => {
    if (!focusSelected.current || !selectedId) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-version-id="${selectedId}"]`);
    if (!row) return;
    focusSelected.current = false;
    row.focus();
  }, [selectedId, versions]);

  // Diff of the selected version.
  useEffect(() => {
    if (!selectedId) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    const request =
      compare === "current" ? historyDiff(path, selectedId, null) : historyDiff(path, null, selectedId);
    request
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((e) => {
        if (!cancelled) {
          setDiff(null);
          setDiffError(message(e));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, selectedId, compare, revision]);

  const select = useCallback(
    (version: NoteVersion, focus = false) => {
      setSelectedId(version.id);
      onVersionSelected?.(version);
      if (focus) {
        requestAnimationFrame(() => {
          listRef.current?.querySelector<HTMLElement>(`[data-version-id="${version.id}"]`)?.focus();
        });
      }
    },
    [onVersionSelected]
  );

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!versions?.length) return;
    const index = Math.max(0, versions.findIndex((v) => v.id === selectedId));
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(versions.length - 1, index + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = versions.length - 1;
    if (next === null) return;
    e.preventDefault();
    select(versions[next], true);
  };

  const snapshot = async () => {
    setSnapshotting(true);
    try {
      const activity = await useHistoryStore.getState().snapshotNow(path);
      if (activity) toast.success("Snapshot saved", { description: `${noteTitle(path)} is in history.` });
      else toast.info("Nothing to snapshot", { description: "This note has no unsaved changes in history." });
    } catch (e) {
      toast.error("Snapshot failed", { description: message(e) });
    } finally {
      setSnapshotting(false);
    }
  };

  const confirmRestore = async () => {
    if (!selected) return;
    setRestoring(true);
    try {
      const result = await useHistoryStore.getState().restore(path, selected);
      if (result.commit_id) {
        pendingSelect.current = result.commit_id;
        focusSelected.current = true;
        toast.success("Note restored", {
          description: `${noteTitle(path)} is back to the version from ${formatDateTime(selected.time)}.`,
        });
      } else if (enabled) {
        toast.info("Nothing to restore", { description: "The note already has this content." });
      } else {
        toast.success("Note restored", { description: "Automatic versioning is off, so no new version was recorded." });
      }
      setConfirming(false);
    } catch (e) {
      toast.error("Restore failed", { description: message(e) });
    } finally {
      setRestoring(false);
    }
  };

  const rel = relativeToVault(path, vaultPath) ?? path;
  const folder = noteFolder(rel);
  const showVersions = show !== "diff";
  const showDiff = show !== "versions";
  const oldLabel = compare === "current" ? "This version" : "Previous version";
  const newLabel = compare === "current" ? "Current file" : "This version";

  let versionsBody: ReactNode;
  if (loadError) {
    versionsBody = (
      <div className="ui-notice ui-notice-danger history-inline-notice" role="alert">
        {loadError}
      </div>
    );
  } else if (versions === null) {
    versionsBody = (
      <div className="history-loading" role="status">
        <Spinner size={14} />
        <span>Loading versions…</span>
      </div>
    );
  } else if (versions.length === 0) {
    versionsBody = (
      <EmptyState
        size="sm"
        icon={History}
        title="No versions yet"
        description={
          enabled
            ? "Edits are saved here automatically a few seconds after each save."
            : "Automatic versioning is off. Turn it on in Settings → History."
        }
        action={
          enabled ? (
            <Button size="sm" iconLeft={<Camera size={14} />} loading={snapshotting} onClick={() => void snapshot()}>
              Snapshot now
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    versionsBody = (
      <div
        ref={listRef}
        className="history-version-list"
        role="listbox"
        aria-label={`Versions of ${noteTitle(path)}`}
        onKeyDown={onListKeyDown}
      >
        {versions.map((v) => {
          const isSelected = v.id === selectedId;
          return (
            <ListRow
              key={v.id}
              role="option"
              aria-selected={isSelected}
              tabIndex={isSelected || (!selectedId && v.id === latestId) ? 0 : -1}
              data-version-id={v.id}
              selected={isSelected}
              className={cx("history-version", v.change === "deleted" && "is-deleted")}
              icon={<VersionIcon version={v} />}
              title={
                <span className="history-version-title">
                  <span>{versionLabel(v)}</span>
                  {v.id === latestId && (
                    <Badge variant="accent" className="history-latest">
                      Latest
                    </Badge>
                  )}
                </span>
              }
              description={
                <span title={formatDateTime(v.time)}>
                  {relativeTime(v.time, now)} · {formatClock(v.time)}
                </span>
              }
              meta={<DiffStat added={v.summary_added} removed={v.summary_removed} />}
              onClick={() => select(v)}
            />
          );
        })}
      </div>
    );
  }

  let diffBody: ReactNode;
  if (!selected) {
    diffBody = (
      <EmptyState
        size="sm"
        icon={Columns2}
        title="No version selected"
        description="Pick a version to see what changed."
      />
    );
  } else if (diffError) {
    diffBody = (
      <div className="ui-notice ui-notice-danger history-inline-notice" role="alert">
        {diffError}
      </div>
    );
  } else if (!diff) {
    diffBody = (
      <div className="history-loading" role="status">
        <Spinner size={14} />
        <span>Loading changes…</span>
      </div>
    );
  } else {
    diffBody = (
      <div className={cx("history-diff-wrap", diffLoading && "is-stale")}>
        <HistoryDiffView diff={diff} layout={layout} oldLabel={oldLabel} newLabel={newLabel} />
      </div>
    );
  }

  const restoreDisabledReason = !selected
    ? "Pick a version first"
    : selected.change === "deleted"
      ? "This version deleted the note — pick an earlier one"
      : null;

  return (
    <div className={cx("history-panel", `is-${variant}`)}>
      {showVersions && (
        <section className="history-pane history-versions" aria-label="Versions">
          {versionsHeader}
          <div className="history-pane-head">
            <div className="history-pane-titles">
              <h2 className="history-pane-title" title={rel}>
                {variant === "stacked" ? "Versions" : noteTitle(path)}
              </h2>
              <p className="history-pane-subtitle">
                {folder || "Vault root"}
                {versions && versions.length > 0 && ` · ${versions.length} version${versions.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <div className="history-pane-actions">
              {onOpenNote && (
                <IconButton
                  size="sm"
                  label="Open note"
                  icon={<FileText size={14} />}
                  onClick={() => onOpenNote(path)}
                />
              )}
              <IconButton
                size="sm"
                label={enabled ? "Snapshot this note" : "Automatic versioning is off"}
                icon={<Camera size={14} />}
                loading={snapshotting}
                disabled={!enabled}
                onClick={() => void snapshot()}
              />
            </div>
          </div>
          <div className="history-pane-scroll">{versionsBody}</div>
        </section>
      )}
      {showDiff && (
        <section className="history-pane history-diffpane" aria-label="Changes">
          <div className="history-pane-head">
            <div className="history-pane-titles">
              <h2 className="history-pane-title">
                {compare === "current" ? "Changes since this version" : "Changes in this version"}
              </h2>
              <p className="history-pane-subtitle">
                {selected ? (
                  <>
                    {formatDateTime(selected.time)} · <span className="mono">{selected.short_id}</span>
                  </>
                ) : (
                  "No version selected"
                )}
                {diffLoading && diff && <Spinner size={14} label="Updating" />}
              </p>
            </div>
            <div className="history-pane-actions">
              <SegmentedControl<CompareMode>
                size="sm"
                aria-label="Compare with"
                value={compare}
                onChange={setCompare}
                options={[
                  { value: "previous", label: "Previous" },
                  { value: "current", label: "Current file" },
                ]}
              />
              <SegmentedControl<DiffLayout>
                size="sm"
                aria-label="Diff layout"
                value={layout}
                onChange={setLayout}
                options={[
                  { value: "unified", label: undefined, icon: <Rows2 size={14} />, "aria-label": "Unified" },
                  { value: "split", label: undefined, icon: <Columns2 size={14} />, "aria-label": "Side by side" },
                ]}
              />
            </div>
          </div>
          <div className="history-pane-scroll history-diff-scroll">{diffBody}</div>
          <div className="history-pane-foot">
            <span className="history-foot-hint">
              {restoreDisabledReason ??
                (selected?.id === latestId && compare === "previous"
                  ? "This is the newest version."
                  : "Restoring keeps the current text in history.")}
            </span>
            <Button
              variant="primary"
              size="sm"
              iconLeft={<RotateCcw size={14} />}
              disabled={!!restoreDisabledReason}
              title={restoreDisabledReason ?? undefined}
              onClick={() => setConfirming(true)}
            >
              Restore this version
            </Button>
          </div>
          <RestoreDialog
            open={confirming}
            path={path}
            version={selected}
            enabled={enabled}
            restoring={restoring}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void confirmRestore()}
          />
        </section>
      )}
    </div>
  );
}
