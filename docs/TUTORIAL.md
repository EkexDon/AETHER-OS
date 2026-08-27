# AETHER-OS — The Complete Tutorial

> **Everything this app can do, explained like you're six.** This is the longest, most detailed, most picture-heavy file in the repo. If you read this end to end, you will know AETHER-OS better than its creator does on a Tuesday morning.

---

## Table of contents

1. [What is AETHER-OS?](#1-what-is-aether-os)
2. [The very first time you open it](#2-the-very-first-time-you-open-it)
3. [The left rail — every workspace at a glance](#3-the-left-rail)
4. [Workspace 1 — Dashboard](#4-workspace-1--dashboard)
5. [Workspace 2 — Note Editor](#5-workspace-2--note-editor)
6. [Workspace 3 — Embedded IDE](#6-workspace-3--embedded-ide)
7. [Workspace 4 — Projects launcher](#7-workspace-4--projects-launcher)
8. [Workspace 5 — AI Memory](#8-workspace-5--ai-memory)
9. [Workspace 6 — Semantic Search](#9-workspace-6--semantic-search)
10. [Workspace 7 — Knowledge Graph](#10-workspace-7--knowledge-graph)
11. [Workspace 8 — AI Notes](#11-workspace-8--ai-notes)
12. [Workspace 9 — Terminal](#12-workspace-9--terminal)
13. [Workspace 10 — System Monitor](#13-workspace-10--system-monitor)
14. [Workspace 11 — Browser](#14-workspace-11--browser)
15. [The AI Agent (everywhere)](#15-the-ai-agent-everywhere)
16. [Settings — vault, providers, models, editor](#16-settings)
17. [Quick Capture — `⌘⇧N`](#17-quick-capture)
18. [Web Clipper — `⌘⇧C`](#18-web-clipper)
19. [Command Bar — `⌘K`](#19-command-bar)
20. [Keyboard shortcuts cheat-sheet](#20-keyboard-shortcuts)
21. [Where your data lives](#21-where-your-data-lives)
22. [Power-user tips](#22-power-user-tips)
23. [Troubleshooting](#23-troubleshooting)

---

## 1. What is AETHER-OS?

AETHER-OS is **one app** that holds **everything you do on a computer**. It is:

- 📝 A **note app** like Obsidian, with wikilinks, backlinks, daily notes.
- 🧠 A **semantic search engine** that understands what you mean, not just what you type.
- 🤖 An **AI chat client** that can read all your notes and answer questions about them.
- 💻 A **code editor** (Monaco, the same as VS Code) with Git, file tree, terminals, and language server support.
- 🐚 A **terminal** with real PTY (full `zsh`, `bash`, `git`, `cargo`, etc.).
- 🌐 A **web browser** with tabs, bookmarks, history.
- 🖥️ A **system monitor** that shows CPU, RAM, disk, network, processes.
- 📊 A **knowledge graph** that visualizes how your notes connect.
- ⚡ A **quick-capture** tool that drops thoughts into today's daily note from anywhere.

All of this is in **one window** that you resize however you like. Nothing leaves your computer unless you choose to use a cloud AI provider.

### What it is NOT

- It's not a cloud product. There's no account. There's no sync. Your data is on your disk.
- It's not an Electron app. It's built on Tauri (the macOS WebKit, the same engine as Safari), so it's a small, fast native binary.
- It's not done. It's a personal project that's grown into something genuinely useful.

![AETHER-OS hero shot — full app with knowledge graph, AI agent panel, and code editor all visible at once](docs/tutorial/images/00-hero.png)

---

## 2. The very first time you open it

When you launch AETHER-OS for the first time, you'll see a screen with a "No note selected" message in the center. That's normal. The app needs to know **where your notes live** before it can do anything useful.

### Picking a vault

A **vault** is just a folder on your computer that contains `.md` (Markdown) files. The app reads them, indexes them, and shows them in the sidebar. You can use:

- An **existing Obsidian vault** (the app understands Obsidian-flavored Markdown, wikilinks, tags).
- A new empty folder (the app will create notes in it).
- **Any folder** of `.md` files you happen to have.

To set the vault:

1. Click the **gear icon** ⚙️ in the bottom-left corner of the sidebar. Settings opens.
2. The "NoPes Vault Path" field shows your current vault. If it's empty or wrong, click **Browse** and pick a folder.
3. Click **Save**.

The app will then scan the folder, count the notes, and show them in the left sidebar.

### Empty state

If no note is selected, the main area shows:

> ✏️ No note selected
> Pick a note from the sidebar or create a new one to start editing.
> [📄 New Note]

![Editor empty state](docs/tutorial/images/01-editor-empty.png)

The **New Note** button creates a fresh untitled note. The right-side floating buttons (⚡ Quick Capture, 📋 Clip, 🤖 AI) are always available no matter what workspace you're in.

---

## 3. The left rail — every workspace at a glance

The thin vertical strip on the left is the **nav rail**. Each icon is a different workspace. From top to bottom:

| Icon | Workspace | One-line description |
|------|-----------|----------------------|
| 🏠 | **Dashboard** | Vault overview + recent activity |
| ✏️ | **Note Editor** | The Markdown editor + sidebar |
| `</>` | **IDE** | Full code editor with file tree |
| 📁 | **Projects** | Pick a project to open in the IDE |
| 🧠 | **Memory** | The AI's long-term memory |
| 🔍 | **Search** | Semantic (meaning-based) search |
| 🔗 | **Graph** | Visual map of your wikilinks |
| 📋 | **AI Notes** | Saved AI answers |
| 🐚 | **Terminal** | Real shell with multi-tab |
| 📊 | **Monitor** | CPU, RAM, disk, network, processes |
| 🌐 | **Browser** | Embedded web browser |
| ⚙️ | **Settings** | (at the very bottom) |

The rail is **collapsible** — drag the right edge of the sidebar to make the panels wider or narrower.

### Sidebar panels (Editor only)

When you're in the **Note Editor** workspace, the leftmost panel is the **vault sidebar** with three sections:

- **Vault** — every `.md` file in your vault, grouped by folder. Click a note to open it. Type in the search box to filter.
- The **note title** at the top of the page (or just below the breadcrumb) is editable — rename a note in place.
- Use `Cmd+K` to open the **Command Bar** for fuzzy-search across the whole vault.

---

## 4. Workspace 1 — Dashboard

The **Dashboard** is your "home base". It shows:

- **Vault stats**: total notes, total words, total links, total tags.
- **Recent notes**: the last 5 notes you opened.
- **Pinned notes**: notes you've manually pinned (click the 📌 icon on any note).
- **Tasks**: checkboxes from your notes (any `- [ ]` line in any `.md` file) pulled into a single task list.
- **Daily note** shortcut: click "Today" to open or create today's daily note (e.g. `2026-08-26.md`).

### How to use it

- Click 🏠 in the nav rail to come back to dashboard from anywhere.
- Treat it like a morning briefing: glance at tasks, jump into the daily note, see what you were working on yesterday.

### Getting good at it

- Pin the 3–5 notes you reference daily (your "always open" notes).
- Keep your daily note short — bullet list of what you did, what you'll do, what's blocking.
- A 5-minute end-of-day routine: open the dashboard, tick off completed tasks, add 1–3 for tomorrow, close the app.

---

## 5. Workspace 2 — Note Editor

The Note Editor is the heart of the app. It's where you write.

![Editor empty state](docs/tutorial/images/01-editor-empty.png)

### Layout

Three columns:

1. **Vault sidebar** (left) — file tree, search, "New Note" button.
2. **Editor** (center) — what you type.
3. **Right panel** (collapsible) — contains **Backlinks**, **Unlinked Mentions**, **AETHER Memory**, and a **preview** of the rendered Markdown.

### Markdown editing

- **Bold** = `**text**`, *italic* = `*text*`, ~~strike~~ = `~~text~~`.
- Headings = `#`, `##`, `###` for h1, h2, h3.
- Lists: `- item` or `1. item` or `- [ ] todo`.
- Code: `` `inline` `` or ` ```lang ` for blocks.
- Links: `[text](url)`.
- Images: `![alt](path)` — supports local paths in your vault, like `![[vacation.jpg]]`.

### Wikilinks (`[[…]]`)

The most important feature for note-taking. Type two open square brackets and you get a **fuzzy-searchable popup** of every note in your vault:

```
I should read [[Atomic Habits]] this weekend.
```

If `Atomic Habits.md` exists, it becomes a clickable link that jumps to that note. If it doesn't exist, the link is "dangling" and the app will offer to create it.

### Backlinks

Open a note, look at the right panel under **Backlinks**. You'll see every other note that has a `[[link]]` pointing to the current note, with a snippet showing the surrounding context.

**This is the killer feature.** It's how knowledge stays connected. When you read a note about "Project X", the backlinks tell you: "this note is referenced from 3 other notes" — and you can jump straight to those.

### Unlinked Mentions

Sometimes you write a note's name without `[[]]` — e.g. "I really like Atomic Habits" instead of "[[Atomic Habits]]". Unlinked Mentions finds these **and offers to convert them to real wikilinks in one click**.

### Slash commands

Type `/` at the start of a line and you get a menu of common Markdown structures: H1, H2, bullet list, numbered list, code block, quote, divider, etc. Hit `Enter` to apply, or arrow-keys to pick.

### Auto-save

The editor saves your note **1 second after you stop typing**. There's no save button. If you ever see a tiny "Saving…" indicator, the note is being written to disk. You cannot lose work.

### Resizing

Drag the splitter between any two panels. Layouts are saved per-workspace.

---

## 6. Workspace 3 — Embedded IDE

This is **VS Code, but built in**. Same Monaco editor, same multi-tab, same file tree, but you never have to leave AETHER-OS.

### The folder picker

When you click the IDE icon for the first time, you'll see a screen like this:

![IDE folder picker](docs/tutorial/images/13-ide-picker.png)

It shows every folder you've whitelisted in the **Projects** workspace. Click any folder to open it. Once opened, AETHER-OS remembers your last project and opens it automatically next time.

### The workbench

After you open a project, the IDE has three main areas:

1. **Activity bar** (far left) — Files / Git / Search / Extensions icons. (Currently Files and Git are implemented; others coming soon.)
2. **Sidebar** — either the file tree, or the source control panel, depending on which activity you picked.
3. **Editor area** — the Monaco editor, with tabs.
4. **Panel** (bottom) — collapsible terminal, problems, output.

![IDE file tree](docs/tutorial/images/14-ide-tree.png)

### The file tree

- Click a folder name to expand it.
- Click a file to open it in the editor.
- The `</>` icon at the top toggles between Files and Git sidebars.
- Hover a file and click the trash icon to delete (it asks for confirmation).

### The editor

It's Monaco. You get:

- **Syntax highlighting** for every language Monaco knows (TypeScript, Python, Rust, JSON, Markdown, etc.).
- **IntelliSense** — autocomplete as you type (`Ctrl+Space` to force).
- **Multi-cursor** — `Alt+Click` to add cursors; `Cmd+D` to select next occurrence.
- **Find/Replace** — `Cmd+F` / `Cmd+H`.
- **Format** — right-click → "Format Document" (or `Shift+Alt+F`).
- **Go to definition** — `F12` or `Cmd+Click` on a symbol.
- **Hover** — hover any symbol to see its type/doc.
- **Bracket matching**, **auto-indent**, **line numbers**, **minimap** — all standard.

![IDE code editor](docs/tutorial/images/15-ide-code.png)

### Git source control

Click the **Git** icon in the activity bar (or the branch name in the source-control panel header):

![IDE Git panel](docs/tutorial/images/16-ide-git.png)

You get a real Git workflow:

- **Branch name** at the top — click to switch branches.
- **↑N ↓N** — commits ahead/behind the upstream. Click to **push** / **pull**.
- **Staged Changes** section — files you've `git add`ed.
- **Changes** section — modified, added, deleted, untracked files. Letters next to filenames:
  - `M` = modified
  - `A` = added (new file)
  - `D` = deleted
  - `?` = untracked
- **Click any file** in the list to open a side-by-side **diff view** — the file on the left, the changes highlighted on the right, with red = removed lines, green = added lines.
- **Type a commit message** in the textbox at the bottom of the panel, click ✓ to commit.
- **`+` icon** next to a file stages it. **`−`** un-stages it.
- **Refresh icon** (top right) re-fetches `git status`.

### The integrated terminal

The IDE has its own **embedded terminal** at the bottom. Click the panel-toggle button (or press `Ctrl+``):

![IDE bottom terminal](docs/tutorial/images/17-ide-terminal.png)

It's a real PTY. You can run `git`, `npm`, `cargo`, `python`, anything. The terminal is automatically `cd`'d to your project root.

### LSP (Language Server Protocol)

AETHER-OS ships with a **TypeScript language server sidecar**. That means for any `.ts` / `.tsx` file in your project, you get:

- 🟢 Green/red squigglies (errors, warnings)
- 💡 Hover tooltips with type info
- ⌨️ Intelligent autocomplete
- 🔗 "Go to definition" (`F12`)
- 🔍 "Find all references" (`Shift+F12`)

LSP support is per-language and configured in the `src-tauri/src/engine/lsp.rs` engine.

### Why this is amazing

You no longer have a "VS Code for code" and an "Obsidian for notes" — they're one app. You can be writing a note about a bug you're investigating, open the same project in the IDE, edit the code, run the test, then `⌘⇧H` to jump back to the note and continue writing. No window-switching. No context loss.

---

## 7. Workspace 4 — Projects launcher

![Projects launcher](docs/tutorial/images/09-projects.png)

The Projects workspace is where you **whitelist folders** the IDE and several other workspaces can reach. This is a security feature: the IDE can't open `/etc/passwd` because you haven't whitelisted it.

### Layout

- **Top**: a search box (filter projects by name) and a **`+ Add Folder`** button.
- **Filter chips**: each project's path is a chip you can click to filter. `~/Documents/NoPesV.3 ×` means "show only NoPesV.3 projects".
- **Grid of cards**: each card is one project. Click a card to open that project in the IDE.

### Each card shows

- Project name (the basename of the folder).
- A colored dot (green = clean working tree, yellow = modified, etc.).
- Current **branch** name.
- **"N modified"** / **"N untracked"** counts.
- The most recent **commit message** (truncated).
- A **time-ago** indicator (e.g. `27d ago`).

### Adding a project

Click **`+ Add Folder`**, pick a directory in the macOS folder picker. The app will:

1. Verify it's a Git repo (or initialize one if it isn't).
2. Add it to your `project_dirs.json`.
3. Show it in the grid.

### Removing a project

Click the **trash icon** on the card. The folder isn't deleted from disk — just removed from the whitelist.

### Why this is useful

If you have 12 repos across `~/Documents/`, you can:

- See at a glance which one is dirty (uncommitted changes).
- See which one has been touched recently.
- Jump to any of them with one click.

It replaces your terminal workflow of `cd ~/Documents/<whatever> && git status`.

---

## 8. Workspace 5 — AI Memory

![AI Memory in context](docs/tutorial/images/16-ide-git.png)

(Shown in the right rail when an IDE file is open and you click the 🧠 Memory icon.)

AI Memory is **a tiny database of facts the AI should always know about you**. Every time you ask the AI a question, it sees these facts first.

### Add a fact

- Type the fact in the "Remember..." input at the top.
- Optionally pick a category: `general`, `projects`, `preferences`, `people`, `work`, `personal`.
- Click **Remember** (or hit `Enter`).
- The fact appears in the list below.

### Examples of good facts

- "Ekin prefers Devin (Windsurf) as Editor" (preference)
- "AETHER-OS is built in TypeScript + Rust" (project)
- "I always use dark mode" (preference)
- "Today's focus is the tutorial writeup" (general)

### Why this exists

Without memory, every AI conversation starts from zero. With memory, the AI knows who you are, what you're building, how you like to work. After a month of adding facts, the AI feels like an assistant who has been with you for years.

### Delete a fact

Hover a fact card and click the trash icon.

---

## 9. Workspace 6 — Semantic Search

![Semantic search with results](docs/tutorial/images/06-semantic-search.png)

**Semantic search** is the killer feature for finding information. Unlike keyword search, it understands *meaning*.

### Example

Suppose you wrote three notes:
- `Atomic Habits — book notes.md` (talks about habit formation, the four laws)
- `Project X — running log.md` (talks about your morning routine)
- `2026-05-12.md` (daily note: "struggling to get up early")

Now type into the search box: **"how do I wake up earlier"**

A **keyword** search would find nothing (no note contains the words "wake up" or "earlier").

**Semantic search** finds all three — because it understands that habit formation + morning routine + struggling to get up are all *related* to the question.

### How to use it

1. Click 🔍 in the nav rail.
2. Type a question or phrase into the search bar.
3. Click **Search** (or hit `Enter`).
4. The results appear as cards. Each card has:
   - The **note name**.
   - A **snippet** of the most relevant text.
   - A **match percentage** (e.g. `52.4%`) — cosine similarity between your query and the note's embedding.

Click any card to open that note.

### How it works (under the hood)

- Every note in your vault is converted to a **vector** (a list of ~768 numbers) by a model called `nomic-embed-text` running locally in Ollama.
- When you search, your query is converted to a vector the same way.
- The app finds the notes whose vectors are most similar to your query's vector.
- This is **semantic similarity**, not keyword matching.

### Indexing

The first time you add the vault, the app indexes every note. This takes a few seconds per note. After that, incremental updates happen in the background as you edit.

To force a full re-index, open Settings and click "Rebuild search index".

### Tips for good searches

- **Ask questions, don't just type keywords**. "How do I…", "Why does X happen", "Best way to…" all work great.
- **Be specific**. "Python error handling" beats "python".
- **Mix concepts**. "Note about habits and reading" will find notes about either.

---

## 10. Workspace 7 — Knowledge Graph

![Knowledge graph](docs/tutorial/images/07-graph.png)

The Knowledge Graph **visualizes your vault as a network**. Every note is a dot. Every `[[wikilink]]` is a line between two dots.

### How to use it

1. Click 🔗 in the nav rail.
2. You'll see all 23 notes as scattered dots, with lines connecting the ones that link to each other.
3. **Double-click any empty space** to create a new note at that location.
4. **Click a node** to select that note.
5. **Drag a node** to reposition it.
6. **Scroll** to zoom in/out.
7. **Drag empty space** to pan the view.

### What the numbers mean

The header shows: `Knowledge Graph — 23 notes, 0 connections`.

- **N notes** = how many `.md` files the app has indexed.
- **N connections** = how many `[[wikilinks]]` exist in your vault.

If connections is 0, your notes don't link to each other yet. Add some wikilinks and the graph will populate.

### A graph in action

Once you have even a few wikilinks, you can spot patterns:

- **Hubs** (a note that many others link to) — these are your "load-bearing" notes, your key concepts.
- **Bridges** (a note that connects two clusters) — these are integration notes, where you synthesized two ideas.
- **Outliers** (a note with no links) — these are isolated thoughts. Either link them or delete them.

### Tips

- Add wikilinks liberally when you write. Every `[[link]]` makes the graph denser and the search more useful.
- When you add a new note, link it to at least 2 existing notes. Otherwise it becomes an orphan.
- The graph is **fun** to look at. Open it when you're procrastinating. Sometimes you'll see a connection you didn't know you had.

---

## 11. Workspace 8 — AI Notes

![AI Notes library](docs/tutorial/images/08-ai-notes.png)

Every AI response you ever click **"Save as AETHER Note"** on lives here. It's a permanent, searchable library of everything the AI has ever said to you that's worth keeping.

### Layout

- **Left column**: a list of every saved note, with date and a one-line preview. Click to open.
- **Right column**: the full content of the selected note, rendered as Markdown.

### Each AI Note contains

- The **question** you asked.
- The **answer** the AI gave.
- The **date and time** it was saved.
- The **list of notes** the AI had as context (so you can reconstruct what it saw).
- The **model** and **provider** used (e.g. "Ollama · gemma2:2b" or "OpenRouter · claude-3.5-sonnet").

### How to save an AI answer

1. In the AI Agent panel, get an answer you want to keep.
2. Click the **Save as AETHER Note** button (📌) in the answer's footer.
3. Done. The note appears in the AI Notes library and is also searchable via Semantic Search.

### Deleting an AI Note

Click the trash icon on the note (top right of the rendered note).

### Why this is powerful

Six months from now, when you've forgotten what the AI said about a topic, you can:

- Search the AI Notes library by date.
- Semantic-search across all saved answers.
- Find the original prompt that produced a particular answer.

It's your personal ChatGPT history, but on your disk, under your control.

---

## 12. Workspace 9 — Terminal

![Terminal with real PTY output](docs/tutorial/images/10-terminal.png)

The Terminal workspace is a **real PTY** (Pseudo-Terminal) running `zsh` (or your default shell). It's not a fake JavaScript terminal — it can run `vim`, `htop`, `ssh`, anything.

### Layout

- **Top bar**: tab strip (each open terminal session is a tab) + `+` to create new + ↻ to reset.
- **Bottom**: the terminal itself, using `xterm.js` for rendering (full ANSI color, cursor, etc.).

### Tabs

- **`+` button** opens a new tab. Each tab is its own independent shell.
- **Click the `x` on a tab** to close it.
- **Right-click a tab** for "Duplicate", "Rename", etc.

### Reset Terminal

If a tab freezes or screen corruption creeps in (rare, but possible with weird ANSI escapes), click the ↻ button in the top right. It kills the underlying PTY and starts a fresh shell in the same tab.

### Resize

Drag the splitter above the terminal to make it taller. The PTY is automatically resized to match.

### Common uses

- Run `git`, `npm`, `cargo`, `python`, `ollama`, `docker`, etc. — anything that's on your `$PATH`.
- Test the app's built-in terminal by running `echo hi && uname -a && ls` — you should see real output.
- Pipe things: `cat file.md | wc -l`.
- Use `tmux` or `screen` if you want multiple panes inside one tab.

### What's not in the IDE vs. this Terminal?

The IDE has a **per-project terminal** (auto-`cd`'d to your project root). The standalone Terminal workspace is for general shell work. They share the same xterm.js + portable-pty stack.

---

## 13. Workspace 10 — System Monitor

(System Monitor screenshot is part of the in-context AI Agent screenshot in the right rail — see [the agent answer section](#15-the-ai-agent-everywhere) for an example.)

The System Monitor is a **live dashboard** of your Mac's resource usage. Click 📊 in the nav rail.

### What it shows

- **CPU**: total usage %, per-core graph, current load average.
- **Memory**: used / total / available, swap usage.
- **Disk**: read/write bytes per second, used / total disk space.
- **Network**: bytes/sec in and out, packets dropped.
- **Battery** (on laptops): charge %, time remaining, charging state.
- **Top processes**: a sortable list of the top 10 processes by CPU, with PID, name, and %.

### Live updates

The data refreshes **every 1 second**. The graphs scroll. The numbers change. This is real `sysinfo` data piped in from Rust — not a fake UI.

### Why you need this

If you're running Ollama (which eats a lot of RAM), or compiling a Rust project (which eats a lot of CPU), the System Monitor tells you **what your computer is actually doing**. No more opening Activity Monitor.

### Tips

- If your fan is loud, check this view. The "Top Processes" list will tell you what's hot.
- If you have 8GB RAM, watch the memory number when starting a chat with Ollama. If you get close to the limit, consider switching to a smaller model (e.g. `gemma2:2b` instead of `qwen2.5:7b`).

---

## 14. Workspace 11 — Browser

![Browser home](docs/tutorial/images/11-browser-home.png)

The Browser workspace is a **real, fully-featured web browser** embedded in the app. It's not a restricted HTML renderer — it's a WebKit webview with the same engine as Safari.

### Home screen

When you first open the Browser workspace, you see the app's home screen:

> 🌍 AETHER-OS Browser
> Enter a URL or search query above to get started.
> Pages render in a real browser engine embedded in this window — Google, YouTube, GitHub and all other sites work natively.

### URL bar

The URL bar is at the top. Type any URL or any search query (Google search will be used if no protocol is specified). Press `Enter` to navigate.

### Real-world use

![Browser loading example.com](docs/tutorial/images/12-browser-site.png)

The screenshot above shows `example.com` loaded correctly. **You can sign into Google, watch YouTube, read GitHub PRs, check email, anything** that a normal browser can do.

### Why have a browser in an OS-app?

Because context-switching is expensive. You're writing a note about a Stack Overflow answer. The note is in AETHER-OS. The answer is in a browser. Instead of alt-tabbing, the browser is **right there in the same app**, in the same window, and when you find something worth saving you just press `⌘⇧C` to clip it to your vault.

### Tabs

- **`+` button** opens a new tab.
- **`x` on a tab** closes it.
- **Drag a tab** to reorder.

### Bookmarks

Click the **star icon** in the URL bar to bookmark the current page. Click it again to remove the bookmark. Bookmarks persist across sessions.

### History

Click the **clock icon** to see recently visited URLs. Click any to go back to it.

### External link

Click the **arrow-out icon** to open the current URL in your default system browser (Safari/Chrome/etc.).

### Reload / Back / Forward

Standard browser buttons in the URL bar.

---

## 15. The AI Agent (everywhere)

The **AI Agent panel** is a sliding side-panel that lives on the right side of the screen. It's available in **every workspace**. You can open it from:

- The ⚡ button in the bottom-right of the sidebar.
- The keyboard shortcut (configurable in Settings).
- Clicking the AI icon in the top-right of any workspace.

### Layout

- **Header**: AETHER Agent title, history button, new-chat button, close button.
- **Engine bar**: AI provider dropdown (Ollama or OpenRouter) + model dropdown + connection status indicator.
- **Context area**: shows which notes the AI will see (or "All notes" by default).
- **History**: list of past conversations, click any to load it.
- **Messages**: scrollable conversation history.
- **Input**: textarea at the bottom + send button.

### The engine bar

- **Provider dropdown**: pick `Ollama · Local` (free, private, slower) or `OpenRouter · Cloud` (paid, fast, huge model selection).
- **Model dropdown**: pick a model. For Ollama, you see only models you have `ollama pull`ed. For OpenRouter, you see 100+ models.
- **Connection indicator**: a green dot + "connected" = good. A red dot = check Settings.

### Picking context

The AI needs to know **which notes** to read to answer your question. Three modes:

1. **All notes** (default) — the AI sees the full content of every note in your vault. Slow but thorough.
2. **Selected notes** — click the **"Select context notes"** button (a stack-of-cards icon) and pick a subset. Useful for narrow questions.
3. **Empty** — the AI answers from its general knowledge + the memory facts only. Useful for "explain this concept" questions.

### Memory integration

The AI **always** sees the facts in your AI Memory. So you can teach it "my project is in TypeScript" once, and every future conversation will know that.

### Streaming

Responses **stream token by token** as the AI generates them. You see the words appear in real time. No waiting for the full response.

### Saving answers

Click the 📌 **Save as AETHER Note** button in the footer of any AI message. It saves that answer as a permanent note (see [Workspace 8](#11-workspace-8--ai-notes)).

### Real example

![AI Agent with a real streamed answer from OpenRouter](docs/tutorial/images/19-agent-answer.png)

The screenshot above shows a real conversation:

- **User**: "What is AETHER-OS? Answer in one friendly sentence."
- **AI**: "AETHER-OS is your local-first personal operating system — a project you're building to keep your digital life private, fast, and fully under your control. 🚀"

That was streamed live from OpenRouter's `stealth/ox-alpha` model. You can see the provider dropdown shows `OpenRouter · Cloud`, the model is `stealth/ox-alpha`, and the connection indicator is green.

### `/model` slash command

Type `/model` in the input box. The app shows an inline menu of available models. Type a few characters to filter. Hit `Enter` to switch. This is faster than using the dropdown when you know what you want.

![Model picker menu](docs/tutorial/images/18-ide-agent-picker.png)

### Tips for good AI interactions

- **Be specific**. "Why does my Python `for` loop skip the first item?" is better than "Python loop broken".
- **Provide context**. Use the "Select context notes" button to point the AI at the exact files or notes it should read.
- **Ask follow-ups**. The conversation is persistent. The AI remembers what it said earlier in the same chat.
- **Use the right model for the job**:
  - Quick factual questions → `gemma2:2b` or `llama-3.1-8b-instant` (cheap, fast).
  - Code review / writing → `claude-3.5-sonnet` or `gpt-4o` (slower, much better quality).
  - Big multi-file refactors → `claude-3.5-sonnet` (long context, careful reasoning).

---

## 16. Settings

Click the ⚙️ icon in the bottom-left of the sidebar to open Settings.

![Settings panel](docs/tutorial/images/20-settings.png)

### NoPes Vault Path

- **What it is**: the folder on your disk where your notes live.
- **How to set it**: click `Browse`, pick a folder, click `Save`.
- **Auto-detection**: if AETHER-OS finds a `.nopes/index.json` in your home directory, it'll suggest it automatically.

### AI Providers

Two providers, both supported simultaneously:

#### Ollama (default)

- **What it is**: a local LLM runtime. Runs on your Mac, no data leaves.
- **How to connect**: install Ollama (`brew install ollama`), start it (`ollama serve`), pull a model (`ollama pull gemma2:2b`). The status pill turns green when it's reachable.
- **Cost**: free. **Privacy**: 100%.

#### OpenRouter

- **What it is**: a proxy to 100+ cloud models (Claude, GPT-4o, Gemini, Qwen, etc.). One API key, any model.
- **How to connect**: get a key at [openrouter.ai/keys](https://openrouter.ai/keys), paste it in the "OpenRouter API Key" field, click `Save Key`, then `Test` to verify.
- **Where the key is stored**: `~/Library/Application Support/com.ekin.aetheros/auth.json` with file permissions 600. Never sent to your browser, never put in your notes.
- **Cost**: per-token, varies by model. See [openrouter.ai/models](https://openrouter.ai/models).
- **Privacy**: your prompts and the AI's responses go to OpenRouter's servers and the upstream provider. Read OpenRouter's privacy policy.

### Default Editor

The external editor that opens when you click "Open in Editor" on a project card. Defaults to whatever your macOS default is for `.md` files. Set it to `Devin`, `Zed`, `Cursor`, `Sublime Text`, `VS Code`, anything you have installed.

### Local Model

The default Ollama model to use for AI queries. The header of the AI chat lets you switch at any time, but this is the "default if I haven't picked one" model.

Recommended:

| RAM | Recommended model |
|-----|-------------------|
| 8 GB | `gemma2:2b` or `llama3.2:3b` |
| 16 GB | `qwen2.5:7b` or `llama3.1:8b` |
| 32 GB+ | `qwen2.5:14b` or `llama3.1:70b` (quantized) |

---

## 17. Quick Capture

![Quick Capture open](docs/tutorial/images/02-quick-capture-typing.png)

`⌘⇧N` (Command + Shift + N) opens a small floating textbox **anywhere in the app**. Type a thought, hit `Enter`, and it gets appended to **today's daily note** (e.g. `2026-08-26.md`) with a timestamp.

### When to use it

You're reading a paper. A thought strikes you. You don't want to context-switch to your notes app, find the right note, click into the right spot, type, save. Just hit `⌘⇧N`, type, Enter, done. The thought is captured, you'll find it later in your daily note.

### What happens after you hit Enter

![Quick Capture saved confirmation](docs/tutorial/images/03-quick-capture-saved.png)

The textbox shows a green checkmark and a "Saved to daily note" message. A new **Open note** button appears — click it to jump straight to today's daily note and keep working.

### Tips

- The daily note is named after the current date in your local timezone.
- Quick Capture never overwrites anything. It always appends.
- One capture per line. Multi-line thoughts are fine — just hit `Shift+Enter` for a newline within the box, then `Enter` when done.

---

## 18. Web Clipper

![Web Clipper showing a preview of example.com](docs/tutorial/images/04-web-clipper-preview.png)

`⌘⇧C` (Command + Shift + C) opens the Web Clipper. Paste any URL, click **Clip**, and the app fetches the page, extracts the readable text, and shows you a clean Markdown preview.

### How it works

1. **Open the Browser workspace**, navigate to any page (e.g. a blog post).
2. Hit `⌘⇧C` to open the clipper with that URL pre-filled.
3. Click **Clip** — the app fetches the page server-side (in Rust, not in your browser) and uses readability heuristics to extract the main content.
4. A **preview** appears in the clipper showing the title, source URL, and the cleaned-up content.
5. Edit the title and content if you want (the clipper is a real Markdown editor).
6. Click **Save to Vault** — a new note is created in your vault with the date in the filename.

### After saving

![Editor showing the clipped note](docs/tutorial/images/05-editor-after-clip.png)

The note opens in the editor so you can read it, annotate it, link to it.

### Tips

- Best for **articles, blog posts, documentation pages**. Not great for dynamic SPAs (e.g. Twitter, Reddit) where the content is loaded by JavaScript.
- The clipper keeps the original URL as a `source:` frontmatter field, so you always know where the content came from.
- Combine with wikilinks: open a clipped note, add `[[related-note-name]]` in the body, save. The new note is now part of your graph.

---

## 19. Command Bar

The **Command Bar** is a `⌘K` palette. Hit it from anywhere.

### What it does

A fuzzy-searchable input that:

- Searches all your notes by name.
- Searches all your projects.
- Runs commands like "Open Settings", "Switch to Dark Mode", "Rebuild Search Index".

### How to use it

1. Hit `⌘K`.
2. Start typing. Results appear as you type, ranked by fuzzy match.
3. Arrow up/down to highlight a result.
4. Hit `Enter` to open.
5. Hit `Esc` to close without doing anything.

### Example flows

- `⌘K` → `tut` → `Enter` → opens `Nopes_Tutorial.md`
- `⌘K` → `set` → `Enter` → opens Settings
- `⌘K` → `mycli` → `Enter` → opens a project named "mycli"

### Tips

- It searches note **names**, not content. For content, use Semantic Search.
- "New Note" via `⌘K` is the fastest way to create a new note.

---

## 20. Keyboard shortcuts cheat-sheet

| Shortcut | Action |
|----------|--------|
| `⌘K` | Open Command Bar |
| `⌘⇧N` | Open Quick Capture |
| `⌘⇧C` | Open Web Clipper |
| `⌘⇧H` | Toggle AI Agent panel |
| `⌘B` | Toggle sidebar |
| `⌘.` | Toggle Settings |
| `⌘1` … `⌘9` | Jump to workspace 1–9 (Dashboard … Browser) |
| `⌘N` | New note |
| `⌘S` | Force-save current note (it's autosaved anyway, but this is here) |
| `⌘W` | Close current note tab |
| `⌘F` | Find in current view |
| `⌘⇧F` | Find across vault |
| `⌘/` | Toggle line comment in IDE |
| `F12` | Go to definition (IDE) |
| `Shift+F12` | Find references (IDE) |
| `Ctrl+`` | Toggle IDE terminal |
| `Cmd+Click` on a wikilink | Open the linked note |
| `Cmd+Click` on a symbol (IDE) | Go to definition |
| `Alt+Click` (IDE) | Add cursor |
| `Cmd+D` (IDE) | Select next occurrence |

---

## 21. Where your data lives

| What | Where (macOS) |
|------|---------------|
| App config | `~/Library/Application Support/com.ekin.aetheros/config.json` |
| Vault (your notes) | wherever you set it (default `~/Documents/NopeVault`) |
| Vector embeddings | `~/Library/Application Support/com.ekin.aetheros/vectors/` |
| AI-saved notes | `~/Library/Application Support/com.ekin.aetheros/aether/notes/` |
| AI memory facts | `~/Library/Application Support/com.ekin.aetheros/memory/facts.json` |
| AI conversation history | `~/Library/Application Support/com.ekin.aetheros/memory/conversations/` |
| Session DB | `~/Library/Application Support/com.ekin.aetheros/aether.sqlite` |
| Auth keys | `~/Library/Application Support/com.ekin.aetheros/auth.json` |
| IDE settings per project | `~/Library/Application Support/com.ekin.aetheros/ide-store.json` |
| App log | `~/Library/Logs/aether-core/` |
| Crash reports | `~/Library/Logs/CrashReporter/aether-core-*.ips` |

**The vault is plain `.md` files.** Open any file in any text editor, even if AETHER-OS disappears. You will never be locked in.

---

## 22. Power-user tips

### 1. The "morning routine"

Open AETHER-OS every morning. Hit `⌘K`, type "today", `Enter`. The daily note opens. Look at the AI Memory for "today's focus" if you set one. Check the dashboard for any open tasks. Now you're ready to work.

### 2. The "end of day" routine

Hit `⌘K`, type "today", `Enter`. Scroll to the bottom. Type 3 bullets: what you finished, what's blocked, what you'll do tomorrow. Save. Close the app.

### 3. Use wikilinks to build a personal wiki

Whenever you write about a topic, link the first mention of any concept to its dedicated note. After a year, you'll have a Wikipedia of your own thinking.

### 4. The AI as a thought partner

Don't just ask the AI questions. Tell it what you're thinking and ask for feedback. "Here's my plan for X. What am I missing?" works much better than "How do I do X?".

### 5. Semantic search beats file search

Once you have 50+ notes, your brain stops remembering exact filenames. Semantic search lets you find the right note by *what it's about*, not what it's *called*.

### 6. The 1-second autosave is your friend

Stop worrying about saving. Just type. The app saves 1 second after you stop.

### 7. The IDE and the Notes are the same place

Open the project in the IDE, open the project's README in the Note Editor side-by-side. Edit both. The wall between docs and code disappears.

### 8. The Web Clipper is your research assistant

Read an article in the Browser workspace. Hit `⌘⇧C`. Edit the preview to add your reaction. Save. You have a permanent record.

### 9. Quick Capture is your safety net

Any thought you don't want to lose → `⌘⇧N` → type → Enter. Don't even read what you wrote. It'll be in your daily note later.

### 10. The graph is fun

Open it when you're procrastinating. Sometimes you see a connection you didn't know you had.

---

## 23. Troubleshooting

### "Ollama offline" in the corner

- Is `ollama serve` running? Open a terminal and check.
- Did you `ollama pull` any models? The app needs at least one model pulled.
- Try `curl http://localhost:11434/api/tags` — if that fails, Ollama isn't running.

### AI chat says "no model selected"

Pick a model from the dropdown in the AI chat header. If the list is empty:

- For Ollama: run `ollama pull gemma2:2b` (or any other model).
- For OpenRouter: check the connection status pill. If red, re-paste your API key in Settings.

### Semantic search returns nothing

- Have you indexed the vault? Open Settings → "Rebuild search index".
- Is Ollama running with `nomic-embed-text` pulled? `ollama pull nomic-embed-text`.

### A note didn't save

- The auto-save runs 1s after you stop typing. If you closed the app mid-edit, those last characters may be lost.
- Check the file directly in the vault folder to see what was saved.

### IDE shows "Open a project" even though I have projects

- Open the Projects workspace and make sure the folder is whitelisted.
- Click the folder to open it in the IDE.

### Web Clipper fetches but the preview is empty

- The page is probably JavaScript-rendered (a SPA). Try a different page.
- The URL is wrong. Check the URL bar.

### The terminal is garbled

- Hit the ↻ **Reset Terminal** button in the top right of the Terminal workspace. It kills and restarts the shell.

### The Knowledge Graph is empty

- The graph only shows notes that have at least one `[[wikilink]]`. If you have notes but no links between them, the graph will look sparse.
- Add some `[[links]]` between notes and the graph will populate.

### I want to nuke and restart

Delete the app data folder: `rm -rf ~/Library/Application\ Support/com.ekin.aetheros`. The app will rebuild everything from your vault on next launch. Your notes are untouched (they're in your vault folder, not the app data folder).

---

## 🎉 You're done

If you read this whole thing, you now know more about AETHER-OS than 99% of people who will ever open it. Go write a note, ask the AI something useful, commit some code, and see the graph fill up.

Welcome to your local-first personal operating system. 🚀
