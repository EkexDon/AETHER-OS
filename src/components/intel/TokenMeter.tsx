import { Gauge } from "lucide-react";
import { Tooltip, cx } from "../../ui";
import { formatTokens, meterLevel } from "../../lib/intel/tokens";
import "../../styles/views/intel.css";

export interface TokenMeterProps {
  /** Estimated tokens of the prompt window (summary + recent messages). */
  tokens: number;
  threshold: number;
  autoCompact: boolean;
  compacting: boolean;
  /** Compact now; the chip is disabled without it. */
  onCompact?: () => void;
}

/**
 * Engine-bar chip showing how full the conversation window is. The colour
 * follows tokens / threshold (neutral, warning from 75 %, danger beyond);
 * clicking compacts the conversation.
 */
export function TokenMeter({ tokens, threshold, autoCompact, compacting, onCompact }: TokenMeterProps) {
  const level = meterLevel(tokens, threshold);
  const ratio = threshold > 0 ? Math.min(1, tokens / threshold) : 0;
  const tip = compacting
    ? "Compacting the conversation…"
    : `≈ ${tokens.toLocaleString()} tokens in the chat window · ${
        autoCompact ? `compacts automatically above ${threshold.toLocaleString()}` : "auto-compaction is off"
      }${onCompact ? " · click to compact now" : ""}`;
  return (
    <Tooltip content={tip} placement="bottom">
      <button
        type="button"
        className={cx("intel-meter", `is-${level}`, compacting && "is-busy")}
        onClick={onCompact}
        disabled={!onCompact || compacting}
        aria-label={`Conversation size: about ${tokens} tokens of ${threshold}`}
      >
        <Gauge size={11} aria-hidden="true" />
        <span>{formatTokens(tokens)}</span>
        <span className="intel-meter-limit">/ {formatTokens(threshold)}</span>
        <span className="intel-meter-bar" style={{ width: `${Math.round(ratio * 100)}%` }} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
