/**
 * Mock handlers for `commands/search_commands.rs`: a live fake index over
 * the mock vault, projects, project files (mock FS), memory, conversations,
 * calendar, tasks and a fixed list of macOS apps. Ranking mirrors the Rust
 * engine: prefix keyword matching with title weight, fuzzy titles, optional
 * semantic hits from the mock vault search, reciprocal-rank fusion and a
 * frecency boost from the recents list.
 */
import type {
  AppEntry,
  CalendarEvent,
  Conversation,
  IndexReport,
  KindReport,
  MemoryFact,
  Project,
  RecentHit,
  SearchHit,
  SearchKind,
  SearchSettings,
  SearchStatus,
  TaskItem,
  TaskProject,
} from "../../types";
import { launcherScore } from "../search/fuzzy";
import { frecency, frecencyBoost, reciprocalRankFusion, MAX_RECENTS, MAX_VISITS } from "../search/frecency";
import { SEARCH_KINDS } from "../search/kinds";
import { calendarHandlers } from "./calendar";
import { mockFs } from "./fsStore";
import { extractTags, splitFrontmatter } from "./markdown";
import { memoryHandlers } from "./memory";
import { getMockProjectDirs, scanMockProjects } from "./projects";
import {
  argNumber,
  argObject,
  argOptNumber,
  argOptString,
  argString,
  isWithin,
  mockEvents,
  normalizePath,
  nowSeconds,
  registerReset,
  sleep,
  type MockArgs,
  type MockHandlerMap,
} from "./runtime";
import { tasksHandlers } from "./tasks";
import { mockVault } from "./vaultStore";

/** Same wording as `SEMANTIC_INDEX_MISSING` in `search_commands.rs`. */
export const SEMANTIC_INDEX_MISSING =
  'Semantic search needs the vault index. Run "Index vault" first, then try again.';

/** Fake installed applications (paths as on a real Mac). */
export const MOCK_APPS: AppEntry[] = [
  ["Safari", "/Applications/Safari.app", "com.apple.Safari"],
  ["Code", "/Applications/Visual Studio Code.app", "com.microsoft.VSCode"],
  ["Cursor", "/Applications/Cursor.app", "com.todesktop.230313mzl4w4u92"],
  ["Google Chrome", "/Applications/Google Chrome.app", "com.google.Chrome"],
  ["Slack", "/Applications/Slack.app", "com.tinyspeck.slackmacgap"],
  ["Figma", "/Applications/Figma.app", "com.figma.Desktop"],
  ["Spotify", "/Applications/Spotify.app", "com.spotify.client"],
  ["Obsidian", "/Applications/Obsidian.app", "md.obsidian"],
  ["Zed", "/Applications/Zed.app", "dev.zed.Zed"],
  ["Xcode", "/Applications/Xcode.app", "com.apple.dt.Xcode"],
  ["iTerm", "/Applications/iTerm.app", "com.googlecode.iterm2"],
  ["Mail", "/System/Applications/Mail.app", "com.apple.mail"],
  ["Calendar", "/System/Applications/Calendar.app", "com.apple.iCal"],
  ["Notes", "/System/Applications/Notes.app", "com.apple.Notes"],
  ["Music", "/System/Applications/Music.app", "com.apple.Music"],
  ["Photos", "/System/Applications/Photos.app", "com.apple.Photos"],
  ["Messages", "/System/Applications/Messages.app", "com.apple.MobileSMS"],
  ["System Settings", "/System/Applications/System Settings.app", "com.apple.systempreferences"],
  ["Preview", "/System/Applications/Preview.app", "com.apple.Preview"],
  ["Terminal", "/System/Applications/Utilities/Terminal.app", "com.apple.Terminal"],
  ["Activity Monitor", "/System/Applications/Utilities/Activity Monitor.app", "com.apple.ActivityMonitor"],
].map(([name, path, bundle_id]) => ({ name, path, bundle_id }));

const DEFAULT_SETTINGS: SearchSettings = {
  global_shortcut_enabled: true,
  global_shortcut: "Alt+Space",
  kinds: [...SEARCH_KINDS],
  file_roots: [],
};

interface MockRecent {
  id: string;
  kind: string;
  title: string | null;
  count: number;
  lastUsed: number;
  visits: number[];
}

interface SearchState {
  settings: SearchSettings;
  recents: MockRecent[];
  lastIndexedAt: number | null;
  indexing: boolean;
}

