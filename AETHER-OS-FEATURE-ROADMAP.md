# AETHER-OS — Feature Roadmap: From App to Personal OS

> **Vision:** AETHER-OS is not a note app with AI bolted on. It is a local-first personal operating system — the home base for your knowledge, your projects, your tools, and your AI. Everything you need to think, build, and work, in one place, on your machine.

---

## Current State (v0.1)

| Feature | Status |
|---------|--------|
| AI Agent Chat (Ollama, streaming, note context) | ✅ Shipped |
| Semantic Search (vector embeddings) | ✅ Shipped |
| Knowledge Graph (wikilink visualization) | ✅ Shipped |
| Dashboard (vault stats, note preview) | ✅ Shipped |
| AETHER Notes (AI-generated note persistence) | ✅ Shipped |
| Project Dashboard (git status, scan, open in editor) | ✅ Shipped |
| Persistent AI Memory (facts, conversations) | ✅ Shipped |
| Command Bar (Cmd+K palette) | ✅ Shipped |
| Configurable Default Editor | ✅ Shipped |
| Resizable Panels | ✅ Shipped |
| Built-in Terminal (PTY, multi-tab, xterm.js) | ✅ Shipped |
| System Monitor (CPU, RAM, disk, network, processes) | ✅ Shipped |
| Embedded Browser (native webview subviews, tabs, bookmarks, history) | ✅ Shipped |
| Embedded IDE (Monaco editor, file tree, tabs, PTY terminal) | ✅ Shipped |
| Git Source Control in the IDE (status, staging, commit, branches, diffs, log) | ✅ Shipped |
| Project-wide IntelliSense in the IDE (LSP sidecars: hover, completions, go-to-definition, diagnostics) | ✅ Shipped |

---

## Phase 1: The Core OS Layer (Make it feel like an OS)

### 1.1 — Built-in Terminal

**What:** A real PTY-backed terminal inside AETHER-OS. Multiple tabs, split panes, full ANSI support.

**Why:** You shouldn't leave AETHER-OS to run `git`, `npm`, `cargo`, or `ollama`. The terminal is the most fundamental developer tool — having it embedded turns AETHER-OS from "an app I use" into "the app I live in."

**Tech:** `portable-pty` (Rust) for PTY management, `xterm.js` (frontend) for terminal rendering, Tauri IPC for streaming output.

**What you get:** Run commands without context-switching. AI can see terminal output and help you debug. Projects open with a terminal pre-pointed at their directory.

---

### 1.2 — System Monitor

**What:** Live dashboard showing CPU usage, RAM consumption, disk space, network activity, battery, and top processes.

**Why:** On an 8GB M2 Mac, resource awareness is survival. You need to know if Ollama is eating all your RAM before your Mac freezes. A built-in monitor means you never need Activity Monitor again.

**Tech:** `sysinfo` crate (Rust) for hardware metrics, streaming via Tauri events, React charts (recharts or custom SVG).

**What you get:** Real-time visibility into your machine's health. Set alerts for high memory usage. Know exactly when it's safe to run a heavy AI query.

---

### 1.3 — Clipboard Manager

**What:** System-wide clipboard history. Every text snippet, code block, URL, and image you copy is captured and searchable. Pin important clips, search by keyword, paste with one click.

**Why:** Developers copy-paste hundreds of times per day. Losing a snippet means re-searching, re-reading, re-copying. A clipboard history turns throwaway copies into a searchable archive.

**Tech:** Rust backend polling `NSPasteboard` (macOS), SQLite for history storage, React frontend with search/filter.

**What you get:** Never lose a copied snippet again. Search paste history by content. Pin frequently used code blocks. Reduces friction between browser, editor, and terminal.

---

### 1.4 — Quick Launcher

**What:** Spotlight-style launcher (Cmd+Space) that searches across everything: notes, projects, files, commands, bookmarks, AI conversations. One keystroke to jump anywhere or open anything.

**Why:** The Command Bar (Cmd+K) already exists for navigation. A Quick Launcher extends this to the entire system — open any file, launch any app, run any command, search any note, all from one input field.

**Tech:** Extend existing CommandBar component, add file system indexing (Rust `walkdir`), fuzzy search (`fuzzy-matcher` crate), app launching via `open -a`.

**What you get:** One input to rule them all. No moreFinder, no more Spotlight, no more app switching. Type what you want, hit enter, it's open.

---

## Phase 2: The Knowledge Engine (Make it think)

### 2.1 — Note Editor with Live Preview

