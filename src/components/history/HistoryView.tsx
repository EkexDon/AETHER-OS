import { useEffect, useRef, useState } from "react";
import { Camera, Columns2, FolderOpen, History, NotebookPen, Settings2 } from "lucide-react";
import { countLabel, relativeTime } from "../../lib/history/format";
import { initHistorySync, useHistoryStore } from "../../lib/historyStore";
import { useAetherStore } from "../../lib/store";
import { useShellStore } from "../../shell/shellStore";
import { Button, EmptyState, IconButton, SegmentedControl, ViewHeader, cx, useToast } from "../../ui";
import { ActivityTimeline } from "./ActivityTimeline";
import { NoteHistoryPanel } from "./NoteHistoryPanel";
import { NotePicker } from "./NotePicker";
import { useElementWidth, useNow } from "./hooks";

/** Three columns at or above this body width, two columns above `MEDIUM`. */
const WIDE = 980;
const MEDIUM = 640;

type Pane = "activity" | "versions" | "changes";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Layout tier for a measured width (`null` = not measured yet → wide). */
export function historyLayoutMode(width: number | null): "wide" | "medium" | "narrow" {
  if (width === null || width >= WIDE) return "wide";
  return width >= MEDIUM ? "medium" : "narrow";
}

/**
 * The History view: vault activity timeline, versions of the selected note
 * and the diff of the selected version with restore. Collapses to two
 * columns (activity/versions switch + diff) and one column on narrow widths.
 */
