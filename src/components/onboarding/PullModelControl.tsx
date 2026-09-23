import { CircleCheck, Download, RotateCcw, X } from "lucide-react";
import { Badge, Button, IconButton, cx } from "../../ui";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { describePullStatus, pullPercent } from "../../lib/onboarding/models";

/** Progress bar for a model download; indeterminate while the size is unknown. */
export function PullProgressBar({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div
      className={cx("ob-progress", percent === null && "is-indeterminate")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      <span className="ob-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

/**
 * Download button for one Ollama model with live progress, cancel and
 * retry. The download lives in the onboarding store, so it keeps running
 * (and stays visible elsewhere) when this control unmounts.
 */
export function PullModelControl({
  model,
  installed,
  sizeLabel,
  disabled,
  onInstalled,
  compact,
}: {
  model: string;
  /** Already present in Ollama. */
  installed: boolean;
  /** Shown on the button, e.g. "2.0 GB". */
  sizeLabel?: string;
  /** e.g. Ollama offline. */
  disabled?: boolean;
  /** Called after a successful download. */
  onInstalled?: (model: string) => void;
  /** Hide the status text (tight rows). */
  compact?: boolean;
}) {
  const pull = useOnboardingStore((s) => s.pulls[model.trim()]);
  const startPull = useOnboardingStore((s) => s.startPull);
  const cancelPull = useOnboardingStore((s) => s.cancelPull);

  const start = async () => {
    try {
      const outcome = await startPull(model);
      if (outcome && !outcome.cancelled) onInstalled?.(model.trim());
    } catch {
      // The store already shows a toast and keeps the error for the retry state.
    }
  };

  if (pull?.phase === "running") {
    const percent = pullPercent(pull);
    const status = describePullStatus(pull);
    return (
      <div className={cx("ob-pull", compact && "is-compact")}>
        <div className="ob-pull-main">
          <PullProgressBar percent={percent} label={`Downloading ${model}`} />
          {!compact && <span className="ob-pull-status tabular">{status}</span>}
        </div>
        <IconButton size="sm" label={`Cancel download of ${model}`} icon={<X size={14} />} onClick={() => void cancelPull(model)} />
      </div>
    );
  }

  if (installed || pull?.phase === "done") {
    return (
      <Badge variant="success" icon={<CircleCheck size={14} />}>
        Installed
      </Badge>
    );
  }

  if (pull?.phase === "error") {
    return (
      <div className={cx("ob-pull", compact && "is-compact")}>
        {!compact && (
          <span className="ob-pull-error" title={pull.error ?? undefined}>
            {pull.error}
          </span>
        )}
        <Button size="sm" variant="secondary" iconLeft={<RotateCcw size={14} />} onClick={() => void start()} disabled={disabled}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" variant="secondary" iconLeft={<Download size={14} />} onClick={() => void start()} disabled={disabled}>
      {sizeLabel ? `Download · ${sizeLabel}` : "Download"}
    </Button>
  );
}