**What:** Full Markdown editing with live side-by-side preview. Syntax highlighting, wikilink autocomplete, tag autocomplete, image embedding, Mermaid diagram editing.

**Why:** AETHER-OS currently shows notes in read-only preview. A real knowledge OS lets you write, not just read. Editing is the core loop — capture → edit → link → recall.

**Tech:** CodeMirror 6 (lightweight, extensible) or Monaco Editor, custom Markdown parser extensions for wikilinks, live preview via existing MarkdownRenderer.

**What you get:** Write and edit notes without leaving AETHER-OS. Autocomplete for `[[wikilinks]]` and `#tags`. See your formatting live as you type. Turn AETHER-OS from a reader into a workspace.

---

### 2.2 — Backlinks & Bidirectional Links

**What:** When you write `[[Ekins Work]]` in any note, AETHER-OS automatically tracks the reverse link. A backlinks panel shows every note that references the current note.

**Why:** Backlinks are the killer feature of Obsidian and Roam. They reveal unexpected connections — "oh, I referenced this project in 3 different meeting notes." Without backlinks, notes are isolated islands. With them, they're a network.

**Tech:** Rust backend scanning all vault notes for `[[wikilink]]` patterns, building a reverse index. Frontend panel showing backlinks with context previews.

**What you get:** Discover connections you didn't know existed. See which notes reference the current one. Navigate your knowledge graph by relationship, not by folder.

---

### 2.3 — Daily Notes & Quick Capture

**What:** A daily note is auto-created each day (e.g., `2026-07-28.md`). A global hotkey (Cmd+Shift+N) opens a quick-capture input — type a thought, hit enter, it's appended to today's note.

**Why:** Friction kills note-taking. If you have to open the app, navigate to a folder, create a file, name it, and start typing — you won't. Quick capture removes all friction. Daily notes give every thought a home.

**Tech:** Rust backend creating daily note files, global hotkey registration via Tauri, React modal for quick capture input.

**What you get:** Capture any thought in under 2 seconds. Every day has a chronological log. Search past days instantly. Build a journaling habit without trying.

---

### 2.4 — AI Agent Actions (Write, Run, Automate)

**What:** The AI doesn't just answer questions — it takes actions. "Create a note titled X", "Summarize this URL and save it", "Run `cargo test` in project Y and explain the failures", "Add a task to my daily note".

**Why:** Chat-only AI is a glorified search engine. Action-capable AI is a collaborator. The difference between "here's what you should do" and "I did it for you" is the difference between a tool and an OS.

**Tech:** Tool-calling architecture — AI responses include structured action intents, Rust backend executes them (file writes, shell commands, note creation) with user approval for destructive actions.

**What you get:** Tell the AI what you want, it does it. Create notes from conversations. Run commands from chat. Summarize web pages into your vault. The AI becomes an agent, not just a chatbot.

---

### 2.5 — Web Clipper & Research Mode

**What:** Paste a URL, AETHER-OS fetches the page, extracts the main content (stripping nav/ads/footer), and saves it as a Markdown note in your vault. Optionally ask the AI to summarize it first.

**Why:** Research means collecting sources. Currently, you'd copy-paste from a browser manually. A web clipper turns AETHER-OS into a research engine — capture, summarize, and connect web content without leaving your workspace.

**Tech:** Rust `reqwest` for fetching, `scraper` crate for HTML parsing/content extraction, Markdown conversion, AI summarization via existing Ollama integration.

**What you get:** Build a personal knowledge base from web content. One click to capture an article. AI summarizes it. It's searchable alongside your own notes. Never lose a useful article again.

---

## Phase 3: The Productivity Layer (Make it work)

### 3.1 — Task & Project Management

**What:** Kanban board view for tasks. Tasks are extracted from note checkboxes (`- [ ]`) and can be viewed, dragged, and managed across columns (Todo, In Progress, Done). Tasks link back to their source note.

**Why:** Tasks scattered across notes are invisible. A Kanban view aggregates them into one actionable surface. You see everything you need to do, prioritize by dragging, and click through to the note for context.

**Tech:** Rust backend scanning vault for `- [ ]` and `- [x]` patterns, extracting task text + source note path. React Kanban board with drag-and-drop (@hello-pangea/dnd or similar).

**What you get:** All your tasks in one place. Drag to prioritize. Click to see the note context. No separate todo app needed.

---

### 3.2 — Calendar & Reminders

