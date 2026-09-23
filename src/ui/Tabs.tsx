import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { nextRovingIndex } from "./roving";
import { cx } from "./utils";

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Small count after the label. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** `underline` for view-level tabs, `pill` for compact in-panel tabs. */
  variant?: "underline" | "pill";
  size?: "sm" | "md";
  "aria-label"?: string;
  className?: string;
  /** Prefix for tab/panel ids so consumers can set `aria-labelledby`. */
  idPrefix?: string;
}

/**
 * A tab list (`role="tablist"`) with roving focus: ←/→ move and activate,
 * Home/End jump. Render the panel yourself based on `value`.
 */
export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  variant = "underline",
  size = "md",
  className,
  idPrefix,
  ...aria
}: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const currentIndex = Math.max(
    0,
    items.findIndex((i) => i.id === value)
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextRovingIndex(e.key, currentIndex, items.length, "horizontal", (i) => !!items[i]?.disabled);
    if (next === null) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={aria["aria-label"]}
      className={cx("ui-tabs", `ui-tabs-${variant}`, `ui-tabs-${size}`, className)}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.id}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className={cx("ui-tab", selected && "is-selected")}
            onClick={() => onChange(item.id)}
          >
            {item.icon && <span className="ui-tab-icon">{item.icon}</span>}
            <span className="ui-tab-label">{item.label}</span>
            {item.count !== undefined && <span className="ui-tab-count">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
