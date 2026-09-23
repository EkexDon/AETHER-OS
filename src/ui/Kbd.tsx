import type { ReactNode } from "react";
import { shortcutKeys } from "../lib/shortcuts";
import { cx } from "./utils";

export interface KbdProps {
  /** A shortcut string like `mod+shift+k`; rendered as individual key caps. */
  shortcut?: string;
  /** Free-form key label when no shortcut string applies (e.g. "Esc"). */
  children?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}

/** Keyboard key cap(s). */
export function Kbd({ shortcut, children, size = "sm", className }: KbdProps) {
  if (shortcut) {
    const keys = shortcutKeys(shortcut);
    return (
      <span className={cx("ui-kbd-group", className)} aria-label={keys.join(" ")}>
        {keys.map((k, i) => (
          <kbd key={`${k}-${i}`} className={cx("ui-kbd", `ui-kbd-${size}`)} aria-hidden="true">
            {k}
          </kbd>
        ))}
      </span>
    );
  }
  return <kbd className={cx("ui-kbd", `ui-kbd-${size}`, className)}>{children}</kbd>;
}
