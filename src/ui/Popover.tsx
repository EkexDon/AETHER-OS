import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { Portal } from "./Portal";
import { computePosition, cx, focusableWithin, mergeRefs, type Placement, type Position } from "./utils";

export interface PopoverProps {
  /** The element that toggles the popover (must forward its ref). */
  trigger: ReactElement;
  /** Popover content. A function receives a `close` callback. */
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: Placement;
  /** Controlled open state (omit for uncontrolled). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Move focus into the popover when it opens (default true). */
  autoFocus?: boolean;
  /** Fixed width in px (default: fit content). */
  width?: number;
  className?: string;
  "aria-label"?: string;
}

/**
 * Click-triggered floating panel (menus, pickers). Closes on outside click,
 * Escape (returning focus to the trigger) and when `close()` is called.
 */
export function Popover({
  trigger,
  children,
  placement = "bottom-start",
  open: controlledOpen,
  onOpenChange,
  autoFocus = true,
  width,
  className,
  ...aria
}: PopoverProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlledOpen ?? uncontrolled;
  const [pos, setPos] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolled(next);
      onOpenChange?.(next);
      if (!next) setPos(null);
    },
    [controlledOpen, onOpenChange]
  );

  const close = useCallback(() => setOpen(false), [setOpen]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return;
    const measure = () => {
      if (!triggerRef.current || !panelRef.current) return;
      const a = triggerRef.current.getBoundingClientRect();
      const p = panelRef.current.getBoundingClientRect();
      setPos(computePosition(a, { width: p.width, height: p.height }, placement, {
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpen]);

  useEffect(() => {
    if (!open || !autoFocus) return;
    const frame = requestAnimationFrame(() => {
      if (!panelRef.current) return;
      const first = focusableWithin(panelRef.current)[0];
      (first ?? panelRef.current).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, autoFocus]);

  const child = Children.only(trigger);
  if (!isValidElement(child)) return null;
  const childProps = child.props as { onClick?: (e: MouseEvent<HTMLElement>) => void };
  const childRef = (child as unknown as { ref?: Ref<HTMLElement> }).ref;

  const triggerEl = cloneElement(child as ReactElement<Record<string, unknown>>, {
    ref: mergeRefs(triggerRef, childRef),
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    onClick: (e: MouseEvent<HTMLElement>) => {
      childProps.onClick?.(e);
      if (!e.defaultPrevented) setOpen(!open);
    },
  });

  return (
    <>
      {triggerEl}
      {open && (
        <Portal>
          <div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-label={aria["aria-label"]}
            tabIndex={-1}
            className={cx("ui-popover", pos && "is-positioned", className)}
            data-placement={pos?.placement ?? placement}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
          >
            {typeof children === "function" ? children(close) : children}
          </div>
        </Portal>
      )}
    </>
  );
}
