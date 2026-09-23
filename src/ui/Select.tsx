import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "./utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "sm" | "md";
  /** Options; alternatively pass `<option>` children. */
  options?: SelectOption[];
  /** Optional leading icon. */
  iconLeft?: ReactNode;
  invalid?: boolean;
  /** Wrapper class; the `<select>` gets `selectClassName`. */
  className?: string;
  selectClassName?: string;
}

/**
 * A native `<select>` in AETHER styling. Native keeps full keyboard and
 * screen-reader support and the OS picker.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = "md", options, iconLeft, invalid, className, selectClassName, children, disabled, ...rest },
  ref
) {
  return (
    <span
      className={cx(
        "ui-select",
        `ui-select-${size}`,
        iconLeft && "has-icon",
        invalid && "is-invalid",
        disabled && "is-disabled",
        className
      )}
    >
      {iconLeft && <span className="ui-select-icon">{iconLeft}</span>}
      <select
        ref={ref}
        className={cx("ui-select-field", selectClassName)}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        {...rest}
      >
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown size={14} className="ui-select-chevron" aria-hidden="true" />
    </span>
  );
});
