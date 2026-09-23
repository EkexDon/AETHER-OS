/**
 * Mock handlers for `commands/intel_commands.rs`.
 *
 * - Compaction returns a canned structured summary after 800 ms.
 * - Suggestions run the real keyword fallback (`src/lib/intel/keywords.ts`,
 *   a port of the Rust scorer) over the mock vault; tags are merged into the
 *   frontmatter exactly like the desktop app does.
 * - `run_command` validates the working directory against the IDE sandbox
 *   roots and returns plausible fake output (nothing is executed).
 * - Note, git and task actions go through the vault, git and task mocks,
 *   and every executed action lands in an in-memory audit log.
 *
 * Conversations are stored in the memory mock through its own handlers so
 * the agent's history list shows compacted sessions.
 */
import type {
  ActionPreview,
  ActionRisk,
  AgentAction,
  AuditEntry,
  AuditStatus,
  ChatMessageRecord,
  CommandOutput,
  CompactionResult,
  Conversation,
  IntelSettings,
  RepoStatus,
  TaskItem,
  TaskProject,
} from "../../types";
import { describeAction } from "../agentActions";
import { actionRisk } from "../intel/risk";
import { addTagToContent, buildDocTerms, normalizeTag, rankByKeywords, rankTags, type DocTerms } from "../intel/keywords";
import { toggleTaskLine, parseTaskLine } from "../intel/taskLine";
import { estimateConversationTokens } from "../intel/tokens";
import { gitHandlers } from "./git";
import { ideRoots } from "./ide";
import { firstSentence } from "./markdown";
import { memoryHandlers } from "./memory";
import { mockFs } from "./fsStore";
import {
  argNumber,
  argObject,
  argOptNumber,
  argOptString,
  argString,
  basename,
  dirname,
  isWithin,
  mockUuid,
  normalizePath,
  registerReset,
  sleep,
  type MockArgs,
  type MockHandlerMap,
} from "./runtime";
import { tasksHandlers } from "./tasks";
import { mockVault } from "./vaultStore";

/** How long the fake summariser takes. */
export const MOCK_COMPACT_MS = 800;
/** How long a fake shell command takes. */
export const MOCK_COMMAND_MS = 450;

const DEFAULTS: IntelSettings = {
  auto_compact: true,
  compact_threshold_tokens: 6_000,
  keep_recent_messages: 4,
  related_suggestions: true,
  llm_tag_suggestions: false,
  command_timeout_secs: 60,
};

interface IntelMockState {
  settings: IntelSettings;
  audit: AuditEntry[];
}

function seedAudit(): AuditEntry[] {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const entries: AuditEntry[] = [
    {
      id: mockUuid(),
      timestamp: at(3),
      action: "append_daily",
      risk: "safe",
      summary: 'Add to daily note: Asked AETHER: "What should I focus on today?"',
      status: "ok",
      detail: "Added to daily note",
      duration_ms: null,
    },
    {
      id: mockUuid(),
      timestamp: at(42),
      action: "run_command",
      risk: "dangerous",
      summary: "Run `git status` in /Users/demo/Developer/aether-demo-app",
      status: "ok",
      detail: "git status (in /Users/demo/Developer/aether-demo-app) → exit 0",
      duration_ms: 118,
    },
    {
      id: mockUuid(),
      timestamp: at(95),
      action: "delete_note",
      risk: "dangerous",
      summary: "Move note Scratch.md to trash",
      status: "denied",
      detail: null,
      duration_ms: null,
    },
  ];
  // Oldest first, like lines appended to audit.jsonl.
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

let state: IntelMockState = { settings: { ...DEFAULTS }, audit: seedAudit() };
registerReset(() => {
  state = { settings: { ...DEFAULTS }, audit: seedAudit() };
});

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));

