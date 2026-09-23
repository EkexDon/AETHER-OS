import { useEffect, useState } from "react";
import { Camera, CodeXml, History } from "lucide-react";
import { SettingsGroup, SettingsPage, SettingsRow } from "../../settings/layout";
import { countLabel, formatDateTime, relativeTime } from "../../lib/history/format";
import { useHistoryStore } from "../../lib/historyStore";
import { isDirty, useIdeStore } from "../../lib/ideStore";
import { useAetherStore } from "../../lib/store";
import { useShellStore } from "../../shell/shellStore";
import { Badge, Button, Switch, useToast } from "../../ui";
import { useNow } from "./hooks";
import "../../styles/views/history.css";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Point the IDE at the vault repository (so its Source Control panel shows
 * the history commits). Refuses while IDE tabs have unsaved changes.
 * Returns an error message, or `null` on success.
 */
export function openVaultRepoInIde(vaultPath: string): string | null {
  const ide = useIdeStore.getState();
  if (ide.rootPath !== vaultPath) {
    if (ide.tabs.some(isDirty)) return "Save or close the files open in the IDE first.";
    ide.closeAll();
    ide.setRoot(vaultPath);
  }
  useShellStore.getState().closeSettings();
  useAetherStore.getState().setView("ide");
  return null;
}

/** Settings → History: automatic versioning, repository facts, snapshot. */
export function HistorySettings() {
  const toast = useToast();
  const status = useHistoryStore((s) => s.status);
  const statusError = useHistoryStore((s) => s.statusError);
  const refreshStatus = useHistoryStore((s) => s.refreshStatus);
  const setEnabled = useHistoryStore((s) => s.setEnabled);
  const snapshotNow = useHistoryStore((s) => s.snapshotNow);
  const [toggling, setToggling] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const now = useNow();

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const toggle = async (next: boolean) => {
    setToggling(true);
    try {
      await setEnabled(next);
      toast.success(next ? "Automatic versioning is on" : "Automatic versioning is off");
    } catch (e) {
      toast.error("Could not change note history", { description: message(e) });
    } finally {
      setToggling(false);
    }
  };

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

  const openInIde = () => {
    if (!status?.vault_path) return;
    const error = openVaultRepoInIde(status.vault_path);
    if (error) toast.error("Cannot open the vault in the IDE", { description: error });
  };

  const enabled = status?.enabled ?? true;
  const hasVault = !!status?.vault_path;

  return (
    <SettingsPage
      title="History"
      description="Every note save is committed to a local Git repository inside your vault, so you can browse, compare and restore any version. Nothing leaves this machine."
    >
      {statusError && (
        <div className="ui-notice ui-notice-danger" role="alert">
          {statusError}
        </div>
      )}
      {status?.last_error && (
        <div className="ui-notice ui-notice-warning" role="status">
          {status.last_error}
        </div>
      )}

      <SettingsGroup title="Automatic versioning">
        <SettingsRow
          label="Version notes automatically"
          hint="A snapshot is taken 2 seconds after a note is saved, plus a safety scan every 30 seconds. Markdown notes and attachments up to 25 MB are versioned; hidden folders are skipped."
          control={
            <Switch
              checked={enabled}
              disabled={toggling || !status}
              onChange={(next) => void toggle(next)}
              aria-label="Version notes automatically"
            />
          }
        />
        <SettingsRow
          label="Snapshot now"
          hint="Commit every pending change immediately (⌥⌘S)."
          control={
            <Button
              size="sm"
              iconLeft={<Camera size={14} />}
              loading={snapshotting}
              disabled={!enabled || !hasVault}
              onClick={() => void snapshot()}
            >
              Snapshot now
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Repository">
        <SettingsRow
          label="Location"
          hint={
            status?.repo_path ? (
              <span className="mono history-settings-path">{status.repo_path}</span>
            ) : hasVault ? (
              enabled ? "Created with the first snapshot." : "No history repository yet."
            ) : (
              "Connect a vault first."
            )
          }
          control={
            <Button size="sm" iconLeft={<CodeXml size={14} />} disabled={!status?.repo_path} onClick={openInIde}>
              Open in IDE
            </Button>
          }
        />
        <SettingsRow
          label="Versions"
          hint={status?.branch ? `On branch ${status.branch}` : undefined}
          control={<span className="tabular history-settings-value">{status ? status.commit_count.toLocaleString() : "—"}</span>}
        />
        <SettingsRow
          label="Last snapshot"
          control={
            <span className="history-settings-value" title={status?.last_commit_at ? formatDateTime(status.last_commit_at) : undefined}>
              {status?.last_commit_at ? relativeTime(status.last_commit_at, now) : "Never"}
            </span>
          }
        />
        <SettingsRow
          label="File watcher"
          hint="Watches the vault folder for saved notes."
          control={
            status?.watching ? (
              <Badge variant="success" dot>
                Watching
              </Badge>
            ) : (
              <Badge variant="neutral" dot>
                {enabled ? "Idle" : "Off"}
              </Badge>
            )
          }
        />
        <SettingsRow
          label="Browse versions"
          hint="Timeline, per-note versions, diffs and restore (⇧⌘H for the current note)."
          control={
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<History size={14} />}
              onClick={() => {
                useShellStore.getState().closeSettings();
                useAetherStore.getState().setView("history");
              }}
            >
              Open History
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
