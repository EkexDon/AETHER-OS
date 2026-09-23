import { forwardRef, type HTMLAttributes } from "react";
import { cx } from "./utils";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md" | "lg";
  /** Hover + pointer affordance for clickable cards. */
  interactive?: boolean;
  selected?: boolean;
  /** Use the elevated shadow (floating cards, hero blocks). */
  raised?: boolean;
}

/**
 * A content container (radius 12px). When `interactive` and `onClick` are
 * set, it also becomes keyboard-activatable (Enter / Space).
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { padding = "md", interactive, selected, raised, className, onClick, onKeyDown, role, tabIndex, ...rest },
  ref
) {
  const clickable = interactive && !!onClick;
  return (
    <div
      ref={ref}
      role={role ?? (clickable ? "button" : undefined)}
      tabIndex={tabIndex ?? (clickable ? 0 : undefined)}
      aria-pressed={clickable && selected !== undefined ? selected : undefined}
      className={cx(
        "ui-card",
        `ui-card-pad-${padding}`,
        interactive && "is-interactive",
        selected && "is-selected",
        raised && "is-raised",
        className
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!clickable || e.defaultPrevented || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).click();
        }
      }}
      {...rest}
    />
  );
});
