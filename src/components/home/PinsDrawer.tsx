import { useEffect, useRef } from "react";
import { Bookmark, Pin, X } from "lucide-react";
import "../../styles/views/home.css";
import { useHomeStore } from "../../lib/homeStore";
import { countPins, useIsPinned, usePinsStore } from "../../lib/pinsStore";
import { useAetherStore } from "../../lib/store";
import { pinCurrentNote } from "../../lib/home/commands";
import { noteTitleFromPath } from "../../lib/home/format";
import { Badge, Button, IconButton, Kbd, Portal, toast } from "../../ui";
import { PinsPanel } from "./PinsPanel";

/** Selector of elements that toggle the drawer (clicks there must not count as "outside"). */
export const PINS_DRAWER_TOGGLE_ATTR = "data-pins-drawer-toggle";

/**
 * Right-hand drawer with all pin groups — the primary way to reach pins
 * outside Home. Non-modal: the app stays usable; Escape or a click outside
 * closes it and focus returns to where it was.
 */
export function PinsDrawer() {
  const open = useHomeStore((s) => s.pinsDrawerOpen);
  const setOpen = useHomeStore((s) => s.setPinsDrawerOpen);
  const total = usePinsStore((s) => countPins(s.groups));
  const notePath = useAetherStore((s) => s.selectedNotePath);
  const notePinned = useIsPinned("note", notePath);
  const panelRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => panelRef.current?.focus());

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || panelRef.current?.contains(target)) return;
      if (target.closest(`[${PINS_DRAWER_TOGGLE_ATTR}]`)) return;
      // Toasts (e.g. "Undo") and popovers live outside the drawer.
      if (target.closest(".ui-toast-viewport, .ui-popover, .ui-tooltip, .ui-modal-backdrop")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      const back = returnFocus.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <Portal>
      <aside ref={panelRef} className="home-pins-drawer" role="dialog" aria-modal="false" aria-label="Pins" tabIndex={-1}>
        <header className="home-pins-drawer-header">
          <span className="home-pins-drawer-title">
            <Bookmark size={14} />
            Pins
            {total > 0 && <Badge>{total}</Badge>}
          </span>
          <span className="home-pins-drawer-hint">
            <Kbd shortcut="mod+alt+b" />
          </span>
          <IconButton label="Close pins" shortcut="escape" icon={<X size={14} />} onClick={() => setOpen(false)} />
        </header>
        {notePath && !notePinned && (
          <div className="home-pins-drawer-current">
            <Button
              size="sm"
              variant="secondary"
              fullWidth
              iconLeft={<Pin size={13} />}
              onClick={() => {
                const result = pinCurrentNote();
                if (result?.pinned) toast.success("Pinned", { description: result.label });
              }}
            >
              Pin “{noteTitleFromPath(notePath)}”
            </Button>
          </div>
        )}
        <div className="home-pins-drawer-body">
          <PinsPanel variant="full" onOpened={() => setOpen(false)} />
        </div>
      </aside>
    </Portal>
  );
}
