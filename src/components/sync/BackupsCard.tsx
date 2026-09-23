import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, FileArchive, RefreshCw, ShieldCheck } from "lucide-react";
import { useSyncStore } from "../../lib/syncStore";
import { absoluteTime, errorText, formatBytes, relativeTime } from "../../lib/sync/format";
import { pickBackupFile } from "../../lib/sync/pickFolder";
import { Badge, Button, Checkbox, EmptyState, IconButton, ListRow, Spinner, Tooltip, useToast } from "../../ui";
import { FolderField } from "./fields";
import { RestoreWizard } from "./RestoreWizard";
import { VerifyBackupModal } from "./VerifyBackupModal";

/** Create, list, verify and restore encrypted backups. */
export function BackupsCard() {
  const status = useSyncStore((s) => s.status);
  const settings = useSyncStore((s) => s.settings);
  const backupsDir = useSyncStore((s) => s.backupsDir);
  const backups = useSyncStore((s) => s.backups);
  const loading = useSyncStore((s) => s.backupsLoading);
  const loadBackups = useSyncStore((s) => s.loadBackups);
  const createBackup = useSyncStore((s) => s.createBackup);
  const openUnlock = useSyncStore((s) => s.openUnlock);
  const toast = useToast();

  const [dir, setDir] = useState(backupsDir ?? settings?.backup_dir ?? "");
  const [includeAppData, setIncludeAppData] = useState(settings?.backup_include_app_data ?? true);
  const [creating, setCreating] = useState(false);
  const [verifyPath, setVerifyPath] = useState<string | null>(null);
  const [restorePath, setRestorePath] = useState<string | null>(null);

  const effectiveDir = backupsDir ?? settings?.backup_dir ?? null;

  useEffect(() => {
    if (effectiveDir) {
      setDir(effectiveDir);
      loadBackups(effectiveDir).catch((e) => toast.error("Could not list backups", { description: errorText(e) }));
    }
    // Load once per folder.
  }, [effectiveDir]);

  const list = async (path: string) => {
    try {
      await loadBackups(path);
    } catch (e) {
      toast.error("Could not list backups", { description: errorText(e) });
    }
  };

  const create = async () => {
    if (!status?.unlocked) {
      openUnlock();
      return;
    }
    const target = dir.trim();
    if (!target) {
      toast.info("Choose a folder first", { description: "Backups are written as .aetherbak files into it." });
      return;
    }
    setCreating(true);
    try {
      if (target !== backupsDir) await loadBackups(target).catch(() => undefined);
      const report = await createBackup(target, includeAppData);
      toast.success("Backup created", {
        description: `${report.file_name} · ${report.files.toLocaleString("en-US")} files · ${formatBytes(report.archive_bytes)}`,
      });
    } catch (e) {
      toast.error("Backup failed", { description: errorText(e) });
    } finally {
      setCreating(false);
    }
  };

  const restoreFromFile = async () => {
    const file = await pickBackupFile(dir || null).catch(() => null);
    if (file) setRestorePath(file);
  };

  return (
    <section className="sync-card" aria-labelledby="sync-backups-title">
      <header className="sync-card-header">
        <div>
          <h2 className="sync-card-title" id="sync-backups-title">
            Backups
          </h2>
          <p className="sync-card-subtitle">One-click encrypted snapshots you can verify and restore anywhere.</p>
        </div>
        <div className="sync-card-actions">
          <Button variant="ghost" size="sm" iconLeft={<ArchiveRestore size={14} />} onClick={() => void restoreFromFile()}>
            Restore from file…
          </Button>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Archive size={14} />}
            onClick={() => void create()}
            loading={creating}
          >
            {status?.unlocked ? "Back up now" : "Unlock to back up"}
          </Button>
        </div>
      </header>

      <label className="ui-field-label" htmlFor="sync-backups-dir">
        Backup folder — listed below, “Back up now” writes here
      </label>
      <div className="sync-backup-controls">
        <FolderField
          id="sync-backups-dir"
          value={dir}
          onChange={setDir}
          purpose="backup"
          dialogTitle="Choose a backup folder"
          placeholder="Folder for .aetherbak files"
          onPicked={(p) => void list(p)}
        />
        <IconButton
          label="Refresh backup list"
          icon={<RefreshCw size={14} />}
          onClick={() => dir.trim() && void list(dir.trim())}
          disabled={!dir.trim()}
        />
      </div>
      <Checkbox
        checked={includeAppData}
        onChange={setIncludeAppData}
        label="Include app data"
        description="Memory, calendar, tasks and AETHER notes."
      />

      {loading && backups.length === 0 ? (
        <div className="sync-inline-loading">
          <Spinner size={14} /> <span>Reading backups…</span>
        </div>
      ) : !backupsDir ? (
        <EmptyState
          size="sm"
          icon={FileArchive}
          title="No backup folder chosen"
          description="Pick a folder — an external drive works well — to create and list backups."
        />
      ) : backups.length === 0 ? (
        <EmptyState
          size="sm"
          icon={FileArchive}
          title="No backups in this folder"
          description="Create the first one with “Back up now”."
        />
      ) : (
        <div className="sync-backup-list" role="list" aria-label="Backups">
          {backups.map((b) => (
            <ListRow
              key={b.path}
              role="listitem"
              icon={<FileArchive size={14} />}
              title={
                b.error ? (
                  b.file_name
                ) : (
                  <Tooltip content={absoluteTime(b.created_at)} placement="top">
                    <span tabIndex={0}>{relativeTime(b.created_at)}</span>
                  </Tooltip>
                )
              }
              description={
                b.error
                  ? b.error
                  : `${b.files.toLocaleString("en-US")} files · ${formatBytes(b.archive_bytes)} · ${b.device_name}`
              }
              meta={
                <span className="sync-badges">
                  {b.error ? (
                    <Badge size="sm" variant="danger">
                      Unreadable
                    </Badge>
                  ) : (
                    <>
                      <Badge size="sm" variant={b.scheduled ? "neutral" : "accent"}>
                        {b.scheduled ? "Scheduled" : "Manual"}
                      </Badge>
                      {b.include_app_data && <Badge size="sm">App data</Badge>}
                    </>
                  )}
                </span>
              }
              actions={
                b.error ? undefined : (
                  <>
                    <IconButton size="sm" label="Verify backup" icon={<ShieldCheck size={14} />} onClick={() => setVerifyPath(b.path)} />
                    <IconButton size="sm" label="Restore backup" icon={<ArchiveRestore size={14} />} onClick={() => setRestorePath(b.path)} />
                  </>
                )
              }
            />
          ))}
        </div>
      )}

      <VerifyBackupModal path={verifyPath} onClose={() => setVerifyPath(null)} />
      <RestoreWizard path={restorePath} onClose={() => setRestorePath(null)} />
    </section>
  );
}
