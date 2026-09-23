import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Badge, Button, Modal, Spinner, Switch, cx } from "../../ui";
import { describeAction } from "../../lib/agentActions";
import { allowToggleLabel } from "../../lib/intel/risk";
import { previewAgentAction } from "../../lib/ipc";
import { useIntelStore, type ApprovalItem } from "../../lib/intelStore";
import type { ActionPreview, AgentAction } from "../../types";
import "../../styles/views/intel.css";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Plain-language heading of the approval card (details follow below it). */
export function approvalTitle(action: AgentAction): string {
  switch (action.action) {
    case "run_command":
      return "Run a shell command";
    case "delete_note":
      return "Move a note to the trash";
    case "move_note":
      return "Move a note";
    case "git_commit":
      return "Commit repository changes";
    case "toggle_vault_task":
      return "Tick or untick a task";
    case "update_calendar_event":
      return "Change a calendar event";
    case "delete_calendar_event":
      return "Delete a calendar event";
    case "import_calendar_ics":
      return "Import a calendar file";
    default:
      return describeAction(action);
  }
}

const orDash = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : v);

/** The full details of an action, command text in mono, paths resolved. */
function ActionFields({ action, preview }: { action: AgentAction; preview: ActionPreview | undefined }) {
  const target = preview?.target ?? null;
  switch (action.action) {
    case "run_command":
      return (
        <dl className="intel-approval-fields">
          <Field label="Command">
            <code className="intel-code">{action.command}</code>
          </Field>
          <Field label="Directory">
            <span className="intel-path">{target ?? (action.cwd || "the vault")}</span>
          </Field>
        </dl>
      );
    case "delete_note":
      return (
        <dl className="intel-approval-fields">
          <Field label="Note">
            <span className="intel-path">{target ?? action.path}</span>
          </Field>
        </dl>
      );
    case "move_note":
      return (
        <dl className="intel-approval-fields">
          <Field label="From">
            <span className="intel-path">{target ?? action.from}</span>
          </Field>
          <Field label="To">
            <span className="intel-path">{action.to}</span>
          </Field>
        </dl>
      );
    case "git_commit":
      return (
        <dl className="intel-approval-fields">
          <Field label="Repository">
            <span className="intel-path">{target ?? action.project_path}</span>
          </Field>
          <Field label="Message">
            <code className="intel-code">{action.message}</code>
          </Field>
        </dl>
      );
    case "toggle_vault_task":
      return (
        <dl className="intel-approval-fields">
          <Field label="Note">
            <span className="intel-path">{target ?? action.note_path}</span>
          </Field>
          <Field label="Line">{action.line}</Field>
        </dl>
      );
    case "update_calendar_event": {
      const changes = (
        ["title", "description", "all_day", "start", "end", "due", "color", "tags", "attendees", "location"] as const
      )
        .filter((k) => action[k] !== null && action[k] !== undefined)
        .map((k) => `${k.replace("_", " ")}: ${Array.isArray(action[k]) ? (action[k] as string[]).join(", ") : String(action[k])}`);
      return (
        <dl className="intel-approval-fields">
          <Field label="Event">
            <span className="intel-path">{action.id}</span>
          </Field>
          <Field label="Changes">{changes.length ? changes.join(" · ") : "—"}</Field>
        </dl>
      );
    }
    case "delete_calendar_event":
      return (
        <dl className="intel-approval-fields">
          <Field label="Event">
            <span className="intel-path">{action.id}</span>
          </Field>
          <Field label="Effect">Deleted permanently</Field>
        </dl>
      );
    case "import_calendar_ics":
      return (
        <dl className="intel-approval-fields">
          <Field label="File">
            <span className="intel-path">{action.path}</span>
          </Field>
          <Field label="Existing events">{action.overwrite_existing ? "Overwritten on conflict" : "Kept"}</Field>
          <Field label="Color">{orDash(action.default_color)}</Field>
        </dl>
      );
    default:
      return (
        <dl className="intel-approval-fields">
          <Field label="Payload">
            <code className="intel-code">{JSON.stringify(action, null, 2)}</code>
          </Field>
        </dl>
      );
  }
}

/**
 * Approval dialog for `confirm` and `dangerous` agent actions. Lists every
 * pending action of the reply; the current one shows its full details and
 * the resolved targets from `cmd_intel_preview_action`. Closing the dialog
 * (Escape, backdrop, ×) denies everything that is still pending.
 */
