import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./utils";

export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: "sm" | "md";
  /** Leading status dot in the badge color. */
  dot?: boolean;
  icon?: ReactNode;
  /** Outline style instead of a soft fill. */
  outline?: boolean;
}

/** Small status / count label (radius 4px). */
export function Badge({ variant = "neutral", size = "sm", dot, icon, outline, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx("ui-badge", `ui-badge-${variant}`, `ui-badge-${size}`, outline && "is-outline", className)}
      {...rest}
    >
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      {icon && <span className="ui-badge-icon">{icon}</span>}
      {children}
    </span>
  );
}
