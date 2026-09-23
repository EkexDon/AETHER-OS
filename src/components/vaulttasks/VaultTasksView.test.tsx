import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { VaultTaskItem } from "../../types";
import { addDaysIso, todayIso } from "../../lib/vaulttasks/dates";
import { appendTaskToContent, applyDue, applyPriority, applyStatus } from "../../lib/vaulttasks/edit";
import { parseTasks } from "../../lib/vaulttasks/parser";

/** A tiny stateful backend on top of the real parser and line edits. */
const notes = new Map<string, string>();
const all = () => [...notes].flatMap(([path, content]) => parseTasks(path, content));
const edit = (path: string, line: number, next: string) => {
  notes.set(path, next);
  return parseTasks(path, next).find((t) => t.line === line)!;
};

vi.mock("../../lib/ipc", () => ({
  isDesktopRuntime: () => true,
  listVaultTasks: vi.fn(async () => all()),
  rescanVaultTasks: vi.fn(async () => all()),
  getVaultTaskStats: vi.fn(),
  toggleVaultTask: vi.fn(async (t: VaultTaskItem, checked: boolean) =>
    edit(t.note_path, t.line, applyStatus(notes.get(t.note_path)!, t.note_path, t.line, t.text_raw, checked ? "done" : "todo", todayIso()))
  ),
  setVaultTaskStatus: vi.fn(async (t: VaultTaskItem, status: VaultTaskItem["status"]) =>
    edit(t.note_path, t.line, applyStatus(notes.get(t.note_path)!, t.note_path, t.line, t.text_raw, status, todayIso()))
  ),
  setVaultTaskDue: vi.fn(async (t: VaultTaskItem, due: string | null) =>
    edit(t.note_path, t.line, applyDue(notes.get(t.note_path)!, t.note_path, t.line, t.text_raw, due))
  ),
  setVaultTaskPriority: vi.fn(async (t: VaultTaskItem, p: VaultTaskItem["priority"]) =>
    edit(t.note_path, t.line, applyPriority(notes.get(t.note_path)!, t.note_path, t.line, t.text_raw, p))
  ),
  appendVaultTask: vi.fn(async (path: string, text: string) => {
    const { content, line } = appendTaskToContent(notes.get(path) ?? "", text);
    return edit(path, line, content);
  }),
  dailyNote: vi.fn(async () => {
    const path = `/vault/daily/${todayIso()}.md`;
    if (!notes.has(path)) notes.set(path, `# ${todayIso()}\n\n`);
    return path;
  }),
  listTaskProjects: vi.fn(async () => [
    { id: "p1", name: "AETHER", description: "", color: "#3b82f6", icon: null, created_at: "", updated_at: "" },
  ]),
  createTask: vi.fn(async () => ({})),
}));

import * as ipc from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { useVaultTasksStore } from "../../lib/vaultTasksStore";
import { ToastProvider } from "../../ui";
import { VaultTasksView } from "./VaultTasksView";
import { VaultTasksQuickAddHost, VaultTasksStatusItem } from "./VaultTasksStatusItem";
import { DRAG_TYPE } from "./BoardView";

const mocked = vi.mocked(ipc);
const today = todayIso();
const WORK = "/vault/Work.md";

function seed() {
  notes.clear();
  notes.set(
    WORK,
    [
      "## Sprint",
      `- [ ] Write the spec 📅 ${today} #work`,
      `- [ ] Review [[Design Doc]] 📅 ${addDaysIso(today, -2)}`,
      `- [/] Build the board 📅 ${addDaysIso(today, 3)} ⏫`,
      "- [x] Ship v1",
      "- [ ] Someday idea",
      "",
    ].join("\n")
  );
}

function renderView() {
  return render(
    <ToastProvider>
      <VaultTasksView />
    </ToastProvider>
  );
}

function fakeDataTransfer() {
  const data = new Map<string, string>();
  return {
    data,
    effectAllowed: "all",
    dropEffect: "none",
    get types() {
      return [...data.keys()];
    },
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  window.localStorage.removeItem("aether-vaulttasks-prefs");
  useAetherStore.setState({ vaultPath: "/vault", view: "vaulttasks", vaultNotes: [] });
  useVaultTasksStore.setState({
    tasks: [],
    loaded: false,
    loading: false,
    error: null,
    stats: null,
    pending: {},
    mode: "list",
    query: "",
    due: "all",
    priority: "all",
    tag: null,
    showCompleted: false,
    quickAddOpen: false,
    quickAddHosts: 0,
    collapsedNotes: {},
  });
});