function seed(): SearchState {
  return { settings: structuredCloneSafe(DEFAULT_SETTINGS), recents: [], lastIndexedAt: nowSeconds(), indexing: false };
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let state = seed();
registerReset(() => {
  state = seed();
});

// ── Documents ──

interface MockDoc {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  path: string;
  body: string;
  tags: string[];
  updated_at: number;
  extra: Record<string, unknown>;
}

/** Readable text of a note (frontmatter, Markdown markers and link syntax removed). */
export function plainText(markdown: string): string {
  const { body } = splitFrontmatter(markdown);
  return body
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/^\s*(>\s*)+/, "")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => (alias ?? target).trim())
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*|__|~~|==|[`*]/g, "")
        .trimEnd()
    )
    .join("\n")
    .trim();
}

function noteDocs(): MockDoc[] {
  const root = mockVault.root;
  if (!root) return [];
  return mockVault.list().map((note) => {
    const content = mockVault.read(note.path);
    const rel = note.path.slice(root.length + 1);
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    return {
      id: `note:${note.path}`,
      kind: "note" as const,
      title: note.name,
      subtitle: folder || "Vault",
      path: note.path,
      body: plainText(content),
      tags: extractTags(content).map((t) => t.toLowerCase()),
      updated_at: note.mtime,
      extra: { folder },
    };
  });
}

function mockProjects(): Project[] {
  return scanMockProjects(getMockProjectDirs());
}

function projectDocs(projects: Project[]): MockDoc[] {
  return projects.map((p) => ({
    id: `project:${p.path}`,
    kind: "project" as const,
    title: p.name,
    subtitle: p.git_branch ? `${p.language} · ${p.git_branch}` : p.language,
    path: p.path,
    body: `${p.name} ${p.language} ${p.git_branch ?? ""}`,
    tags: [p.language],
    updated_at: p.last_commit_date ?? 0,
    extra: { branch: p.git_branch, language: p.language },
  }));
}

const SKIP_DIRS = ["node_modules", "target", "dist", "build", ".git"];

function fileDocs(projects: Project[]): MockDoc[] {
  const roots = state.settings.file_roots.length > 0 ? state.settings.file_roots : projects.map((p) => p.path);
  const docs: MockDoc[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const rootName = root.slice(root.lastIndexOf("/") + 1);
    for (const rel of mockFs.filesUnder(root).keys()) {
      const parts = rel.split("/");
      if (parts.some((p) => p.startsWith(".") || SKIP_DIRS.includes(p)) || parts.length > 9) continue;
      const path = `${root}/${rel}`;
      if (seen.has(path)) continue;
      seen.add(path);
      const name = parts[parts.length - 1];
      const folder = parts.slice(0, -1).join("/");
      docs.push({
        id: `file:${path}`,
        kind: "file",
        title: name,
        subtitle: folder ? `${rootName}/${folder}` : rootName,
        path,
        body: `${rootName}/${rel}`,
        tags: [],
        updated_at: 0,
        extra: { root, rel },
      });
    }
  }
  return docs;
}

function fnvHex(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function memoryDocs(): MockDoc[] {
  const facts = memoryHandlers.cmd_get_memory_facts({}) as MemoryFact[];
  return facts.map((f) => ({
    id: `memory:${fnvHex(f.fact)}`,
    kind: "memory" as const,
    title: f.fact.slice(0, 160),
    subtitle: `Memory · ${f.category}`,
    path: "",
    body: f.fact,
    tags: [f.category.toLowerCase()],
    updated_at: f.created_at,
    extra: { category: f.category, fact: f.fact },
  }));
}

function conversationDocs(): MockDoc[] {
  const conversations = memoryHandlers.cmd_get_recent_conversations({ limit: 5000 }) as Conversation[];
  return conversations.map((c) => {
    const firstUser = c.messages.find((m) => m.role === "user")?.content ?? "";
    const title = (c.summary.trim() || firstUser).slice(0, 120) || "Conversation";
    const date = new Date(c.timestamp * 1000).toISOString().slice(0, 10);
    return {
      id: `conversation:${c.id}`,
      kind: "conversation" as const,
      title,
      subtitle: `AI conversation · ${date} · ${c.messages.length} messages`,
      path: "",
      body: plainText(c.messages.map((m) => m.content).join("\n")),
      tags: [],
      updated_at: c.timestamp,
      extra: { conversation_id: c.id, context_notes: c.context_notes },
    };
  });
}

function eventDocs(): MockDoc[] {
  const events = calendarHandlers.cmd_list_calendar_events({}) as CalendarEvent[];
  return events.map((e) => {
    const date = e.start.slice(0, 10);
    const time = e.all_day ? `${date} · all day` : `${date} ${e.start.slice(11, 16)}`;
    return {
      id: `event:${e.id}`,
      kind: "event" as const,
      title: e.title,
      subtitle: e.location ? `${time} · ${e.location}` : time,
      path: "",
      body: [plainText(e.description), e.location ?? "", e.attendees.join(", ")].join("\n"),
      tags: e.tags.map((t) => t.toLowerCase()),
      updated_at: Math.floor(Date.parse(e.updated_at) / 1000) || 0,
      extra: { event_id: e.id, date, start: e.start, all_day: e.all_day, color: e.color },
    };
  });
}

function taskDocs(): MockDoc[] {
  const projects = tasksHandlers.cmd_list_task_projects({}) as TaskProject[];
  const tasks = tasksHandlers.cmd_list_tasks({ projectId: null }) as TaskItem[];
  return tasks.map((t) => {
    const projectName = projects.find((p) => p.id === t.project_id)?.name ?? "Tasks";
    const due = t.due_date ? ` · due ${t.due_date}` : "";
    return {
      id: `task:${t.id}`,
      kind: "task" as const,
      title: t.title,
      subtitle: `${projectName} · ${t.status.replace(/_/g, " ")} · ${t.priority}${due}`,
      path: "",
      body: `${plainText(t.description)}\n${t.labels.join(" ")}`,
      tags: t.labels.map((l) => l.toLowerCase()),
      updated_at: Math.floor(Date.parse(t.updated_at) / 1000) || 0,
      extra: {
        task_id: t.id,
        project_id: t.project_id,
        project_name: projectName,
        status: t.status,
        priority: t.priority,
        due_date: t.due_date,
      },
    };
  });
}

function appDocs(): MockDoc[] {
  return MOCK_APPS.map((a) => ({
    id: `app:${a.path}`,
    kind: "app" as const,
    title: a.name,
    subtitle: "Application",
    path: a.path,
    body: `${a.path.slice(a.path.lastIndexOf("/") + 1).replace(/\.app$/, "")} ${a.bundle_id ?? ""}`,
    tags: [],
    updated_at: 0,
    extra: { bundle_id: a.bundle_id },
  }));
}

/** Every document of the enabled kinds (computed live, so edits show up at once). */
function allDocs(kinds: SearchKind[] = state.settings.kinds): MockDoc[] {
  const wanted = new Set(kinds);
  const docs: MockDoc[] = [];
  const projects = wanted.has("project") || wanted.has("file") ? mockProjects() : [];
  if (wanted.has("note")) docs.push(...noteDocs());
  if (wanted.has("project")) docs.push(...projectDocs(projects));
  if (wanted.has("file")) docs.push(...fileDocs(projects));
  if (wanted.has("memory")) docs.push(...memoryDocs());
  if (wanted.has("conversation")) docs.push(...conversationDocs());
  if (wanted.has("event")) docs.push(...eventDocs());
  if (wanted.has("task")) docs.push(...taskDocs());
  if (wanted.has("app")) docs.push(...appDocs());
  return docs;
}

// ── Query ──

/** Lower-cased alphanumeric terms (diacritics folded), like the FTS tokenizer. */
export function terms(query: string): string[] {
  const out: string[] = [];
  for (const raw of fold(query).split(/[^\p{L}\p{N}]+/u)) {
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out.slice(0, 12);
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

function tokens(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** BM25-like keyword score: every term must prefix-match a token; title counts 10×, tags 5×. */
function keywordScore(doc: MockDoc, queryTerms: string[], tagOnly: boolean): number {
  const title = tokens(doc.title);
  const body = tokens(doc.body);
  const tags = doc.tags.flatMap(tokens);
  let score = 0;
  for (const term of queryTerms) {
    const inTitle = tagOnly ? 0 : title.filter((t) => t.startsWith(term)).length;
    const inBody = tagOnly ? 0 : body.filter((t) => t.startsWith(term)).length;
    const inTags = tags.filter((t) => t.startsWith(term)).length;
    if (inTitle + inBody + inTags === 0) return 0;
    score += inTitle * 10 + (inBody / Math.sqrt(body.length + 1)) * 4 + inTags * 5;
  }
  return score;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Escaped snippet around the first term match, matches wrapped in `<mark>`. */
export function snippetFor(text: string, queryTerms: string[], maxChars = 180): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const folded = fold(collapsed);
  const aligned = folded.length === collapsed.length;
  const startsWord = (i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(collapsed[i - 1]);
  const matchAt = (i: number): number => {
    if (!aligned || !startsWord(i)) return 0;
    let best = 0;
    for (const t of queryTerms) if (t && folded.startsWith(t, i) && t.length > best) best = t.length;
    return best;
  };
  let first = -1;
  for (let i = 0; i < collapsed.length && first < 0; i++) if (matchAt(i) > 0) first = i;
  let start = first > maxChars / 3 ? first - Math.floor(maxChars / 4) : 0;
  while (start > 0 && start < first && !startsWord(start)) start++;
  const end = Math.min(collapsed.length, start + maxChars);
  let out = start > 0 ? "…" : "";
  let plain = "";
  for (let i = start; i < end; ) {
    const len = matchAt(i);
    if (len > 0) {
      out += escapeHtml(plain);
      plain = "";
      out += `<mark>${escapeHtml(collapsed.slice(i, Math.min(end, i + len)))}</mark>`;
      i += len;
    } else {
      plain += collapsed[i];
      i++;
    }
  }
  out += escapeHtml(plain);
  return end < collapsed.length ? `${out}…` : out;
}

function frecencyMap(now: number): Map<string, number> {
  return new Map(state.recents.map((r) => [r.id, frecency({ count: r.count, lastUsed: r.lastUsed, visits: r.visits }, now)]));
}

function toHit(doc: MockDoc, snippet: string, score: number, matched: SearchHit["matched"]): SearchHit {
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    subtitle: doc.subtitle,
    path: doc.path,
    snippet_html: snippet,
    score,
    updated_at: doc.updated_at,
    extra: doc.extra,
    matched,
  };
}

function parseKinds(value: unknown): SearchKind[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("invalid args `kinds` for command: expected a list");
  const kinds: SearchKind[] = [];
  for (const k of value) {
    if (typeof k !== "string" || !(SEARCH_KINDS as string[]).includes(k)) {
      throw new Error(`invalid input: unknown search kind: ${String(k)}`);
    }
    if (!kinds.includes(k as SearchKind)) kinds.push(k as SearchKind);
  }
  return kinds;
}

/** The mock `cmd_search_query`. */
export function mockSearch(args: MockArgs): SearchHit[] {
  const raw = argString(args, "q").trim();
  const requested = parseKinds(args.kinds);
  const limit = Math.max(1, Math.min(500, argNumber(args, "limit")));
  const perKind = argOptNumber(args, "perKind");
  const semantic = args.semantic === true;
  const enabled = state.settings.kinds;
  const kinds = requested && requested.length > 0 ? requested.filter((k) => enabled.includes(k)) : enabled;
  if (!raw || kinds.length === 0) return [];
  const tagOnly = raw.startsWith("#");
  const queryText = tagOnly ? raw.slice(1) : raw;
  const queryTerms = terms(queryText);
  if (queryTerms.length === 0) return [];

  const docs = allDocs(kinds);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const keyword = docs
    .map((doc) => ({ doc, score: keywordScore(doc, queryTerms, tagOnly) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const fuzzy = tagOnly
    ? []
    : docs
        .map((doc) => ({ doc, score: launcherScore(raw, doc.title) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
  const semanticHits =
    semantic && !tagOnly && kinds.includes("note")
      ? mockVault.search(raw, 30).filter((m) => m.score >= 0.25 && byId.has(`note:${m.id}`))
      : [];

  const fused = reciprocalRankFusion([
    { ids: keyword.map((k) => k.doc.id), weight: 1 },
    { ids: fuzzy.slice(0, Math.max(15, limit)).map((f) => f.doc.id), weight: 0.9 },
    { ids: semanticHits.map((m) => `note:${m.id}`), weight: 1 },
  ]);
  const now = nowSeconds();
  const boosts = frecencyMap(now);
  const ranked = fused
    .map(({ id, score }) => ({ id, score: score * frecencyBoost(boosts.get(id) ?? 0) }))
    .sort((a, b) => b.score - a.score);

  const keywordIds = new Set(keyword.map((k) => k.doc.id));
  const fuzzyIds = new Set(fuzzy.map((f) => f.doc.id));
  const semanticIds = new Set(semanticHits.map((m) => `note:${m.id}`));
  const perKindCount = new Map<string, number>();
  const hits: SearchHit[] = [];
  const top = ranked[0]?.score || 1;
  for (const { id, score } of ranked) {
    const doc = byId.get(id);
    if (!doc) continue;
    const count = perKindCount.get(doc.kind) ?? 0;
    if (perKind !== null && count >= Math.max(1, perKind)) continue;
    perKindCount.set(doc.kind, count + 1);
    const matched: SearchHit["matched"] = [];
    if (keywordIds.has(id)) matched.push("keyword");
    if (fuzzyIds.has(id)) matched.push("fuzzy");
    if (semanticIds.has(id)) matched.push("semantic");
    const source = tagOnly ? doc.body : doc.body || doc.subtitle;
    hits.push(toHit(doc, snippetFor(source, queryTerms), Math.round((score / top) * 1000) / 1000, matched));
    if (hits.length >= limit) break;
  }
  return hits;
}

// ── Recents ──

function recordRecent(id: string, kind: string, title: string | null): void {
  const cleanId = id.trim();
  const cleanKind = kind.trim();
  if (!cleanId || !cleanKind) throw new Error("invalid input: recent id and kind are required");
  const now = nowSeconds();
  const existing = state.recents.find((r) => r.id === cleanId);
  const entry: MockRecent = existing
    ? {
        ...existing,
        kind: cleanKind,
        title: title?.trim() ? title.trim().slice(0, 300) : existing.title,
        count: existing.count + 1,
        lastUsed: now,
        visits: [now, ...existing.visits].slice(0, MAX_VISITS),
      }
    : { id: cleanId, kind: cleanKind, title: title?.trim() ? title.trim().slice(0, 300) : null, count: 1, lastUsed: now, visits: [now] };
  state.recents = [entry, ...state.recents.filter((r) => r.id !== cleanId)].slice(0, MAX_RECENTS);
}

function listRecents(limit: number): RecentHit[] {
  const now = nowSeconds();
  const docs = new Map(allDocs(SEARCH_KINDS).map((d) => [d.id, d]));
  const out: RecentHit[] = [];
  for (const r of [...state.recents].sort((a, b) => b.lastUsed - a.lastUsed)) {
    const isIndexed = (SEARCH_KINDS as string[]).includes(r.kind);
    const doc = docs.get(r.id);
    if (isIndexed && !doc) continue;
    out.push({
      id: r.id,
      kind: r.kind,
      title: r.title,
      count: r.count,
      last_used: r.lastUsed,
      frecency: frecency({ count: r.count, lastUsed: r.lastUsed, visits: r.visits }, now),
      hit: doc ? toHit(doc, "", 1, []) : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Settings, status, reindex ──

const MODIFIERS = new Set(["alt", "option", "ctrl", "control", "cmd", "command", "super", "commandorcontrol", "cmdorctrl", "cmdorcontrol", "commandorctrl", "shift"]);
const STRONG = new Set(["alt", "option", "ctrl", "control", "cmd", "command", "super", "commandorcontrol", "cmdorctrl", "cmdorcontrol", "commandorctrl"]);
const KEY_RE = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4])|space|enter|tab|escape|esc|backspace|delete|up|down|left|right|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|comma|period|slash|backslash|semicolon|quote|backquote|minus|equal|bracketleft|bracketright|[,./\\;'`\-=[\]])$/;

