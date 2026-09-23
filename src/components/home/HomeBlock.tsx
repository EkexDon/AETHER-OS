import type { LucideIcon } from "lucide-react";
import { ArrowUpRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Badge, Button, Spinner, cx } from "../../ui";

export interface HomeBlockProps {
  title: string;
  icon: LucideIcon;
  /** Small count badge next to the title. */
  count?: number;
  /** Extra controls in the header (segmented control, icon buttons). */
  controls?: ReactNode;
  /** Label of the "See all" style header action. */
  actionLabel?: string;
  onAction?: () => void;
  /** Shows a spinner next to the title while data loads. */
  loading?: boolean;
  /** Inline error line under the header. */
  error?: string | null;
  className?: string;
  children: ReactNode;
}

/**
 * A titled dashboard block: icon · title · count · controls · "See all",
 * then its content. Used for every section on Home so they share one
 * rhythm.
 */
export function HomeBlock({
  title,
  icon: Icon,
  count,
  controls,
  actionLabel,
  onAction,
  loading,
  error,
  className,
  children,
}: HomeBlockProps) {
  const headingId = useId();
  return (
    <section className={cx("home-block", className)} aria-labelledby={headingId}>
      <header className="home-block-header">
        <h2 className="home-block-title" id={headingId}>
          <span className="home-block-icon" aria-hidden="true">
            <Icon size={14} strokeWidth={1.9} />
          </span>
          {title}
          {count !== undefined && count > 0 && <Badge className="home-block-count">{count}</Badge>}
          {loading && <Spinner size={12} label={`Loading ${title.toLowerCase()}`} />}
        </h2>
        <div className="home-block-actions">
          {controls}
          {actionLabel && onAction && (
            <Button variant="ghost" size="sm" iconRight={<ArrowUpRight size={13} />} onClick={onAction}>
              {actionLabel}
            </Button>
          )}
        </div>
      </header>
      {error && (
        <p className="ui-notice ui-notice-danger home-block-error" role="alert">
          {error}
        </p>
      )}
      <div className="home-block-body">{children}</div>
    </section>
  );
}
