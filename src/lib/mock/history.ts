/**
 * Mock note history (mirrors `engine/note_history.rs`).
 *
 * Seeds a realistic, deterministic Git history for the demo vault: an
 * initial snapshot five weeks ago, daily notes created on their day, a
 * handful of notes edited several times (tasks ticked off, bullets and
 * sections added, sentences reworded), one multi-file commit, a scratch
 * note that was later deleted, and an accidental wipe that was restored.
 * The newest version of every note equals the mock vault's seed content,
 * so the history starts "clean".
 *
 * Like the real file watcher, every handler call (and, in the browser, a
 * 3 s timer) first commits notes whose content changed in the mock vault,
 * emitting `history-commit` events.
 */
import type {
  FileDiff,
  GitChangeKind,
  HistoryActivity,
  HistoryFileChange,
  HistoryRestore,
  HistoryStatus,
  NoteVersion,
} from "../../types";
import { diffLines, diffStats } from "../history/diff";
import { buildVaultFixture } from "./fixtures/vault";
import {
  addDays,
  argBool,
  argOptNumber,
  argOptString,
  argString,
  dirname,
  fakeSha,
  localDate,
  mockEvents,
  nowSeconds,
  registerReset,
  type MockHandlerMap,
} from "./runtime";
import { mockVault } from "./vaultStore";

/** Same event name as `HISTORY_COMMIT_EVENT` in Rust. */
const COMMIT_EVENT = "history-commit";
const NO_VAULT = "No vault path configured. Open Settings to set a vault path.";
const AUTHOR = "AETHER-OS";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const ACTIVITY_FILES_CAP = 20;

interface MockCommit {
  id: string;
  time: number;
  message: string;
  /** Vault-relative path → new content, `null` = deleted. */
  changes: Map<string, string | null>;
}

interface HistoryState {
  /** Oldest first. */
  commits: MockCommit[];
  /** Snapshot (rel → content) after each commit, by commit id. */
  trees: Map<string, Map<string, string>>;
}

let state: HistoryState | null = null;
let enabled = true;

// ── Seed ─────────────────────────────────────────────────────────

/** Deterministic small hash for spacing seed timestamps. */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Remove the last clause of the first long bullet ("…, more words" → "…"). */
function rewordLine(content: string): string {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => /^- (?!\[)/.test(l) && l.split(" ").length >= 7);
  if (idx < 0) return content;
  const line = lines[idx];
  const comma = line.lastIndexOf(",");
  const cut = comma > 8 ? line.slice(0, comma) : line.split(" ").slice(0, -2).join(" ");
  lines[idx] = cut.replace(/[\s.,;:—-]+$/, "") + ".";
  return lines.join("\n");
}

/** Reopen the first ticked-off task. */
function uncheckTask(content: string): string {
  return content.replace("- [x]", "- [ ]");
}

/** Drop the last bullet line. */
function dropLastBullet(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*- /.test(lines[i])) {
      lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  return content;
}

/** Drop the last `## ` section when the note has at least two. */
function dropLastSection(content: string): string {
  const lines = content.split("\n");
  const headings = lines.map((l, i) => (l.startsWith("## ") ? i : -1)).filter((i) => i >= 0);
  if (headings.length < 2) return content;
  const start = headings[headings.length - 1];
  return lines.slice(0, start).join("\n").replace(/\n+$/, "\n");
}

/** Drop a trailing `#tag` line. */
function dropTagLine(content: string): string {
  const lines = content.replace(/\n+$/, "").split("\n");
  if (lines.length > 1 && /^#\w/.test(lines[lines.length - 1])) {
    lines.pop();
    return lines.join("\n").replace(/\n+$/, "") + "\n";
  }
  return content;
}

const TRANSFORMS = [rewordLine, uncheckTask, dropLastBullet, dropLastSection, dropTagLine, dropLastBullet];

