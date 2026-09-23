import { useState } from "react";
import { Cloud, CloudAlert, CloudOff, FolderSync, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { useSyncStore } from "../../lib/syncStore";
import {
  absoluteTime,
  baseName,
  describeReport,
  displayPath,
  progressPercent,
  relativeTime,
  statusSummary,
} from "../../lib/sync/format";
import { Badge, Button, Switch, Tooltip, cx } from "../../ui";
import { ProgressBar } from "./fields";
import { useSettingsPatch } from "./ScheduleControls";

function StateIcon({ state, enabled, configured }: { state: string; enabled: boolean; configured: boolean }) {
  if (!configured || !enabled) return <CloudOff size={18} />;
  if (state === "locked") return <Lock size={18} />;
  if (state === "error") return <CloudAlert size={18} />;
  if (state === "syncing") return <RefreshCw size={18} className="sync-spin" />;
  return <Cloud size={18} />;
}

/** Overview: state, folder, last sync, pending work, last report. */
export function SyncStatusCard() {
  const status = useSyncStore((s) => s.status);
  const settings = useSyncStore((s) => s.settings);
  const report = useSyncStore((s) => s.lastReport);
  const progress = useSyncStore((s) => s.progress);
  const openSetup = useSyncStore((s) => s.openSetup);
  const openUnlock = useSyncStore((s) => s.openUnlock);
  const patch = useSettingsPatch();
  const [showIssues, setShowIssues] = useState(false);

  const summary = statusSummary(status);
  const busy = status?.state === "syncing";
  const configured = !!status?.configured;
  const percent = progressPercent(progress);

  return (
    <section className="sync-card sync-status-card" aria-labelledby="sync-status-title" data-tone={summary.tone}>
      <div className="sync-status-main">
        <span className={cx("sync-status-icon", `is-${summary.tone}`)} aria-hidden="true">
          <StateIcon state={status?.state ?? "idle"} enabled={!!status?.enabled} configured={configured} />
        </span>
        <div className="sync-status-text">
          <div className="sync-status-line">
            <h2 className="sync-card-title" id="sync-status-title">
              {summary.label}
            </h2>
            {configured && (
              <Badge size="sm" variant={status?.unlocked ? "success" : "warning"} dot>
                {status?.unlocked ? "Unlocked" : "Locked"}
              </Badge>
            )}
          </div>
          <p className="sync-status-detail">{summary.detail}</p>
        </div>
        <div className="sync-card-actions">
          {!configured ? (
            <Button variant="secondary" iconLeft={<FolderSync size={14} />} onClick={openSetup}>
              Set up sync
            </Button>
          ) : !status?.unlocked ? (
            <Button variant="secondary" iconLeft={<Lock size={14} />} onClick={openUnlock}>
              Unlock
            </Button>
          ) : (
            <Switch
              size="sm"
              checked={!!settings?.enabled}
              onChange={(v) => void patch({ enabled: v }, v ? "Background sync resumed" : "Background sync paused")}
              label="Background sync"
            />
          )}
        </div>
      </div>

      {busy && (
        <div className="sync-progress-block">
          <ProgressBar percent={percent} label="Sync progress" />
        </div>
      )}

      {configured && (
        <dl className="sync-facts">
          <div>
            <dt>Folder</dt>
            <dd>
              <Tooltip content={settings?.sync_dir ?? ""} placement="top">
                <span className="sync-fact-path" tabIndex={0}>
                  {settings?.sync_dir ? baseName(settings.sync_dir) : "—"}
                </span>
              </Tooltip>
            </dd>
          </div>
          <div>
            <dt>Last sync</dt>
            <dd>
              <Tooltip content={absoluteTime(status?.last_sync_at)} placement="top">
                <span tabIndex={0}>{relativeTime(status?.last_sync_at)}</span>
              </Tooltip>
            </dd>
          </div>
          <div>
            <dt>Pending</dt>
            <dd className="tabular">
              ↑ {status?.pending_uploads ?? 0} · ↓ {status?.pending_downloads ?? 0}
            </dd>
          </div>
          <div>
            <dt>Conflicts</dt>
            <dd className={cx("tabular", (status?.conflicts ?? 0) > 0 && "is-warning")}>{status?.conflicts ?? 0}</dd>
          </div>
        </dl>
      )}

      {report && (
        <div className="sync-report">
          <span className="sync-report-summary">
            Last round: {describeReport(report)} · {(report.duration_ms / 1000).toFixed(1)} s
          </span>
          {report.issues.length > 0 && (
            <>
              <button
                type="button"
                className="sync-link"
                aria-expanded={showIssues}
                onClick={() => setShowIssues((v) => !v)}
              >
                <TriangleAlert size={14} aria-hidden="true" />
                {showIssues ? "Hide details" : `${report.issues.length} item(s) need attention`}
              </button>
              {showIssues && (
                <ul className="sync-issues">
                  {report.issues.slice(0, 20).map((issue, i) => (
                    <li key={`${issue.path}-${i}`}>
                      <span className="mono">{displayPath(issue.path)}</span> — {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {configured && (
        <p className="sync-status-footer ui-field-hint">
          This device: <strong>{status?.device_name}</strong>
          {settings ? ` · syncs ${settings.include_app_data ? "vault + app data" : "the vault"}` : ""}
        </p>
      )}
    </section>
  );
}
