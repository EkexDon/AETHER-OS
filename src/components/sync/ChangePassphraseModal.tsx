import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { changeSyncPassphrase } from "../../lib/ipc";
import { useSyncStore } from "../../lib/syncStore";
import { estimatePassphrase } from "../../lib/sync/entropy";
import { errorText, progressPercent, progressText } from "../../lib/sync/format";
import { Button, Modal, useToast } from "../../ui";
import { PassphraseInput, ProgressBar, StrengthMeter } from "./fields";

/** Change the sync passphrase; re-encrypts everything in the sync folder. */
export function ChangePassphraseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const progress = useSyncStore((s) => s.progress);
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
    }
  }, [open]);

  const estimate = estimatePassphrase(next);
  const mismatch = confirm.length > 0 && confirm !== next;
  const same = next.length > 0 && next === current;
  const ready = !busy && current.length > 0 && estimate.acceptable && confirm === next && !same;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const report = await changeSyncPassphrase(current, next);
      await useSyncStore.getState().refresh().catch(() => undefined);
      onClose();
      toast.success("Passphrase changed", {
        description: report.sync_folder
          ? `Re-encrypted ${report.blobs} files, ${report.indexes} indexes and ${report.devices} device records.${
              report.issues.length ? ` ${report.issues.length} item(s) could not be migrated.` : ""
            }`
          : "The new passphrase protects this device's backups from now on.",
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const running = busy && progress?.operation === "passphrase";

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Change passphrase"
      description="Everything in the sync folder is re-encrypted with a new key. Other devices will ask for the new passphrase; existing backups keep the one they were made with."
      icon={KeyRound}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!ready}>
            Change passphrase
          </Button>
        </>
      }
    >
      <div className="sync-form">
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="sync-change-current">
            Current passphrase
          </label>
          <PassphraseInput id="sync-change-current" value={current} onChange={setCurrent} autoFocus />
        </div>
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="sync-change-new">
            New passphrase
          </label>
          <PassphraseInput id="sync-change-new" value={next} onChange={setNext} autoComplete="new-password" invalid={same} />
          <StrengthMeter passphrase={next} />
          {same && <span className="ui-field-error">Choose a passphrase different from the current one.</span>}
        </div>
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="sync-change-confirm">
            Repeat new passphrase
          </label>
          <PassphraseInput
            id="sync-change-confirm"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            invalid={mismatch}
            onEnter={() => void submit()}
          />
          {mismatch && <span className="ui-field-error">The passphrases do not match.</span>}
        </div>
        {running && (
          <div className="sync-progress-block">
            <ProgressBar percent={progressPercent(progress)} label="Re-encrypting" />
            <span className="ui-field-hint tabular">Re-encrypting · {progressText(progress)}</span>
          </div>
        )}
        {error && (
          <p className="ui-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
