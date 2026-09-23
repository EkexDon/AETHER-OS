import { useState } from "react";
import { KeyRound, Lock, ShieldCheck } from "lucide-react";
import { useSyncStore } from "../../lib/syncStore";
import { errorText } from "../../lib/sync/format";
import { Button, Switch, useToast } from "../../ui";
import { ChangePassphraseModal } from "./ChangePassphraseModal";
import { useSettingsPatch } from "./ScheduleControls";

/** Key handling: lock, remember on this device, change passphrase. */
export function SecurityCard() {
  const status = useSyncStore((s) => s.status);
  const settings = useSyncStore((s) => s.settings);
  const lock = useSyncStore((s) => s.lock);
  const openUnlock = useSyncStore((s) => s.openUnlock);
  const patch = useSettingsPatch();
  const toast = useToast();
  const [changing, setChanging] = useState(false);

  const doLock = async () => {
    try {
      await lock();
      toast.success("Sync locked", { description: "The key was removed from memory." });
    } catch (e) {
      toast.error("Could not lock sync", { description: errorText(e) });
    }
  };

  return (
    <section className="sync-card" aria-labelledby="sync-security-title">
      <header className="sync-card-header">
        <div>
          <h2 className="sync-card-title" id="sync-security-title">
            Encryption
          </h2>
          <p className="sync-card-subtitle">Argon2id key · AES-256-GCM per file · hashed file names.</p>
        </div>
        <ShieldCheck size={16} className="sync-card-icon" aria-hidden="true" />
      </header>
      <div className="sync-controls">
        <Switch
          size="sm"
          checked={!!settings?.remember_key}
          disabled={!status?.unlocked && !settings?.remember_key}
          onChange={(v) =>
            void patch(
              { remember_key: v },
              v ? "Key remembered on this device" : "Key forgotten — you will be asked at start"
            )
          }
          label="Remember on this device"
          description="Less secure: stores the key in the app data folder."
        />
        <div className="sync-button-row">
          {status?.unlocked ? (
            <Button size="sm" variant="secondary" iconLeft={<Lock size={14} />} onClick={() => void doLock()}>
              Lock now
            </Button>
          ) : (
            <Button size="sm" variant="secondary" iconLeft={<Lock size={14} />} onClick={openUnlock} disabled={!status?.initialized && !status?.configured}>
              Unlock
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<KeyRound size={14} />}
            onClick={() => setChanging(true)}
            disabled={!status?.initialized}
          >
            Change passphrase
          </Button>
        </div>
      </div>
      <ChangePassphraseModal open={changing} onClose={() => setChanging(false)} />
    </section>
  );
}
