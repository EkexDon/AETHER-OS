import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";
import { Spinner } from "./Spinner";
import { cx, type Placement } from "./utils";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required accessible name; also shown as the tooltip. */
  label: string;
  /** The icon (lucide, 14/16/18). */
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "danger";
  size?: "sm" | "md";
  /** Pressed/toggled state (sets `aria-pressed`). */
  active?: boolean;
  loading?: boolean;
  /** Shortcut shown inside the tooltip. */
  shortcut?: string;
  /** Show the tooltip (default true). */
  tooltip?: boolean;
  tooltipPlacement?: Placement;
}

/** A square icon-only button with a mandatory label and a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = "ghost",
    size = "md",
    active,
    loading,
    shortcut,
    tooltip = true,
    tooltipPlacement = "top",
    className,
    disabled,
    type = "button",
    ...rest
  },
  ref
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cx(
        "ui-icon-button",
        `ui-icon-button-${variant}`,
        `ui-icon-button-${size}`,
        active && "is-active",
        className
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 12 : 14} /> : icon}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltipPlacement} describeChild={false}>
      {button}
    </Tooltip>
  );
});
