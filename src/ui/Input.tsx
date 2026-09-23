import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md" | "lg";
  /** Icon rendered inside the field on the left. */
  iconLeft?: ReactNode;
  /** Content inside the field on the right (a Kbd hint, a clear button…). */
  suffix?: ReactNode;
  /** Error styling + `aria-invalid`. */
  invalid?: boolean;
  /** Class for the outer wrapper (the input itself gets `inputClassName`). */
  className?: string;
  inputClassName?: string;
}

/** Single-line text field. The ref points at the `<input>`. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", iconLeft, suffix, invalid, className, inputClassName, disabled, ...rest },
  ref
) {
  return (
    <span
      className={cx(
        "ui-input",
        `ui-input-${size}`,
        invalid && "is-invalid",
        disabled && "is-disabled",
        iconLeft && "has-icon",
        className
      )}
    >
      {iconLeft && <span className="ui-input-icon">{iconLeft}</span>}
      <input
        ref={ref}
        className={cx("ui-input-field", inputClassName)}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        {...rest}
      />
      {suffix && <span className="ui-input-suffix">{suffix}</span>}
    </span>
  );
});