function normalizeSettings(input: Partial<IntelSettings>): IntelSettings {
  const s = { ...DEFAULTS, ...input };
  return {
    auto_compact: Boolean(s.auto_compact),
    compact_threshold_tokens: clamp(Number(s.compact_threshold_tokens), 1_000, 64_000),
    keep_recent_messages: clamp(Number(s.keep_recent_messages), 2, 20),
    related_suggestions: Boolean(s.related_suggestions),
    llm_tag_suggestions: Boolean(s.llm_tag_suggestions),
    command_timeout_secs: clamp(Number(s.command_timeout_secs), 5, 300),
  };
}

function record(action: AgentAction, status: AuditStatus, detail: string | null, durationMs: number | null): AuditEntry {
  const entry: AuditEntry = {
    id: mockUuid(),
    timestamp: new Date().toISOString(),
    action: action.action,
    risk: actionRisk(action) as ActionRisk,
    summary: describeAction(action),
    status,
    detail: detail && detail.trim() ? detail.trim().slice(0, 600) : null,
    duration_ms: durationMs,
  };
  state.audit.push(entry);
  return entry;
}

/** Run `fn`, audit its outcome like the Rust commands do, and rethrow errors. */
async function audited<T>(action: AgentAction, fn: () => T | Promise<T>, detail: (value: T) => [AuditStatus, string]): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    const [status, text] = detail(value);
    record(action, status, text, Date.now() - started);
    return value;
  } catch (e) {
    record(action, "error", e instanceof Error ? e.message : String(e), Date.now() - started);
    throw e;
  }
}

function parseMessages(args: MockArgs): ChatMessageRecord[] {
  const value = args.messages;
  if (!Array.isArray(value)) throw new Error("invalid args `messages` for command: command missing required key messages");
  return value.map((m) => ({ role: String((m as ChatMessageRecord).role ?? ""), content: String((m as ChatMessageRecord).content ?? "") }));
}

function requireRoot(): string {
  const root = mockVault.root;
  if (!root) throw new Error("vault error: No vault path configured.");
  return root;
}

function hidden(path: string, root: string): boolean {
  return path
    .slice(root.length + 1)
    .split("/")
    .some((p) => p.startsWith("."));
}

/** Same resolution rules as `resolve_existing_note` in approvals.rs. */
function resolveNote(input: string): string {
  const root = requireRoot();
  const trimmed = input.trim();
  if (!trimmed) throw new Error("invalid input: note path must not be empty");
  const candidate = normalizePath(trimmed.startsWith("/") ? trimmed : `${root}/${trimmed}`);
  for (const attempt of [candidate, `${candidate}.md`]) {
    if (mockVault.hasFile(attempt)) {
      if (!isWithin(attempt, root)) throw new Error(`invalid input: path is outside the vault: ${attempt}`);
      if (hidden(attempt, root)) throw new Error(`invalid input: refusing to touch files in hidden folders: ${attempt}`);
      if (!/\.md$/i.test(attempt)) throw new Error(`invalid input: only Markdown notes (.md) can be changed: ${attempt}`);
      return attempt;
    }
  }
  if (!trimmed.includes("/")) {
    const wanted = trimmed.replace(/\.md$/i, "").toLowerCase();
    const matches = mockVault.list().filter((n) => n.name.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0].path;
    if (matches.length > 1) {
      throw new Error(`invalid input: "${trimmed}" matches ${matches.length} notes, use a path: ${matches.map((m) => m.path).join(", ")}`);
    }
  }
  throw new Error(`invalid input: note not found: ${trimmed}`);
}

function resolveMoveTarget(from: string, to: string): string {
  const root = requireRoot();
  const cleaned = to.trim().replace(/\\/g, "/");
  if (!cleaned) throw new Error("invalid input: move target must not be empty");
  if (cleaned.split("/").includes("..")) throw new Error(`invalid input: move target must not contain '..': ${cleaned}`);
  let target = normalizePath(cleaned.startsWith("/") ? cleaned : `${root}/${cleaned.replace(/^\.\//, "")}`);
  if (cleaned.endsWith("/") || mockVault.hasDir(target)) target = `${target}/${basename(from)}`;
  const ext = /\.([^./]+)$/.exec(basename(target))?.[1] ?? "";
  if (ext.toLowerCase() !== "md") {
    if (/^[A-Za-z]{1,4}$/.test(ext)) throw new Error(`invalid input: notes must keep the .md extension (got .${ext})`);
    target = `${target}.md`;
  }
  if (!isWithin(target, root) || target === root) throw new Error(`invalid input: path is outside the vault: ${target}`);
  if (hidden(target, root)) throw new Error(`invalid input: refusing to touch files in hidden folders: ${target}`);
  if (mockVault.hasFile(target)) throw new Error(`invalid input: a note already exists at ${target}`);
  return target;
}

