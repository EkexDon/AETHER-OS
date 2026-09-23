import { forwardRef, useId, type ReactNode } from "react";
import { cx } from "./utils";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (also the accessible name). */
  label?: ReactNode;
  /** Secondary text under the label. */
  description?: ReactNode;
  /** Accessible name when no visible label is rendered. */
  "aria-label"?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  id?: string;
}

/** On/off toggle (`role="switch"`). Space and Enter toggle it. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, description, disabled, size = "md", className, id, ...aria },
  ref
) {
  const autoId = useId();
  const controlId = id ?? autoId;
  const labelId = `${controlId}-label`;
  const descId = `${controlId}-desc`;
  const control = (
    <button
      ref={ref}
      id={controlId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descId : undefined}
      aria-label={label ? undefined : aria["aria-label"]}
      disabled={disabled}
      className={cx("ui-switch", `ui-switch-${size}`, checked && "is-checked")}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </button>
  );
  if (!label) return <span className={cx("ui-switch-wrap", className)}>{control}</span>;
  return (
    <div className={cx("ui-switch-field", disabled && "is-disabled", className)}>
      <span className="ui-switch-text">
        <label id={labelId} htmlFor={controlId} className="ui-switch-label">
          {label}
        </label>
        {description && (
          <span id={descId} className="ui-switch-description">
            {description}
          </span>
        )}
      </span>
      {control}
    </div>
  );
});
