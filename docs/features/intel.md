# AI intelligence layer — `intel` (roadmap 4.3 + 4.2 + 2.4 phase 2)

Three things that make the agent smarter and safer: long chats are
**compacted** into a structured memory instead of overflowing the model's
context, the editor suggests **related notes and tags** while you write,
and the agent can now propose **destructive actions** (shell commands,
deleting / moving notes, commits, task changes) that only run after you
approve them — with every executed or denied action in a local **audit log**.

## Why

- The chat used to send only the current question to the model, so
  follow-ups ("and the second point?") had no context, and there was no way
  to keep long conversations inside a 4k-token local model.
- Linking is what turns a folder of Markdown into a knowledge base; finding
  the right note to link while writing should not need a search.
- Agent actions were all auto-executed. Anything that runs code or removes
  data needs a human in the loop, a clear preview of what it touches and a
  trail of what happened.

## How to use

### Conversation memory (compaction)

- The chat now sends the **conversation window** with every question: the
  summary of older messages plus the most recent messages (bounded per
  provider — tight for local 4k models, generous for OpenRouter).
- The **token meter** in the agent's engine bar (`2.1k / 6k`) estimates the
  window size (`ceil(characters / 4)` + 4 per message). It turns amber at
  75 % and red past the threshold. Click it to compact now.
- **Auto mode** (default on, threshold 6,000 tokens): after a reply, when
  the window exceeds the threshold and there is something older than the
  last *N* messages (default 4), the current model writes a structured
  summary — *Topic, Facts, Decisions, Open questions, User preferences*.
  If the model is offline or answers with garbage, an **extractive
  fallback** (first sentences of your messages, questions, preferences) is
  used and the card shows a `fallback` badge.
- **Compact now**: the fold icon in the agent header, a click on the meter,
  or the palette command *AI: compact conversation*.
- The collapsible **Conversation summary** card sits at the top of the chat.
  *Show N earlier* reveals the summarised messages — the full transcript is
  always kept and saved.
- Each chat session is now **one entry** in the history (it used to be one
  entry per question). Compacted sessions show an archive icon and their
  topic as the title; reopening one restores its summary.

### Related notes and tags while writing

- With a note open in the **Notes** view, the status bar shows
  **“N related”** (computed 1.5 s after you stop typing, cached per note and
  text). Click it or press **⌘⇧R** (*Notes: show related notes*).
- The **Related** drawer lists related notes with a reason chip —
  `semantic 0.82` (vector index), `shares #rust` or `keywords: a, b, c`
  (local fallback) — and a **Link** button that appends `[[Note]]` to the end
  of the note (as another list item after a list of links, otherwise as a new
  paragraph). Already-linked notes show a check mark. Clicking a name opens it.
- **Tag chips** suggest existing vault tags; one click adds the tag: merged
  into the frontmatter `tags:` (inline list, comma list or block list, keeping
  the style; a missing key is added as `tags: [tag]`) or appended as `#tag`
  when the note has no frontmatter.
- The agent's context bar gets a **“N related”** chip: one click uses the
  open note plus its related notes as chat context (click again for all
  notes).
- Edits wait for the editor's autosave and then reload the note, so an
  insert can never be overwritten by pending typing.

### Agent actions with approval

| Action | Risk | What it does |
| --- | --- | --- |
| `create_note`, `append_note`, `append_daily`, `add_memory_fact`, `save_aether_note`, `open_url`, `clip_url`, `create_calendar_event`, `list_calendar_events`, `create_task` | safe | Runs automatically, as before. |
| `move_note { from, to }`, `git_commit { project_path, message }`, `toggle_vault_task { note_path, line }`, `update_calendar_event`, `import_calendar_ics` | confirm | Needs one approval. |
| `run_command { command, cwd? }`, `delete_note { path }`, `delete_calendar_event` | dangerous | Needs an explicit approval. |

