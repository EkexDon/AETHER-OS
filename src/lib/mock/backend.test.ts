import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import libRs from "../../../src-tauri/src/lib.rs?raw";
import type {
  CalendarEvent,
  GraphData,
  RepoStatus,
  SystemMetrics,
  TaskItem,
  TaskProject,
  TerminalOutputEvent,
  VaultNote,
  VaultStats,
} from "../../types";
import { mockEvents, mockHandlers, mockInvoke, resetMockState, setMockLatency } from "./backend";
import { MOCK_VAULT_ROOT } from "./fixtures/vault";
import { MOCK_PROJECTS_ROOT } from "./fixtures/workspace";
import { mockVault } from "./vaultStore";

/** Command names registered in `tauri::generate_handler![…]`. */
function registeredCommands(): string[] {
  const block = /generate_handler!\[([\s\S]*?)\]\)/.exec(libRs)?.[1];
  if (!block) throw new Error("generate_handler! block not found in src-tauri/src/lib.rs");
  const code = block
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return [...code.matchAll(/commands::\w+::(cmd_\w+)/g)].map((m) => m[1]);
}

/** Command names referenced by the typed IPC wrappers. */
function wrapperCommands(): string[] {
  const sources = import.meta.glob("../ipc/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >;
  const names = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const m of source.matchAll(/"(cmd_[a-z0-9_]+)"/g)) names.add(m[1]);
  }
  return [...names];
}

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);
const REPO = `${MOCK_PROJECTS_ROOT}/aether-demo-app`;

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("command coverage", () => {
  it("parses the handler list from lib.rs", () => {
    const commands = registeredCommands();
    expect(commands.length).toBeGreaterThan(100);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("has a mock handler for every command registered in src-tauri/src/lib.rs", () => {
    const missing = registeredCommands().filter((name) => !(name in mockHandlers));
    expect(missing, `add mock handlers in src/lib/mock/ for: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no stale mock handlers for commands that do not exist", () => {
    const registered = new Set(registeredCommands());
    const stale = Object.keys(mockHandlers).filter((name) => !registered.has(name));
    expect(stale, `remove or register: ${stale.join(", ")}`).toEqual([]);
  });

  it("only wraps commands that are registered in lib.rs", () => {
    const registered = new Set(registeredCommands());
    const unknown = wrapperCommands().filter((name) => !registered.has(name));
    expect(unknown, `src/lib/ipc wrappers call unregistered commands: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe("mockInvoke", () => {
  it("rejects unknown commands and handler errors with a string, like Tauri", async () => {
    await expect(invoke("cmd_does_not_exist")).rejects.toMatch(/not found/);
    await expect(invoke("cmd_get_note_content", {})).rejects.toMatch(/missing required key path/);
  });

  it("keeps calls in FIFO order despite random latency", async () => {
    vi.useFakeTimers();
    setMockLatency(5, 40);
    const order: number[] = [];
    const calls = Array.from({ length: 12 }, (_, i) =>
      invoke("cmd_get_vault_path").then(() => order.push(i))
    );
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("returns null for unit results and deep copies values", async () => {
    await expect(invoke("cmd_lsp_stop_all")).resolves.toBeNull();
    const notes = await invoke<VaultNote[]>("cmd_get_vault_notes");
    notes[0].name = "mutated";
    const again = await invoke<VaultNote[]>("cmd_get_vault_notes");
    expect(again[0].name).not.toBe("mutated");
  });
});

describe("mock events", () => {
  it("treats every listen() as its own registration, like Tauri", () => {
    const received: string[] = [];
    const handler = (p: string) => received.push(p);
    const first = mockEvents.listen("demo-event", handler);
    const second = mockEvents.listen("demo-event", handler);
    first();
    mockEvents.emit("demo-event", "still subscribed");
    expect(received).toEqual(["still subscribed"]);
    second();
    expect(mockEvents.listenerCount("demo-event")).toBe(0);
  });
});

describe("mock vault", () => {
  it("serves a realistic seed vault", async () => {
    const notes = await invoke<VaultNote[]>("cmd_get_vault_notes");
    expect(notes.length).toBeGreaterThanOrEqual(25);
    const paths = notes.map((n) => n.path);
    for (const folder of ["00-Inbox", "01-Projects", "03-Resources", "daily"]) {
      expect(paths.some((p) => p.startsWith(`${MOCK_VAULT_ROOT}/${folder}/`))).toBe(true);
    }
    const all = await Promise.all(paths.map((path) => invoke<string>("cmd_get_note_content", { path })));
    const text = all.join("\n");
    expect(text).toContain("```mermaid");
    expect(text).toMatch(/!\[[^\]]*\]\(attachments\//);
    expect(text).toMatch(/^---\n/m);
    expect(text).toMatch(/📅 \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("Zettelkasten");
    expect(Math.max(...all.map((c) => c.length))).toBeGreaterThan(2500);
    const graph = await invoke<GraphData>("cmd_get_vault_graph");
    expect(graph.edges.length).toBeGreaterThan(40);
  });

  it("keeps list, graph, stats and backlinks consistent through create/append/write/delete", async () => {
    const baseStats = await invoke<VaultStats>("cmd_get_vault_stats");
    const baseGraph = await invoke<GraphData>("cmd_get_vault_graph");
    const hub = `${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS.md`;

    const path = await invoke<string>("cmd_create_note", {
      relPath: "00-Inbox/Mock Test",
      content: "# Mock Test\n\nLinks to [[AETHER-OS]] #brandnewtag\n\n- [ ] first task",
    });
    expect(path).toBe(`${MOCK_VAULT_ROOT}/00-Inbox/Mock Test.md`);

    let stats = await invoke<VaultStats>("cmd_get_vault_stats");
    expect(stats.note_count).toBe(baseStats.note_count + 1);
    expect(stats.total_tasks).toBe(baseStats.total_tasks + 1);
    expect(stats.open_tasks).toBe(baseStats.open_tasks + 1);
    expect(stats.total_links).toBe(baseStats.total_links + 1);
    expect(stats.total_tags).toBe(baseStats.total_tags + 1);

    let graph = await invoke<GraphData>("cmd_get_vault_graph");
    expect(graph.nodes).toHaveLength(baseGraph.nodes.length + 1);
    expect(graph.edges).toContainEqual({ source: path, target: hub });
    const backlinks = await invoke<{ note_path: string }[]>("cmd_get_backlinks", { noteName: "aether-os" });
    expect(backlinks.map((b) => b.note_path)).toContain(path);

    await invoke("cmd_append_note", { path, content: "- [x] second task" });
    stats = await invoke<VaultStats>("cmd_get_vault_stats");
    expect(stats.total_tasks).toBe(baseStats.total_tasks + 2);
    expect(stats.open_tasks).toBe(baseStats.open_tasks + 1);

    await invoke("cmd_write_note", { path, content: "# Mock Test\n\nNo links anymore." });
    graph = await invoke<GraphData>("cmd_get_vault_graph");
    expect(graph.edges).not.toContainEqual({ source: path, target: hub });

    expect(mockVault.delete(path)).toBe(true);
    stats = await invoke<VaultStats>("cmd_get_vault_stats");
    expect(stats).toEqual(baseStats);
    graph = await invoke<GraphData>("cmd_get_vault_graph");
    expect(graph.nodes).toHaveLength(baseGraph.nodes.length);
  });

  it("never clobbers on create and rejects unsafe paths", async () => {
    const first = await invoke<string>("cmd_create_note", { relPath: "clips/Article", content: "a" });
    const second = await invoke<string>("cmd_create_note", { relPath: "clips/Article.md", content: "b" });
    expect(second).toBe(first.replace(/\.md$/, " 2.md"));
    await expect(invoke("cmd_create_note", { relPath: "../escape", content: "x" })).rejects.toMatch(/invalid note path/);
    await expect(invoke("cmd_write_note", { path: "/etc/passwd", content: "x" })).rejects.toMatch(/outside vault/);
  });

  it("creates daily notes and appends timestamped bullets", async () => {
    const path = await invoke<string>("cmd_daily_note");
    expect(path).toMatch(new RegExp(`^${MOCK_VAULT_ROOT}/daily/\\d{4}-\\d{2}-\\d{2}\\.md$`));
    const appended = await invoke<string>("cmd_append_daily", { text: "  shipped mock mode " });
    expect(appended).toBe(path);
    const content = await invoke<string>("cmd_get_note_content", { path });
    expect(content).toMatch(/- \*\*\d{2}:\d{2}\*\* — shipped mock mode\n$/);
  });

  it("executes vault agent actions with the backend's status strings", async () => {
    const status = await invoke<string>("cmd_execute_agent_action", {
      action: { action: "create_note", title: "Agent Note", content: "# Hi" },
    });
    expect(status).toBe(`Created note: ${MOCK_VAULT_ROOT}/Agent Note.md`);
    await expect(
      invoke("cmd_execute_agent_action", { action: { action: "open_url", url: "https://example.com" } })
    ).rejects.toMatch(/dedicated commands/);
  });

  it("moves the demo content when the vault path changes", async () => {
    await invoke("cmd_set_vault_path", { path: "/Users/demo/Other Vault" });
    expect(await invoke("cmd_get_vault_path")).toBe("/Users/demo/Other Vault");
    const notes = await invoke<VaultNote[]>("cmd_get_vault_notes");
    expect(notes.every((n) => n.path.startsWith("/Users/demo/Other Vault/"))).toBe(true);
  });
});

describe("mock AI", () => {
  it("ranks semantic search results by relevance", async () => {
    const matches = await invoke<{ id: string; score: number }[]>("cmd_semantic_search", {
      query: "Sauerteig backen",
      limit: 5,
    });
    expect(matches[0].id).toContain("Sauerteigbrot Rezept");
    for (let i = 1; i < matches.length; i++) expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
  });

  it("streams an answer word by word over llm-stream-chunk and resolves when done", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const unlisten = mockEvents.listen<string>("llm-stream-chunk", (c) => chunks.push(c));
    let chunksWhenDone = -1;
    const notePaths = (await invoke<VaultNote[]>("cmd_get_vault_notes")).map((n) => n.path);
    const done = invoke("cmd_agent_query_with_notes", {
      prompt: "Wie ist der Stand meiner Masterarbeit?",
      notePaths,
      model: "qwen2.5:7b",
      provider: "ollama",
    }).then(() => {
      chunksWhenDone = chunks.length;
    });
    await vi.advanceTimersByTimeAsync(95);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunksWhenDone).toBe(-1);
    await vi.runAllTimersAsync();
    await done;
    unlisten();
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunksWhenDone).toBe(chunks.length);
    const answer = chunks.join("");
    expect(answer).toContain("**Kurz gesagt:**");
    expect(answer).toContain("[[Masterarbeit]]");
    expect(answer).toContain("qwen2.5:7b");
  });

  it("emits an action block when the user asks to remember something", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const unlisten = mockEvents.listen<string>("llm-stream-chunk", (c) => chunks.push(c));
    const done = invoke("cmd_agent_query_with_notes", {
      prompt: "Please remember that I prefer dark mode",
      notePaths: [],
      model: "qwen2.5:7b",
    });
    await vi.runAllTimersAsync();
    await done;
    unlisten();
    const block = /```action\n([\s\S]*?)\n```/.exec(chunks.join(""));
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1])).toMatchObject({ action: "add_memory_fact", category: "general" });
  });

  it("indexes the vault in about 1.5 s", async () => {
    vi.useFakeTimers();
    let result: { total: number; indexed: number } | null = null;
    const pending = invoke<{ total: number; indexed: number }>("cmd_index_vault").then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(1400);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(result!.total).toBeGreaterThanOrEqual(25);
    expect(result!.indexed).toBeLessThanOrEqual(result!.total);
  });

  it("reports health and models, and gates OpenRouter on a key", async () => {
    expect(await invoke("cmd_get_health")).toEqual({
      ollama_online: true,
      openrouter_configured: false,
      vault_connected: true,
    });
    expect(await invoke("cmd_list_local_models")).toEqual(["qwen2.5:7b", "llama3.2:1b", "gemma2:2b"]);
    await expect(invoke("cmd_list_cloud_models")).rejects.toMatch(/OpenRouter API key is missing/);
    expect(await invoke("cmd_set_openrouter_key", { key: "sk-or-test" })).toBe(true);
    expect((await invoke<string[]>("cmd_list_cloud_models")).length).toBeGreaterThan(0);
  });
});

describe("mock terminal", () => {
  it("echoes input and runs built-ins, emitting base64 output", async () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const unlisten = mockEvents.listen<TerminalOutputEvent>("terminal-output", (e) => {
      const bytes = Uint8Array.from(atob(e.dataBase64), (c) => c.charCodeAt(0));
      output.push(new TextDecoder().decode(bytes));
    });
    const session = await invoke<{ id: string; alive: boolean }>("cmd_terminal_spawn", { cols: 80, rows: 24 });
    expect(session.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(output.join("")).toContain("demo@aether");

    await invoke("cmd_terminal_write", { id: session.id, data: "cd Developer\r" });
    await invoke("cmd_terminal_write", { id: session.id, data: "pwd\r" });
    await vi.advanceTimersByTimeAsync(20);
    expect(output.join("")).toContain(`${MOCK_PROJECTS_ROOT}\r\n`);

    await invoke("cmd_terminal_kill", { id: session.id });
    await expect(invoke("cmd_terminal_write", { id: session.id, data: "x" })).rejects.toMatch(/not found/);
    unlisten();
  });
});

describe("mock git + IDE", () => {
  const status = () => invoke<RepoStatus>("cmd_git_status", { path: `${REPO}/src` });

  it("reports staged, unstaged and untracked changes", async () => {
    const s = await status();
    expect(s.branch).toBe("main");
    expect(s.entries).toEqual([
      { path: "README.md", staged: "modified", unstaged: null },
      { path: "src/App.tsx", staged: null, unstaged: "modified" },
      { path: "src/utils/format.test.ts", staged: null, unstaged: "added" },
    ]);
  });

  it("stages, commits and logs consistently", async () => {
    await invoke("cmd_git_stage", { path: REPO, files: ["src/App.tsx"] });
    const diff = await invoke<{ old_content: string; new_content: string }>("cmd_git_diff_file", {
      path: REPO,
      file: "src/App.tsx",
      staged: true,
    });
    expect(diff.new_content).toContain("Reset");
    expect(diff.old_content).not.toContain("Reset");

    const id = await invoke<string>("cmd_git_commit", { path: REPO, message: "Add reset button" });
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    const log = await invoke<{ id: string; summary: string }[]>("cmd_git_log", { path: REPO, limit: 3 });
    expect(log[0]).toMatchObject({ id: id.slice(0, 7), summary: "Add reset button" });
    expect((await status()).entries.map((e) => e.path)).toEqual(["src/utils/format.test.ts"]);
    await expect(invoke("cmd_git_commit", { path: REPO, message: "  " })).rejects.toMatch(/must not be empty/);
  });

  it("sees IDE edits as working tree changes and discards them", async () => {
    const file = `${REPO}/src/main.tsx`;
    const original = await invoke<string>("cmd_ide_read_file", { path: file });
    await invoke("cmd_ide_write_file", { path: file, content: `${original}// edited\n` });
    expect((await status()).entries).toContainEqual({ path: "src/main.tsx", staged: null, unstaged: "modified" });
    await invoke("cmd_git_discard", { path: REPO, files: ["src/main.tsx"] });
    expect(await invoke("cmd_ide_read_file", { path: file })).toBe(original);
  });

  it("lists sandboxed directories and rejects escapes", async () => {
    const roots = await invoke<string[]>("cmd_ide_roots");
    expect(roots).toEqual([MOCK_PROJECTS_ROOT, MOCK_VAULT_ROOT]);
    const entries = await invoke<{ name: string; is_dir: boolean }[]>("cmd_ide_list_dir", { path: REPO });
    expect(entries[0]).toMatchObject({ name: "src", is_dir: true });
    await expect(invoke("cmd_ide_read_file", { path: `${REPO}/../../../etc/passwd` })).rejects.toMatch(/outside the allowed/);
    const vaultEntries = await invoke<{ name: string }[]>("cmd_ide_list_dir", { path: MOCK_VAULT_ROOT });
    expect(vaultEntries.map((e) => e.name)).toContain("01-Projects");
  });

  it("switches and creates branches", async () => {
    await invoke("cmd_git_create_branch", { path: REPO, branch: "feature/x" });
    await expect(invoke("cmd_git_create_branch", { path: REPO, branch: "feature/x" })).rejects.toMatch(/already exists/);
    await invoke("cmd_git_switch_branch", { path: REPO, branch: "feature/x" });
    const branches = await invoke<{ name: string; is_current: boolean }[]>("cmd_git_branches", { path: REPO });
    expect(branches[0]).toEqual({ name: "feature/x", is_current: true });
    await expect(invoke("cmd_git_switch_branch", { path: REPO, branch: "nope" })).rejects.toMatch(/no such branch/);
  });

  it("scans four fake projects with git info", async () => {
    const dirs = await invoke<string[]>("cmd_get_project_dirs");
    const projects = await invoke<{ name: string; git_status: string; language: string }[]>("cmd_scan_projects", {
      directories: dirs,
    });
    expect(projects).toHaveLength(4);
    expect(projects.find((p) => p.name === "aether-demo-app")).toMatchObject({
      language: "typescript",
      git_status: "2 modified, 1 untracked",
    });
    expect(await invoke("cmd_scan_projects", { directories: ["/nowhere"] })).toEqual([]);
  });
});

describe("mock calendar, tasks and metrics", () => {
  it("seeds about a dozen events this month and validates CRUD", async () => {
    const events = await invoke<CalendarEvent[]>("cmd_list_calendar_events");
    expect(events.length).toBeGreaterThanOrEqual(10);
    const month = new Date().toISOString().slice(0, 7);
    expect(events.filter((e) => e.start.startsWith(month)).length).toBeGreaterThanOrEqual(10);
    expect([...events].sort((a, b) => a.start.localeCompare(b.start))).toEqual(events);

    const base = {
      title: "Planning",
      description: "",
      allDay: true,
      start: "2026-10-02",
      end: "2026-10-01",
      due: null,
      color: "#3b82f6",
      tags: [],
      attendees: [],
      location: null,
      sourceNotePath: null,
    };
    await expect(invoke("cmd_create_calendar_event", base)).rejects.toMatch(/is before start/);
    await expect(invoke("cmd_create_calendar_event", { ...base, end: "2026-10-02", color: "blue" })).rejects.toMatch(
      /#RRGGBB/
    );
    const created = await invoke<CalendarEvent>("cmd_create_calendar_event", { ...base, end: "2026-10-03" });
    const updated = await invoke<CalendarEvent>("cmd_update_calendar_event", {
      id: created.id,
      patch: { title: "Planning v2", location: "Room 1" },
    });
    expect(updated).toMatchObject({ title: "Planning v2", location: "Room 1", start: "2026-10-02" });

    const ics = await invoke<string>("cmd_export_calendar_ics", { from: null, to: null, calendarName: null });
    expect(ics).toContain("SUMMARY:Planning v2");
    await invoke("cmd_delete_calendar_event", { id: created.id });
    const result = await invoke<{ added: number }>("cmd_import_calendar_ics", {
      content: ics,
      overwriteExisting: false,
      defaultColor: "#10b981",
    });
    expect(result.added).toBe(1);
  });

  it("creates tasks at the end of their column and cascades project deletes", async () => {
    const projects = await invoke<TaskProject[]>("cmd_list_task_projects");
    expect(projects).toHaveLength(3);
    const project = projects[0];
    const before = await invoke<TaskItem[]>("cmd_list_tasks", { projectId: project.id });
    const task = await invoke<TaskItem>("cmd_create_task", {
      projectId: project.id,
      title: "New task",
      description: "",
      status: "todo",
      priority: "high",
      dueDate: null,
      labels: [],
      order: null,
    });
    const maxTodo = Math.max(0, ...before.filter((t) => t.status === "todo").map((t) => t.order));
    expect(task.order).toBe(maxTodo + 1000);
    await expect(
      invoke("cmd_create_task", { ...task, projectId: project.id, title: " ", dueDate: null, order: null })
    ).rejects.toMatch(/title is required/);
    await invoke("cmd_delete_task_project", { id: project.id });
    expect(await invoke("cmd_list_tasks", { projectId: project.id })).toEqual([]);
  });

  it("returns smoothly varying, internally consistent metrics", async () => {
    const a = await invoke<SystemMetrics>("cmd_get_system_metrics");
    const b = await invoke<SystemMetrics>("cmd_get_system_metrics");
    for (const m of [a, b]) {
      expect(m.cpus).toHaveLength(8);
      expect(m.memory.used + m.memory.available).toBe(m.memory.total);
      expect(m.overall_cpu).toBeGreaterThanOrEqual(0);
      expect(m.overall_cpu).toBeLessThanOrEqual(100);
      expect(m.battery?.percent).toBeGreaterThan(0);
      expect(m.processes[0].cpu_usage).toBeGreaterThanOrEqual(m.processes[1].cpu_usage);
    }
    expect(Math.abs(a.overall_cpu - b.overall_cpu)).toBeLessThan(25);
  });
});
