import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import { Spinner, Tooltip, cx } from "../../ui";
import { useAetherStore } from "../../lib/store";
import { useIntelStore } from "../../lib/intelStore";
import { RELATED_DEBOUNCE_MS, refreshRelated } from "../../lib/intel/related";
import { noteNameFromPath } from "../../lib/intel/noteEdits";
import { isDesktopRuntime } from "../../lib/ipc";
import { RelatedDrawer } from "./RelatedDrawer";

/**
 * Keeps related-note suggestions for the open note fresh: 1.5 s after the
 * last edit (and whenever another note is opened) while the editor view is
 * active, cached per note and text hash.
 */
export function useRelatedSuggestions(): void {
  const view = useAetherStore((s) => s.view);
  const path = useAetherStore((s) => s.selectedNotePath);
  const content = useAetherStore((s) => s.noteContent);
  const enabled = useIntelStore((s) => s.settings.related_suggestions);
  const loaded = useIntelStore((s) => s.settingsLoaded);
  const loadSettings = useIntelStore((s) => s.loadSettings);

  useEffect(() => {
    if (!loaded && isDesktopRuntime()) void loadSettings().catch(() => undefined);
  }, [loaded, loadSettings]);

  useEffect(() => {
    if (!enabled || view !== "editor" || !path || content === null || !isDesktopRuntime()) return;
    const timer = setTimeout(() => void refreshRelated(path, content), RELATED_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, view, path, content]);
}

/**
 * Status bar chip "3 related" while the editor is active; opens the
 * Related drawer (which this item also hosts, so it exists wherever the
 * status bar does).
 */
export function RelatedStatusItem() {
  useRelatedSuggestions();
  const view = useAetherStore((s) => s.view);
  const path = useAetherStore((s) => s.selectedNotePath);
  const enabled = useIntelStore((s) => s.settings.related_suggestions);
  const entry = useIntelStore((s) => (path ? s.related[path] : undefined));
  const open = useIntelStore((s) => s.relatedOpen);
  const toggle = useIntelStore((s) => s.toggleRelated);

  const visible = enabled && view === "editor" && path !== null;
  const count = entry?.suggestions.length ?? 0;
  const label = entry?.loading && !entry.suggestions.length ? "Related…" : `${count} related`;

  return (
    <>
      {visible && (
        <Tooltip
          content={`Notes related to ${noteNameFromPath(path)}`}
          shortcut="mod+shift+r"
          placement="top"
        >
          <button
            type="button"
            className={cx("statusbar-item", open && "is-active")}
            onClick={toggle}
            aria-pressed={open}
          >
            {entry?.loading ? <Spinner size={11} /> : <Sparkles size={12} />}
            <span className="statusbar-muted tabular">{label}</span>
          </button>
        </Tooltip>
      )}
      <RelatedDrawer />
    </>
  );
}