- The **approval dialog** lists every gated action of a reply. The current
  one shows its full details (command in mono, resolved working directory,
  resolved note path, files a commit would include, the task line that will
  flip) plus **warnings** for destructive commands (`rm -rf`, `sudo`, force
  pushes, `curl | sh`, …). Buttons: **Approve**, **Deny**, **Approve all**,
  **Deny all**; Escape / closing denies what is pending. Safe actions of the
  same reply run meanwhile; order is kept.
- **Always allow**: the switch in the dialog creates a rule — for commands
  scoped to the working directory (and below). Rules for *dangerous* actions
  last until the app quits; rules for *confirm* actions are remembered on
  this device. Revoke them in Settings → AI Intelligence.
- Results appear as cards in *Tools used*; `run_command` output is an
  expandable terminal block (stdout, stderr in red, exit code, duration).
- **Agent activity** (Settings → AI Intelligence, or *AI: show agent
  activity*) lists the last 50 executed or denied actions.

Action semantics:

- `run_command` runs `sh -lc <command>` (login shell, your profile's `PATH`;
  `cmd /C` on Windows) with stdin closed, `AETHER_AGENT=1` in the
  environment, a 60 s timeout (configurable 15 s–5 min) and 64 KB of captured
  output per stream. `cwd` defaults to the vault; relative paths resolve
  against the vault; the directory must be inside a project directory or the
  vault. On timeout the whole process group is killed.
- `delete_note` never deletes: the note moves to
  `<vault>/.trash/<YYYYmmdd-HHMMSS>-<name>.md` (hidden from the vault scan).
  Restore it by moving it back.
- `move_note` never overwrites and keeps the `.md` extension; folders are
  created. Wikilinks to a renamed note are not rewritten.