export function ApprovalModal() {
  const approvals = useIntelStore((s) => s.approvals);
  const resolveApproval = useIntelStore((s) => s.resolveApproval);
  const approveAll = useIntelStore((s) => s.approveAll);
  const denyAll = useIntelStore((s) => s.denyAll);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [previews, setPreviews] = useState<Record<string, ActionPreview | "loading">>({});

  const current: ApprovalItem | undefined = useMemo(
    () => approvals.find((a) => a.runId === currentId) ?? approvals[0],
    [approvals, currentId]
  );

  useEffect(() => {
    setRemember(false);
  }, [current?.runId]);

  useEffect(() => {
    for (const item of approvals) {
      if (previews[item.runId] !== undefined) continue;
      setPreviews((p) => ({ ...p, [item.runId]: "loading" }));
      previewAgentAction(item.action)
        .then((preview) => setPreviews((p) => ({ ...p, [item.runId]: preview })))
        .catch((e) =>
          setPreviews((p) => ({
            ...p,
            [item.runId]: { target: null, details: [], warnings: [], error: e instanceof Error ? e.message : String(e) },
          }))
        );
    }
  }, [approvals, previews]);

  if (!current) return null;
  const rawPreview = previews[current.runId];
  const preview = rawPreview === "loading" ? undefined : rawPreview;
  const dangerous = current.risk === "dangerous";
  const others = approvals.filter((a) => a.runId !== current.runId);
  const count = approvals.length;

  const approve = () => resolveApproval(current.runId, "approved", remember);
  const deny = () => resolveApproval(current.runId, "denied");

  return (
    <Modal
      open
      onClose={denyAll}
      size="md"
      icon={ShieldAlert}
      title={count > 1 ? `Approve ${count} agent actions` : "Approve agent action"}
      description="The agent wants to do something that changes or removes data. Nothing runs until you approve."
      footerStart={
        <Button variant="ghost" onClick={count > 1 ? denyAll : deny}>
          {count > 1 ? "Deny all" : "Deny"}
        </Button>
      }
      footer={
        <>
          {count > 1 && (
            <>
              <Button variant="secondary" onClick={deny}>
                Deny
              </Button>
              <Button variant="secondary" onClick={approveAll}>
                Approve all ({count})
              </Button>
            </>
          )}
          <Button variant={dangerous ? "danger" : "primary"} onClick={approve}>
            Approve
          </Button>
        </>
      }
    >
      <div className="intel-approval">
        <div className={cx("intel-approval-card", dangerous && "is-dangerous")}>
          <div className="intel-approval-heading">
            <span className="intel-approval-summary">{approvalTitle(current.action)}</span>
            <Badge variant={dangerous ? "danger" : "warning"} dot>
              {dangerous ? "Dangerous" : "Needs approval"}
            </Badge>
          </div>
          <ActionFields action={current.action} preview={preview} />
          {rawPreview === "loading" && (
            <span className="intel-drawer-state">
              <Spinner size={12} /> Checking what this touches…
            </span>
          )}
          {preview && preview.details.length > 0 && (
            <ul className="intel-approval-details">
              {preview.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {preview?.warnings.map((w) => (
            <div key={w} className="ui-notice ui-notice-danger" role="alert">
              <AlertTriangle size={13} /> {w}
            </div>
          ))}
          {preview?.error && (
            <div className="ui-notice ui-notice-warning">
              <AlertTriangle size={13} /> This will probably fail: {preview.error}
            </div>
          )}
          <Switch
            size="sm"
            checked={remember}
            onChange={setRemember}
            label={allowToggleLabel(current.action)}
            description={
              dangerous
                ? "Matching actions run without asking until you quit AETHER-OS."
                : "Matching actions run without asking. Revoke in Settings → AI Intelligence."
            }
          />
        </div>

        {others.length > 0 && (
          <div>
            <span className="ui-section-label">Also waiting ({others.length})</span>
            <div className="intel-approval-queue">
              {others.map((item) => (
                <button
                  key={item.runId}
                  type="button"
                  className="intel-approval-queue-row"
                  onClick={() => setCurrentId(item.runId)}
                >
                  <span className={cx("intel-risk-dot", item.risk === "dangerous" && "is-dangerous")} aria-hidden="true" />
                  <span>{describeAction(item.action)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
