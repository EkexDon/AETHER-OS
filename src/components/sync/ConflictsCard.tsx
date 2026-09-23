import { useState } from "react";
import { CircleCheck, GitCompareArrows, Lock } from "lucide-react";
import { useSyncStore } from "../../lib/syncStore";
import { relativeTime } from "../../lib/sync/format";
import { Badge, Button, EmptyState, ListRow } from "../../ui";
import { ConflictDiffModal } from "./ConflictDiffModal";

const RESOLUTION_LABEL = { local: "kept the note", remote: "used the copy", both: "kept both" } as const;

/** Unresolved conflicts (compare + resolve) and recently resolved ones. */
export function ConflictsCard() {
  const status = useSyncStore((s) => s.status);
  const conflicts = useSyncStore((s) => s.conflicts);
  const openUnlock = useSyncStore((s) => s.openUnlock);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const open = conflicts.filter((c) => !c.resolved);
  const resolved = conflicts.filter((c) => c.resolved);
  const locked = !status?.unlocked;

  return (
    <section className="sync-card" aria-labelledby="sync-conflicts-title">
      <header className="sync-card-header">
        <div>
          <h2 className="sync-card-title" id="sync-conflicts-title">
            Conflicts {open.length > 0 && <Badge size="sm" variant="warning">{open.length}</Badge>}
          </h2>
          <p className="sync-card-subtitle">When two devices change the same file, both versions are kept.</p>
        </div>
      </header>

      {!status?.configured ? (
        <EmptyState
          size="sm"
          icon={GitCompareArrows}
          title="Sync is not set up"
          description="Conflicts appear here once two devices sync through a folder."
        />
      ) : locked ? (
        <EmptyState
          size="sm"
          icon={Lock}
          title="Locked"
          description="Unlock sync to see conflicts."
          action={
            <Button size="sm" onClick={openUnlock}>
              Unlock
            </Button>
          }
        />
      ) : open.length === 0 ? (
        <EmptyState size="sm" icon={CircleCheck} title="No conflicts" description="Every file has one clear version." />
      ) : (
        <div className="sync-conflict-list" role="list" aria-label="Open conflicts">
          {open.map((c) => (
            <ListRow
              key={c.id}
              role="listitem"
              icon={<GitCompareArrows size={14} />}
              title={c.display_path}
              description={`Note kept ${c.current.is_this_device ? "this device's" : `${c.current.device_name}'s`} version · copy from ${
                c.other.is_this_device ? "this device" : c.other.device_name
              } · ${relativeTime(c.detected_at)}`}
              meta={c.kind === "app" ? <Badge size="sm">App data</Badge> : undefined}
              actions={
                <Button size="sm" variant="secondary" onClick={() => setOpenId(c.id)}>
                  Compare
                </Button>
              }
            />
          ))}
        </div>
      )}

      {!locked && resolved.length > 0 && (
        <div className="sync-resolved">
          <button type="button" className="sync-link" aria-expanded={showResolved} onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide resolved" : `Recently resolved (${resolved.length})`}
          </button>
          {showResolved && (
            <ul className="sync-resolved-list">
              {resolved.map((c) => (
                <li key={c.id}>
                  <span className="sync-resolved-path">{c.display_path}</span>
                  <span className="ui-field-hint">
                    {c.resolved_by_name ?? "A device"} {c.resolution ? RESOLUTION_LABEL[c.resolution] : "resolved it"}{" "}
                    {relativeTime(c.resolved_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConflictDiffModal conflictId={openId} onClose={() => setOpenId(null)} />
    </section>
  );
}
