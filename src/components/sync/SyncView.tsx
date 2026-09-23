import { useEffect, useState } from "react";
import { FolderSync, Lock, RefreshCw, ShieldCheck } from "lucide-react";
import "../../styles/views/sync.css";
import { useAetherStore } from "../../lib/store";
import { retainSyncEvents, useSyncStore } from "../../lib/syncStore";
import { runSyncNow } from "../../lib/sync/commands";
import { errorText, statusSummary } from "../../lib/sync/format";
import { Button, IconButton, Spinner, Tooltip, ViewHeader, useToast } from "../../ui";
import { BackupsCard } from "./BackupsCard";
import { ConflictsCard } from "./ConflictsCard";
import { DevicesCard } from "./DevicesCard";
import { BackupScheduleControls, SyncScheduleControls } from "./ScheduleControls";
import { SecurityCard } from "./SecurityCard";
import { SyncStatusCard } from "./SyncStatusCard";

function ScheduleCard() {
  return (
    <section className="sync-card" aria-labelledby="sync-schedule-title">
      <header className="sync-card-header">
        <div>
          <h2 className="sync-card-title" id="sync-schedule-title">
            Schedule
          </h2>
          <p className="sync-card-subtitle">Background sync and automatic backups (overdue ones run at launch).</p>
        </div>
      </header>
      <SyncScheduleControls idPrefix="sync-view" />
      <div className="sync-divider" role="separator" />
      <BackupScheduleControls idPrefix="sync-view" />
    </section>
  );
}

/** The "Sync & Backup" view. */
export function SyncView() {
  const status = useSyncStore((s) => s.status);
  const loadError = useSyncStore((s) => s.loadError);
  const openSetup = useSyncStore((s) => s.openSetup);
  const lock = useSyncStore((s) => s.lock);
  const setView = useAetherStore((s) => s.setView);
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const release = retainSyncEvents();
    useSyncStore
      .getState()
      .refresh()
      .catch((e) => toast.error("Could not load sync status", { description: errorText(e) }));
    return release;
  }, [toast]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      await runSyncNow({ toast, setView });
    } finally {
      setSyncing(false);
    }
  };

  const doLock = async () => {
    try {
      await lock();
      toast.success("Sync locked", { description: "The key was removed from memory." });
    } catch (e) {
      toast.error("Could not lock sync", { description: errorText(e) });
    }
  };

  const summary = statusSummary(status);
  const busy = syncing || status?.state === "syncing";

  return (
    <div className="view sync-view">
      <ViewHeader
        title="Sync & Backup"
        icon={ShieldCheck}
        subtitle={status ? `${summary.label} · end-to-end encrypted, no account` : "End-to-end encrypted, no account"}
        actions={
          <>
            {status?.unlocked && (
              <IconButton label="Lock sync" shortcut="mod+alt+l" icon={<Lock size={16} />} onClick={() => void doLock()} />
            )}
            {status && !status.configured ? (
              <Button variant="primary" iconLeft={<FolderSync size={14} />} onClick={openSetup}>
                Set up sync
              </Button>
            ) : (
              <Tooltip content="Sync now" shortcut="mod+alt+y" placement="bottom">
                <Button
                  variant="primary"
                  iconLeft={<RefreshCw size={14} />}
                  onClick={() => void syncNow()}
                  loading={busy}
                  disabled={!status}
                >
                  {status?.unlocked ? "Sync now" : "Unlock & sync"}
                </Button>
              </Tooltip>
            )}
          </>
        }
      />
      <div className="view-body">
        {!status ? (
          loadError ? (
            <p className="ui-notice ui-notice-danger sync-notice" role="alert">
              {errorText(loadError)}
            </p>
          ) : (
            <div className="sync-inline-loading">
              <Spinner size={14} /> <span>Loading sync status…</span>
            </div>
          )
        ) : (
          <div className="sync-layout">
            <div className="sync-column-main">
              <SyncStatusCard />
              <ConflictsCard />
              <BackupsCard />
            </div>
            <aside className="sync-column-side" aria-label="Sync details">
              <DevicesCard />
              <ScheduleCard />
              <SecurityCard />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
