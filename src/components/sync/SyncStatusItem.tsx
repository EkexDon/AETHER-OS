import { useEffect } from "react";
import { Cloud, CloudAlert, CloudOff, Lock, TriangleAlert } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { retainSyncEvents, useSyncStore } from "../../lib/syncStore";
import { progressPercent, relativeTime, statusSummary } from "../../lib/sync/format";
import { Spinner, Tooltip } from "../../ui";
import { SetupWizard } from "./SetupWizard";
import { UnlockModal } from "./UnlockModal";

/** Short status-bar label for the current state. */
export function statusItemLabel(status: ReturnType<typeof useSyncStore.getState>["status"]): string {
  if (!status) return "Sync";
  if (status.state === "syncing") {
    const pct = progressPercent(status.progress);
    return pct === null ? "Syncing…" : `Syncing ${pct}%`;
  }
  if (!status.configured || !status.enabled) return "Sync off";
  if (status.state === "locked") return "Locked";
  if (status.state === "error") return "Sync error";
  if (status.conflicts > 0) return `${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`;
  return "Synced";
}

/**
 * Status bar item: sync state icon (idle / syncing / error / locked) with a
 * tooltip; click opens the Sync & Backup view. It also hosts the global
 * unlock and setup dialogs and asks for the passphrase once at start-up when
 * sync is on but locked.
 */
export function SyncStatusItem() {
  const status = useSyncStore((s) => s.status);
  const progress = useSyncStore((s) => s.progress);
  const prompted = useSyncStore((s) => s.prompted);
  const setView = useAetherStore((s) => s.setView);

  useEffect(() => {
    const release = retainSyncEvents();
    useSyncStore
      .getState()
      .refresh()
      .catch(() => undefined); // Background refresh: the view reports errors.
    return release;
  }, []);

  // Default is "prompt at app start": ask once per session.
  useEffect(() => {
    if (!status || prompted) return;
    if (status.enabled && status.configured && !status.unlocked) {
      useSyncStore.getState().openUnlock();
    }
    useSyncStore.getState().markPrompted();
  }, [status, prompted]);

  const summary = statusSummary(status ? { ...status, progress: progress ?? status.progress } : null);
  const label = statusItemLabel(status ? { ...status, progress: progress ?? status.progress } : null);
  const off = !status || !status.configured || !status.enabled;
  const icon =
    status?.state === "syncing" ? (
      <Spinner size={14} />
    ) : off ? (
      <CloudOff size={14} />
    ) : status.state === "locked" ? (
      <Lock size={14} />
    ) : status.state === "error" ? (
      <CloudAlert size={14} />
    ) : status.conflicts > 0 ? (
      <TriangleAlert size={14} />
    ) : (
      <Cloud size={14} />
    );
  const tooltip =
    status && status.configured && status.last_sync_at && status.state !== "syncing"
      ? `${summary.detail} Last sync ${relativeTime(status.last_sync_at)}.`
      : summary.detail;

  return (
    <>
      <Tooltip content={tooltip} shortcut="mod+alt+y" placement="top">
        <button
          type="button"
          className={`statusbar-item sync-statusbar is-${summary.tone}`}
          onClick={() => setView("sync")}
          aria-label={`Sync & Backup: ${label}`}
          aria-busy={status?.state === "syncing" || undefined}
        >
          {icon}
          <span className="statusbar-muted tabular">{label}</span>
        </button>
      </Tooltip>
      <UnlockModal />
      <SetupWizard />
    </>
  );
}