**What:** Monthly calendar view showing tasks with due dates, daily notes, and reminders. Desktop notifications for upcoming deadlines. ICS import/export for Google Calendar / Apple Calendar sync.

**Why:** Time is the missing dimension in note apps. Notes are spatial (they live in folders), but work is temporal (it has deadlines). A calendar bridges this — see what's due, when, and what your day looks like.

**Tech:** Rust backend parsing date metadata from note frontmatter, ICS parsing/generation, macOS notification API (`mac_notification_sys` or Tauri plugin).

**What you get:** See your week at a glance. Get notified before deadlines. Sync with your existing calendar. Never miss a deadline because it was buried in a note.

---

### 3.3 — Pomodoro & Focus Mode

**What:** Built-in Pomodoro timer (25/5 or custom). Focus mode dims everything except the current note/editor. Timer state persists across sessions. Daily focus time tracked and shown on dashboard.

**Why:** Productivity isn't just about having tools — it's about using them consistently. A Pomodoro timer builds focus habits. Focus mode eliminates distractions. Tracked time shows you patterns in your work.

**Tech:** React timer component, Tauri window management for focus mode, SQLite or JSON for time tracking persistence.

**What you get:** Build deep work habits. Track how much focused time you actually get. See patterns — "I focus best at 10am" — and optimize your schedule.

---

### 3.4 — Bookmarks & Pinned Items

**What:** Pin frequently used notes, projects, commands, and AI conversations to a sidebar. Quick access without searching. Organize pins into groups.

**Why:** You have 10-20 things you access daily. Searching for them every time is friction. Pinned items are one click away — your daily note, your main project, your most-used AI conversation.

**Tech:** Zustand store with localStorage persistence, React sidebar component, drag-to-reorder.

**What you get:** Your most-used items are always one click away. No searching, no navigating. Customize your workflow surface.

---

## Phase 4: The Intelligence Layer (Make it grow)

### 4.1 — Auto-Git Versioning for Notes

**What:** Every note edit is automatically committed to a local git repository. Browse version history, diff changes, restore previous versions. No manual commits needed.

**Why:** Notes change over time. Without version history, you lose the evolution of your thinking. Auto-git means every edit is recoverable — you can always go back. It's like Time Machine for your brain.

**Tech:** Rust backend running `git add && git commit` on file change events (via `notify` crate), git log/diff parsing for history UI, React timeline component.

**What you get:** Never lose a draft. See how your notes evolved. Restore anything. Your knowledge base has a history, not just a present.

---

### 4.2 — AI-Powered Note Suggestions

**What:** As you write, the AI suggests related notes you might want to link to. After writing a note, the AI offers to create backlinks, suggest tags, and summarize the note for the dashboard.

**Why:** Manual linking is tedious. AI suggestions surface connections you'd miss — "this note about React hooks is related to your note about state management from last month." The system actively helps you build your knowledge graph.

**Tech:** Semantic similarity via existing vector embeddings, real-time suggestions during editing, AI summarization via Ollama.

**What you get:** Your knowledge graph grows automatically. Connections you'd never make manually are surfaced. The system gets smarter the more you use it.

---

### 4.3 — Conversation Auto-Compaction

**What:** Long AI conversations are automatically compressed into summaries when they exceed a token threshold. The summary preserves key facts and decisions. Full transcript is archived but not loaded into context.

**Why:** Long conversations bloat context windows, slow down AI responses, and consume RAM. Auto-compaction keeps conversations fast and affordable while preserving memory. You can have month-long project conversations without performance degradation.

**Tech:** Rust backend tracking conversation token count, Ollama summarization when threshold exceeded, summary stored in MemoryStore.

**What you get:** Month-long AI conversations that stay fast. No more manually starting "new chat" because the old one got slow. The AI remembers the summary, you keep the full history.

---

### 4.4 — Cross-Module Universal Search

**What:** One search bar that searches across everything: notes, projects, AI conversations, memory facts, clipboard history, bookmarks, file system. Results are categorized and ranked by relevance.

**Why:** Currently, search is fragmented — semantic search only covers notes, project search only covers projects. Universal search means you type once and find anything, regardless of where it lives.

**Tech:** Unified search index combining vector embeddings (notes), BM25 keyword search (all text), file system index, and memory store queries. React results UI with category tabs.

**What you get:** Find anything from one input. No more "which search do I use?" One box, everything searchable, results ranked by relevance.

---

## Phase 5: The Extension Layer (Make it yours)

### 5.1 — Plugin System