/** `[oldest, …, current]` — up to `steps` older variants of `content`. */
function versionChain(content: string, steps: number): string[] {
  const chain = [content];
  let current = content;
  for (const transform of TRANSFORMS) {
    if (chain.length > steps) break;
    const older = transform(current);
    if (older !== current) {
      chain.unshift(older);
      current = older;
    }
  }
  return chain;
}

interface SeedEvent {
  time: number;
  rel: string;
  content: string | null;
  /** Events sharing a batch become one commit. */
  batch?: string;
  /** Commit message override. */
  restore?: boolean;
}

/** Notes with a longer story: path → number of earlier versions to invent. */
function storiedNotes(now: Date): Record<string, number> {
  const d = (offset: number) => localDate(addDays(now, offset));
  return {
    "01-Projects/AETHER-OS.md": 5,
    "00-Inbox/Quick Capture.md": 4,
    [`daily/${d(0)}.md`]: 3,
    "01-Projects/Masterarbeit.md": 3,
    "01-Projects/AETHER-OS Roadmap.md": 3,
    "01-Projects/Umzug Berlin.md": 3,
    "00-Inbox/Ideen fürs Wochenende.md": 2,
    "02-Areas/Weekly Review Checklist.md": 2,
    "03-Resources/Ollama Setup Tutorial.md": 2,
    "00-Inbox/Meeting Notes Team Sync.md": 2,
    [`daily/${d(-1)}.md`]: 2,
  };
}

const BATCH_NOTES = ["03-Resources/SQLite FTS5.md", "03-Resources/Vector Search Basics.md", "03-Resources/React Patterns.md"];

function seedEvents(now: Date): SeedEvent[] {
  const nowSec = Math.floor(now.getTime() / 1000);
  const day = 86_400;
  const origin = nowSec - 35 * day;
  const storied = storiedNotes(now);
  const events: SeedEvent[] = [];

  for (const note of buildVaultFixture(now)) {
    const daily = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(note.rel);
    const steps = storied[note.rel] ?? (BATCH_NOTES.includes(note.rel) ? 1 : 0);
    const chain = versionChain(note.content, steps);
    const h = hashOf(note.rel);
    // The newest version lands roughly at the note's mtime.
    const last =
      note.ageDays === 0
        ? nowSec - (12 + (h % 30)) * 60
        : nowSec - note.ageDays * day - (1 + (h % 7)) * 3600;
    const gap = note.ageDays === 0 ? 47 * 60 : Math.round(1.4 * day) + (h % 5) * 3600;

    let created: number;
    if (daily) {
      const start = new Date(`${daily[1]}T08:20:00`).getTime() / 1000;
      created = Math.min(start, last - (chain.length - 1) * gap - 60);
    } else {
      created = origin;
    }
    chain.forEach((content, i) => {
      const isBatch = BATCH_NOTES.includes(note.rel) && i === chain.length - 1 && i > 0;
      const time = i === 0 ? created : isBatch ? nowSec - 9 * day - 3 * 3600 : last - (chain.length - 1 - i) * gap;
      events.push({ time: Math.max(time, created), rel: note.rel, content, batch: isBatch ? "resources" : undefined });
    });
  }

  // A scratch note that lived for two weeks.
  events.push(
    { time: nowSec - 20 * day, rel: "00-Inbox/Scratchpad.md", content: "# Scratchpad\n\n- try `rg --files-with-matches`\n" },
    {
      time: nowSec - 15 * day,
      rel: "00-Inbox/Scratchpad.md",
      content: "# Scratchpad\n\n- try `rg --files-with-matches`\n- compare Obsidian sync vs git\n",
    },
    { time: nowSec - 6 * day, rel: "00-Inbox/Scratchpad.md", content: null }
  );

  // An accidental wipe of the thesis note, restored minutes later.
  const thesis = events.filter((e) => e.rel === "01-Projects/Masterarbeit.md").sort((a, b) => a.time - b.time);
  const final = thesis[thesis.length - 1];
  if (final?.content) {
    const stub = final.content.split("\n").slice(0, 6).join("\n") + "\n";
    events.push(
      { time: final.time + 180, rel: final.rel, content: stub },
      { time: final.time + 420, rel: final.rel, content: final.content, restore: true }
    );
  }
  return events;
}

