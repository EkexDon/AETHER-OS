import { cx } from "./utils";

export interface SpinnerProps {
  /** Diameter in px (icons use 14/16/18). */
  size?: number;
  /** Accessible label; when omitted the spinner is decorative. */
  label?: string;
  className?: string;
}

/** A small circular progress indicator that inherits `currentColor`. */
export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const stroke = size <= 14 ? 1.75 : 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className={cx("ui-spinner", className)}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" strokeOpacity={0.2} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.28} ${c}`}
        />
      </svg>
    </span>
  );
}