export function HistoryView() {
  const toast = useToast();
  const status = useHistoryStore((s) => s.status);
  const selectedPath = useHistoryStore((s) => s.selectedPath);
  const selectNote = useHistoryStore((s) => s.selectNote);
  const snapshotNow = useHistoryStore((s) => s.snapshotNow);
  const setEnabled = useHistoryStore((s) => s.setEnabled);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const now = useNow();
  const layoutRef = useRef<HTMLDivElement>(null);
  const mode = historyLayoutMode(useElementWidth(layoutRef));
  const [pane, setPane] = useState<Pane>("versions");
  const [snapshotting, setSnapshotting] = useState(false);

  useEffect(() => initHistorySync(), []);

  // Start with the note that is open in the editor.
  useEffect(() => {
    const current = useAetherStore.getState().selectedNotePath;
    if (!useHistoryStore.getState().selectedPath && current) selectNote(current);
  }, [selectNote]);

  // The medium layout always shows the diff, so "changes" means "versions" there.
  useEffect(() => {
    if (mode === "medium" && pane === "changes") setPane("versions");
  }, [mode, pane]);

  const snapshot = async () => {
    setSnapshotting(true);
    try {
      const activity = await snapshotNow(null);
      if (activity) toast.success("Snapshot saved", { description: `${countLabel(activity.file_count, "file")} saved.` });
      else toast.info("Nothing to snapshot", { description: "Every note is already saved in history." });
    } catch (e) {
      toast.error("Snapshot failed", { description: message(e) });
    } finally {
      setSnapshotting(false);
    }
  };

  const enable = async () => {
    try {
      await setEnabled(true);
      toast.success("Automatic versioning is on");
    } catch (e) {
      toast.error("Could not turn on note history", { description: message(e) });
    }
  };

  const openNote = (path: string) => {
    const app = useAetherStore.getState();
    app.selectNote(path);
    app.setView("editor");
  };

  const pickFromTimeline = (path: string, commitId: string) => {
    selectNote(path, commitId);
    if (mode === "narrow") setPane("changes");
    else if (mode === "medium") setPane("versions");
  };

  const pickNote = (path: string) => {
    selectNote(path);
    if (mode !== "wide") setPane("versions");
  };

  const subtitle = !status
    ? "Every save of every note, restorable"
    : !status.enabled
      ? "Automatic versioning is off"
      : status.last_commit_at
        ? `${countLabel(status.commit_count, "version")} · last snapshot ${relativeTime(status.last_commit_at, now)}${status.watching ? " · watching the vault" : ""}`
        : "No snapshots yet";

  const connected = !!(vaultPath ?? status?.vault_path);

  const showActivity = mode === "wide" || pane === "activity";
  const panelShow: "both" | "versions" | "diff" =
    mode === "wide" ? "both" : mode === "medium" ? (pane === "activity" ? "diff" : "both") : pane === "changes" ? "diff" : "versions";
  const showPanel = mode !== "narrow" || pane !== "activity";

  const paneOptions =
    mode === "narrow"
      ? [
          { value: "activity" as const, label: "Activity" },
          { value: "versions" as const, label: "Versions" },
          { value: "changes" as const, label: "Changes" },
        ]
      : [
          { value: "activity" as const, label: "Activity" },
          { value: "versions" as const, label: "Versions" },
        ];

  const picker = <NotePicker onPick={pickNote} />;

  return (
    <div className="view history-view">
      <ViewHeader
        title="History"
        subtitle={subtitle}
        bordered
        actions={
          <>
            <Button
              size="sm"
              iconLeft={<Camera size={14} />}
              loading={snapshotting}
              disabled={!connected || !(status?.enabled ?? true)}
              onClick={() => void snapshot()}
              title="Snapshot now (⌥⌘S)"
            >
              Snapshot now
            </Button>
            <IconButton
              label="History settings"
              icon={<Settings2 size={16} />}
              onClick={() => useShellStore.getState().openSettings("history")}
            />
          </>
        }
      />
      <div className="view-body is-flush history-view-body">
        {!connected ? (
          <EmptyState
            icon={FolderOpen}
            title="No vault connected"
            description="Note history versions the Markdown vault. Choose your vault folder to start."
            action={
              <Button variant="primary" onClick={() => useShellStore.getState().openSettings("vault")}>
                Choose vault
              </Button>
            }
          />
        ) : (
          <>
            {status && !status.enabled && (
              <div className="ui-notice ui-notice-warning history-banner" role="status">
                <span>Automatic versioning is off. Existing versions stay browsable, new saves are not recorded.</span>
                <Button size="sm" onClick={() => void enable()}>
                  Turn on
                </Button>
              </div>
            )}
            {status?.enabled && status.last_error && (
              <div className="ui-notice ui-notice-danger history-banner" role="alert">
                <span>{status.last_error}</span>
              </div>
            )}
            <div ref={layoutRef} className={cx("history-layout", `is-${mode}`)}>
              {mode !== "wide" && (
                <div className="history-pane-switch">
                  <SegmentedControl<Pane>
                    size="sm"
                    aria-label="History panes"
                    value={mode === "medium" && pane === "changes" ? "versions" : pane}
                    onChange={setPane}
                    options={paneOptions}
                  />
                </div>
              )}
              {showActivity && <ActivityTimeline selectedPath={selectedPath} onPick={pickFromTimeline} />}
              {showPanel &&
                (selectedPath ? (
                  <NoteHistoryPanel
                    path={selectedPath}
                    variant="columns"
                    show={panelShow}
                    versionsHeader={picker}
                    onOpenNote={openNote}
                    onVersionSelected={() => {
                      if (mode === "narrow") setPane("changes");
                    }}
                  />
                ) : (
                  <div className="history-panel is-columns">
                    {panelShow !== "diff" && (
                      <section className="history-pane history-versions" aria-label="Versions">
                        {picker}
                        <div className="history-pane-scroll">
                          <EmptyState
                            size="sm"
                            icon={NotebookPen}
                            title="Pick a note"
                            description="Search above, or choose a snapshot in the activity timeline."
                          />
                        </div>
                      </section>
                    )}
                    {panelShow !== "versions" && (
                      <section className="history-pane history-diffpane" aria-label="Changes">
                        <div className="history-pane-scroll">
                          <EmptyState
                            size="sm"
                            icon={Columns2}
                            title="Nothing to compare yet"
                            description="The changes of the selected version appear here."
                          />
                        </div>
                      </section>
                    )}
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
