import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { nextRovingIndex } from "./roving";
import { cx } from "./utils";

export interface SegmentOption<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Accessible name when `label` is visually hidden / icon-only. */
  "aria-label"?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  "aria-label": string;
  className?: string;
  /** Stretch segments to fill the container width. */
  fullWidth?: boolean;
}

/**
 * A compact single-choice switcher (`role="radiogroup"`), e.g. Month / Week /
 * Day. Arrow keys move the selection.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  fullWidth,
  ...aria
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const key = e.key === "ArrowDown" ? "ArrowRight" : e.key === "ArrowUp" ? "ArrowLeft" : e.key;
    const next = nextRovingIndex(key, current, options.length, "horizontal", (i) => !!options[i]?.disabled);
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      className={cx("ui-segmented", `ui-segmented-${size}`, fullWidth && "is-full", className)}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o["aria-label"]}
            tabIndex={checked ? 0 : -1}
            disabled={o.disabled}
            className={cx("ui-segment", checked && "is-selected")}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <span className="ui-segment-icon">{o.icon}</span>}
            {o.label !== undefined && o.label !== null && <span className="ui-segment-label">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
