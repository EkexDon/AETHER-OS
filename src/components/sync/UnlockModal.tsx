import { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import type { SyncFolderInfo } from "../../types";
import { inspectSyncFolder } from "../../lib/ipc";
import { useSyncStore } from "../../lib/syncStore";
import { estimatePassphrase } from "../../lib/sync/entropy";
import { baseName, errorText } from "../../lib/sync/format";
import { Button, Checkbox, Modal, Spinner, useToast } from "../../ui";
import { PassphraseInput, StrengthMeter } from "./fields";

/**
 * Global passphrase prompt (opened by the status bar, commands and the
 * view). Creates the key when neither this device nor the sync folder has
 * one yet (passphrase twice + strength meter), otherwise unlocks.
 */
export function UnlockModal() {
  const open = useSyncStore((s) => s.unlockOpen);
  const status = useSyncStore((s) => s.status);
  const settings = useSyncStore((s) => s.settings);
  const close = useSyncStore((s) => s.closeUnlock);
  const unlock = useSyncStore((s) => s.unlock);
  const toast = useToast();

  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState<SyncFolderInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const syncDir = settings?.sync_dir ?? null;

  useEffect(() => {
    if (!open) {
      // Never keep a typed passphrase around after the dialog closes.
      setPassphrase("");
      setConfirm("");
      setError(null);
      setFolder(null);
      return;
    }
    setRemember(settings?.remember_key ?? false);
    if (syncDir && !status?.initialized) {
      setInspecting(true);
      inspectSyncFolder(syncDir)
        .then(setFolder)
        .catch(() => setFolder(null))
        .finally(() => setInspecting(false));
    }
  }, [open, syncDir, status?.initialized, settings?.remember_key]);

  const creating = !status?.initialized && !folder?.initialized;
  const estimate = estimatePassphrase(passphrase);
  const mismatch = creating && confirm.length > 0 && confirm !== passphrase;
  const canSubmit =
    !busy && !inspecting && passphrase.length > 0 && (!creating || (estimate.acceptable && confirm === passphrase));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(passphrase, remember);
      toast.success(creating ? "Passphrase set" : "Sync unlocked", {
        description: remember
          ? "The key is remembered on this device."
          : "The key stays in memory until you lock sync or quit.",
      });
    } catch (e) {
      setError(errorText(e));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const description = creating
    ? "Choose the passphrase that encrypts your data. Other devices need the same passphrase — it cannot be recovered."
    : folder?.initialized && !status?.initialized
      ? `Enter the passphrase used on your other devices${folder.created_by ? ` (set up on ${folder.created_by})` : ""}.`
      : syncDir
        ? `Decrypts the encrypted store in “${baseName(syncDir)}”.`
        : "Decrypts your encrypted backups on this device.";

  return (
    <Modal
      open={open}
      onClose={close}
      title={creating ? "Set a sync passphrase" : "Unlock sync"}
      description={description}
      icon={KeyRound}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!canSubmit}>
            {creating ? "Set passphrase" : "Unlock"}
          </Button>
        </>
      }
    >
      <div className="sync-form">
        {inspecting ? (
          <div className="sync-inline-loading">
            <Spinner size={14} /> <span>Checking the sync folder…</span>
          </div>
        ) : (
          <>
            <div className="ui-field">
              <label className="ui-field-label" htmlFor="sync-unlock-passphrase">
                Passphrase
              </label>
              <PassphraseInput
                id="sync-unlock-passphrase"
                value={passphrase}
                onChange={(v) => {
                  setPassphrase(v);
                  setError(null);
                }}
                autoFocus
                inputRef={inputRef}
                invalid={!!error}
                onEnter={() => void submit()}
                autoComplete={creating ? "new-password" : "current-password"}
              />
              {creating && <StrengthMeter passphrase={passphrase} />}
            </div>
            {creating && (
              <div className="ui-field">
                <label className="ui-field-label" htmlFor="sync-unlock-confirm">
                  Repeat passphrase
                </label>
                <PassphraseInput
                  id="sync-unlock-confirm"
                  value={confirm}
                  onChange={setConfirm}
                  invalid={mismatch}
                  onEnter={() => void submit()}
                  autoComplete="new-password"
                />
                {mismatch && <span className="ui-field-error">The passphrases do not match.</span>}
              </div>
            )}
            <Checkbox
              checked={remember}
              onChange={setRemember}
              label="Remember on this device"
              description="Skip this prompt when AETHER-OS starts."
            />
            {remember && (
              <div className="ui-notice ui-notice-warning sync-notice" role="note">
                <ShieldAlert size={14} aria-hidden="true" />
                <span>
                  Less secure: the key is stored in the AETHER-OS data folder, readable by any app running as you.
                  Without it, you are asked once per launch.
                </span>
              </div>
            )}
            {error && (
              <p className="ui-field-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
