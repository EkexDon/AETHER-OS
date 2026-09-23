import { Pin, PinOff } from "lucide-react";
import type { PinKind } from "../../types";
import { useIsPinned, usePinsStore } from "../../lib/pinsStore";
import { IconButton, toast } from "../../ui";

export interface PinButtonProps {
  kind: PinKind;
  /** Target reference (path, id or URL). */
  target: string;
  label: string;
}

/** Small pin / unpin toggle for list rows. */
export function PinButton({ kind, target, label }: PinButtonProps) {
  const pinned = useIsPinned(kind, target);
  return (
    <IconButton
      size="sm"
      label={pinned ? `Unpin ${label}` : `Pin ${label}`}
      active={pinned}
      icon={pinned ? <PinOff size={14} /> : <Pin size={14} />}
      onClick={(e) => {
        e.stopPropagation();
        const store = usePinsStore.getState();
        if (pinned) {
          store.removePinByRef(kind, target);
          toast.success("Unpinned", { description: label });
        } else {
          store.addPin({ kind, ref: target, label });
          toast.success("Pinned", { description: label });
        }
      }}
    />
  );
}