/** Same rules as `parse_global_shortcut`: modifiers first, one key, Alt/Ctrl/Cmd required. */
export function validateShortcut(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("invalid input: shortcut is empty");
  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.some((p) => !p)) throw new Error(`invalid input: invalid shortcut "${trimmed}": empty token`);
  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  if (mods.some((m) => !MODIFIERS.has(m)) || MODIFIERS.has(key) || !KEY_RE.test(key)) {
    throw new Error(`invalid input: invalid shortcut "${trimmed}": use modifiers first and one key, e.g. Alt+Space`);
  }
  if (!mods.some((m) => STRONG.has(m))) throw new Error(`invalid input: shortcut "${trimmed}" needs Alt, Ctrl or Cmd`);
  return trimmed;
}

function validateSettings(input: Partial<SearchSettings>): SearchSettings {
  const shortcut = validateShortcut(String(input.global_shortcut ?? ""));
  const kinds = parseKinds(input.kinds ?? []) ?? [];
  if (kinds.length === 0) throw new Error("invalid input: select at least one kind of result to search");
  const roots: string[] = [];
  for (const raw of input.file_roots ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("/")) throw new Error(`invalid input: file index folder must be an absolute path: ${trimmed}`);
    const path = normalizePath(trimmed);
    if (path === "/") throw new Error("invalid input: indexing the whole disk is not supported; pick a folder");
    const exists = mockFs.isDir(path) || mockVault.hasDir(path);
    if (!exists) throw new Error(`invalid input: file index folder does not exist: ${trimmed}`);
    if (!roots.includes(path)) roots.push(path);
  }
  return {
    global_shortcut_enabled: input.global_shortcut_enabled !== false,
    global_shortcut: shortcut,
    kinds,
    file_roots: roots,
  };
}