describe("VaultTasksView", () => {
  it("lists open tasks grouped by due date with stats", async () => {
    renderView();
    expect(await screen.findByText("Write the spec")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Overdue/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Today/ })).toBeInTheDocument();
    expect(screen.getByText("4 open")).toBeInTheDocument();
    expect(screen.getByText("1 due today")).toBeInTheDocument();
    expect(screen.getByText("1 overdue")).toBeInTheDocument();
    // Completed tasks stay hidden until requested.
    expect(screen.queryByText("Ship v1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Show completed" }));
    expect(await screen.findByText("Ship v1")).toBeInTheDocument();
  });

  it("toggles a checkbox and writes the note", async () => {
    renderView();
    const box = await screen.findByRole("checkbox", { name: /Complete "Write the spec/ });
    fireEvent.click(box);
    await waitFor(() => expect(notes.get(WORK)).toContain(`- [x] Write the spec 📅 ${today} #work ✅ ${today}`));
    expect(mocked.toggleVaultTask).toHaveBeenCalledTimes(1);
  });

  it("filters by search and offers to clear", async () => {
    renderView();
    await screen.findByText("Write the spec");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "zzz" } });
    expect(await screen.findByText("No tasks match these filters")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Write the spec")).toBeInTheDocument();
  });

  it("moves tasks between board columns by drag and drop", async () => {
    useVaultTasksStore.setState({ mode: "board" });
    renderView();
    const card = (await screen.findByText("Someday idea")).closest("article")!;
    const columns = screen.getAllByRole("listitem");
    expect(columns.map((c) => c.getAttribute("data-status"))).toEqual(["todo", "in_progress", "done", "cancelled"]);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    expect(dataTransfer.data.get(DRAG_TYPE)).toBe(`${WORK}\u00005`);
    fireEvent.dragOver(columns[3], { dataTransfer });
    fireEvent.drop(columns[3], { dataTransfer });
    await waitFor(() => expect(notes.get(WORK)).toContain("- [-] Someday idea"));
    expect(mocked.setVaultTaskStatus).toHaveBeenCalledWith(expect.objectContaining({ line: 5 }), "cancelled");
    await waitFor(() => expect(within(columns[3]).getByText("Someday idea")).toBeInTheDocument());
  });

  it("groups by note with progress", async () => {
    useVaultTasksStore.setState({ mode: "notes", showCompleted: true });
    renderView();
    const toggle = await screen.findByRole("button", { name: /^Work/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("progressbar", { name: "Work progress" })).toHaveAttribute("aria-valuenow", "20");
    fireEvent.click(toggle);
    expect(screen.queryByText("Someday idea")).not.toBeInTheDocument();
  });

  it("adds a task to today's daily note", async () => {
    renderView();
    await screen.findByText("Write the spec");
    fireEvent.change(screen.getByRole("textbox", { name: "New task for today's daily note" }), {
      target: { value: "Water the plants" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocked.appendVaultTask).toHaveBeenCalledWith(`/vault/daily/${today}.md`, "Water the plants"));
    const list = document.querySelector(".vt-list") as HTMLElement;
    expect(await within(list).findByText("Water the plants")).toBeInTheDocument();
    expect(await screen.findByText("Task added to today's daily note")).toBeInTheDocument();
  });

  it("changes the priority from the details popover", async () => {
    renderView();
    await screen.findByText("Someday idea");
    const row = screen.getByText("Someday idea").closest(".vt-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Task details" }));
    const dialog = await screen.findByRole("dialog", { name: "Task details" });
    fireEvent.change(within(dialog).getByLabelText("Priority"), { target: { value: "urgent" } });
    await waitFor(() => expect(notes.get(WORK)).toContain("- [ ] Someday idea 🔺"));
    expect(await within(dialog).findByText("AETHER")).toBeInTheDocument();
  });

  it("asks for a vault when none is connected", () => {
    useAetherStore.setState({ vaultPath: null });
    renderView();
    expect(screen.getByText("No vault connected")).toBeInTheDocument();
    expect(mocked.listVaultTasks).not.toHaveBeenCalled();
  });
});

describe("status bar item", () => {
  it("shows tasks due today and opens the view", async () => {
    useAetherStore.setState({ view: "dashboard" });
    mocked.getVaultTaskStats.mockResolvedValue({
      total: 5,
      open: 4,
      in_progress: 1,
      done: 1,
      cancelled: 0,
      overdue: 1,
      due_today: 3,
      due_this_week: 3,
      by_note: [],
    });
    render(<VaultTasksStatusItem />);
    const chip = await screen.findByRole("button", { name: /3 due today/ });
    expect(chip).toHaveTextContent("+1 overdue");
    fireEvent.click(chip);
    expect(useAetherStore.getState().view).toBe("vaulttasks");
    expect(useVaultTasksStore.getState().due).toBe("today");
  });

  it("hosts the quick-add dialog", async () => {
    render(
      <ToastProvider>
        <VaultTasksQuickAddHost />
      </ToastProvider>
    );
    expect(useVaultTasksStore.getState().quickAddHosts).toBe(1);
    act(() => {
      useVaultTasksStore.getState().openQuickAdd();
    });
    const dialog = await screen.findByRole("dialog", { name: "Add task to daily note" });
    fireEvent.change(within(dialog).getByLabelText("Task"), { target: { value: "Pay rent" } });
    fireEvent.change(within(dialog).getByLabelText("Priority"), { target: { value: "high" } });
    fireEvent.keyDown(within(dialog).getByLabelText("Task"), { key: "Enter" });
    await waitFor(() => expect(mocked.appendVaultTask).toHaveBeenCalledWith(`/vault/daily/${today}.md`, "Pay rent ⏫"));
    await waitFor(() => expect(useVaultTasksStore.getState().quickAddOpen).toBe(false));
  });
});