function isDirectory(path: string): boolean {
  const root = mockVault.root;
  if (root && isWithin(path, root)) return mockVault.hasDir(path);
  return mockFs.isDir(path);
}

/** Like `resolve_cwd` in shell_exec.rs, against the IDE sandbox roots. */
function resolveCwd(cwd: string | null): string {
  const root = mockVault.root;
  const requested = cwd?.trim() ?? "";
  let dir: string;
  if (!requested) {
    if (!root) throw new Error("invalid input: no vault is configured; give the command a cwd inside a project directory");
    dir = root;
  } else if (requested.startsWith("~/")) {
    dir = normalizePath(`/Users/demo/${requested.slice(2)}`);
  } else if (requested.startsWith("/")) {
    dir = normalizePath(requested);
  } else {
    if (!root) throw new Error(`invalid input: relative cwd "${requested}" needs a configured vault; use an absolute path`);
    dir = normalizePath(`${root}/${requested}`);
  }
  if (!isDirectory(dir)) throw new Error(`invalid input: working directory does not exist: ${dir}`);
  if (!ideRoots().some((r) => isWithin(dir, r))) {
    throw new Error(`invalid input: working directory is outside the project directories and the vault: ${dir}`);
  }
  return dir;
}

function repoStatusOrNull(path: string): RepoStatus | null {
  try {
    return gitHandlers.cmd_git_status({ path }) as RepoStatus;
  } catch {
    return null;
  }
}

function listing(dir: string): string[] {
  const root = mockVault.root;
  const children = root && isWithin(dir, root) ? mockVault.children(dir) : mockFs.children(dir);
  return children
    .filter((c) => !c.name.startsWith("."))
    .map((c) => (c.isDir ? `${c.name}/` : c.name))
    .sort((a, b) => a.localeCompare(b));
}

