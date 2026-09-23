import { Sparkles } from "lucide-react";
import { Tooltip, cx } from "../../ui";
import { useAetherStore } from "../../lib/store";
import { useIntelStore } from "../../lib/intelStore";
import { noteNameFromPath } from "../../lib/intel/noteEdits";
import "../../styles/views/intel.css";

/**
 * Suggestions chip in the agent's context bar: one click focuses the chat
 * context on the open note plus its related notes (instead of "all notes",
 * where only the first few fit into the prompt).
 */
export function RelatedContextChip() {
  const path = useAetherStore((s) => s.selectedNotePath);
  const allNotesInContext = useAetherStore((s) => s.allNotesInContext);
  const contextNotes = useAetherStore((s) => s.contextNotes);
  const entry = useIntelStore((s) => (path ? s.related[path] : undefined));
  if (!path || !entry || entry.suggestions.length === 0) return null;

  const related = entry.suggestions.slice(0, 5).map((s) => s.path);
  const wanted = [path, ...related];
  const active = !allNotesInContext && contextNotes.size === wanted.length && wanted.every((p) => contextNotes.has(p));

  const apply = () => {
    const store = useAetherStore.getState();
    if (active) {
      store.resetContextToAll();
      return;
    }
    store.resetContextToAll();
    for (const p of wanted) useAetherStore.getState().toggleContextNote(p);
  };

  const tip = active
    ? "Back to all notes as context"
    : `Use ${noteNameFromPath(path)} and ${related.length} related note${related.length === 1 ? "" : "s"} as context`;
  return (
    <Tooltip content={tip} placement="bottom">
      <button
        type="button"
        className={cx("intel-context-chip", active && "is-active")}
        onClick={apply}
        aria-pressed={active}
        aria-label={tip}
      >
        <Sparkles size={11} aria-hidden="true" />
        {related.length} related
      </button>
    </Tooltip>
  );
}
