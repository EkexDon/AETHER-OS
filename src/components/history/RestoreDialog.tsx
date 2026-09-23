import { RotateCcw } from "lucide-react";
import { formatDateTime, noteTitle } from "../../lib/history/format";
import type { NoteVersion } from "../../types";
import { Button, Modal } from "../../ui";

export interface RestoreDialogProps {
  open: boolean;
  path: string;
  version: NoteVersion | null;
  /** Automatic versioning is on (the restore itself becomes a version). */
  enabled: boolean;
  restoring: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Confirmation before a note is reset to an older version. */
export function RestoreDialog({ open, path, version, enabled, restoring, onCancel, onConfirm }: RestoreDialogProps) {
  if (!version) return null;
  const title = noteTitle(path);
  return (
    <Modal
      open={open}
      onClose={onCancel}
      dismissible={!restoring}
      size="sm"
      icon={RotateCcw}
      title="Restore this version?"
      description={`“${title}” will get its content from ${formatDateTime(version.time)} back.`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={restoring}>
            Cancel
          </Button>
          <Button variant="primary" iconLeft={<RotateCcw size={14} />} loading={restoring} onClick={onConfirm} autoFocus>
            Restore
          </Button>
        </>
      }
    >
      <p className="history-restore-copy">
        {enabled
          ? "The current text stays in the history as its own version, so you can undo this at any time."
          : "Automatic versioning is off: the restore is written to the note but not recorded as a new version."}
      </p>
    </Modal>
  );
}