function counts() {
  const byKind = new Map<string, number>();
  for (const doc of allDocs()) byKind.set(doc.kind, (byKind.get(doc.kind) ?? 0) + 1);
  return [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, count]) => ({ kind, count }));
}

function status(): SearchStatus {
  const c = counts();
  return {
    counts: c,
    total: c.reduce((sum, k) => sum + k.count, 0),
    last_indexed_at: state.lastIndexedAt,
    indexing: state.indexing,
    shortcut: state.settings.global_shortcut_enabled ? state.settings.global_shortcut : null,
    shortcut_error: null,
  };
}

async function reindex(kinds: SearchKind[] | null): Promise<IndexReport> {
  const started = Date.now();
  state.indexing = true;
  try {
    const reports: KindReport[] = [];
    for (const kind of kinds && kinds.length > 0 ? kinds : SEARCH_KINDS) {
      const kindStarted = Date.now();
      await sleep(kind === "file" ? 260 : 90);
      const count = state.settings.kinds.includes(kind) ? allDocs([kind]).length : 0;
      const report: KindReport = {
        kind,
        count,
        changed: kind === "note" ? count : 0,
        removed: 0,
        ms: Date.now() - kindStarted,
        truncated: false,
        error: kind === "note" && !mockVault.root ? "vault error: no vault path configured" : null,
      };
      reports.push(report);
      mockEvents.emit("search-index-progress", report);
    }
    state.lastIndexedAt = nowSeconds();
    const report: IndexReport = { kinds: reports, total: reports.reduce((s, r) => s + r.count, 0), ms: Date.now() - started };
    mockEvents.emit("search-index-updated", report);
    return report;
  } finally {
    state.indexing = false;
  }
}

