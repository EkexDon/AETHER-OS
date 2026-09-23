import { useEffect, useState } from "react";
import { CircleCheck, ShieldCheck, TriangleAlert } from "lucide-react";
import type { BackupVerifyReport } from "../../types";
import { verifyBackup } from "../../lib/ipc";
import { useSyncStore } from "../../lib/syncStore";
import { baseName, displayPath, errorText, formatBytes, progressPercent, progressText } from "../../lib/sync/format";
import { Button, Modal } from "../../ui";
import { PassphraseInput, ProgressBar } from "./fields";

/** Decrypt every file of a backup and report whether it restores cleanly. */
export function VerifyBackupModal({ path, onClose }: { path: string | null; onClose: () => void }) {
  const progress = useSyncStore((s) => s.progress);
  const [passphrase, setPassphrase] = useState("");
  const [report, setReport] = useState<BackupVerifyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPassphrase("");
    setReport(null);
    setError(null);
  }, [path]);

  const run = async () => {
    if (!path || !passphrase) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await verifyBackup(path, passphrase));
      setPassphrase("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={path !== null}
      onClose={onClose}
      dismissible={!busy}
      title="Verify backup"
      description={path ? baseName(path) : undefined}
      icon={ShieldCheck}
      size="sm"
      footer={
        report ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void run()} loading={busy} disabled={!passphrase}>
              Verify
            </Button>
          </>
        )
      }
    >
      <div className="sync-form">
        {!report && (
          <div className="ui-field">
            <label className="ui-field-label" htmlFor="sync-verify-passphrase">
              Backup passphrase
            </label>
            <PassphraseInput
              id="sync-verify-passphrase"
              value={passphrase}
              onChange={(v) => {
                setPassphrase(v);
                setError(null);
              }}
              autoFocus
              invalid={!!error}
              onEnter={() => void run()}
            />
            <span className="ui-field-hint">Every file is decrypted and checked against its hash; nothing is written.</span>
          </div>
        )}
        {busy && progress?.operation === "verify" && (
          <div className="sync-progress-block">
            <ProgressBar percent={progressPercent(progress)} label="Verifying" />
            <span className="ui-field-hint tabular">Checking · {progressText(progress)}</span>
          </div>
        )}
        {report &&
          (report.ok ? (
            <div className="ui-notice ui-notice-success sync-notice" role="status">
              <CircleCheck size={14} aria-hidden="true" />
              <span>
                All {report.files_checked.toLocaleString("en-US")} files ({formatBytes(report.bytes)}) decrypt and match
                their checksums.
              </span>
            </div>
          ) : (
            <div className="ui-notice ui-notice-danger sync-notice" role="alert">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                {report.issues.length} problem{report.issues.length === 1 ? "" : "s"} found (
                {report.files_checked.toLocaleString("en-US")} files fine):{" "}
                {report.issues
                  .slice(0, 4)
                  .map((i) => displayPath(i.path))
                  .join(", ")}
                {report.issues.length > 4 ? "…" : ""}
              </span>
            </div>
          ))}
        {error && (
          <p className="ui-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
