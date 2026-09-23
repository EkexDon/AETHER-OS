import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Spinner } from "./Spinner";
import { cx } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. `primary` is the single most important action on screen. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets `aria-busy` and blocks clicks. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Stretch to the container width. */
  fullWidth?: boolean;
}

/**
 * The standard button. Defaults to `type="button"` so it never submits a
 * surrounding form by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    iconLeft,
    iconRight,
    fullWidth,
    disabled,
    className,
    children,
    type = "button",
    onClick,
    ...rest
  },
  ref
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "ui-button",
        `ui-button-${variant}`,
        `ui-button-${size}`,
        fullWidth && "ui-button-full",
        loading && "is-loading",
        className
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={isDisabled ? undefined : onClick}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === "sm" ? 12 : 14} />
      ) : (
        iconLeft && <span className="ui-button-icon">{iconLeft}</span>
      )}
      {children !== undefined && children !== null && children !== false && (
        <span className="ui-button-label">{children}</span>
      )}
      {iconRight && !loading && <span className="ui-button-icon">{iconRight}</span>}
    </button>
  );
});