- `git_commit` commits what is staged, or stages every change first when
  nothing is; it refuses empty commits. The repository must be inside a
  project directory (same rule as the IDE's Source Control).
- `create_task` takes a project id **or name**; without one it goes to an
  **Inbox** project (created on demand). Priority `none|low|medium|high|urgent`,
  due date `YYYY-MM-DD`.
- `toggle_vault_task` flips `[ ]` ↔ `[x]` on a 1-based line of a note (only
  that character changes). This deliberately duplicates a minimal part of the
  `vaulttasks` feature's engine so `intel` does not depend on it.
- Note paths may be absolute, vault-relative (with or without `.md`) or a
  bare, unique note name. Paths outside the vault, in hidden folders or not
  ending in `.md` are rejected.

### Keyboard shortcuts & commands

| Shortcut | Command |
| --- | --- |
| ⌘⇧R | Notes: show related notes (in the Notes view) |
| — | AI: compact conversation |
| — | AI: show agent activity (opens Settings → AI Intelligence) |
| Esc | Close the Related drawer / deny all pending approvals |

## For other features: open a saved conversation

`src/lib/agentChatBus.ts` is the public, component-free entry point into
the agent chat (used by Home's "Continue" list and conversation pins):

```ts
import { openConversation, startNewConversation } from "../lib/agentChatBus";

await openConversation(conversation.id); // opens the panel with that chat (and its summary)
startNewConversation();                  // opens the panel with an empty chat
```

`openConversation` looks in the loaded history first, then in the 100 most
recent saved conversations; it rejects when the id no longer exists or the
agent is still answering. Tests: `src/lib/intel/pipeline.test.ts`.

## Where data lives

| Data | Location |
| --- | --- |
| Settings | `<app data>/intel/settings.json` |
| Audit log | `<app data>/intel/audit.jsonl` (one JSON object per line, trimmed to the newer half past 2 MB) |
| Chat sessions + summaries | `<app data>/memory/conversations/<ts>-<id>.json` — the `MemoryStore` format; the compaction summary is the `summary` field |
| Trashed notes | `<vault>/.trash/` |
| "Always allow" rules | `confirm` rules: `localStorage["aether-intel-allow-rules"]`; `dangerous` rules: memory only |
| Suggestion cache | memory only (keyword statistics by path + mtime in Rust, results per note + text hash in the UI) |

## IPC

| Command | Input | Output |
| --- | --- | --- |
| `cmd_intel_get_settings` | — | `IntelSettings` |
| `cmd_intel_set_settings` | `settings` | `IntelSettings` (clamped) |
| `cmd_intel_compact` | `messages`, `model`, `provider?`, `previousSummary?`, `keepRecent?` | `CompactionResult { summary, kept_messages, dropped_count, tokens_before, tokens_after, source, model_error }` |
| `cmd_intel_save_conversation` | `id?`, `messages`, `contextNotes`, `summary?` | `Conversation` (replaces the session's previous record) |
| `cmd_intel_suggest_related` | `text`, `excludePath?`, `limit?` | `Suggestion[] { path, name, score, reason, kind, linked }` |
| `cmd_intel_suggest_tags` | `text`, `limit?`, `model?`, `provider?` | `string[]` |
| `cmd_intel_add_tag` | `path`, `tag` | `{ path, tag, changed }` |
| `cmd_intel_run_command` | `command`, `cwd?` | `CommandOutput { command, cwd, exit_code, stdout, stderr, timed_out, duration_ms, truncated }` |
| `cmd_intel_delete_note` | `path` | `{ original_path, trash_path }` |
| `cmd_intel_move_note` | `from`, `to` | `{ from, to }` |
| `cmd_intel_git_commit` | `projectPath`, `message` | `{ commit_id, branch, files, staged_all }` |
| `cmd_intel_create_task` | `projectId?`, `title`, `description?`, `priority?`, `dueDate?` | `{ task, project, created_project }` |
| `cmd_intel_toggle_vault_task` | `notePath`, `line` | `{ path, line, checked, text }` |
| `cmd_intel_preview_action` | `action` | `ActionPreview { target, details, warnings, error }` |
| `cmd_intel_audit_list` | `limit?` (50, ≤ 500) | `AuditEntry[]` newest first |
| `cmd_intel_audit_record` | `action`, `status`, `detail?` | `AuditEntry` (for actions routed through other commands, and denials) |
| `cmd_intel_audit_clear` | — | — |
| `cmd_agent_query_with_notes` *(extended)* | + `conversation? { id, summary, history }` | streams over `llm-stream-chunk` |

Rust: `engine/intel.rs` (engine, settings) with `intel/compaction.rs`,
`intel/suggestions.rs`, `intel/approvals.rs` (audit log, note / git / task
operations), `intel/shell_exec.rs`; commands in
`commands/intel_commands.rs`; new `AgentAction` variants, `ActionRisk` and
`action_risk` in `engine/agent_actions.rs`; the system prompt and prompt
builder in `commands/ai_commands.rs`. Frontend: `src/lib/intelStore.ts`,
`src/lib/intel/*` (tokens, risk, summary, keywords, noteEdits, taskLine,
related, executeAction, pipeline, commands), `src/lib/agentChatBus.ts`,
`src/components/intel/*`, `src/styles/views/intel.css`, wired into
`src/components/AgentChat.tsx`.

## Mock mode

`npm run dev:mock`: compaction returns a canned summary after 800 ms;
related notes and tags use the real keyword scorer (a TypeScript port) over
the demo vault; `add_tag`, trash, move, toggle, commit and create-task work
against the vault / git / task mocks; `run_command` validates the working
directory and returns plausible fake output for `ls`, `pwd`, `echo`,
`git status|log`, `npm|cargo test` (nothing is executed). The fake LLM
answers explicit requests with the matching action block — try
``run `git status` in the demo app``, *delete the note Quick Capture*,
*move Reading List to the archive*, *commit my changes*, *add a task to call
the landlord*, *tick off the first task in Reading List*.

## Limitations

- The token estimate is a heuristic (characters / 4), not the model's
  tokenizer; it is deliberately conservative for German and code.
- The semantic path needs a built vector index (`Index` in the status bar)
  and Ollama; otherwise suggestions come from the keyword fallback over
  titles and the first 3 KB of each note.
- The optional LLM tag ranking only re-orders existing tags.
- `move_note` does not rewrite wikilinks pointing to the old name.
- `run_command` is not interactive (no stdin, no TTY) and detached daemons
  started by a command are killed with its process group.
- "Always allow" for dangerous actions intentionally never survives a
  restart.
