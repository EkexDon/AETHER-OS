import { useEffect } from "react";
import { ClipboardList, ClipboardX } from "lucide-react";
import { ensureClipboardSync, useClipboardStore } from "../../lib/clipboardStore";
import { useAetherStore } from "../../lib/store";
import { Tooltip } from "../../ui";

/** Status bar: clip count (or "Paused" / "Off"); click opens the history. */
export function ClipboardStatusItem() {
  const stats = useClipboardStore((s) => s.stats);
  const setView = useAetherStore((s) => s.setView);

  useEffect(() => {
    ensureClipboardSync();
    void useClipboardStore.getState().refreshStats();
  }, []);

  if (!stats) return null;
  const off = !stats.enabled;
  const paused = stats.paused;
  const label = off ? "Off" : paused ? "Paused" : stats.total.toLocaleString("en-US");
  const tooltip = off
    ? "Clipboard history is turned off"
    : paused
      ? "Clipboard capture is paused — click to open the history"
      : stats.watcher_error
        ? `Clipboard unavailable: ${stats.watcher_error}`
        : `${stats.total.toLocaleString("en-US")} clip${stats.total === 1 ? "" : "s"} in the clipboard history`;

  return (
    <Tooltip content={tooltip} shortcut="mod+shift+v" placement="top">
      <button
        type="button"
        className={`statusbar-item clip-status${off || paused ? " is-paused" : ""}`}
        onClick={() => setView("clipboard")}
        aria-label={`Clipboard history: ${label}`}
      >
        {off || paused ? <ClipboardX size={14} /> : <ClipboardList size={14} />}
        <span className="statusbar-muted tabular">{label}</span>
      </button>
    </Tooltip>
  );
}
