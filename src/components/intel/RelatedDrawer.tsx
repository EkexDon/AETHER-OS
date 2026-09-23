import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, FileText, Hash, Link2, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, Portal, Spinner, Tooltip, useToast } from "../../ui";
import { useAetherStore } from "../../lib/store";
import { useIntelStore } from "../../lib/intelStore";
import { applyTag, insertLink, refreshRelated } from "../../lib/intel/related";
import { noteNameFromPath } from "../../lib/intel/noteEdits";
import type { RelatedSuggestion } from "../../types";

function reasonVariant(kind: RelatedSuggestion["kind"]): "accent" | "info" | "neutral" {
  if (kind === "semantic") return "accent";
  if (kind === "tags") return "info";
  return "neutral";
}

/** Keep the drawer clear of the agent panel when it is open. */
function useRightOffset(open: boolean): number {
  const [right, setRight] = useState(16);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const panel = document.querySelector(".agent-chat");
      const rect = panel?.getBoundingClientRect();
      setRight(rect && rect.width > 0 ? Math.max(16, window.innerWidth - rect.left + 12) : 16);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    const panel = document.querySelector(".agent-chat");
    if (observer && panel) observer.observe(panel);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [open]);
  return right;
}

/**
 * Floating "Related" drawer for the note being edited: related notes with
 * their reason chip and one-click "Insert [[link]]", plus tag chips that
 * add the tag to the note. Toggled by `mod+shift+r` or the status bar chip.
 */
export function RelatedDrawer() {
  const toast = useToast();
  const open = useIntelStore((s) => s.relatedOpen);
  const setOpen = useIntelStore((s) => s.setRelatedOpen);
  const selectedNotePath = useAetherStore((s) => s.selectedNotePath);
  const noteContent = useAetherStore((s) => s.noteContent);
  const view = useAetherStore((s) => s.view);
  const entry = useIntelStore((s) => (selectedNotePath ? s.related[selectedNotePath] : undefined));
  const [busy, setBusy] = useState<string | null>(null);
  const right = useRightOffset(open);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Close when leaving the editor; the command reopens it there.
  useEffect(() => {
    if (open && view !== "editor") setOpen(false);
  }, [open, view, setOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const noteName = selectedNotePath ? noteNameFromPath(selectedNotePath) : null;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      toast.error("Could not update the note", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const onInsert = (s: RelatedSuggestion) =>
    run(`link:${s.path}`, async () => {
      if (!selectedNotePath) return;
      const inserted = await insertLink(selectedNotePath, s.name);
      if (inserted) toast.success(`Linked [[${s.name}]]`, { description: `Added at the end of ${noteName}.` });
      else toast.info(`${noteName} already links to [[${s.name}]]`);
    });

  const onTag = (tag: string) =>
    run(`tag:${tag}`, async () => {
      if (!selectedNotePath) return;
      const changed = await applyTag(selectedNotePath, tag);
      if (changed) toast.success(`Tagged #${tag}`);
      else toast.info(`${noteName} already has #${tag}`);
    });

  const onRefresh = () => {
    if (selectedNotePath && noteContent !== null) void refreshRelated(selectedNotePath, noteContent, true);
  };

  const openNote = (path: string) => {
    useAetherStore.getState().selectNote(path);
  };

  const suggestions = entry?.suggestions ?? [];
  const tags = entry?.tags ?? [];

  return (
    <Portal>
      <aside className="intel-drawer" style={{ right }} aria-label="Related notes">
        <header className="intel-drawer-header">
          <span className="intel-summary-icon" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <div className="intel-drawer-titles">
            <span className="intel-drawer-title">Related notes</span>
            <span className="intel-drawer-subtitle">{noteName ? `For ${noteName}` : "Open a note to see suggestions"}</span>
          </div>
          <IconButton
            size="sm"
            label="Refresh suggestions"
            icon={entry?.loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
            onClick={onRefresh}
            disabled={!selectedNotePath || entry?.loading}
          />
          <IconButton ref={closeRef} size="sm" label="Close" shortcut="mod+shift+r" icon={<X size={14} />} onClick={() => setOpen(false)} />
        </header>
        <div className="intel-drawer-body">
          {!selectedNotePath ? (
            <EmptyState size="sm" icon={FileText} title="No note open" description="Open a note in the editor to see related notes." />
          ) : entry?.error ? (
            <div className="ui-notice ui-notice-danger" role="alert">
              {entry.error}
            </div>
          ) : !entry || (entry.loading && suggestions.length === 0) ? (
            <div className="intel-drawer-state">
              <Spinner size={14} /> Finding related notes…
            </div>
          ) : (
            <>
              <section className="intel-drawer-section" aria-label="Related notes list">
                <span className="ui-section-label">Notes</span>
                {suggestions.length === 0 ? (
                  <EmptyState
                    size="sm"
                    icon={Link2}
                    title="Nothing related yet"
                    description="Write a little more, or index the vault for semantic matches."
                  />
                ) : (
                  suggestions.map((s) => (
                    <div key={s.path} className="intel-suggestion">
                      <button type="button" className="intel-suggestion-main" onClick={() => openNote(s.path)} title={s.path}>
                        <span className="intel-suggestion-name">{s.name}</span>
                        <span className="intel-suggestion-reason">
                          <Badge variant={reasonVariant(s.kind)}>{s.reason}</Badge>
                        </span>
                      </button>
                      {s.linked ? (
                        <Tooltip content="Already linked from this note">
                          <span className="intel-run-status" tabIndex={0} aria-label="Already linked">
                            <Check size={14} />
                          </span>
                        </Tooltip>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          iconLeft={<Link2 size={14} />}
                          loading={busy === `link:${s.path}`}
                          disabled={busy !== null}
                          onClick={() => void onInsert(s)}
                          aria-label={`Insert link to ${s.name} at the end of the note`}
                        >
                          Link
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </section>
              <section className="intel-drawer-section" aria-label="Suggested tags">
                <span className="ui-section-label">Tags</span>
                {tags.length === 0 ? (
                  <p className="intel-drawer-state">
                    <Hash size={14} /> No tag suggestions for this note.
                  </p>
                ) : (
                  <div className="intel-tags">
                    {tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="intel-tag-chip"
                        onClick={() => void onTag(tag)}
                        disabled={busy !== null}
                        aria-label={`Add tag ${tag}`}
                      >
                        {busy === `tag:${tag}` ? <Spinner size={14} /> : <Plus size={14} />}#{tag}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </Portal>
  );
}
