import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, TriangleAlert } from "lucide-react";
import type { BackupPreview, RestoreMode, RestoreReport } from "../../types";
import { previewBackup, restoreBackup } from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { useSyncStore } from "../../lib/syncStore";
import { absoluteTime, baseName, displayPath, errorText, formatBytes, progressPercent, progressText } from "../../lib/sync/format";
import { Badge, Button, Modal, SearchField, SegmentedControl, useToast } from "../../ui";
import { FolderField, PassphraseInput, ProgressBar } from "./fields";

type Step = "passphrase" | "preview" | "target" | "done";

const MAX_LISTED = 300;

/**
 * Restore flow: passphrase → dry-run preview (files, size, device, date) →
 * target folder + mode → result. `replace` never deletes: the existing
 * folder is moved to `<name>.pre-restore-<time>` first.
 */
export function RestoreWizard({ path, onClose }: { path: string | null; onClose: () => void }) {
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const progress = useSyncStore((s) => s.progress);
  const toast = useToast();
  const [step, setStep] = useState<Step>("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<RestoreMode>("merge");
  const [filter, setFilter] = useState("");
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStep("passphrase");
    setPassphrase("");
    setPreview(null);
    setReport(null);
    setError(null);
    setFilter("");
    setMode("merge");
    setTarget(vaultPath ?? "");
  }, [path, vaultPath]);

  const files = useMemo(() => {
    if (!preview) return [];
    const q = filter.trim().toLowerCase();
    return preview.files.filter((f) => !q || f.path.toLowerCase().includes(q));
  }, [preview, filter]);

  const loadPreview = async () => {
    if (!path || !passphrase) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewBackup(path, passphrase));
      setStep("preview");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!path || !target.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await restoreBackup(path, passphrase, target.trim(), mode);
      setReport(result);
      setPassphrase("");
      setStep("done");
      toast.success("Backup restored", {
        description: `${result.restored + result.app_files_restored} files written to ${baseName(result.target_dir)}.`,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const intoVault = !!vaultPath && target.trim().replace(/\/+$/, "") === vaultPath.replace(/\/+$/, "");
  const restoring = busy && progress?.operation === "restore";

  const footer =
    step === "passphrase" ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void loadPreview()} loading={busy} disabled={!passphrase}>
          Show contents
        </Button>
      </>
    ) : step === "preview" ? (
      <>
        <Button variant="ghost" onClick={() => setStep("passphrase")}>
          Back
        </Button>
        <Button variant="primary" onClick={() => setStep("target")}>
          Choose where to restore
        </Button>
      </>
    ) : step === "target" ? (
      <>
        <Button variant="ghost" onClick={() => setStep("preview")} disabled={busy}>
          Back
        </Button>
        <Button variant={mode === "replace" ? "danger" : "primary"} onClick={() => void run()} loading={busy} disabled={!target.trim()}>
          {mode === "replace" ? "Replace and restore" : "Restore"}
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );

  return (
    <Modal
      open={path !== null}
      onClose={onClose}
      dismissible={!busy}
      title="Restore backup"
      description={path ? baseName(path) : undefined}
      icon={ArchiveRestore}
      size="lg"
      footer={footer}
    >
      <div className="sync-form">
        {step === "passphrase" && (
          <div className="ui-field">
            <label className="ui-field-label" htmlFor="sync-restore-passphrase">
              Backup passphrase
            </label>
            <PassphraseInput
              id="sync-restore-passphrase"
              value={passphrase}
              onChange={(v) => {
                setPassphrase(v);
                setError(null);
              }}
              autoFocus
              invalid={!!error}
              onEnter={() => void loadPreview()}
            />
            <span className="ui-field-hint">The passphrase that was active when the backup was made.</span>
          </div>
        )}

        {step === "preview" && preview && (
          <>
            <dl className="sync-facts">
              <div>
                <dt>Created</dt>
                <dd>{absoluteTime(preview.created_at)}</dd>
              </div>
              <div>
                <dt>Device</dt>
                <dd>{preview.device}</dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd className="tabular">{preview.file_count.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd className="tabular">{formatBytes(preview.bytes)}</dd>
              </div>
            </dl>
            {preview.include_app_data && <Badge size="sm">Includes app data</Badge>}
            <SearchField value={filter} onChange={setFilter} placeholder="Filter files…" aria-label="Filter files" />
            <ul className="sync-file-list" aria-label="Files in the backup">
              {files.slice(0, MAX_LISTED).map((f) => (
                <li key={f.path}>
                  <span className="sync-file-path">{displayPath(f.path)}</span>
                  <span className="sync-file-size tabular">{formatBytes(f.size)}</span>
                </li>
              ))}
              {files.length === 0 && <li className="sync-file-empty">No files match.</li>}
            </ul>
            {files.length > MAX_LISTED && (
              <span className="ui-field-hint">
                Showing {MAX_LISTED} of {files.length.toLocaleString("en-US")} files.
              </span>
            )}
          </>
        )}

        {step === "target" && (
          <>
            <div className="ui-field">
              <label className="ui-field-label" htmlFor="sync-restore-target">
                Restore vault files to
              </label>
              <FolderField
                id="sync-restore-target"
                value={target}
                onChange={setTarget}
                purpose="restore"
                dialogTitle="Choose where to restore the vault"
              />
              {intoVault && <span className="ui-field-hint">This is your current vault.</span>}
            </div>
            <div className="ui-field">
              <span className="ui-field-label" id="sync-restore-mode-label">
                Existing files
              </span>
              <SegmentedControl<RestoreMode>
                aria-label="Restore mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "merge", label: "Merge" },
                  { value: "replace", label: "Replace" },
                ]}
              />
              <span className="ui-field-hint">
                {mode === "merge"
                  ? "Adds missing files. Files that differ are kept and the backup version is saved next to them as “(restored …)”."
                  : "Restores exactly the backup. The existing folder is moved aside first — nothing is deleted."}
              </span>
            </div>
            {mode === "replace" && (
              <div className="ui-notice ui-notice-warning sync-notice" role="note">
                <TriangleAlert size={14} aria-hidden="true" />
                <span>
                  “{baseName(target || "folder")}” will be renamed to “{baseName(target || "folder")}.pre-restore-&lt;time&gt;”
                  {preview?.include_app_data ? " and the current app data set aside" : ""}. With sync on, the
                  restored state is sent to your other devices on the next round.
                </span>
              </div>
            )}
            {restoring && (
              <div className="sync-progress-block">
                <ProgressBar percent={progressPercent(progress)} label="Restoring" />
                <span className="ui-field-hint tabular">Restoring · {progressText(progress)}</span>
              </div>
            )}
          </>
        )}

        {step === "done" && report && (
          <>
            <dl className="sync-facts">
              <div>
                <dt>Written</dt>
                <dd className="tabular">{report.restored}</dd>
              </div>
              <div>
                <dt>Unchanged</dt>
                <dd className="tabular">{report.unchanged}</dd>
              </div>
              <div>
                <dt>Restored copies</dt>
                <dd className="tabular">{report.restored_copies}</dd>
              </div>
              <div>
                <dt>App data</dt>
                <dd className="tabular">
                  {report.app_files_restored} written · {report.app_files_kept} kept
                </dd>
              </div>
            </dl>
            {report.moved_existing_to && (
              <p className="ui-field-hint">
                The previous folder is at <span className="mono">{report.moved_existing_to}</span>.
              </p>
            )}
            {report.issues.length > 0 && (
              <div className="ui-notice ui-notice-warning sync-notice" role="note">
                {report.issues.length} file(s) could not be restored: {report.issues.slice(0, 3).map((i) => displayPath(i.path)).join(", ")}
                {report.issues.length > 3 ? "…" : ""}
              </div>
            )}
          </>
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
