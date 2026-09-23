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
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { Portal } from "./Portal";
import { Kbd } from "./Kbd";
import { computePosition, cx, mergeRefs, type Placement, type Position } from "./utils";

export interface TooltipProps {
  /** Tooltip text. */
  content: ReactNode;
  /** Optional shortcut rendered as key caps next to the text. */
  shortcut?: string;
  placement?: Placement;
  /** Hover delay in ms before the tooltip appears (keyboard focus is instant). */
  delay?: number;
  disabled?: boolean;
  /**
   * Link the tooltip to the trigger via `aria-describedby`. Turn off when the
   * trigger's accessible name already equals the tooltip text.
   */
  describeChild?: boolean;
  /** Exactly one focusable element that forwards its ref. */
  children: ReactElement;
}

/** After one tooltip closes, the next opens instantly within this window. */
const WARM_WINDOW_MS = 500;
let lastHiddenAt = 0;

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Hover/focus tooltip. Appears after `delay` on hover, immediately on
 * keyboard focus, hides on blur, pointer down, scroll and Escape.
 */
export function Tooltip({
  content,
  shortcut,
  placement = "top",
  delay = 450,
  disabled = false,
  describeChild = true,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(false);
  const id = useId();

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const show = useCallback(
    (immediate = false) => {
      if (disabled) return;
      clearTimer();
      const warm = Date.now() - lastHiddenAt < WARM_WINDOW_MS;
      if (immediate || warm || delay <= 0) {
        openRef.current = true;
        setOpen(true);
      } else {
        timer.current = setTimeout(() => {
          timer.current = null;
          openRef.current = true;
          setOpen(true);
        }, delay);
      }
    },
    [delay, disabled]
  );

  const hide = useCallback(() => {
    clearTimer();
    if (openRef.current) lastHiddenAt = Date.now();
    openRef.current = false;
    setOpen(false);
    setPos(null);
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tipRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    setPos(
      computePosition(
        anchor,
        { width: tip.width, height: tip.height },
        placement,
        { width: window.innerWidth, height: window.innerHeight },
        8
      )
    );
  }, [open, placement, content, shortcut]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onScroll = () => hide();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onScroll);
    };
  }, [open, hide]);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useEffect(() => () => clearTimer(), []);

  const child = Children.only(children);
  if (!isValidElement(child)) return child;
  const childProps = child.props as {
    onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
    onFocus?: (e: FocusEvent<HTMLElement>) => void;
    onBlur?: (e: FocusEvent<HTMLElement>) => void;
    onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
    "aria-describedby"?: string;
  };
  const childRef = (child as unknown as { ref?: Ref<HTMLElement> }).ref;

  const trigger = cloneElement(child as ReactElement<Record<string, unknown>>, {
    ref: mergeRefs(triggerRef, childRef),
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e);
      if (isFocusVisible(e.currentTarget)) show(true);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e);
      hide();
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      childProps.onPointerDown?.(e);
      hide();
    },
    "aria-describedby":
      open && describeChild
        ? [childProps["aria-describedby"], id].filter(Boolean).join(" ")
        : childProps["aria-describedby"],
  });

  return (
    <>
      {trigger}
      {open && !disabled && (
        <Portal>
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={cx("ui-tooltip", pos && "is-positioned")}
            data-placement={pos?.placement ?? placement}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            <span className="ui-tooltip-text">{content}</span>
            {shortcut && <Kbd shortcut={shortcut} className="ui-tooltip-kbd" />}
          </div>
        </Portal>
      )}
    </>
  );
}