function applyChanges(base: Map<string, string>, changes: Map<string, string | null>): Map<string, string> {
  const next = new Map(base);
  for (const [rel, content] of changes) {
    if (content === null) next.delete(rel);
    else next.set(rel, content);
  }
  return next;
}

function pushCommit(s: HistoryState, time: number, message: string, changes: Map<string, string | null>): MockCommit {
  const parent = s.commits[s.commits.length - 1];
  const base = parent ? (s.trees.get(parent.id) ?? new Map<string, string>()) : new Map<string, string>();
  const commit: MockCommit = {
    id: fakeSha(`${s.commits.length}:${time}:${message}`),
    time,
    message,
    changes,
  };
  s.commits.push(commit);
  s.trees.set(commit.id, applyChanges(base, changes));
  return commit;
}

function commitMessage(rels: string[]): string {
  return rels.length === 1 ? `note: ${rels[0]}` : `notes: ${rels.length} files`;
}

function seed(now: Date = new Date()): HistoryState {
  const s: HistoryState = { commits: [], trees: new Map() };
  const events = seedEvents(now).sort((a, b) => a.time - b.time || a.rel.localeCompare(b.rel));
  const origin = events[0]?.time ?? Math.floor(now.getTime() / 1000);

  const initial = events.filter((e) => e.time === origin);
  const initialChanges = new Map<string, string | null>([[".gitignore", ".obsidian/workspace*.json\n.trash/\n.DS_Store\n"]]);
  for (const e of initial) initialChanges.set(e.rel, e.content);
  pushCommit(s, origin, `notes: initial snapshot (${initialChanges.size} files)`, initialChanges);

  const touched = new Map<string, string[]>(); // rel → commit ids, oldest first
  for (const rel of initialChanges.keys()) touched.set(rel, [s.commits[0].id]);

  const rest = events.filter((e) => e.time !== origin);
  for (let i = 0; i < rest.length; i++) {
    const event = rest[i];
    const group = [event];
    while (event.batch && rest[i + 1]?.batch === event.batch) group.push(rest[++i]);
    const changes = new Map(group.map((e) => [e.rel, e.content] as const));
    let message = commitMessage(group.map((e) => e.rel));
    if (event.restore) {
      const ids = touched.get(event.rel) ?? [];
      const target = ids[ids.length - 2];
      if (target) message = `restore: ${event.rel} to ${target.slice(0, 7)}`;
    }
    const commit = pushCommit(s, event.time, message, changes);
    for (const e of group) touched.set(e.rel, [...(touched.get(e.rel) ?? []), commit.id]);
  }
  return s;
}

function ensureState(): HistoryState {
  state ??= seed();
  return state;
}

registerReset(() => {
  state = null;
  enabled = true;
});

// ── Helpers ──────────────────────────────────────────────────────

function head(s: HistoryState): MockCommit | undefined {
  return s.commits[s.commits.length - 1];
}

function headTree(s: HistoryState): Map<string, string> {
  const h = head(s);
  return h ? (s.trees.get(h.id) ?? new Map()) : new Map();
}

function requireRoot(): string {
  const root = mockVault.root;
  if (!root) throw new Error(NO_VAULT);
  return root;
}

function invalid(message: string): Error {
  return new Error(`invalid input: ${message}`);
}

/** Same rules as `note_rel` + `normalize_rel` in Rust. */
function toRel(path: string, root: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw invalid("note path must not be empty");
  let rel = trimmed;
  if (trimmed.startsWith("/")) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!trimmed.startsWith(prefix)) throw invalid(`path is outside the vault: ${trimmed}`);
    rel = trimmed.slice(prefix.length);
  }
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw invalid(`path traversal is not allowed: ${rel}`);
  if (parts.some((p) => p.startsWith(".") || p.includes("\\"))) throw invalid(`hidden files are not versioned: ${rel}`);
  if (parts.length === 0) throw invalid("note path must not be empty");
  return parts.join("/");
}

