import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./utils";

export interface EmptyStateProps {
  /** A lucide icon component (rendered at 18px inside a soft tile). */
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Primary action(s), typically a `<Button>`. */
  action?: ReactNode;
  /** `sm` for side panels and list placeholders. */
  size?: "sm" | "md";
  className?: string;
}

/** "Nothing here yet" placeholder with a clear next step. */
export function EmptyState({ icon: Icon, title, description, action, size = "md", className }: EmptyStateProps) {
  return (
    <div className={cx("ui-empty", `ui-empty-${size}`, className)}>
      {Icon && (
        <span className="ui-empty-icon" aria-hidden="true">
          <Icon size={size === "sm" ? 16 : 18} strokeWidth={1.75} />
        </span>
      )}
      <div className="ui-empty-title">{title}</div>
      {description && <div className="ui-empty-description">{description}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
