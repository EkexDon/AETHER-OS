import type { LucideIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import { Portal } from "./Portal";
import { IconButton } from "./IconButton";
import { cx, focusableWithin } from "./utils";

export type ModalSize = "sm" | "md" | "lg" | "xl";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Heading; also the dialog's accessible name. */
  title?: ReactNode;
  /** Line under the title. */
  description?: ReactNode;
  /** Optional lucide icon before the title. */
  icon?: LucideIcon;
  /** Width: sm 400 · md 520 · lg 680 · xl 880. */
  size?: ModalSize;
  /** Right-aligned footer actions. */
  footer?: ReactNode;
  /** Left side of the footer (e.g. a destructive action). */
  footerStart?: ReactNode;
  /** Extra content on the right of the header (before the close button). */
  headerActions?: ReactNode;
  /** Element to focus on open (defaults to the first focusable in the body). */
  initialFocusRef?: RefObject<HTMLElement>;
  /** Close on Escape / backdrop click (default true). */
  dismissible?: boolean;
  hideCloseButton?: boolean;
  /** Vertical anchor: centered (default) or near the top (palettes, capture). */
  position?: "center" | "top";
  /** Remove body padding (full-bleed layouts like the settings split view). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  /** Accessible name when no visible title is rendered. */
  "aria-label"?: string;
  children?: ReactNode;
}

/** Open modals, top-most last; only the top one reacts to Escape / Tab. */
const modalStack: string[] = [];

/**
 * Dialog rendered in a portal with backdrop, focus trap, Escape to close
 * and focus restoration to the previously focused element.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  size = "md",
  footer,
  footerStart,
  headerActions,
  initialFocusRef,
  dismissible = true,
  hideCloseButton = false,
  position = "center",
  flush = false,
  className,
  bodyClassName,
  children,
  ...aria
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const downOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Register in the stack and restore focus on close.
  useLayoutEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalStack.push(id);
    return () => {
      const idx = modalStack.lastIndexOf(id);
      if (idx >= 0) modalStack.splice(idx, 1);
      const target = restoreRef.current;
      if (target && document.contains(target)) {
        // Defer so the element is focusable again after the portal unmounts.
        requestAnimationFrame(() => target.focus?.());
      }
    };
  }, [open, id]);

  // Initial focus.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (dialog.contains(document.activeElement) && document.activeElement !== dialog) return;
      const preferred = initialFocusRef?.current;
      if (preferred) {
        preferred.focus();
        return;
      }
      const inBody = bodyRef.current ? focusableWithin(bodyRef.current) : [];
      const target = inBody.find((el) => el.hasAttribute("autofocus")) ?? inBody[0];
      (target ?? dialog).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialFocusRef]);

  if (!open) return null;

  const isTop = () => modalStack[modalStack.length - 1] === id;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isTop()) return;
    if (e.key === "Escape") {
      if (e.defaultPrevented) return;
      e.stopPropagation();
      if (dismissible) {
        e.preventDefault();
        onCloseRef.current();
      }
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = focusableWithin(dialogRef.current);
    if (items.length === 0) {
      e.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onBackdropDown = (e: MouseEvent<HTMLDivElement>) => {
    downOnBackdrop.current = e.target === e.currentTarget;
  };
  const onBackdropUp = (e: MouseEvent<HTMLDivElement>) => {
    if (downOnBackdrop.current && e.target === e.currentTarget && dismissible && isTop()) onCloseRef.current();
    downOnBackdrop.current = false;
  };

  const hasHeader = title !== undefined || !hideCloseButton || headerActions;

  return (
    <Portal>
      <div
        className={cx("ui-modal-backdrop", position === "top" && "is-top")}
        onMouseDown={onBackdropDown}
        onMouseUp={onBackdropUp}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title !== undefined ? titleId : undefined}
          aria-label={title === undefined ? aria["aria-label"] : undefined}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          className={cx("ui-modal", `ui-modal-${size}`, className)}
          onKeyDown={onKeyDown}
        >
          {hasHeader && (
            <div className={cx("ui-modal-header", title === undefined && "is-bare")}>
              {title !== undefined && (
                <div className="ui-modal-titles">
                  <h2 id={titleId} className="ui-modal-title">
                    {Icon && (
                      <span className="ui-modal-title-icon" aria-hidden="true">
                        <Icon size={16} strokeWidth={1.9} />
                      </span>
                    )}
                    {title}
                  </h2>
                  {description && (
                    <p id={descId} className="ui-modal-description">
                      {description}
                    </p>
                  )}
                </div>
              )}
              <div className="ui-modal-header-actions">
                {headerActions}
                {!hideCloseButton && (
                  <IconButton label="Close" icon={<X size={16} />} size="sm" onClick={onClose} tooltip={false} />
                )}
              </div>
            </div>
          )}
          <div ref={bodyRef} className={cx("ui-modal-body", flush && "is-flush", bodyClassName)}>
            {children}
          </div>
          {(footer || footerStart) && (
            <div className="ui-modal-footer">
              <div className="ui-modal-footer-start">{footerStart}</div>
              <div className="ui-modal-footer-end">{footer}</div>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}
