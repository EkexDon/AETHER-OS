import { useEffect, useState } from "react";
import { ExternalLink, FolderSync, KeyRound, Lock, LockOpen } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { retainSyncEvents, useSyncStore } from "../../lib/syncStore";
import { errorText, statusSummary } from "../../lib/sync/format";
import { SettingsGroup, SettingsPage, SettingsRow } from "../../settings/layout";
import { useShellStore } from "../../shell/shellStore";
import { Badge, Button, Input, Switch, useToast } from "../../ui";
import { ChangePassphraseModal } from "./ChangePassphraseModal";
import { BackupScheduleControls, SyncScheduleControls, useSettingsPatch } from "./ScheduleControls";

/** Settings → Sync & Backup: everything from the view in compact form. */
export function SyncSettingsSection() {
  const status = useSyncStore((s) => s.status);
  const settings = useSyncStore((s) => s.settings);
  const openSetup = useSyncStore((s) => s.openSetup);
  const openUnlock = useSyncStore((s) => s.openUnlock);
  const lock = useSyncStore((s) => s.lock);
  const patch = useSettingsPatch();
  const toast = useToast();
  const [deviceName, setDeviceName] = useState("");
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    const release = retainSyncEvents();
    useSyncStore
      .getState()
      .refresh()
      .catch((e) => toast.error("Could not load sync settings", { description: errorText(e) }));
    return release;
  }, [toast]);

  const savedName = settings?.device_name;
  useEffect(() => {
    if (savedName !== undefined) setDeviceName(savedName);
  }, [savedName]);

  const openView = () => {
    useShellStore.getState().closeSettings();
    useAetherStore.getState().setView("sync");
  };

  const summary = statusSummary(status);

  return (
    <SettingsPage
      title="Sync & Backup"
      description="End-to-end encrypted sync through any folder (iCloud Drive, Dropbox, Syncthing, USB, NAS) and encrypted backups. No account, no server."
    >
      <SettingsGroup title="Folder sync">
        <SettingsRow
          label="Status"
          hint={summary.detail}
          control={
            <div className="settings-badges">
              <Badge variant={summary.tone} dot>
                {summary.label}
              </Badge>
              <Button size="sm" variant="ghost" iconLeft={<ExternalLink size={14} />} onClick={openView}>
                Open
              </Button>
            </div>
          }
        />
        <SettingsRow
          label="Sync folder"
          hint={settings?.sync_dir ?? "Not set up yet."}
          control={
            <Button size="sm" variant={settings?.sync_dir ? "secondary" : "primary"} iconLeft={<FolderSync size={14} />} onClick={openSetup}>
              {settings?.sync_dir ? "Change…" : "Set up…"}
            </Button>
          }
        />
        {settings && (
          <>
            <SettingsRow
              label="Background sync"
              hint="Runs every interval while the key is unlocked."
              control={
                <Switch
                  checked={settings.enabled}
                  disabled={!settings.sync_dir}
                  onChange={(v) => void patch({ enabled: v })}
                  aria-label="Background sync"
                />
              }
            />
            <SettingsRow label="Interval and scope" stacked>
              <SyncScheduleControls idPrefix="sync-settings" />
            </SettingsRow>
            <SettingsRow label="Device name" hint="Shown on your other devices and in conflict copies." htmlFor="sync-settings-device">
              <div className="ui-field-row">
                <Input
                  id="sync-settings-device"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void patch({ device_name: deviceName }, "Device name saved");
                  }}
                  maxLength={64}
                />
                <Button
                  size="sm"
                  onClick={() => void patch({ device_name: deviceName }, "Device name saved")}
                  disabled={!deviceName.trim() || deviceName.trim() === settings.device_name}
                >
                  Save
                </Button>
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Backups" description="Encrypted .aetherbak archives — verify and restore from Sync & Backup.">
        <SettingsRow label="Schedule" stacked>
          <BackupScheduleControls idPrefix="sync-settings" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Passphrase">
        <SettingsRow
          label={status?.unlocked ? "Unlocked" : "Locked"}
          hint="The passphrase is never stored. Without “remember”, AETHER-OS asks once per launch."
          control={
            status?.unlocked ? (
              <Button size="sm" variant="secondary" iconLeft={<Lock size={14} />} onClick={() => void lock().catch((e) => toast.error("Could not lock sync", { description: errorText(e) }))}>
                Lock now
              </Button>
            ) : (
              <Button size="sm" variant="secondary" iconLeft={<LockOpen size={14} />} onClick={openUnlock} disabled={!status?.initialized && !status?.configured}>
                Unlock…
              </Button>
            )
          }
        />
        {settings && (
          <SettingsRow
            label="Remember on this device"
            hint="Less secure: the key is kept in the app data folder so no prompt appears at start."
            control={
              <Switch
                checked={settings.remember_key}
                disabled={!status?.unlocked && !settings.remember_key}
                onChange={(v) => void patch({ remember_key: v })}
                aria-label="Remember on this device"
              />
            }
          />
        )}
        <SettingsRow
          label="Change passphrase"
          hint="Re-encrypts everything in the sync folder; other devices then ask for the new one."
          control={
            <Button size="sm" variant="ghost" iconLeft={<KeyRound size={14} />} onClick={() => setChanging(true)} disabled={!status?.initialized}>
              Change…
            </Button>
          }
        />
      </SettingsGroup>
      <ChangePassphraseModal open={changing} onClose={() => setChanging(false)} />
    </SettingsPage>
  );
}
