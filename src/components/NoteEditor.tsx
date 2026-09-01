import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useEditor, EditorContent, Extension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import LinkExtension from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";
import {
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, Link as LinkIcon,
  List, ListOrdered, Quote, Code, Minus, FileText, Underline as UnderlineIcon,
  Palette, Plus, X, Save, Edit3, FilePlus, Link2, ArrowLeft, Loader2,
  Grid3x3, CheckSquare, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Trash2,
} from "lucide-react";
import { useAetherStore } from "../lib/store";
import { writeNote, createNote, getBacklinks, getVaultNotes, getNoteContent } from "../lib/ipc";
import { BacklinksPanel } from "./BacklinksPanel";
import { findUnlinkedMentions, linkMentions } from "../lib/mentions";
import type { Backlink, VaultNote } from "../types";

// Custom FontSize extension
const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize?.replace(/['"]+/g, ""),
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize: (fontSize: string) => ({ chain }: any) => {
        return chain().setMark("textStyle", { fontSize }).run();
      },
      unsetFontSize: () => ({ chain }: any) => {
        return chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run();
      },
    };
  },
});

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

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSeqRef = useRef(0);
  const currentTabRef = useRef<string | null>(selectedNotePath);
  currentTabRef.current = selectedNotePath;

  const COLORS = ["#e8e8e8", "#ffffff", "#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6"];
  const SIZES = ["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px"];

  const activeNoteName = useMemo(() => {
    if (!selectedNotePath) return "";
    return selectedNotePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  }, [selectedNotePath]);

  // Debounced note save
  const saveCurrentNote = useCallback(async (contentToSave: string) => {
    const targetPath = currentTabRef.current;
    if (!targetPath) return;

    setSaving(true);
    setError(null);
    try {
      await writeNote(targetPath, contentToSave);
      setNoteDirty(false);
      const notes = await getVaultNotes();
      setVaultNotes(notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [setNoteDirty, setVaultNotes]);

  // Initialize TipTap WYSIWYG Editor
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Underline,
      TextStyle,
      FontSize,
      Color,
      Image.configure({ allowBase64: true }),
      LinkExtension.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: "Start writing markdown, thoughts, or ideas…" }),
      Markdown.configure({
        html: true,
        transformCopiedText: false,
        transformPastedText: false,
      }),
    ],
    content: "",
    onUpdate: ({ editor: currentEditor }) => {
      setNoteDirty(true);
      const md = (currentEditor.storage as any).markdown?.getMarkdown?.() ?? "";
      setNoteContent(md);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void saveCurrentNote(md);
      }, 1200);
    },
    editorProps: {
      attributes: {
        spellcheck: "false",
        class: "nopes-prosemirror-canvas",
      },
    },
  });

  // Load note content when selectedNotePath changes
  useEffect(() => {
    if (!selectedNotePath) {
      setNoteContent(null);
      setNoteDirty(false);
      setBacklinks([]);
      setUnlinkedMentions([]);
      if (editor && !editor.isDestroyed) {
        editor.commands.setContent("");
      }
      return;
    }

    const currentSeq = ++loadSeqRef.current;
    setLoadingContent(true);
    setError(null);
    setNoteDirty(false);

    void getNoteContent(selectedNotePath)
      .then((rawContent) => {
        if (loadSeqRef.current !== currentSeq) return;

        setNoteContent(rawContent);
        setLoadingContent(false);

        if (editor && !editor.isDestroyed) {
          editor.commands.setContent(rawContent || "", { emitUpdate: false } as any);
        }

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
  }, [selectedNotePath, editor, setNoteContent, setNoteDirty]);

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
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!editor) return;
    const md = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
    void saveCurrentNote(md);
  }, [editor, saveCurrentNote]);

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
          <div className="note-editor-empty-inner">
            <Edit3 size={48} className="note-editor-empty-icon" />
            <h2>No note selected</h2>
            <p>Pick a note from the sidebar or create a new one to start writing.</p>
            <button className="btn btn-primary" onClick={() => setShowNewNote(true)}>
              <FilePlus size={16} />
              New Note
            </button>
            {showNewNote && (
              <div className="note-new-note-inline">
                <input
                  type="text"
                  placeholder="Note name…"
                  value={newNoteName}
                  onChange={(e) => setNewNoteName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateNote()}
                  autoFocus
                  className="note-new-note-input"
                />
                <button className="btn btn-primary" onClick={handleCreateNote}>Create</button>
                <button className="btn btn-ghost" onClick={() => setShowNewNote(false)}>Cancel</button>
              </div>
            )}
          </div>
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
              <FileText size={13} />
              <span className="tab-title">{tabName}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeNoteTab(tabPath);
                }}
                title="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          className="tab-new-btn"
          onClick={() => setShowNewNote(true)}
          title="New note"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* ── Topbar (Breadcrumb + Save Status + Actions) ─────────── */}
      <div className="editor-topbar">
        <div className="editor-topbar-left">
          <button className="icon-btn sm" onClick={() => setView("dashboard")} title="Dashboard">
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
            title="Linked Mentions / Backlinks"
            onClick={() => setShowBacklinks((v) => !v)}
          >
            <Link2 size={14} />
            {backlinks.length > 0 && <span className="topbar-badge">{backlinks.length}</span>}
          </button>

          <button
            className={`icon-btn sm ${showUnlinked ? "is-active" : ""}`}
            title="Unlinked Mentions"
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
            <Save size={13} />
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
            title="Inline Code"
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
                (editor.chain().focus() as any).unsetFontSize().run();
              } else {
                (editor.chain().focus() as any).setFontSize(size).run();
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
                    key={c}
                    className="color-swatch"
                    style={{ background: c }}
                    onClick={() => {
                      editor.chain().focus().setColor(c).run();
                      setShowColor(false);
                    }}
                  />
                ))}
                <button
                  className="color-swatch color-swatch-reset"
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
            title="Insert Link"
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
            title="Insert Table (3×3)"
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            <Grid3x3 size={14} />
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

          <EditorContent editor={editor} />

          {/* Backlinks Panel (at bottom of document) */}
          {showBacklinks && (
            <div className="editor-bottom-panel">
              <BacklinksPanel
                backlinks={backlinks}
                noteName={activeNoteName}
                onSelect={(path: string) => selectNote(path)}
              />
            </div>
          )}

          {/* Unlinked Mentions Panel */}
          {showUnlinked && (
            <div className="editor-bottom-panel unlinked-panel">
              <div className="unlinked-header">
                <LinkIcon size={14} />
                <span className="unlinked-title">Unlinked Mentions ({unlinkedMentions.length})</span>
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
                        <FileText size={12} />
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
      {showLinkModal && (
        <div className="modal-backdrop" onClick={() => setShowLinkModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Insert Link</div>
            <label className="modal-label">URL</label>
            <input
              className="modal-input"
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (editor) {
                    editor.chain().focus().setLink({ href: linkUrl }).run();
                  }
                  setShowLinkModal(false);
                }
              }}
            />
            <div className="modal-actions">
              <button className="modal-btn secondary" onClick={() => setShowLinkModal(false)}>Cancel</button>
              <button
                className="modal-btn primary"
                onClick={() => {
                  if (editor) {
                    editor.chain().focus().setLink({ href: linkUrl }).run();
                  }
                  setShowLinkModal(false);
                }}
              >
                Insert
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Inline New Note Modal ───────────────────────────────── */}
      {showNewNote && (
        <div className="modal-backdrop" onClick={() => setShowNewNote(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">New Note</div>
            <label className="modal-label">Note Name</label>
            <input
              className="modal-input"
              autoFocus
              value={newNoteName}
              onChange={(e) => setNewNoteName(e.target.value)}
              placeholder="e.g. My New Note"
              onKeyDown={(e) => e.key === "Enter" && handleCreateNote()}
            />
            <div className="modal-actions">
              <button className="modal-btn secondary" onClick={() => setShowNewNote(false)}>Cancel</button>
              <button className="modal-btn primary" onClick={handleCreateNote}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