export const searchHandlers: MockHandlerMap = {
  cmd_search_query: (args) => {
    if (args.semantic === true && !mockVault.root) throw new Error(SEMANTIC_INDEX_MISSING);
    return mockSearch(args);
  },
  cmd_search_reindex: (args) => reindex(parseKinds(args.kinds)),
  cmd_search_apps: () => MOCK_APPS,
  cmd_launch_app: (args) => {
    const path = argString(args, "path").trim();
    if (!path) throw new Error("invalid input: app path is required");
    const app = MOCK_APPS.find((a) => a.path === normalizePath(path));
    if (!app) {
      const inRoots = ["/Applications", "/System/Applications"].some((root) => isWithin(normalizePath(path), root));
      throw new Error(
        inRoots
          ? `invalid input: application not found: ${path}`
          : `invalid input: refusing to launch an application outside the application folders: ${path}`
      );
    }
    console.info(`[mock] launch app: ${app.name}`);
  },
  cmd_search_recents_record: (args) => {
    recordRecent(argString(args, "id"), argString(args, "kind"), argOptString(args, "title"));
  },
  cmd_search_recents_list: (args) => listRecents(Math.max(1, Math.min(50, argOptNumber(args, "limit") ?? 20))),
  cmd_search_recents_clear: () => {
    state.recents = [];
  },
  cmd_search_get_settings: () => state.settings,
  cmd_search_set_settings: (args) => {
    state.settings = validateSettings(argObject<SearchSettings>(args, "settings"));
    return state.settings;
  },
  cmd_search_status: () => status(),
};
