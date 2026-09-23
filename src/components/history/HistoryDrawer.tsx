import { useEffect } from "react";
import { History, Maximize2 } from "lucide-react";
import { noteTitle } from "../../lib/history/format";
import { useHistoryStore } from "../../lib/historyStore";
import { useAetherStore } from "../../lib/store";
import { IconButton, Modal } from "../../ui";
import { NoteHistoryPanel } from "./NoteHistoryPanel";
import "../../styles/views/history.css";

/**
 * Right-side drawer with the history of one note, opened with ⌘⇧H while
 * editing. Mounted globally (through the status bar item) so it can sit on
 * top of the editor without changes to the editor itself.
 */
export function HistoryDrawer() {
  const path = useHistoryStore((s) => s.drawerPath);
  const close = useHistoryStore((s) => s.closeDrawer);

  // The modal handles Escape while focus is inside it. A restore remounts
  // the editor underneath, which can leave focus on <body>; Escape must
  // still close the drawer then.
  useEffect(() => {
    if (!path) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[role="dialog"]')) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [path, close]);

  if (!path) return null;

  const openFullHistory = () => {
    close();
    useHistoryStore.getState().selectNote(path);
    useAetherStore.getState().setView("history");
  };

  return (
    <Modal
      open
      onClose={close}
      icon={History}
      title={noteTitle(path)}
      description="Version history"
      size="xl"
      flush
      className="history-drawer"
      bodyClassName="history-drawer-body"
      headerActions={
        <IconButton
          size="sm"
          label="Open in History view"
          icon={<Maximize2 size={14} />}
          onClick={openFullHistory}
        />
      }
    >
      <NoteHistoryPanel path={path} variant="stacked" />
    </Modal>
  );
}