**What:** A plugin architecture allowing custom tools, views, and AI tools to be added without modifying core code. Plugins are JavaScript/TypeScript modules loaded at runtime.

**Why:** No app anticipates every use case. A plugin system means AETHER-OS grows with your needs — add a flashcard plugin, a recipe organizer, a workout tracker, whatever you want. The community can build and share plugins.

**Tech:** Plugin manifest format, sandboxed JS execution (via `deno_core` or Web Workers), plugin API exposing vault access, AI access, and UI registration.

**What you get:** Infinite extensibility without forking. Build custom tools for your workflow. Share them with others. AETHER-OS becomes a platform, not just an app.

---

### 5.2 — Export & Publishing

**What:** Export notes to PDF, HTML, or standalone Markdown bundles. Publish a note or folder as a static website (like Obsidian Publish, but self-hosted and free).

**Why:** Knowledge is meant to be shared. Currently, notes are locked in the vault. Export lets you share with non-AETHER-OS users. Publishing lets you share your knowledge with the world.

**Tech:** Rust backend for PDF generation (via `printpdf` or `wkhtmltopdf`), static site generation from Markdown, optional GitHub Pages deployment.

**What you get:** Share notes as polished PDFs. Publish a knowledge site from your vault. Export everything as a backup. Your knowledge isn't locked in.

---

### 5.3 — Sync & Multi-Device

**What:** End-to-end encrypted sync between devices via a simple relay (or direct LAN sync). No cloud account required — sync key is derived from a password you memorize.

**Why:** You work on multiple devices — Mac, maybe a phone eventually. Your knowledge base should be everywhere you are, without trusting a cloud provider with your data.

**Tech:** Rust sync engine with AES-256-GCM encryption, optional relay server (self-hosted or free tier), conflict resolution via CRDT or last-write-wins.

**What you get:** Your knowledge base on every device. Encrypted, private, no subscription. Sync happens in the background.

---

## Priority Matrix

| Feature | Impact | Effort | Priority |
|---------|--------|--------|----------|
| 1.1 Built-in Terminal | Critical | Medium | P0 |
| 1.2 System Monitor | High | Low | P0 |
| 1.3 Clipboard Manager | High | Medium | P1 |
| 1.4 Quick Launcher | High | Low | P1 |
| 2.1 Note Editor | Critical | High | P0 |
| 2.2 Backlinks | High | Low | P1 |
| 2.3 Daily Notes & Quick Capture | High | Low | P0 |
| 2.4 AI Agent Actions | Critical | High | P1 |
| 2.5 Web Clipper | Medium | Medium | P2 |
| 3.1 Task Management (Kanban) | High | Medium | P1 |
| 3.2 Calendar & Reminders | Medium | High | P2 |
| 3.3 Pomodoro & Focus Mode | Medium | Low | P2 |
| 3.4 Bookmarks & Pinned Items | Medium | Low | P1 |
| 4.1 Auto-Git Versioning | High | Medium | P1 |
| 4.2 AI Note Suggestions | Medium | Medium | P2 |
| 4.3 Conversation Auto-Compaction | High | Low | P1 |
| 4.4 Universal Search | High | Medium | P1 |
| 5.1 Plugin System | High | Very High | P3 |
| 5.2 Export & Publishing | Medium | Medium | P3 |
| 5.3 Sync & Multi-Device | High | Very High | P3 |

---

## Architecture Impact

```
Current:
  Frontend (React) ←IPC→ Backend (Rust) → Ollama + Vault

Target:
  Frontend (React) ←IPC→ Kernel (Rust)
    ├── Vault Engine (notes, backlinks, daily notes)
    ├── AI Engine (chat, actions, suggestions, compaction)
    ├── Project Engine (scan, git, terminal)
    ├── System Engine (monitor, clipboard, notifications)
    ├── Search Engine (universal: vector + keyword + file)
    ├── Sync Engine (encrypted, multi-device)
    └── Plugin Runtime (sandboxed JS/TS)
```

---

## The North Star

AETHER-OS should be the first app you open in the morning and the last you close at night. It should replace:

- **Activity Monitor** → System Monitor
- **Notes app** → Vault with full editor
- **Todo app** → Task management from notes
- **Calendar app** → Built-in calendar with reminders
- **Spotlight** → Quick Launcher
- **Clipboard manager** → Built-in clipboard history
- **Terminal** → Built-in PTY terminal
- **ChatGPT/Claude** → Local AI with your context
- **Obsidian** → Full knowledge management with AI

One app. Your data. Your machine. Your OS.
