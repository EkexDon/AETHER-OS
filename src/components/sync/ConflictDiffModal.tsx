import { useEffect, useMemo, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import type { SyncConflictDetail, SyncKeepChoice } from "../../types";
import { getSyncConflict } from "../../lib/ipc";
import { useSyncStore } from "../../lib/syncStore";
import { collapseRows, diffLines, diffStats, sideBySide, type DiffRow, type DiffSkip } from "../../lib/sync/diff";
import { absoluteTime, errorText, relativeTime } from "../../lib/sync/format";
import { Badge, Button, EmptyState, Modal, Spinner, Tooltip, cx, useToast } from "../../ui";

function SideLabel({ title, device, time, thisDevice }: { title: string; device: string; time: string; thisDevice: boolean }) {
  return (
    <div className="sync-diff-side-label">
      <span className="sync-diff-side-title">{title}</span>
      <Tooltip content={absoluteTime(time)} placement="bottom">
        <span className="sync-diff-side-meta" tabIndex={0}>
          {device}
          {thisDevice ? " (this device)" : ""} · {relativeTime(time)}
        </span>
      </Tooltip>
    </div>
  );
}

function Cell({ cell, kind, side }: { cell: DiffRow["left"]; kind: DiffRow["kind"]; side: "left" | "right" }) {
  const changed = kind !== "equal" && cell !== null;
  return (
    <div
      role="cell"
      className={cx("sync-diff-cell", changed && (side === "left" ? "is-removed" : "is-added"), !cell && "is-empty")}
    >
      <span className="sync-diff-line tabular" aria-hidden="true">
        {cell?.line ?? ""}
      </span>
      <span className="sync-diff-text">{cell ? cell.text || " " : ""}</span>
    </div>
  );
}

/** Side-by-side diff of a conflict with resolve actions. */
export function ConflictDiffModal({ conflictId, onClose }: { conflictId: string | null; onClose: () => void }) {
  const resolve = useSyncStore((s) => s.resolveConflict);
  const toast = useToast();
  const [detail, setDetail] = useState<SyncConflictDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SyncKeepChoice | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!conflictId) return;
    let cancelled = false;
    getSyncConflict(conflictId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [conflictId]);

  const rows = useMemo<(DiffRow | DiffSkip)[]>(() => {
    if (!detail || detail.binary) return [];
    const ops = diffLines(detail.current_content ?? "", detail.other_content ?? "");
    return collapseRows(sideBySide(ops), 3);
  }, [detail]);

  const stats = useMemo(() => {
    if (!detail || detail.binary) return null;
    return diffStats(diffLines(detail.current_content ?? "", detail.other_content ?? ""));
  }, [detail]);

  const conflict = detail?.conflict;

  const choose = async (keep: SyncKeepChoice) => {
    if (!conflict) return;
    setBusy(keep);
    try {
      await resolve(conflict.id, keep);
      toast.success("Conflict resolved", {
        description:
          keep === "local"
            ? "Kept the note's version; the conflict copy moved to the trash."
            : keep === "remote"
              ? "The note now has the conflict copy's content; the copy moved to the trash."
              : "Both files were kept.",
      });
      onClose();
    } catch (e) {
      toast.error("Could not resolve the conflict", { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const resolved = conflict?.resolved ?? false;

  return (
    <Modal
      open={conflictId !== null}
      onClose={onClose}
      title={conflict ? conflict.display_path : "Conflict"}
      description={
        conflict
          ? `Both devices changed this ${conflict.kind === "app" ? "app-data file" : "note"}. Detected by ${conflict.detected_by_name} ${relativeTime(conflict.detected_at)}.`
          : undefined
      }
      icon={GitCompareArrows}
      size="xl"
      headerActions={
        stats ? (
          <span className="sync-diff-stats tabular" aria-label={`${stats.added} lines only in the copy, ${stats.removed} lines only in the note`}>
            <span className="is-added">+{stats.added}</span> <span className="is-removed">−{stats.removed}</span>
          </span>
        ) : undefined
      }
      footerStart={
        conflict && !resolved ? (
          <Button variant="ghost" onClick={() => void choose("both")} loading={busy === "both"} disabled={busy !== null}>
            Keep both files
          </Button>
        ) : undefined
      }
      footer={
        conflict && !resolved ? (
          <>
            <Button variant="secondary" onClick={() => void choose("remote")} loading={busy === "remote"} disabled={busy !== null || !conflict.copy_exists}>
              Use the copy
            </Button>
            <Button variant="primary" onClick={() => void choose("local")} loading={busy === "local"} disabled={busy !== null}>
              Keep the note
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {error && (
        <p className="ui-field-error" role="alert">
          {error}
        </p>
      )}
      {!detail && !error && (
        <div className="sync-inline-loading">
          <Spinner size={14} /> <span>Decrypting both versions…</span>
        </div>
      )}
      {conflict && detail && (
        <div className="sync-diff">
          {resolved && (
            <div className="ui-notice ui-notice-success sync-notice" role="status">
              Resolved by {conflict.resolved_by_name ?? "a device"}
              {conflict.resolved_at ? ` ${relativeTime(conflict.resolved_at)}` : ""}.
            </div>
          )}
          {!conflict.copy_exists && !resolved && (
            <div className="ui-notice ui-notice-warning sync-notice" role="note">
              The conflict copy is no longer on this device — only “Keep the note” or “Keep both files” are possible.
            </div>
          )}
          <div className="sync-diff-head">
            <SideLabel
              title="In the note"
              device={conflict.current.device_name}
              time={conflict.current.modified_at}
              thisDevice={conflict.current.is_this_device}
            />
            <SideLabel
              title="Conflict copy"
              device={conflict.other.device_name}
              time={conflict.other.modified_at}
              thisDevice={conflict.other.is_this_device}
            />
          </div>
          {detail.binary ? (
            <EmptyState
              size="sm"
              icon={GitCompareArrows}
              title="No text preview"
              description="One of the versions is binary or larger than 2 MB. Both files are in your vault — compare them in Finder."
            />
          ) : rows.length === 0 ? (
            <EmptyState size="sm" icon={GitCompareArrows} title="Both versions are empty" />
          ) : (
            <div className="sync-diff-table mono" role="table" aria-label="Side-by-side comparison">
              {rows.map((row, i) =>
                row.kind === "skip" ? (
                  <div key={`skip-${i}`} className="sync-diff-skip" role="row">
                    <span role="cell">
                      {row.count} unchanged line{row.count === 1 ? "" : "s"}
                    </span>
                  </div>
                ) : (
                  <div key={i} className={cx("sync-diff-row", `is-${row.kind}`)} role="row">
                    <Cell cell={row.left} kind={row.kind} side="left" />
                    <Cell cell={row.right} kind={row.kind} side="right" />
                  </div>
                )
              )}
            </div>
          )}
          <div className="sync-diff-legend">
            <Badge size="sm" variant="danger">
              only in the note
            </Badge>
            <Badge size="sm" variant="success">
              only in the copy
            </Badge>
            <span className="ui-field-hint mono">{conflict.display_copy_path}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