function isVersioned(rel: string): boolean {
  return /\.(md|png|jpe?g|gif|webp|svg|pdf|canvas)$/i.test(rel) && !rel.split("/").some((p) => p.startsWith("."));
}

function resolveCommit(s: HistoryState, id: string): MockCommit {
  const trimmed = id.trim();
  if (trimmed.length < 4 || trimmed.length > 40 || !/^[0-9a-f]+$/i.test(trimmed)) {
    throw invalid(`invalid version id: ${trimmed}`);
  }
  const lower = trimmed.toLowerCase();
  const found = s.commits.find((c) => c.id.startsWith(lower));
  if (!found) throw invalid(`unknown version: ${trimmed}`);
  return found;
}

function parentOf(s: HistoryState, commit: MockCommit): MockCommit | undefined {
  const idx = s.commits.indexOf(commit);
  return idx > 0 ? s.commits[idx - 1] : undefined;
}

function contentAt(s: HistoryState, commit: MockCommit | undefined, rel: string): string | null {
  if (!commit) return null;
  return s.trees.get(commit.id)?.get(rel) ?? null;
}

function changeKind(old: string | null, next: string | null): GitChangeKind {
  if (old === null) return "added";
  if (next === null) return "deleted";
  return "modified";
}

function activityFor(s: HistoryState, commit: MockCommit, root: string): HistoryActivity {
  const parent = parentOf(s, commit);
  const files: HistoryFileChange[] = [...commit.changes.keys()].sort().map((rel) => ({
    rel_path: rel,
    path: `${root}/${rel}`,
    change: changeKind(contentAt(s, parent, rel), contentAt(s, commit, rel)),
  }));
  return {
    commit_id: commit.id,
    short_id: commit.id.slice(0, 7),
    time: commit.time,
    message: commit.message,
    files: files.slice(0, ACTIVITY_FILES_CAP),
    file_count: files.length,
  };
}

/** Current mock-vault notes as rel → content. */
function vaultFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const note of mockVault.list()) {
    const rel = note.path.slice(root.length + 1);
    if (isVersioned(rel)) files.set(rel, mockVault.read(note.path));
  }
  return files;
}

/** Commit the given paths (or every pending change) as they are now. */
function commitPending(s: HistoryState, root: string, only: string[] | null, message?: string): HistoryActivity | null {
  const current = vaultFiles(root);
  const tree = headTree(s);
  const candidates = only ?? [...new Set([...current.keys(), ...[...tree.keys()].filter(isVersioned)])];
  const changes = new Map<string, string | null>();
  for (const rel of [...candidates].sort()) {
    const now = current.get(rel) ?? null;
    const before = tree.get(rel) ?? null;
    if (now !== before) changes.set(rel, now);
  }
  if (changes.size === 0) return null;
  const commit = pushCommit(s, Math.max(nowSeconds(), head(s)?.time ?? 0), message ?? commitMessage([...changes.keys()]), changes);
  const activity = activityFor(s, commit, root);
  mockEvents.emit(COMMIT_EVENT, activity);
  return activity;
}

/** The "watcher": commit whatever changed in the mock vault. */
function sync(): HistoryState {
  const s = ensureState();
  const root = mockVault.root;
  if (enabled && root) commitPending(s, root, null);
  return s;
}

