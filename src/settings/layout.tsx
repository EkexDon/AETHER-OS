import type { ReactNode } from "react";
import { cx } from "../ui";

/**
 * Building blocks for settings sections so every section — built-in or
 * contributed by a feature — has the same rhythm:
 *
 * ```tsx
 * <SettingsPage title="Sync" description="…">
 *   <SettingsGroup title="Folder">
 *     <SettingsRow label="Target folder" hint="…" control={<Input … />} />
 *   </SettingsGroup>
 * </SettingsPage>
 * ```
 */
export function SettingsPage({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <h2 className="settings-page-title">{title}</h2>
        {description && <p className="settings-page-description">{description}</p>}
      </header>
      <div className="settings-page-body">{children}</div>
    </div>
  );
}

/** A titled card of related rows. */
export function SettingsGroup({
  title,
  description,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("settings-group", className)}>
      {(title || description) && (
        <div className="settings-group-header">
          {title && <h3 className="settings-group-title">{title}</h3>}
          {description && <p className="settings-group-description">{description}</p>}
        </div>
      )}
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

/**
 * One setting: label + hint on the left, control on the right. Use
 * `stacked` for wide controls (path inputs, key fields) that need a full row.
 */
export function SettingsRow({
  label,
  hint,
  control,
  stacked,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  stacked?: boolean;
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx("settings-row", stacked && "is-stacked")}>
      <div className="settings-row-text">
        <label className="settings-row-label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint && <p className="settings-row-hint">{hint}</p>}
      </div>
      {control && <div className="settings-row-control">{control}</div>}
      {children && <div className="settings-row-extra">{children}</div>}
    </div>
  );
}
