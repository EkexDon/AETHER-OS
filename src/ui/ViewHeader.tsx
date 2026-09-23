import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./utils";

export interface ViewHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional lucide icon shown before the title. */
  icon?: LucideIcon;
  /** Right-aligned actions (buttons, search field, segmented control). */
  actions?: ReactNode;
  /** A second row under the title, typically `<Tabs>`. */
  tabs?: ReactNode;
  /** Draw a bottom border (for views whose body is a full-bleed surface). */
  bordered?: boolean;
  /** Tighter variant for tool views (graph, calendar). */
  compact?: boolean;
  className?: string;
}

/** The header every view starts with: title, subtitle, actions, optional tabs. */
export function ViewHeader({ title, subtitle, icon: Icon, actions, tabs, bordered, compact, className }: ViewHeaderProps) {
  return (
    <header className={cx("ui-view-header", bordered && "is-bordered", compact && "is-compact", className)}>
      <div className="ui-view-header-row">
        <div className="ui-view-header-titles">
          <h1 className="ui-view-header-title">
            {Icon && (
              <span className="ui-view-header-icon" aria-hidden="true">
                <Icon size={16} strokeWidth={1.9} />
              </span>
            )}
            <span className="ui-view-header-title-text">{title}</span>
          </h1>
          {subtitle && <p className="ui-view-header-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="ui-view-header-actions">{actions}</div>}
      </div>
      {tabs && <div className="ui-view-header-tabs">{tabs}</div>}
    </header>
  );
}
