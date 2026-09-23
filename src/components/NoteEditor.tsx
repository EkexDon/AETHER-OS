import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import {
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, Link as LinkIcon,
  List, ListOrdered, Quote, Code, Minus, FileText, Underline as UnderlineIcon,
  Palette, Plus, X, Save, Edit3, FilePlus, Link2, ArrowLeft,
  Grid3x3, CheckSquare, ListPlus,
} from "lucide-react";
import { useAetherStore } from "../lib/store";
import { useVaultTasksStore } from "../lib/vaultTasksStore";
import { Button, EmptyState, Input, Modal } from "../ui";
import { writeNote, createNote, getBacklinks, getVaultNotes, getNoteContent } from "../lib/ipc";
import { createAutosaveScheduler } from "../lib/autosave";
import { subscribeNoteReload } from "../lib/noteEditorBus";
import { noteEditorExtensions } from "../lib/editor/extensions";
import { frontmatterLineCount, joinFrontmatter, splitFrontmatter } from "../lib/editor/frontmatter";
import { prefersTightLists, tightenListSpacing } from "../lib/editor/listSpacing";
import { lineToBlock, locateBlock } from "../lib/editor/lineToBlock";
import { BacklinksPanel } from "./BacklinksPanel";
import { NoteProperties } from "./NoteProperties";
import { findUnlinkedMentions, linkMentions } from "../lib/mentions";
import type { Backlink, VaultNote } from "../types";

/** The canvas body as Markdown (tiptap-markdown's serializer). */
function editorMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as { markdown?: { getMarkdown?: () => string } };
  return storage.markdown?.getMarkdown?.() ?? "";
}

/**
 * Scroll the canvas to the block showing 0-based `line` of the note file and
 * flash it; lines inside the front matter scroll to the Properties panel.
 */
