import { useState } from "react";
import type { SyncSettingsPatch } from "../../types";
import { useSyncStore } from "../../lib/syncStore";
import { errorText, intervalLabel } from "../../lib/sync/format";
import { Select, Switch, useToast } from "../../ui";
import { FolderField } from "./fields";

/** Choices for the background sync interval (seconds). */
export const INTERVAL_OPTIONS = [30, 60, 300, 900, 3600].map((s) => ({ value: String(s), label: intervalLabel(s) }));

/** Choices for scheduled backups (hours, 0 = off). */
export const BACKUP_EVERY_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "6", label: "Every 6 hours" },
  { value: "12", label: "Every 12 hours" },
  { value: "24", label: "Daily" },
  { value: "168", label: "Weekly" },
];

/** Choices for how many scheduled backups to keep. */
export const BACKUP_KEEP_OPTIONS = [3, 7, 14, 30, 90].map((n) => ({ value: String(n), label: `Keep ${n}` }));

/** Apply a settings patch with a toast on failure. Returns whether it worked. */
export function useSettingsPatch(): (patch: SyncSettingsPatch, success?: string) => Promise<boolean> {
  const update = useSyncStore((s) => s.updateSettings);
  const toast = useToast();
  return async (patch, success) => {
    try {
      await update(patch);
      if (success) toast.success(success);
      return true;
    } catch (e) {
      toast.error("Could not save the setting", { description: errorText(e) });
      return false;
    }
  };
}

/** Background interval + app-data switch. */
export function SyncScheduleControls({ idPrefix }: { idPrefix: string }) {
  const settings = useSyncStore((s) => s.settings);
  const patch = useSettingsPatch();
  if (!settings) return null;
  const intervalValue = INTERVAL_OPTIONS.some((o) => o.value === String(settings.interval_seconds))
    ? String(settings.interval_seconds)
    : "60";
  return (
    <div className="sync-controls">
      <div className="ui-field">
        <label className="ui-field-label" htmlFor={`${idPrefix}-interval`}>
          Sync
        </label>
        <Select
          id={`${idPrefix}-interval`}
          size="sm"
          value={intervalValue}
          onChange={(e) => void patch({ interval_seconds: Number(e.target.value) })}
          options={INTERVAL_OPTIONS}
        />
      </div>
      <Switch
        size="sm"
        checked={settings.include_app_data}
        onChange={(v) => void patch({ include_app_data: v })}
        label="Include app data"
        description="Memory, calendar, tasks, AETHER notes"
      />
    </div>
  );
}

/** Backup folder, schedule and retention. */
export function BackupScheduleControls({ idPrefix }: { idPrefix: string }) {
  const settings = useSyncStore((s) => s.settings);
  const patch = useSettingsPatch();
  const [dir, setDir] = useState<string | null>(null);
  if (!settings) return null;
  const folder = dir ?? settings.backup_dir ?? "";
  const every = String(settings.backup_every_hours);
  const everyOptions = BACKUP_EVERY_OPTIONS.some((o) => o.value === every)
    ? BACKUP_EVERY_OPTIONS
    : [...BACKUP_EVERY_OPTIONS, { value: every, label: `Every ${every} hours` }];
  const keep = String(settings.backup_keep);
  const keepOptions = BACKUP_KEEP_OPTIONS.some((o) => o.value === keep)
    ? BACKUP_KEEP_OPTIONS
    : [...BACKUP_KEEP_OPTIONS, { value: keep, label: `Keep ${keep}` }];

  const saveFolder = async (value: string) => {
    if (value.trim() === (settings.backup_dir ?? "")) return;
    const cleared = !value.trim();
    // Without a folder there is nowhere to write scheduled backups: switch them off too.
    const next: SyncSettingsPatch = cleared ? { backup_dir: "", backup_every_hours: 0 } : { backup_dir: value.trim() };
    if (await patch(next, cleared ? "Backup folder cleared" : "Backup folder saved")) {
      setDir(null);
    }
  };

  return (
    <div className="sync-controls">
      <div className="ui-field">
        <label className="ui-field-label" htmlFor={`${idPrefix}-backup-dir`}>
          Folder for scheduled backups
        </label>
        <FolderField
          id={`${idPrefix}-backup-dir`}
          value={folder}
          onChange={setDir}
          purpose="backup"
          dialogTitle="Choose the folder for scheduled backups"
          placeholder="Choose a folder"
          onPicked={(p) => void saveFolder(p)}
        />
        {dir !== null && dir.trim() !== (settings.backup_dir ?? "") && (
          <button type="button" className="sync-link" onClick={() => void saveFolder(dir)}>
            Save folder
          </button>
        )}
      </div>
      <div className="sync-controls-row">
        <div className="ui-field">
          <label className="ui-field-label" htmlFor={`${idPrefix}-backup-every`}>
            Schedule
          </label>
          <Select
            id={`${idPrefix}-backup-every`}
            size="sm"
            value={every}
            onChange={(e) => void patch({ backup_every_hours: Number(e.target.value) })}
            options={everyOptions}
            disabled={!settings.backup_dir}
          />
        </div>
        <div className="ui-field">
          <label className="ui-field-label" htmlFor={`${idPrefix}-backup-keep`}>
            Retention
          </label>
          <Select
            id={`${idPrefix}-backup-keep`}
            size="sm"
            value={keep}
            onChange={(e) => void patch({ backup_keep: Number(e.target.value) })}
            options={keepOptions}
          />
        </div>
      </div>
      <Switch
        size="sm"
        checked={settings.backup_include_app_data}
        onChange={(v) => void patch({ backup_include_app_data: v })}
        label="Include app data in scheduled backups"
      />
      {!settings.backup_dir && <span className="ui-field-hint">Choose a folder to schedule backups.</span>}
    </div>
  );
}
