import { useEffect, useState } from "react";
import { FolderSync, KeyRound, Lock, ShieldCheck, Smartphone } from "lucide-react";
import type { SyncFolderInfo } from "../../types";
import { inspectSyncFolder } from "../../lib/ipc";
import { useSyncStore } from "../../lib/syncStore";
import { estimatePassphrase } from "../../lib/sync/entropy";
import { absoluteTime, describeReport, errorText } from "../../lib/sync/format";
import { Badge, Button, Checkbox, Modal, Switch, useToast } from "../../ui";
import { FolderField, PassphraseInput, StrengthMeter } from "./fields";

type Step = 0 | 1 | 2;
const STEPS = ["Folder", "How it works", "Passphrase"] as const;

/**
 * Three-step setup: choose the shared folder, understand the encryption
 * model, then set (or enter) the passphrase. Finishing turns background
 * sync on and runs the first round.
 */
export function SetupWizard() {
  const open = useSyncStore((s) => s.setupOpen);
  const close = useSyncStore((s) => s.closeSetup);
  const settings = useSyncStore((s) => s.settings);
  const status = useSyncStore((s) => s.status);
  const toast = useToast();

  const [step, setStep] = useState<Step>(0);
  const [folder, setFolder] = useState("");
  const [info, setInfo] = useState<SyncFolderInfo | null>(null);
  const [includeAppData, setIncludeAppData] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setFolder(settings?.sync_dir ?? "");
      setIncludeAppData(settings?.include_app_data ?? true);
      setRemember(settings?.remember_key ?? false);
      setInfo(null);
      setError(null);
    } else {
      setPassphrase("");
      setConfirm("");
    }
    // Re-initialise only when the dialog opens, not on every settings event.
  }, [open]);

  const mode: "join" | "existing" | "create" = info?.initialized
    ? "join"
    : status?.initialized
      ? "existing"
      : "create";
  const estimate = estimatePassphrase(passphrase);
  const mismatch = mode === "create" && confirm.length > 0 && confirm !== passphrase;
  const passphraseReady =
    passphrase.length > 0 && (mode !== "create" || (estimate.acceptable && confirm === passphrase));

  const inspect = async () => {
    if (!folder.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await inspectSyncFolder(folder.trim()));
      setStep(1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!passphraseReady) return;
    setBusy(true);
    setError(null);
    const store = useSyncStore.getState();
    try {
      await store.updateSettings({ sync_dir: info?.path ?? folder.trim(), include_app_data: includeAppData, enabled: true });
      await store.unlock(passphrase, remember);
      close();
      toast.success(mode === "join" ? "Joined the sync folder" : "Sync is set up", {
        description: "The first sync runs now; afterwards every minute in the background.",
      });
      store
        .syncNow()
        .then((report) => toast.info("First sync finished", { description: describeReport(report) }))
        .catch((e) => toast.error("First sync failed", { description: errorText(e) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      {step > 0 && (
        <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
          Back
        </Button>
      )}
      {step === 0 && (
        <Button variant="primary" onClick={() => void inspect()} loading={busy} disabled={!folder.trim()}>
          Continue
        </Button>
      )}
      {step === 1 && (
        <Button variant="primary" onClick={() => setStep(2)}>
          Continue
        </Button>
      )}
      {step === 2 && (
        <Button variant="primary" onClick={() => void finish()} loading={busy} disabled={!passphraseReady}>
          {mode === "join" ? "Join and sync" : "Turn on sync"}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title="Set up encrypted sync"
      description="Sync your vault through a folder you already use — iCloud Drive, Dropbox, Syncthing, a USB stick or a NAS."
      icon={FolderSync}
      size="md"
      dismissible={!busy}
      footer={footer}
    >
      <ol className="sync-steps" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "is-current" : i < step ? "is-done" : undefined} aria-current={i === step ? "step" : undefined}>
            <span className="sync-step-number tabular">{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="sync-form">
          <div className="ui-field">
            <label className="ui-field-label" htmlFor="sync-setup-folder">
              Sync folder
            </label>
            <FolderField
              id="sync-setup-folder"
              value={folder}
              onChange={(v) => {
                setFolder(v);
                setError(null);
              }}
              purpose="sync"
              dialogTitle="Choose the folder to sync through"
              placeholder="~/Library/Mobile Documents/com~apple~CloudDocs/AETHER"
            />
            <span className="ui-field-hint">
              AETHER-OS creates an <span className="mono">aether-sync</span> folder inside it. Pick the same folder on
              every device.
            </span>
          </div>
          {error && (
            <p className="ui-field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="sync-form">
          {info && (
            <div className={`ui-notice ${info.initialized ? "ui-notice-success" : ""} sync-notice`} role="status">
              {info.initialized ? (
                <span>
                  This folder already holds an encrypted AETHER store with{" "}
                  <strong>
                    {info.device_count} device{info.device_count === 1 ? "" : "s"}
                  </strong>
                  {info.created_by ? `, created on ${info.created_by}` : ""}
                  {info.created_at ? ` (${absoluteTime(info.created_at)})` : ""}. You will join it.
                </span>
              ) : (
                <span>A new encrypted store will be created in this folder.</span>
              )}
            </div>
          )}
          <ol className="sync-model">
            <li>
              <span className="sync-model-icon" aria-hidden="true">
                <Lock size={16} />
              </span>
              <div>
                <strong>Encrypted on this device.</strong> A key derived from your passphrase (Argon2id) encrypts
                every file with AES-256-GCM before it reaches the folder.
              </div>
            </li>
            <li>
              <span className="sync-model-icon" aria-hidden="true">
                <ShieldCheck size={16} />
              </span>
              <div>
                <strong>Your sync tool only sees noise.</strong> Contents and file names are hidden; nobody — not
                Apple, Dropbox or a thief with the USB stick — can read them.
              </div>
            </li>
            <li>
              <span className="sync-model-icon" aria-hidden="true">
                <Smartphone size={16} />
              </span>
              <div>
                <strong>Same passphrase on every device.</strong> There is no reset: if you lose the passphrase, the
                synced data cannot be recovered. Keep a backup.
              </div>
            </li>
          </ol>
          <Switch
            checked={includeAppData}
            onChange={setIncludeAppData}
            label="Also sync app data"
            description="Memory facts, calendar events, tasks and saved AI notes."
          />
        </div>
      )}

      {step === 2 && (
        <div className="sync-form">
          <div className="sync-mode-line">
            <KeyRound size={14} aria-hidden="true" />
            {mode === "join" && <span>Enter the passphrase you set on your other device.</span>}
            {mode === "existing" && <span>Enter the passphrase you already use on this device.</span>}
            {mode === "create" && <span>Choose a passphrase — four or more random words work well.</span>}
            {mode === "create" && <Badge size="sm">New</Badge>}
          </div>
          <div className="ui-field">
            <label className="ui-field-label" htmlFor="sync-setup-passphrase">
              Passphrase
            </label>
            <PassphraseInput
              id="sync-setup-passphrase"
              value={passphrase}
              onChange={(v) => {
                setPassphrase(v);
                setError(null);
              }}
              autoFocus
              autoComplete={mode === "create" ? "new-password" : "current-password"}
              invalid={!!error}
              onEnter={() => void finish()}
            />
            {mode === "create" && <StrengthMeter passphrase={passphrase} />}
          </div>
          {mode === "create" && (
            <div className="ui-field">
              <label className="ui-field-label" htmlFor="sync-setup-confirm">
                Repeat passphrase
              </label>
              <PassphraseInput
                id="sync-setup-confirm"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                invalid={mismatch}
                onEnter={() => void finish()}
              />
              {mismatch && <span className="ui-field-error">The passphrases do not match.</span>}
            </div>
          )}
          <Checkbox
            checked={remember}
            onChange={setRemember}
            label="Remember on this device"
            description="Less secure: the key is stored in the app data folder. Otherwise you unlock once per launch."
          />
          {error && (
            <p className="ui-field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
