import { forwardRef, useRef, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { Input } from "./Input";
import { Kbd } from "./Kbd";
import { mergeRefs } from "./utils";

export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "onChange" | "onSubmit"> {
  value: string;
  onChange: (value: string) => void;
  /** Enter pressed. */
  onSubmit?: (value: string) => void;
  /** Called after the clear button / Escape empties the field. */
  onClear?: () => void;
  /** Shortcut hint shown while the field is empty (e.g. `mod+k`). */
  shortcutHint?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Search input with icon, clear button and Escape-to-clear. Pressing Escape
 * on an empty field blurs it.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, onSubmit, onClear, shortcutHint, size = "md", placeholder = "Search…", onKeyDown, className, ...rest },
  ref
) {
  const innerRef = useRef<HTMLInputElement | null>(null);

  const clear = () => {
    onChange("");
    onClear?.();
    innerRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit(value);
    } else if (e.key === "Escape") {
      if (value) {
        e.preventDefault();
        e.stopPropagation();
        onChange("");
        onClear?.();
      } else {
        innerRef.current?.blur();
      }
    }
  };

  const iconSize = size === "lg" ? 16 : 14;
  return (
    <Input
      ref={mergeRefs(innerRef, ref)}
      type="search"
      role="searchbox"
      size={size}
      className={className}
      iconLeft={<Search size={iconSize} />}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      autoComplete="off"
      suffix={
        value ? (
          <button type="button" className="ui-search-clear" onClick={clear} aria-label="Clear search">
            <X size={12} />
          </button>
        ) : shortcutHint ? (
          <Kbd shortcut={shortcutHint} />
        ) : undefined
      }
      {...rest}
    />
  );
});