/** Plausible output for common commands; nothing is executed. */
export function fakeShell(command: string, cwd: string): { stdout: string; stderr: string; exit: number } {
  const trimmed = command.trim();
  const [program, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ");
  switch (program) {
    case "pwd":
      return { stdout: `${cwd}\n`, stderr: "", exit: 0 };
    case "echo":
      return { stdout: `${arg.replace(/^["']|["']$/g, "")}\n`, stderr: "", exit: 0 };
    case "ls":
      return { stdout: `${listing(cwd).join("\n")}\n`, stderr: "", exit: 0 };
    case "whoami":
      return { stdout: "demo\n", stderr: "", exit: 0 };
    case "date":
      return { stdout: `${new Date().toString()}\n`, stderr: "", exit: 0 };
    case "git": {
      const status = repoStatusOrNull(cwd);
      if (!status) return { stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n", exit: 128 };
      if (rest[0] === "status") {
        const lines = status.entries.map((e) => `  ${(e.staged ?? e.unstaged ?? "modified").padEnd(10)}${e.path}`);
        const body = lines.length ? `Changes:\n${lines.join("\n")}\n` : "nothing to commit, working tree clean\n";
        return { stdout: `On branch ${status.branch}\n${body}`, stderr: "", exit: 0 };
      }
      if (rest[0] === "log") {
        const log = gitHandlers.cmd_git_log({ path: cwd, limit: 5 }) as { id: string; summary: string }[];
        return { stdout: `${log.map((c) => `${c.id.slice(0, 7)} ${c.summary}`).join("\n")}\n`, stderr: "", exit: 0 };
      }
      return { stdout: "", stderr: `git ${rest[0] ?? ""}: simulated in the browser preview\n`, exit: 0 };
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "cargo":
      if (/\btest\b/.test(arg)) {
        return {
          stdout: `> ${trimmed}\n\n ✓ src/lib/format.test.ts (4 tests) 12ms\n ✓ src/App.test.tsx (2 tests) 31ms\n\n Test Files  2 passed (2)\n      Tests  6 passed (6)\n`,
          stderr: "",
          exit: 0,
        };
      }
      return { stdout: `> ${trimmed}\n\nDone in 1.2s (browser preview — nothing was executed).\n`, stderr: "", exit: 0 };
    default:
      return { stdout: "", stderr: `sh: ${program}: not available in the browser preview\n`, exit: 127 };
  }
}

function warningsFor(command: string): string[] {
  const c = command.toLowerCase().replace(/\s+/g, " ");
  const out: string[] = [];
  if (/(^|[|;&]\s*)rm\s+(-\w*[rf]|--recursive|--force)/.test(c)) out.push("Deletes files recursively or without confirmation (rm -r / -f).");
  if (/(^|\s|\|)sudo\s/.test(c)) out.push("Runs with administrator privileges (sudo).");
  if (/git push/.test(c) && /(--force| -f)/.test(c)) out.push("Force-pushes and can overwrite remote history.");
  if (/git reset --hard|git clean -/.test(c)) out.push("Discards uncommitted changes in the repository.");
  if (/(curl|wget) /.test(c) && /\|\s*(ba)?sh/.test(c)) out.push("Downloads and executes a remote script.");
  return out;
}

function vaultDocs(): DocTerms[] {
  if (!mockVault.root) throw new Error("No vault path configured.");
  return mockVault.list().map((n) => buildDocTerms(n.path, n.name, mockVault.read(n.path)));
}

function commitCandidates(path: string): { files: string[]; stagedAll: boolean; branch: string } {
  const status = gitHandlers.cmd_git_status({ path }) as RepoStatus;
  if (status.entries.length === 0) throw new Error("invalid input: nothing to commit: the working tree is clean");
  const staged = status.entries.filter((e) => e.staged !== null).map((e) => e.path);
  return staged.length > 0
    ? { files: staged, stagedAll: false, branch: status.branch }
    : { files: status.entries.map((e) => e.path), stagedAll: true, branch: status.branch };
}

function repoRootFor(path: string): string {
  const p = normalizePath(path);
  if (!ideRoots().some((r) => isWithin(p, r))) {
    throw new Error(`invalid input: path is outside the allowed project directories: ${p}`);
  }
  return p;
}

function trashStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Canned structured summary of `messages` (the fake model's answer). */
export function cannedSummary(previous: string | null, messages: ChatMessageRecord[]): string {
  const users = messages.filter((m) => m.role === "user" && m.content.trim());
  const topic = previous?.split("\n")[0]?.replace(/^Topic:\s*/, "") || firstSentence(users[0]?.content ?? "") || "Conversation";
  const previousFacts = (previous ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- ") && !/^- none$/i.test(l))
    .slice(0, 4);
  const facts = [...previousFacts, ...users.map((u) => `- Asked: ${firstSentence(u.content) || u.content.slice(0, 80)}`)].slice(-8);
  const questions = users
    .slice(-2)
    .map((u) => firstSentence(u.content))
    .filter((s) => s.endsWith("?"));
  return [
    `Topic: ${topic.slice(0, 90)}`,
    "Facts:",
    ...(facts.length ? facts : ["- none"]),
    "Decisions:",
    "- Keep the answers grounded in the vault notes",
    "Open questions:",
    ...(questions.length ? questions.map((q) => `- ${q}`) : ["- none"]),
    "User preferences:",
    "- Concise answers with links to notes",
  ].join("\n");
}

function parseAction(args: MockArgs): AgentAction {
  const action = argObject<AgentAction>(args, "action");
  if (typeof action.action !== "string") {
    throw new Error("invalid args `action` for command: command missing required key action");
  }
  return action as AgentAction;
}

const RUST_AUDITED = new Set(["run_command", "delete_note", "move_note", "git_commit", "create_task", "toggle_vault_task"]);

function previewOf(action: AgentAction): ActionPreview {
  const preview: ActionPreview = { target: null, details: [], warnings: [], error: null };
  try {
    switch (action.action) {
      case "run_command":
        preview.warnings = warningsFor(action.command);
        preview.target = resolveCwd(action.cwd ?? null);
        preview.details.push(`Runs in a login shell (sh -lc), stops after ${state.settings.command_timeout_secs} s`);
        break;
      case "delete_note":
        preview.target = resolveNote(action.path);
        preview.details.push(`Moves the note to ${requireRoot()}/.trash — restore it by moving it back`);
        break;
      case "move_note": {
        preview.target = resolveNote(action.from);
        preview.details.push(`New location: ${resolveMoveTarget(preview.target, action.to)}`);
        preview.details.push("Wikilinks to the old name are not rewritten");
        break;
      }
      case "git_commit": {
        const root = repoRootFor(action.project_path);
        preview.target = root;
        const { files, stagedAll, branch } = commitCandidates(root);
        preview.details.push(`Branch ${branch}: ${files.length} file(s)${stagedAll ? ", all changes are staged first" : " already staged"}`);
        files.slice(0, 8).forEach((f) => preview.details.push(`• ${f}`));
        if (files.length > 8) preview.details.push(`… and ${files.length - 8} more`);
        break;
      }
      case "toggle_vault_task": {
        const path = resolveNote(action.note_path);
        preview.target = path;
        const line = mockVault.read(path).split(/\r?\n/)[action.line - 1];
        const parsed = line === undefined ? null : parseTaskLine(line);
        if (!parsed) throw new Error(`invalid input: line ${action.line} is not a Markdown task`);
        preview.details.push(
          `Line ${action.line}: [${parsed.checked ? "x" : " "}] ${parsed.text} → [${parsed.checked ? " " : "x"}]`
        );
        break;
      }
      case "import_calendar_ics":
        preview.target = action.path;
        break;
      default:
        break;
    }
  } catch (e) {
    preview.error = e instanceof Error ? e.message : String(e);
  }
  return preview;
}

export const intelHandlers: MockHandlerMap = {
  cmd_intel_get_settings: () => state.settings,
  cmd_intel_set_settings: (args) => {
    state.settings = normalizeSettings(argObject<IntelSettings>(args, "settings"));
    return state.settings;
  },

  cmd_intel_compact: async (args): Promise<CompactionResult> => {
    const messages = parseMessages(args);
    argString(args, "model");
    const previous = argOptString(args, "previousSummary");
    const keep = Math.max(1, argOptNumber(args, "keepRecent") ?? state.settings.keep_recent_messages);
    let split = Math.max(0, messages.length - Math.min(keep, messages.length));
    if (split > 1 && messages[split]?.role === "assistant" && messages[split - 1]?.role === "user") split -= 1;
    if (split === 0) {
      throw new Error(
        `invalid input: nothing to compact yet: the conversation has ${messages.length} message(s) and the last ${keep} are always kept`
      );
    }
    await sleep(MOCK_COMPACT_MS);
    const dropped = messages.slice(0, split);
    const kept = messages.slice(split);
    const summary = cannedSummary(previous, dropped);
    return {
      summary,
      kept_messages: kept,
      dropped_count: dropped.length,
      tokens_before: estimateConversationTokens(previous, messages),
      tokens_after: estimateConversationTokens(summary, kept),
      source: "model",
      model_error: null,
    };
  },
  cmd_intel_save_conversation: (args): Conversation => {
    const messages = parseMessages(args);
    if (messages.length === 0) throw new Error("invalid input: a conversation needs at least one message");
    const id = argOptString(args, "id");
    if (id !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid input: invalid conversation id: ${id}`);
    const summary = argOptString(args, "summary");
    if (id) memoryHandlers.cmd_delete_conversation({ id });
    // The memory mock stores the object it returns, so fixing up the id and
    // summary here updates its record (the IPC layer clones on the way out).
    const saved = memoryHandlers.cmd_save_conversation({
      messages,
      contextNotes: args.contextNotes ?? [],
    }) as Conversation;
    if (id) saved.id = id;
    if (summary && summary.trim()) saved.summary = summary.trim();
    return saved;
  },

  cmd_intel_suggest_related: (args) => {
    const text = argString(args, "text");
    const exclude = argOptString(args, "excludePath");
    const limit = Math.min(30, Math.max(1, argOptNumber(args, "limit") ?? 8));
    return rankByKeywords(text, vaultDocs(), exclude, limit);
  },
  cmd_intel_suggest_tags: (args) => {
    const text = argString(args, "text");
    const limit = Math.min(20, Math.max(1, argOptNumber(args, "limit") ?? 6));
    return rankTags(text, vaultDocs(), limit);
  },
  cmd_intel_add_tag: (args) => {
    const tag = normalizeTag(argString(args, "tag"));
    const path = resolveNote(argString(args, "path"));
    const { content, changed } = addTagToContent(mockVault.read(path), tag);
    if (changed) mockVault.write(path, content);
    return { path, tag, changed };
  },

  cmd_intel_run_command: async (args): Promise<CommandOutput> => {
    const MOCK_OUTPUT_CAP = 64 * 1024;
    const command = argString(args, "command");
    const cwd = argOptString(args, "cwd");
    const action: AgentAction = { action: "run_command", command, cwd };
    return audited(
      action,
      async () => {
        if (!command.trim()) throw new Error("invalid input: command must not be empty");
        const dir = resolveCwd(cwd);
        const started = Date.now();
        await sleep(MOCK_COMMAND_MS);
        const out = fakeShell(command, dir);
        // Same 64 KiB cap per stream and marker as `shell_exec.rs`.
        const cap = (text: string) =>
          text.length > MOCK_OUTPUT_CAP ? { text: `${text.slice(0, MOCK_OUTPUT_CAP)}\n[… output truncated at 64 KiB]`, cut: true } : { text, cut: false };
        const stdout = cap(out.stdout);
        const stderr = cap(out.stderr);
        return {
          command: command.trim(),
          cwd: dir,
          exit_code: out.exit,
          stdout: stdout.text,
          stderr: stderr.text,
          timed_out: false,
          duration_ms: Date.now() - started,
          truncated: stdout.cut || stderr.cut,
        };
      },
      (out) => [out.exit_code === 0 ? "ok" : "error", `${out.command} (in ${out.cwd}) → exit ${out.exit_code}`]
    );
  },
  cmd_intel_delete_note: (args) => {
    const path = argString(args, "path");
    return audited(
      { action: "delete_note", path },
      () => {
        const note = resolveNote(path);
        const root = requireRoot();
        mockVault.addDir(`${root}/.trash`);
        const stamp = trashStamp(new Date());
        let target = `${root}/.trash/${stamp}-${basename(note)}`;
        for (let i = 2; mockVault.hasFile(target); i++) target = `${root}/.trash/${stamp}-${i}-${basename(note)}`;
        mockVault.write(target, mockVault.read(note));
        mockVault.delete(note);
        return { original_path: note, trash_path: target };
      },
      (t) => ["ok", `${t.original_path} → ${t.trash_path}`]
    );
  },
  cmd_intel_move_note: (args) => {
    const from = argString(args, "from");
    const to = argString(args, "to");
    return audited(
      { action: "move_note", from, to },
      () => {
        const source = resolveNote(from);
        const target = resolveMoveTarget(source, to);
        mockVault.addDir(dirname(target));
        mockVault.write(target, mockVault.read(source));
        mockVault.delete(source);
        return { from: source, to: target };
      },
      (m) => ["ok", `${m.from} → ${m.to}`]
    );
  },
  cmd_intel_git_commit: (args) => {
    const projectPath = argString(args, "projectPath");
    const message = argString(args, "message");
    return audited(
      { action: "git_commit", project_path: projectPath, message },
      () => {
        if (!message.trim()) throw new Error("invalid input: commit message must not be empty");
        const root = repoRootFor(projectPath);
        const { files, stagedAll, branch } = commitCandidates(root);
        if (stagedAll) gitHandlers.cmd_git_stage({ path: root, files });
        const commitId = gitHandlers.cmd_git_commit({ path: root, message }) as string;
        return { commit_id: commitId, branch, files, staged_all: stagedAll };
      },
      (c) => ["ok", `${c.commit_id.slice(0, 7)} on ${c.branch} (${c.files.length} file(s))`]
    );
  },
  cmd_intel_create_task: (args) => {
    const action: AgentAction = {
      action: "create_task",
      project_id: argOptString(args, "projectId"),
      title: argString(args, "title"),
      description: argOptString(args, "description"),
      priority: argOptString(args, "priority"),
      due_date: argOptString(args, "dueDate"),
    };
    return audited(
      action,
      () => {
        const priority = (action.priority ?? "").trim().toLowerCase() || "none";
        const normalizedPriority = priority === "normal" ? "medium" : priority;
        if (!["none", "low", "medium", "high", "urgent"].includes(normalizedPriority)) {
          throw new Error(`invalid input: invalid priority "${priority}" (use none, low, medium, high, urgent)`);
        }
        const due = action.due_date?.trim() || null;
        if (due && !/^\d{4}-\d{2}-\d{2}/.test(due)) throw new Error(`invalid input: invalid due date "${due}" (use YYYY-MM-DD)`);
        const projects = tasksHandlers.cmd_list_task_projects({}) as TaskProject[];
        const wanted = action.project_id?.trim() ?? "";
        let project = wanted
          ? projects.find((p) => p.id === wanted) ?? projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase())
          : projects.find((p) => p.name.toLowerCase() === "inbox");
        let createdProject = false;
        if (!project && wanted) {
          throw new Error(`invalid input: no task project "${wanted}" — available: ${projects.map((p) => p.name).join(", ")}`);
        }
        if (!project) {
          project = tasksHandlers.cmd_create_task_project({
            name: "Inbox",
            description: "Tasks captured by the AETHER agent",
            color: "",
            icon: null,
          }) as TaskProject;
          createdProject = true;
        }
        const task = tasksHandlers.cmd_create_task({
          projectId: project.id,
          title: action.title,
          description: action.description ?? "",
          status: "todo",
          priority: normalizedPriority,
          dueDate: due ? due.slice(0, 10) : null,
          labels: [],
          order: null,
        }) as TaskItem;
        return { task, project, created_project: createdProject };
      },
      (c) => ["ok", `"${c.task.title}" in ${c.project.name}`]
    );
  },
  cmd_intel_toggle_vault_task: (args) => {
    const notePath = argString(args, "notePath");
    const line = argNumber(args, "line");
    return audited(
      { action: "toggle_vault_task", note_path: notePath, line },
      () => {
        const path = resolveNote(notePath);
        const result = toggleTaskLine(mockVault.read(path), line);
        mockVault.write(path, result.content);
        return { path, line, checked: result.checked, text: result.text };
      },
      (t) => ["ok", `${t.checked ? "checked" : "unchecked"} "${t.text}"`]
    );
  },
  cmd_intel_preview_action: (args) => previewOf(parseAction(args)),

  cmd_intel_audit_list: (args) => {
    const limit = Math.min(500, Math.max(1, argOptNumber(args, "limit") ?? 50));
    return [...state.audit].reverse().slice(0, limit);
  },
  cmd_intel_audit_record: (args) => {
    const action = parseAction(args);
    const status = argString(args, "status") as AuditStatus;
    if (!["ok", "error", "denied"].includes(status)) {
      throw new Error("invalid args `status` for command: unknown variant");
    }
    if (RUST_AUDITED.has(action.action) && status !== "denied") {
      throw new Error(`invalid input: ${action.action} is audited by its own command`);
    }
    return record(action, status, argOptString(args, "detail"), null);
  },
  cmd_intel_audit_clear: () => {
    state.audit = [];
  },
};
