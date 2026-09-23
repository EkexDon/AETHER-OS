import { useEffect } from "react";
import { History } from "lucide-react";
import { countLabel, formatDateTime, relativeTime } from "../../lib/history/format";
import { initHistorySync, useHistoryStore } from "../../lib/historyStore";
import { useAetherStore } from "../../lib/store";
import type { HistoryStatus } from "../../types";
import { Tooltip } from "../../ui";
import { HistoryDrawer } from "./HistoryDrawer";
import { useNow } from "./hooks";

/** Short status-bar label for the history state. */
export function historyStatusLabel(status: HistoryStatus, nowMs: number): string {
  if (!status.enabled) return "History off";
  if (status.last_commit_at === null) return "No snapshots";
  return relativeTime(status.last_commit_at, nowMs);
}

/** Tooltip text for the history status item. */
export function historyStatusTooltip(status: HistoryStatus): string {
  if (status.last_error) return `Note history problem: ${status.last_error}`;
  if (!status.enabled) return "Automatic versioning is off — click to open history";
  const versions = countLabel(status.commit_count, "version");
  if (status.last_commit_at === null) return `${versions} · click to open history`;
  return `Last snapshot ${formatDateTime(status.last_commit_at)} · ${versions} · click to open history`;
}

/**
 * Status bar item "⟲ 2m ago": time of the last snapshot, opens the History
 * view. Also keeps the history store live and hosts the global history
 * drawer.
 */
export function HistoryStatusItem() {
  useEffect(() => initHistorySync(), []);
  const status = useHistoryStore((s) => s.status);
  const now = useNow(30_000);
  const setView = useAetherStore((s) => s.setView);

  return (
    <>
      {status?.vault_path && (
        <Tooltip content={historyStatusTooltip(status)} placement="top">
          <button
            type="button"
            className="statusbar-item history-status-item"
            onClick={() => setView("history")}
            aria-label={`Note history: ${historyStatusLabel(status, now)}`}
          >
            <History size={12} aria-hidden="true" />
            {status.last_error && <span className="statusbar-dot is-offline" aria-hidden="true" />}
            <span className="statusbar-muted tabular">{historyStatusLabel(status, now)}</span>
          </button>
        </Tooltip>
      )}
      <HistoryDrawer />
    </>
  );
}