function limitOf(args: Record<string, unknown>): number {
  const raw = argOptNumber(args, "limit") ?? DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

function statusOf(s: HistoryState): HistoryStatus {
  const root = mockVault.root;
  const last = head(s);
  return {
    enabled,
    vault_path: root,
    repo_path: root,
    branch: root ? "main" : null,
    commit_count: root ? s.commits.length : 0,
    last_commit_at: root ? (last?.time ?? null) : null,
    watching: enabled && !!root,
    last_error: null,
  };
}

// Emulate the background watcher in the browser preview.
if (typeof window !== "undefined" && import.meta.env.MODE !== "test") {
  window.setInterval(() => {
    try {
      sync();
    } catch (error) {
      console.error("[mock] note history sync failed", error);
    }
  }, 3000);
}

// ── Handlers ─────────────────────────────────────────────────────

export const historyHandlers: MockHandlerMap = {
  cmd_history_status: () => statusOf(sync()),

  cmd_history_list: (args): NoteVersion[] => {
    const s = sync();
    const rel = toRel(argString(args, "path"), requireRoot());
    const limit = limitOf(args);
    const out: NoteVersion[] = [];
    for (let i = s.commits.length - 1; i >= 0 && out.length < limit; i--) {
      const commit = s.commits[i];
      if (!commit.changes.has(rel)) continue;
      const before = contentAt(s, s.commits[i - 1], rel);
      const after = contentAt(s, commit, rel);
      if (before === after) continue;
      const stats = diffStats(diffLines(before, after));
      out.push({
        id: commit.id,
        short_id: commit.id.slice(0, 7),
        time: commit.time,
        message: commit.message,
        author: AUTHOR,
        change: changeKind(before, after),
        summary_added: stats.added,
        summary_removed: stats.removed,
      });
    }
    return out;
  },

  cmd_history_read: (args): string => {
    const s = sync();
    const rel = toRel(argString(args, "path"), requireRoot());
    const commit = resolveCommit(s, argString(args, "commitId"));
    const content = contentAt(s, commit, rel);
    if (content === null) throw invalid(`${rel} does not exist in version ${commit.id.slice(0, 7)}`);
    return content;
  },

  cmd_history_diff: (args): FileDiff => {
    const s = sync();
    const root = requireRoot();
    const rel = toRel(argString(args, "path"), root);
    const from = argOptString(args, "from");
    const to = argOptString(args, "to");
    const toCommit = to ? resolveCommit(s, to) : null;
    const newContent = toCommit
      ? contentAt(s, toCommit, rel)
      : mockVault.hasFile(`${root}/${rel}`)
        ? mockVault.read(`${root}/${rel}`)
        : null;
    let oldContent: string | null;
    if (from) oldContent = contentAt(s, resolveCommit(s, from), rel);
    else if (toCommit) oldContent = contentAt(s, parentOf(s, toCommit), rel);
    else oldContent = contentAt(s, head(s), rel);
    return { path: rel, old_content: oldContent, new_content: newContent, is_binary: false };
  },

  cmd_history_restore: (args): HistoryRestore => {
    const s = sync();
    const root = requireRoot();
    const rel = toRel(argString(args, "path"), root);
    const commit = resolveCommit(s, argString(args, "commitId"));
    const content = contentAt(s, commit, rel);
    if (content === null) throw invalid(`${rel} does not exist in version ${commit.id.slice(0, 7)}`);
    const abs = `${root}/${rel}`;
    if (!mockVault.hasFile(abs) && !mockVault.hasDir(dirname(abs))) mockVault.addDir(dirname(abs));
    mockVault.write(abs, content);
    const activity = enabled
      ? commitPending(s, root, [rel], `restore: ${rel} to ${commit.id.slice(0, 7)}`)
      : null;
    return { content, commit_id: activity?.commit_id ?? null };
  },

  cmd_history_recent: (args): HistoryActivity[] => {
    const s = sync();
    const root = requireRoot();
    const limit = limitOf(args);
    return s.commits
      .slice(-limit)
      .reverse()
      .map((c) => activityFor(s, c, root));
  },

  cmd_history_set_enabled: (args): HistoryStatus => {
    enabled = argBool(args, "enabled");
    return statusOf(sync());
  },

  cmd_history_commit_now: (args): HistoryActivity | null => {
    if (!enabled) throw invalid("note history is turned off — enable it in Settings → History");
    const s = ensureState();
    const root = requireRoot();
    const path = argOptString(args, "path");
    if (path === null) return commitPending(s, root, null);
    const rel = toRel(path, root);
    if (!isVersioned(rel)) throw invalid(`only notes and attachments are versioned: ${rel}`);
    return commitPending(s, root, [rel]);
  },
};
