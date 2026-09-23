import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cx } from "./utils";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Allow vertical resizing (default true). */
  resizable?: boolean;
  /** Use the monospace font (commit messages, code snippets). */
  mono?: boolean;
}

/** Multi-line text field. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, resizable = true, mono, className, rows = 3, ...rest },
  ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cx(
        "ui-textarea",
        invalid && "is-invalid",
        !resizable && "is-fixed",
        mono && "is-mono",
        className
      )}
      {...rest}
    />
  );
});
