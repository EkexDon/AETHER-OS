import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { EditorState, StateField, Range } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, Decoration, DecorationSet, hoverTooltip, Tooltip } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { autocompletion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from "@codemirror/language";
import { tags as cmTags } from "@lezer/highlight";
import { Save, Eye, Edit3, FilePlus, Link2, ArrowLeft, Loader2, LinkIcon, FileText } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { writeNote, createNote, getBacklinks, getVaultNotes, getNoteContent } from "../lib/ipc";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { BacklinksPanel } from "./BacklinksPanel";
import { findUnlinkedMentions, linkMentions } from "../lib/mentions";
import type { Backlink, VaultNote } from "../types";

type EditorMode = "edit" | "split" | "preview";

interface UnlinkedHit { note: VaultNote; count: number; snippet: string }

const WIKILINK_REGEX = /\[\[([^\]|#\n]+?)(?:\|[^\]]+?)?\]\]/g;

// ── Wikilink decoration field ─────────────────────────────────
const wikiLinkDecorations = StateField.define<DecorationSet>({
  create(state) {
    return buildWikiDecorations(state);
  },
  update(deco, tr) {
    if (!tr.docChanged) return deco;
    return buildWikiDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildWikiDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = state.doc.toString();
  let m: RegExpExecArray | null;
  WIKILINK_REGEX.lastIndex = 0;
  while ((m = WIKILINK_REGEX.exec(doc)) !== null) {
    decorations.push(
      Decoration.mark({
        class: "wikilink-marker",
        attributes: { "data-target": m[1].trim() },
      }).range(m.index, m.index + m[0].length)
    );
  }
  return Decoration.set(decorations);
}

// ── Wikilink hover tooltip ────────────────────────────────────
function wikiLinkTooltip(view: EditorView, pos: number): Tooltip | null {
  const target = getWikilinkAtPos(view.state, pos);
  if (!target) return null;
  return {
    pos,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "wiki-tooltip";
      dom.innerHTML = `<div class="wiki-tooltip-title">${target}</div><div class="wiki-tooltip-sub">Ctrl+Click to open or create</div>`;
      return { dom };
    },
  };
}

// ── Scan doc text for a [[wikilink]] at a given position ──────────
function getWikilinkAtPos(state: EditorState, pos: number): string | null {
  const doc = state.doc.toString();
  WIKILINK_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_REGEX.exec(doc)) !== null) {
    if (pos >= m.index && pos <= m.index + m[0].length) {
      return m[1].trim();
    }
  }
  return null;
}

const highlightTheme = HighlightStyle.define([
  { tag: cmTags.heading, color: "#e0e0e0", fontWeight: "bold" },
  { tag: cmTags.strong, color: "#fff", fontWeight: "bold" },
  { tag: cmTags.emphasis, color: "#ccc", fontStyle: "italic" },
  { tag: cmTags.link, color: "#7ab7ff" },
  { tag: cmTags.url, color: "#7ab7ff" },
  { tag: cmTags.monospace, color: "#e6a23c" },
  { tag: cmTags.quote, color: "#909399" },
  { tag: cmTags.list, color: "#c0c4cc" },
  { tag: cmTags.processingInstruction, color: "#909399" },
]);

export function NoteEditor() {
  const {
    selectedNotePath,
    noteContent,
    setNoteContent,
    vaultNotes,
    setVaultNotes,
    setView,
    noteDirty,
    setNoteDirty,
  } = useAetherStore();

  const [mode, setMode] = useState<EditorMode>("split");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [showBacklinks, setShowBacklinks] = useState(false);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [unlinkedMentions, setUnlinkedMentions] = useState<UnlinkedHit[]>([]);
  const [newNoteName, setNewNoteName] = useState("");
  const [showNewNote, setShowNewNote] = useState(false);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(noteContent ?? "");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeNoteName = useMemo(() => {
    if (!selectedNotePath) return "";
    return selectedNotePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  }, [selectedNotePath]);

  // Build wikilink autocomplete source from vault notes
  const wikilinkCompletions = useCallback(
    (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/\[\[[^\]]*/);
      if (!word) return null;
      const query = word.text.slice(2).toLowerCase();
      const matches = vaultNotes
        .filter((n) => n.name.toLowerCase().includes(query))
        .slice(0, 20)
        .map((n) => ({
          label: n.name,
          type: "class",
          apply: `[[${n.name}]]`,
        }));
      if (matches.length === 0) return null;
      return {
        from: word.from,
        to: word.to,
        options: matches,
        validFor: /^\[\[[^\]]*$/,
      };
    },
    [vaultNotes]
  );

  // Tag autocomplete source — collects #tags from all notes
  const tagCompletions = useCallback(
    (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/#[\w-]*/);
      if (!word) return null;
      const query = word.text.slice(1).toLowerCase();
      const allTags = new Set<string>();
      for (const note of vaultNotes) {
        // Extract tags from note name/path heuristics
        const parts = note.path.split("/");
        for (const p of parts) {
          if (p.startsWith("#")) allTags.add(p.slice(1).toLowerCase());
        }
      }
      // Also scan current content for tags
      const contentTags = contentRef.current.match(/#[\w-]+/g) || [];
      for (const t of contentTags) allTags.add(t.slice(1).toLowerCase());

      const matches = [...allTags]
        .filter((t) => t.includes(query))
        .slice(0, 15)
        .map((t) => ({
          label: `#${t}`,
          type: "variable",
          apply: `#${t}`,
        }));
      if (matches.length === 0) return null;
      return {
        from: word.from,
        to: word.to,
        options: matches,
        validFor: /^#[\w-]*$/,
      };
    },
    [vaultNotes]
  );

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorContainerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const newContent = update.state.doc.toString();
        contentRef.current = newContent;
        setNoteContent(newContent);
        setNoteDirty(true);

        // Debounced save
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => {
          void doSave();
        }, 2000);
      }
    });

    const state = EditorState.create({
      doc: contentRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        highlightSelectionMatches(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlightTheme),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        autocompletion({
          override: [wikilinkCompletions, tagCompletions],
          activateOnTyping: true,
        }),
        wikiLinkDecorations,
        hoverTooltip(wikiLinkTooltip, { hoverTime: 100 }),
        EditorView.lineWrapping,
        updateListener,
        EditorView.domEventHandlers({
          click(event, view) {
            // Ctrl/Cmd+Click on a wikilink → open or create note
            if (!(event.ctrlKey || event.metaKey)) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const target = getWikilinkAtPos(view.state, pos);
            if (target) {
              void handleWikiClick(target);
              event.preventDefault();
              return true;
            }
            return false;
          },
        }),
        EditorView.theme({
          "&": {
            fontSize: "14px",
            height: "100%",
          },
          ".cm-content": {
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            padding: "16px",
          },
          ".cm-gutters": {
            backgroundColor: "transparent",
            borderRight: "1px solid rgba(255,255,255,0.06)",
          },
          ".cm-activeLine": {
            backgroundColor: "rgba(255,255,255,0.03)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "rgba(255,255,255,0.03)",
          },
          ".cm-selectionBackground": {
            backgroundColor: "rgba(122, 183, 255, 0.15)",
          },
          ".cm-tooltip": {
            backgroundColor: "#1a1a2e",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "6px",
          },
          ".cm-tooltip-autocomplete > ul > li": {
            padding: "4px 8px",
          },
          ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
            backgroundColor: "rgba(122, 183, 255, 0.2)",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorContainerRef.current });
    editorViewRef.current = view;

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, [wikilinkCompletions, tagCompletions]);

  // When selectedNotePath changes, reload content
  useEffect(() => {
    if (selectedNotePath && noteContent !== null) {
      contentRef.current = noteContent;
      setNoteDirty(false);
      // Replace editor document
      if (editorViewRef.current) {
        const view = editorViewRef.current;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: noteContent },
        });
      }
      // Load backlinks
      const noteName = selectedNotePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
      void getBacklinks(noteName)
        .then(setBacklinks)
        .catch(() => setBacklinks([]));
    }
  }, [selectedNotePath]);

  // ── Wikilink click handler: open existing note or create new one ──
  const handleWikiClick = useCallback(async (target: string) => {
    const lower = target.toLowerCase();
    const found = vaultNotes.find(
      (n) => n.name.toLowerCase() === lower || n.name.toLowerCase() === lower + ".md"
    );
    if (found) {
      useAetherStore.getState().selectNote(found.path);
      try {
        const content = await getNoteContent(found.path);
        setNoteContent(content);
      } catch {
        setNoteContent(null);
      }
      setView("editor");
    } else {
      // Create new note with this name
      try {
        const path = await createNote(target, `# ${target}\n\n`);
        const notes = await getVaultNotes();
        setVaultNotes(notes);
        useAetherStore.getState().selectNote(path);
        setNoteContent(`# ${target}\n\n`);
        setView("editor");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [vaultNotes, setView, setNoteContent, setVaultNotes]);

  // ── Unlinked mentions: scan vault for plain-text mentions of this note ──
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
          // skip unreadable notes
        }
      }
      if (!cancel) setUnlinkedMentions(hits);
    };
    const t = setTimeout(compute, 800);
    return () => { cancel = true; clearTimeout(t); };
  }, [selectedNotePath, activeNoteName, vaultNotes]);

  // ── Link a mention: convert plain text → [[wikilink]] in the source note ──
  const handleLinkMention = useCallback(async (hit: UnlinkedHit) => {
    try {
      const text = await getNoteContent(hit.note.path);
      const { content: linkedContent, linked } = linkMentions(text, activeNoteName);
      if (linked === 0) return;
      await writeNote(hit.note.path, linkedContent);
      setUnlinkedMentions((prev) => prev.filter((h) => h.note.path !== hit.note.path));
      // Refresh backlinks since we just created new links
      void getBacklinks(activeNoteName).then(setBacklinks).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeNoteName]);

  const doSave = useCallback(async () => {
    if (!selectedNotePath || !noteDirty) return;
    setSaving(true);
    setError(null);
    try {
      await writeNote(selectedNotePath, contentRef.current);
      setNoteDirty(false);
      // Refresh vault notes to pick up mtime changes
      const notes = await getVaultNotes();
      setVaultNotes(notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selectedNotePath, noteDirty, setNoteDirty, setVaultNotes]);

  const handleSaveNow = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    void doSave();
  }, [doSave]);

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
      useAetherStore.getState().selectNote(path);
      setNoteContent(`# ${name}\n\n`);
      setView("editor");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [newNoteName, setVaultNotes, setNoteContent, setView]);

  if (!selectedNotePath) {
    return (
      <div className="note-editor-empty">
        <div className="note-editor-empty-inner">
          <Edit3 size={48} className="note-editor-empty-icon" />
          <h2>No note selected</h2>
          <p>Pick a note from the sidebar or create a new one to start editing.</p>
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
    );
  }

  return (
    <div className="note-editor-container">
      <div className="note-editor-toolbar">
        <button className="btn btn-ghost" onClick={() => setView("dashboard")} title="Back">
          <ArrowLeft size={16} />
        </button>
        <span className="note-editor-title">{activeNoteName}</span>
        {noteDirty && <span className="note-editor-dirty">●</span>}
        {saving && <Loader2 size={14} className="spin" />}
        <div className="note-editor-spacer" />
        <button
          className={`btn btn-icon ${mode === "edit" ? "btn-active" : ""}`}
          onClick={() => setMode("edit")}
          title="Edit only"
        >
          <Edit3 size={16} />
        </button>
        <button
          className={`btn btn-icon ${mode === "split" ? "btn-active" : ""}`}
          onClick={() => setMode("split")}
          title="Split view"
        >
          <span style={{ fontSize: 11, fontWeight: 600 }}>⇆</span>
        </button>
        <button
          className={`btn btn-icon ${mode === "preview" ? "btn-active" : ""}`}
          onClick={() => setMode("preview")}
          title="Preview only"
        >
          <Eye size={16} />
        </button>
        <button
          className={`btn btn-icon ${showBacklinks ? "btn-active" : ""}`}
          onClick={() => setShowBacklinks((s) => !s)}
          title="Backlinks"
        >
          <Link2 size={16} />
        </button>
        <button
          className={`btn btn-icon ${showUnlinked ? "btn-active" : ""}`}
          onClick={() => setShowUnlinked((s) => !s)}
          title="Unlinked Mentions"
        >
          <LinkIcon size={16} />
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSaveNow}
          disabled={!noteDirty || saving}
          title="Save (Cmd+S)"
        >
          <Save size={16} />
        </button>
      </div>

      {error && <div className="note-editor-error">{error}</div>}

      <div className={`note-editor-body mode-${mode}`}>
        {mode !== "preview" && (
          <div className="note-editor-pane">
            <div ref={editorContainerRef} className="cm-editor-wrapper" />
          </div>
        )}
        {mode !== "edit" && (
          <div className="note-preview-pane">
            <MarkdownRenderer content={contentRef.current} />
          </div>
        )}
      </div>

      {showBacklinks && (
        <BacklinksPanel
          backlinks={backlinks}
          noteName={activeNoteName}
          onSelect={(path: string) => {
            useAetherStore.getState().selectNote(path);
            void getVaultNotes().then(setVaultNotes);
          }}
        />
      )}

      {showUnlinked && (
        <div className="unlinked-panel">
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
  );
}
