import { forwardRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./utils";

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  /** Secondary line under the title. */
  description?: ReactNode;
  /** Right-aligned metadata (date, count, badge). */
  meta?: ReactNode;
  /** Buttons revealed on hover / focus (e.g. delete). */
  actions?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  /** Left indent level (tree rows). */
  indent?: number;
}

/**
 * A single row in a list: icon · title/description · meta · hover actions.
 * With `onClick` it acts as a button (Enter / Space activate it); nested
 * action buttons stay independently focusable.
 */
export const ListRow = forwardRef<HTMLDivElement, ListRowProps>(function ListRow(
  { icon, title, description, meta, actions, selected, disabled, indent = 0, className, onClick, onKeyDown, style, ...rest },
  ref
) {
  const clickable = !!onClick && !disabled;
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (!clickable || e.defaultPrevented || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.currentTarget.click();
    }
  };
  return (
    <div
      ref={ref}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-current={selected ? "true" : undefined}
      aria-disabled={disabled || undefined}
      className={cx(
        "ui-list-row",
        clickable && "is-clickable",
        selected && "is-selected",
        disabled && "is-disabled",
        description ? "has-description" : undefined,
        className
      )}
      style={indent ? { paddingLeft: `calc(var(--row-pad-x) + ${indent * 14}px)`, ...style } : style}
      onClick={clickable ? onClick : undefined}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {icon && <span className="ui-list-row-icon">{icon}</span>}
      <span className="ui-list-row-body">
        <span className="ui-list-row-title">{title}</span>
        {description && <span className="ui-list-row-description">{description}</span>}
      </span>
      {meta && <span className="ui-list-row-meta">{meta}</span>}
      {actions && (
        <span className="ui-list-row-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
  );
});
