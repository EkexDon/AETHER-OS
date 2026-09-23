import { forwardRef, useEffect, useId, useRef, type ChangeEvent, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { cx, mergeRefs } from "./utils";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void;
  /** Mixed state (e.g. "some notes selected"). */
  indeterminate?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  id?: string;
}

/** A native checkbox with a custom box; keeps native keyboard + form behavior. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onChange, indeterminate = false, label, description, disabled, className, id, ...aria },
  ref
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const innerRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={cx(
        "ui-checkbox",
        checked && "is-checked",
        indeterminate && "is-indeterminate",
        disabled && "is-disabled",
        className
      )}
      htmlFor={inputId}
    >
      <input
        ref={mergeRefs(innerRef, ref)}
        id={inputId}
        type="checkbox"
        className="ui-checkbox-input"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : aria["aria-label"]}
        aria-checked={indeterminate ? "mixed" : checked}
        onChange={(e) => onChange(e.target.checked, e)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        {indeterminate ? <Minus size={12} strokeWidth={3} /> : checked ? <Check size={12} strokeWidth={3} /> : null}
      </span>
      {(label || description) && (
        <span className="ui-checkbox-text">
          {label && <span className="ui-checkbox-label">{label}</span>}
          {description && <span className="ui-checkbox-description">{description}</span>}
        </span>
      )}
    </label>
  );
});
