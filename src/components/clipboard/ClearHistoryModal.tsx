import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useClipboardStore } from "../../lib/clipboardStore";
import { Button, Checkbox, Modal, useToast } from "../../ui";

export interface ClearHistoryModalProps {
  open: boolean;
  onClose: () => void;
}

/** Confirmation before wiping the clipboard history. */
export function ClearHistoryModal({ open, onClose }: ClearHistoryModalProps) {
  const toast = useToast();
  const stats = useClipboardStore((s) => s.stats);
  const clear = useClipboardStore((s) => s.clear);
  const [keepPinned, setKeepPinned] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKeepPinned(true);
      setBusy(false);
    }
  }, [open]);

  const total = stats?.total ?? 0;
  const pinned = stats?.pinned ?? 0;
  const affected = keepPinned ? total - pinned : total;

  const confirm = async () => {
    setBusy(true);
    try {
      const removed = await clear(keepPinned);
      toast.success(removed === 1 ? "Removed 1 clip" : `Removed ${removed.toLocaleString("en-US")} clips`, {
        description: keepPinned && pinned > 0 ? `${pinned} pinned ${pinned === 1 ? "clip was" : "clips were"} kept.` : undefined,
      });
      onClose();
    } catch (e) {
      toast.error("Could not clear the history", { description: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Clear clipboard history?"
      description={
        affected === 1
          ? "1 clip will be deleted from this Mac. This cannot be undone."
          : `${affected.toLocaleString("en-US")} clips will be deleted from this Mac. This cannot be undone.`
      }
      icon={Trash2}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            Clear history
          </Button>
        </>
      }
    >
      <Checkbox
        checked={keepPinned}
        onChange={setKeepPinned}
        label="Keep pinned clips"
        description={pinned === 1 ? "1 clip is pinned." : `${pinned} clips are pinned.`}
      />
    </Modal>
  );
}
