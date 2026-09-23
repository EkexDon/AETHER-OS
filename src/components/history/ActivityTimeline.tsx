import { useEffect, useMemo } from "react";
import { Activity, FilePen, FilePlus2, Files, Flag, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import {
  commitKind,
  describeActivity,
  formatClock,
  formatDateTime,
  groupByDay,
  isNotePath,
  noteTitle,
} from "../../lib/history/format";
import { useHistoryStore } from "../../lib/historyStore";
import type { HistoryActivity } from "../../types";
import { Badge, EmptyState, IconButton, Spinner, cx } from "../../ui";
import { useNow } from "./hooks";

/** File chips shown under a multi-file commit. */
const FILE_CHIPS = 4;

export interface ActivityTimelineProps {
  /** Note shown in the versions column (entries touching it are marked). */
  selectedPath: string | null;
  /** Open a note at a version. */
  onPick: (path: string, commitId: string) => void;
}

function ActivityIcon({ activity }: { activity: HistoryActivity }) {
  const kind = commitKind(activity.message);
  if (kind === "restore") return <RotateCcw size={14} />;
  if (kind === "initial") return <Flag size={14} />;
  if (activity.file_count > 1) return <Files size={14} />;
  const change = activity.files[0]?.change;
  if (change === "added") return <FilePlus2 size={14} />;
  if (change === "deleted") return <Trash2 size={14} />;
  return <FilePen size={14} />;
}

/** Vault-wide activity feed, grouped by day, newest first. */
export function ActivityTimeline({ selectedPath, onPick }: ActivityTimelineProps) {
  const recent = useHistoryStore((s) => s.recent);
  const loaded = useHistoryStore((s) => s.recentLoaded);
  const loading = useHistoryStore((s) => s.recentLoading);
  const error = useHistoryStore((s) => s.recentError);
  const refresh = useHistoryStore((s) => s.refreshRecent);
  const now = useNow(60_000);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => groupByDay(recent, now), [recent, now]);

  let body;
  if (error) {
    body = (
      <div className="ui-notice ui-notice-danger history-inline-notice" role="alert">
        {error}
      </div>
    );
  } else if (!loaded) {
    body = (
      <div className="history-loading" role="status">
        <Spinner size={14} />
        <span>Loading activity…</span>
      </div>
    );
  } else if (recent.length === 0) {
    body = (
      <EmptyState
        size="sm"
        icon={Activity}
        title="No activity yet"
        description="Saved notes show up here a few seconds after each save."
      />
    );
  } else {
    body = (
      <div className="history-timeline">
        {groups.map((group) => (
          <section key={group.key} className="history-day" aria-label={group.label}>
            <h3 className="ui-section-label history-day-label">{group.label}</h3>
            <ol className="history-day-list">
              {group.items.map((activity) => {
                const { title, detail } = describeActivity(activity);
                const firstNote = activity.files.find((f) => isNotePath(f.rel_path) && f.change !== "deleted")
                  ?? activity.files.find((f) => isNotePath(f.rel_path));
                const touchesSelected = !!selectedPath && activity.files.some((f) => f.path === selectedPath);
                return (
                  <li key={activity.commit_id} className="history-activity-item">
                    <button
                      type="button"
                      className={cx("history-activity", touchesSelected && "is-related")}
                      disabled={!firstNote}
                      onClick={() => firstNote && onPick(firstNote.path, activity.commit_id)}
                      title={activity.message}
                    >
                      <span className="history-activity-icon" aria-hidden="true">
                        <ActivityIcon activity={activity} />
                      </span>
                      <span className="history-activity-body">
                        <span className="history-activity-title">{title}</span>
                        <span className="history-activity-detail">{detail}</span>
                      </span>
                      <time
                        className="history-activity-time tabular"
                        dateTime={new Date(activity.time * 1000).toISOString()}
                        title={formatDateTime(activity.time)}
                      >
                        {formatClock(activity.time)}
                      </time>
                    </button>
                    {activity.file_count > 1 && commitKind(activity.message) !== "initial" && (
                      <div className="history-activity-files">
                        {activity.files.slice(0, FILE_CHIPS).map((file) => (
                          <button
                            key={file.rel_path}
                            type="button"
                            className={cx("history-file-chip", `is-${file.change}`)}
                            disabled={!isNotePath(file.rel_path)}
                            onClick={() => onPick(file.path, activity.commit_id)}
                            title={file.rel_path}
                          >
                            {noteTitle(file.rel_path)}
                          </button>
                        ))}
                        {activity.file_count > FILE_CHIPS && (
                          <span className="history-file-more">+{activity.file_count - FILE_CHIPS}</span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    );
  }

  return (
    <section className="history-pane history-activity-pane" aria-label="Activity">
      <div className="history-pane-head">
        <div className="history-pane-titles">
          <h2 className="history-pane-title">
            Activity
            {recent.length > 0 && (
              <Badge variant="neutral" className="history-count">
                {recent.length}
              </Badge>
            )}
          </h2>
          <p className="history-pane-subtitle">Every snapshot of the vault</p>
        </div>
        <div className="history-pane-actions">
          <IconButton
            size="sm"
            label="Refresh activity"
            icon={<RefreshCw size={14} />}
            loading={loading && loaded}
            onClick={() => void refresh()}
          />
        </div>
      </div>
      <div className="history-pane-scroll">{body}</div>
    </section>
  );
}
