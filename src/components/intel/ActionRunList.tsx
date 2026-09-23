import { useState } from "react";
import { Ban, Check, ChevronRight, CircleDashed, ShieldAlert, SquareTerminal, Wrench, X } from "lucide-react";
import { Badge, IconButton, Spinner, cx } from "../../ui";
import { actionLabel, describeAction } from "../../lib/agentActions";
import type { ActionRun } from "../../lib/intelStore";
import type { CommandOutput } from "../../types";
import "../../styles/views/intel.css";

/** Terminal-styled, expandable output of a `run_command` action. */
export function CommandOutputBlock({ output, defaultOpen = false }: { output: CommandOutput; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const status = output.timed_out
    ? "timed out"
    : output.exit_code === null
      ? "killed"
      : `exit ${output.exit_code}`;
  return (
    <>
      <button type="button" className="intel-output-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={11} style={{ transform: open ? "rotate(90deg)" : undefined }} aria-hidden="true" />
        <SquareTerminal size={11} aria-hidden="true" />
        Output · {status} · {output.duration_ms} ms
      </button>
      {open && (
        <pre className="intel-terminal" aria-label="Command output">
          <span className="intel-terminal-prompt">
            {output.cwd} $ {output.command}
            {"\n"}
          </span>
          {output.stdout}
          {output.stderr && <span className="intel-terminal-stderr">{output.stderr}</span>}
          {!output.stdout && !output.stderr && <span className="intel-terminal-meta">(no output){"\n"}</span>}
          {output.truncated && <span className="intel-terminal-meta">{"\n"}[output truncated at 64 KB]</span>}
        </pre>
      )}
    </>
  );
}

function StatusIcon({ run }: { run: ActionRun }) {
  switch (run.status) {
    case "running":
      return <Spinner size={12} label="Running" />;
    case "done":
      return <Check size={13} aria-label="Done" />;
    case "error":
      return <X size={13} aria-label="Failed" />;
    case "denied":
      return <Ban size={12} aria-label="Denied" />;
    case "awaiting":
      return <ShieldAlert size={13} aria-label="Waiting for approval" />;
    default:
      return <CircleDashed size={12} aria-label="Queued" />;
  }
}

/** The "Tools used" panel under the chat: one card per agent action. */
export function ActionRunList({ runs, onClear }: { runs: ActionRun[]; onClear?: () => void }) {
  if (runs.length === 0) return null;
  const busy = runs.some((r) => r.status === "running" || r.status === "awaiting" || r.status === "queued");
  return (
    <div className="intel-runs" aria-label="Agent actions">
      <div className="intel-runs-header">
        <Wrench size={12} aria-hidden="true" />
        <span>Tools used ({runs.length})</span>
        {onClear && !busy && (
          <IconButton
            className="intel-runs-clear"
            size="sm"
            label="Clear tool results"
            icon={<X size={12} />}
            onClick={onClear}
          />
        )}
      </div>
      {runs.map((run) => (
        <div key={run.id} className={cx("intel-run", `is-${run.status}`)}>
          <div className="intel-run-line">
            <span className="intel-run-status">
              <StatusIcon run={run} />
            </span>
            <span className="intel-run-label" title={describeAction(run.action)}>
              {run.status === "done" ? actionLabel(run.action) : describeAction(run.action)}
            </span>
            {run.risk === "dangerous" && <Badge variant="danger">dangerous</Badge>}
            {run.risk === "confirm" && <Badge variant="warning">approval</Badge>}
          </div>
          {run.status === "awaiting" && <div className="intel-run-message">Waiting for your approval…</div>}
          {run.message && <div className="intel-run-message">{run.message}</div>}
          {run.output && <CommandOutputBlock output={run.output} />}
        </div>
      ))}
    </div>
  );
}