function revealLine(editor: Editor, frontmatter: string | null, body: string, line: number): void {
  const bodyLine = line - frontmatterLineCount(frontmatter);
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  if (bodyLine < 0) {
    editor.view.dom.closest(".editor-body")?.querySelector(".note-properties")?.scrollIntoView({ block: "center", behavior });
    return;
  }
  const target = lineToBlock(body, bodyLine);
  const located = target ? locateBlock(editor.state.doc, target) : null;
  if (!located) return;
  // Caret at the start of the block's first text.
  let textPos = located.pos + 1;
  if (!located.node.isTextblock) {
    located.node.descendants((child, offset) => {
      if (textPos !== located.pos + 1) return false;
      if (child.isTextblock) {
        textPos = located.pos + 1 + offset + 1;
        return false;
      }
      return true;
    });
  }
  editor.chain().setTextSelection(textPos).focus(undefined, { scrollIntoView: false }).flashBlock(located.pos).run();
  const dom = editor.view.nodeDOM(located.pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center", behavior });
}

interface UnlinkedHit { note: VaultNote; count: number; snippet: string }

export function NoteEditor() {
  const {
    selectedNotePath,
    selectNote,
    closeNoteTab,
    openNoteTabs,
    setNoteContent,
    vaultNotes,
    setVaultNotes,
    setView,
    noteDirty,
    setNoteDirty,
  } = useAetherStore();

  const [saving, setSaving] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [showBacklinks, setShowBacklinks] = useState(false);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [unlinkedMentions, setUnlinkedMentions] = useState<UnlinkedHit[]>([]);
  const [newNoteName, setNewNoteName] = useState("");
  const [showNewNote, setShowNewNote] = useState(false);
  const [showColor, setShowColor] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrl, setLinkUrl] = useState("https://");
  // Front matter lives outside the canvas: the raw block exactly as read,
  // re-attached in front of the body on every save.
  const [frontmatter, setFrontmatterState] = useState<string | null>(null);
  const frontmatterRef = useRef<string | null>(null);
  // The latest body Markdown (the file's own bytes until the canvas changes).
  const bodyRef = useRef("");
  /** The open file puts lists directly under headings/paragraphs; keep that when saving. */
  const tightListsRef = useRef(false);
  const [addPropertyRequest, setAddPropertyRequest] = useState(0);
  // The note whose content is in the canvas (drives the pending-line scroll).
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const pendingLine = useVaultTasksStore((s) => s.pendingLine);

  const loadSeqRef = useRef(0);
  const currentTabRef = useRef<string | null>(selectedNotePath);
  currentTabRef.current = selectedNotePath;
  // Bumped by requestNoteReload() when a feature (history restore, sync, an
  // agent action) rewrote the open note on disk and the canvas must re-read it.
  const [reloadToken, setReloadToken] = useState(0);

  // Ink colors are saved into the note, so they are concrete values (data
  // colors) — mid-tones that stay legible on the dark and the light canvas.
  const COLORS = [
    { name: "Gray", value: "#8a8780" },
    { name: "Blue", value: "#5b8bc9" },
    { name: "Teal", value: "#3f9a86" },
    { name: "Green", value: "#6f9a45" },
    { name: "Ochre", value: "#b08a36" },
    { name: "Orange", value: "#c0714d" },
    { name: "Rose", value: "#bd6a86" },
    { name: "Violet", value: "#9477b3" },
  ];
  const SIZES = ["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px"];

  const activeNoteName = useMemo(() => {
    if (!selectedNotePath) return "";
    return selectedNotePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  }, [selectedNotePath]);

  // Writes `contentToSave` to `targetPath`. The path is passed explicitly —
  // never read from the current selection — so a save scheduled for note A
  // can never land in note B after the user switched tabs.
  const saveCurrentNote = useCallback(async (contentToSave: string, targetPath: string) => {
    setSaving(true);
    setError(null);
    try {
      await writeNote(targetPath, contentToSave);
      if (currentTabRef.current === targetPath) setNoteDirty(false);
      const notes = await getVaultNotes();
      setVaultNotes(notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [setNoteDirty, setVaultNotes]);

  // One scheduler for the editor's lifetime; it binds path + content at
  // scheduling time and is flushed before the selection changes.
  const saveRef = useRef(saveCurrentNote);
  saveRef.current = saveCurrentNote;
  const autosave = useMemo(
    () => createAutosaveScheduler({ delayMs: 1200, save: (path, content) => saveRef.current(content, path) }),
    []
  );

  // Initialize TipTap WYSIWYG Editor (stable extension instances, so
  // re-renders never reconfigure it).
  const extensions = useMemo(() => noteEditorExtensions(), []);
  const editor = useEditor({
    extensions,
    content: "",
    onUpdate: ({ editor: currentEditor }) => {
      // No open note (e.g. the canvas was just cleared): nothing to save.
      const target = currentTabRef.current;
      if (!target) return;
      setNoteDirty(true);
      const serialized = editorMarkdown(currentEditor);
      // Keep the file's own "list right under the heading" style (see listSpacing.ts).
      bodyRef.current = tightListsRef.current ? tightenListSpacing(serialized) : serialized;
      const md = joinFrontmatter(frontmatterRef.current, bodyRef.current);
      setNoteContent(md);
      autosave.schedule(target, md);
    },
    editorProps: {
      attributes: {
        spellcheck: "false",
        class: "nopes-prosemirror-canvas",
      },
    },
  });

  // Re-read the open note when another feature changed it on disk.
  useEffect(
    () =>
      subscribeNoteReload((path) => {
        if (path === currentTabRef.current) setReloadToken((t) => t + 1);
      }),
    []
  );

  // Unmounting (view switch) must not lose the last keystrokes.
  useEffect(
    () => () => {
      void autosave.flush();
    },
    [autosave]
  );

  // Load note content when selectedNotePath changes (or a reload is requested)
  useEffect(() => {
    // Flush the previous note's pending autosave first so its last edits
    // land in the previous note, not in the one being opened.
    void autosave.flushIfNot(selectedNotePath);

    if (!selectedNotePath) {
      setNoteContent(null);
      setNoteDirty(false);
      setBacklinks([]);
      setUnlinkedMentions([]);
      frontmatterRef.current = null;
      bodyRef.current = "";
      setFrontmatterState(null);
      setLoadedPath(null);
      if (editor && !editor.isDestroyed) {
        editor.commands.setContent("", { emitUpdate: false });
      }
      return;
    }

    const currentSeq = ++loadSeqRef.current;
    setLoadingContent(true);
    setError(null);
    setNoteDirty(false);
    setLoadedPath(null);

    void getNoteContent(selectedNotePath)
      .then((rawContent) => {
        if (loadSeqRef.current !== currentSeq) return;

        setNoteContent(rawContent);
        setLoadingContent(false);

        const { frontmatter: block, body } = splitFrontmatter(rawContent || "");
        frontmatterRef.current = block;
        bodyRef.current = body;
        tightListsRef.current = prefersTightLists(body);
        setFrontmatterState(block);

        if (editor && !editor.isDestroyed) {
          editor.commands.setContent(body, { emitUpdate: false });
        }
        setLoadedPath(selectedNotePath);

        const noteName = selectedNotePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
        void getBacklinks(noteName)
          .then((bls) => {
            if (loadSeqRef.current === currentSeq) setBacklinks(bls);
          })
          .catch(() => {
            if (loadSeqRef.current === currentSeq) setBacklinks([]);
          });
      })
      .catch((err) => {
        if (loadSeqRef.current !== currentSeq) return;
        setLoadingContent(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [selectedNotePath, reloadToken, editor, autosave, setNoteContent, setNoteDirty]);

  // A task opened from Note Tasks (or Home) asked for a line: once that note
  // is in the canvas, scroll to its block and flash it.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !loadedPath || pendingLine?.notePath !== loadedPath) return;
    const line = useVaultTasksStore.getState().consumePendingLine(loadedPath);
    if (line === null) return;
    // Consuming re-renders this component, so the frame is not tied to the
    // effect's lifetime; it only checks that the note is still the open one.
    requestAnimationFrame(() => {
      if (!editor.isDestroyed && currentTabRef.current === loadedPath) {
        revealLine(editor, frontmatterRef.current, bodyRef.current, line);
      }
    });
  }, [editor, loadedPath, pendingLine]);

  // Properties panel edits: new front matter + the unchanged body bytes.
  const handleFrontmatterChange = useCallback(
    (next: string | null) => {
      const target = currentTabRef.current;
      if (!target) return;
      frontmatterRef.current = next;
      setFrontmatterState(next);
      setNoteDirty(true);
      const md = joinFrontmatter(next, bodyRef.current);
      setNoteContent(md);
      autosave.schedule(target, md);
    },
    [autosave, setNoteContent, setNoteDirty]
  );

  // Scan unlinked mentions
  useEffect(() => {
    if (!selectedNotePath || !activeNoteName) {
      setUnlinkedMentions([]);
      return;
    }
    let cancel = false;
    const compute = async () => {
      const hits: UnlinkedHit[] = [];
      for (const note of vaultNotes.slice(0, 500)) {
        if (cancel) return;
        if (note.path === selectedNotePath) continue;
        try {
          const text = await getNoteContent(note.path);
          const mentions = findUnlinkedMentions(text, activeNoteName);
          if (mentions.length > 0) {
            hits.push({ note, count: mentions.length, snippet: mentions[0].snippet });
          }
        } catch {
          // ignore unreadable
        }
      }
      if (!cancel) setUnlinkedMentions(hits);
    };
    const t = setTimeout(compute, 800);
    return () => { cancel = true; clearTimeout(t); };
  }, [selectedNotePath, activeNoteName, vaultNotes]);

  const handleLinkMention = useCallback(async (hit: UnlinkedHit) => {
    try {
      const text = await getNoteContent(hit.note.path);
      const { content: linkedContent, linked } = linkMentions(text, activeNoteName);
      if (linked === 0) return;
      await writeNote(hit.note.path, linkedContent);
      setUnlinkedMentions((prev) => prev.filter((h) => h.note.path !== hit.note.path));
      void getBacklinks(activeNoteName).then(setBacklinks).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeNoteName]);

  const handleManualSave = useCallback(() => {
    const target = currentTabRef.current;
    if (!editor || !target) return;
    autosave.cancel();
    void saveCurrentNote(joinFrontmatter(frontmatterRef.current, bodyRef.current), target);
  }, [editor, autosave, saveCurrentNote]);

  const handleCreateNote = useCallback(async () => {
    const name = newNoteName.trim();
    if (!name) return;
    setError(null);
    try {
      const path = await createNote(name, `# ${name}\n\n`);
      const notes = await getVaultNotes();
      setVaultNotes(notes);
      setShowNewNote(false);
      setNewNoteName("");
      selectNote(path);
      setView("editor");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [newNoteName, setVaultNotes, selectNote, setView]);

  if (!selectedNotePath) {
    return (
      <div className="editor-shell">
        <div className="note-editor-empty">
          <EmptyState
            icon={Edit3}
            title="No note selected"
            description="Pick a note from the sidebar or create a new one to start writing."
            action={
              !showNewNote && (
                <Button variant="primary" iconLeft={<FilePlus size={14} />} onClick={() => setShowNewNote(true)}>
                  New note
                </Button>
              )
            }
          />
          {showNewNote && (
            <form
              className="note-new-note-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateNote();
              }}
            >
              <Input
                type="text"
                placeholder="Note name…"
                value={newNoteName}
                onChange={(e) => setNewNoteName(e.target.value)}
                autoFocus
                className="note-new-note-input"
                aria-label="Note name"
              />
              <Button type="submit" variant="primary">Create</Button>
              <Button variant="ghost" onClick={() => setShowNewNote(false)}>Cancel</Button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="editor-shell">
      {/* ── Top Note Tabs Bar (matching NoPes V3) ───────────────── */}
      <div className="tab-bar">
        {openNoteTabs.map((tabPath) => {
          const tabName = tabPath.split("/").pop()?.replace(/\.md$/i, "") ?? tabPath;
          const isActive = selectedNotePath === tabPath;
          return (
            <div
              key={tabPath}
              className={`tab-item${isActive ? " is-active" : ""}`}
              onClick={() => selectNote(tabPath)}
            >
              <FileText size={14} />
              <span className="tab-title">{tabName}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeNoteTab(tabPath);
                }}
                title="Close tab"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
        <button
          className="tab-new-btn"
          onClick={() => setShowNewNote(true)}
          title="New note"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* ── Topbar (Breadcrumb + Save Status + Actions) ─────────── */}
      <div className="editor-topbar">
        <div className="editor-topbar-left">
          <button className="icon-btn sm" onClick={() => setView("dashboard")} title="Back to Home">
            <ArrowLeft size={14} />
          </button>
          <FileText size={14} />
          <span className="editor-topbar-breadcrumb">{activeNoteName}</span>
        </div>

        <div className="editor-topbar-right">
          <span className={`save-status ${saving || loadingContent ? "saving" : ""}`}>
            {loadingContent ? "Loading…" : saving ? "Saving…" : noteDirty ? "● Unsaved" : "Saved"}
          </span>

          <button
            className={`icon-btn sm ${showBacklinks ? "is-active" : ""}`}
            title="Backlinks"
            onClick={() => setShowBacklinks((v) => !v)}
          >
            <Link2 size={14} />
            {backlinks.length > 0 && <span className="topbar-badge">{backlinks.length}</span>}
          </button>

          <button
            className={`icon-btn sm ${showUnlinked ? "is-active" : ""}`}
            title="Unlinked mentions"
            onClick={() => setShowUnlinked((v) => !v)}
          >
            <LinkIcon size={14} />
            {unlinkedMentions.length > 0 && <span className="topbar-badge">{unlinkedMentions.length}</span>}
          </button>

          <button
            className="btn btn-primary btn-sm"
            onClick={handleManualSave}
            disabled={!noteDirty || saving}
            title="Save (⌘S)"
          >
            <Save size={14} />
            <span>Save</span>
          </button>
        </div>
      </div>

      {/* ── Rich Formatting Toolbar (matching NoPes V3 Toolbar) ── */}
      {editor && (
        <div className="editor-toolbar">
          <button
            className={`toolbar-btn ${editor.isActive("heading", { level: 1 }) ? "is-active" : ""}`}
            title="Heading 1"
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("heading", { level: 2 }) ? "is-active" : ""}`}
            title="Heading 2"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("heading", { level: 3 }) ? "is-active" : ""}`}
            title="Heading 3"
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 size={14} />
          </button>

          <div className="toolbar-divider" />

          <button
            className={`toolbar-btn ${editor.isActive("bold") ? "is-active" : ""}`}
            title="Bold (⌘B)"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("italic") ? "is-active" : ""}`}
            title="Italic (⌘I)"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("underline") ? "is-active" : ""}`}
            title="Underline (⌘U)"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("strike") ? "is-active" : ""}`}
            title="Strikethrough"
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("code") ? "is-active" : ""}`}
            title="Inline code"
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <Code size={14} />
          </button>

          <div className="toolbar-divider" />

          {/* Font Size Selector */}
          <select
            className="toolbar-select"
            value={(() => {
              const attrs = editor.getAttributes("textStyle");
              return attrs?.fontSize || "16px";
            })()}
            title="Font size"
            onChange={(e) => {
              const size = e.target.value;
              if (size === "16px") {
                editor.chain().focus().unsetFontSize().run();
              } else {
                editor.chain().focus().setFontSize(size).run();
              }
            }}
          >
            <option value="16px">Default</option>
            {SIZES.filter((s) => s !== "16px").map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          {/* Color Picker */}
          <div style={{ position: "relative" }}>
            <button
              className="toolbar-btn"
              title="Text color"
              onClick={() => setShowColor((v) => !v)}
            >
              <Palette size={14} />
            </button>
            {showColor && (
              <div className="color-picker-popup">
                {COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className="color-swatch"
                    style={{ background: c.value }}
                    title={c.name}
                    aria-label={`Text color: ${c.name}`}
                    onClick={() => {
                      editor.chain().focus().setColor(c.value).run();
                      setShowColor(false);
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="color-swatch color-swatch-reset"
                  title="Default color"
                  aria-label="Default text color"
                  onClick={() => {
                    editor.chain().focus().unsetColor().run();
                    setShowColor(false);
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          <div className="toolbar-divider" />

          <button
            className={`toolbar-btn ${editor.isActive("bulletList") ? "is-active" : ""}`}
            title="Bullet list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("orderedList") ? "is-active" : ""}`}
            title="Ordered list"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("taskList") ? "is-active" : ""}`}
            title="Task list"
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          >
            <CheckSquare size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("blockquote") ? "is-active" : ""}`}
            title="Quote block"
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote size={14} />
          </button>
          <button
            className="toolbar-btn"
            title="Horizontal rule"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          >
            <Minus size={14} />
          </button>

          <div className="toolbar-divider" />

          <button
            className={`toolbar-btn ${editor.isActive("link") ? "is-active" : ""}`}
            title="Insert link"
            onClick={() => {
              const currentLink = editor.getAttributes("link").href;
              setLinkUrl(currentLink || "https://");
              setShowLinkModal(true);
            }}
          >
            <LinkIcon size={14} />
          </button>
          <button
            className={`toolbar-btn ${editor.isActive("table") ? "is-active" : ""}`}
            title="Insert table (3×3)"
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            <Grid3x3 size={14} />
          </button>

          <div className="toolbar-divider" />

          <button
            className="toolbar-btn"
            title="Add property (front matter)"
            aria-label="Add property"
            onClick={() => setAddPropertyRequest((n) => n + 1)}
          >
            <ListPlus size={14} />
          </button>
        </div>
      )}

      {error && <div className="note-editor-error">{error}</div>}

      {/* ── Main Document Canvas (Unified Single Document View) ── */}
      <div
        className="editor-scroll"
        onClick={(e) => {
          if ((e.target as HTMLElement).classList.contains("editor-scroll") || (e.target as HTMLElement).classList.contains("editor-body")) {
            editor?.commands.focus("end");
          }
        }}
      >
        <div className="editor-body">
          <div className="note-title">{activeNoteName}</div>

          <NoteProperties frontmatter={frontmatter} onChange={handleFrontmatterChange} addRequest={addPropertyRequest} />

          <EditorContent editor={editor} />

          {/* Backlinks Panel (at bottom of document) */}
          {showBacklinks && (
            <div className="editor-bottom-panel">
              <BacklinksPanel
                backlinks={backlinks}
                noteName={activeNoteName}
                onSelect={(path: string) => selectNote(path)}
                onClose={() => setShowBacklinks(false)}
              />
            </div>
          )}

          {/* Unlinked Mentions Panel */}
          {showUnlinked && (
            <div className="editor-bottom-panel unlinked-panel">
              <div className="unlinked-header">
                <LinkIcon size={14} />
                <span className="unlinked-title">Unlinked mentions ({unlinkedMentions.length})</span>
              </div>
              {unlinkedMentions.length === 0 ? (
                <div className="unlinked-empty">
                  <p>No unlinked mentions found.</p>
                  <p className="unlinked-hint">Plain-text mentions of "{activeNoteName}" in other notes will appear here.</p>
                </div>
              ) : (
                <div className="unlinked-list">
                  {unlinkedMentions.map((hit, i) => (
                    <div key={`${hit.note.path}-${i}`} className="unlinked-item">
                      <div className="unlinked-item-header">
                        <FileText size={14} />
                        <span className="unlinked-item-name">{hit.note.name}</span>
                        <span className="unlinked-item-count">{hit.count} mention{hit.count > 1 ? "s" : ""}</span>
                      </div>
                      <div className="unlinked-item-snippet">{hit.snippet}</div>
                      <button
                        className="btn btn-primary btn-sm unlinked-link-btn"
                        onClick={() => void handleLinkMention(hit)}
                      >
                        Link to [[{activeNoteName}]]
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Link Modal ─────────────────────────────────────────── */}
      <Modal
        open={showLinkModal}
        onClose={() => setShowLinkModal(false)}
        title="Insert link"
        icon={LinkIcon}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowLinkModal(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (editor) {
                  editor.chain().focus().setLink({ href: linkUrl }).run();
                }
                setShowLinkModal(false);
              }}
            >
              Insert
            </Button>
          </>
        }
      >
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="note-link-url">URL</label>
          <Input
            id="note-link-url"
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://example.com"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (editor) {
                  editor.chain().focus().setLink({ href: linkUrl }).run();
                }
                setShowLinkModal(false);
              }
            }}
          />
        </div>
      </Modal>

      {/* ── Inline New Note Modal ───────────────────────────────── */}
      <Modal
        open={showNewNote}
        onClose={() => setShowNewNote(false)}
        title="New note"
        icon={FilePlus}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowNewNote(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void handleCreateNote()} disabled={!newNoteName.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="note-new-name">Note name</label>
          <Input
            id="note-new-name"
            autoFocus
            value={newNoteName}
            onChange={(e) => setNewNoteName(e.target.value)}
            placeholder="e.g. Weekly review"
            onKeyDown={(e) => e.key === "Enter" && handleCreateNote()}
          />
        </div>
      </Modal>
    </div>
  );
}
