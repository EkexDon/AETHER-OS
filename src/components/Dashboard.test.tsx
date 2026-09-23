import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CalendarEvent, FocusStats, TaskItem, TaskProject } from "../types";
import { toLocalRfc3339 } from "../lib/home/format";
import { dateKey, shiftDateKey } from "../lib/home/focusStats";

const now = new Date();
const today = dateKey(now);
const at = (h: number, m = 0, dayOffset = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return toLocalRfc3339(d.getTime());
};

const event = (id: string, title: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  uid: id,
  title,
  description: "",
  all_day: false,
  start,
  end,
  due: null,
  color: "#3fb0a3",
  tags: [],
  attendees: [],
  location: null,
  source_note_path: null,
  created_at: "",
  updated_at: "",
  ...extra,
});

const project: TaskProject = { id: "p1", name: "Launch", description: "", color: "#e27a4e", created_at: "", updated_at: "" };
const task = (id: string, title: string, due: string | null, status: TaskItem["status"] = "todo"): TaskItem => ({
  id,
  project_id: "p1",
  title,
  description: "",
  status,
  priority: "high",
  due_date: due,
  labels: [],
  order: 0,
  created_at: "",
  updated_at: "",
});

const stats: FocusStats = {
  today_minutes: 50,
  today_sessions: 2,
  streak_days: 4,
  total_minutes: 200,
  by_day: Array.from({ length: 7 }, (_, i) => ({ date: shiftDateKey(today, i - 6), minutes: i * 10, sessions: i })),
};

const ipc = vi.hoisted(() => ({
  listCalendarEvents: vi.fn(),
  listTaskProjects: vi.fn(),
  listTasks: vi.fn(),
  getRecentConversations: vi.fn(),
  focusStats: vi.fn(),
  getProjectDirs: vi.fn(),
  scanProjects: vi.fn(),
  getVaultNotes: vi.fn(),
  getVaultStats: vi.fn(),
  indexVault: vi.fn(),
  updateTask: vi.fn(),
  dailyNote: vi.fn(),
  appendDaily: vi.fn(),
  call: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

import { Dashboard } from "./Dashboard";
import { useAetherStore } from "../lib/store";
import { useHomeStore } from "../lib/homeStore";
import { usePinsStore, defaultPinGroups } from "../lib/pinsStore";
import { useFocusStore } from "../lib/focusStore";
import { initialTimer, DEFAULT_POMODORO_SETTINGS } from "../lib/home/pomodoro";
import { useShellStore } from "../shell/shellStore";

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  ipc.listCalendarEvents.mockResolvedValue([
    event("e1", "Standup", at(9), at(9, 15)),
    event("e2", "Design review", at(14), at(15), { location: "Room 2" }),
    event("e3", "Dentist", at(10, 0, 1), at(11, 0, 1)),
  ]);
  ipc.listTaskProjects.mockResolvedValue([project]);
  ipc.listTasks.mockResolvedValue([
    task("t1", "Write release notes", today),
    task("t2", "Fix login bug", shiftDateKey(today, -3)),
    task("t3", "Future work", shiftDateKey(today, 5)),
    task("t4", "Already done", today, "done"),
  ]);
  ipc.getRecentConversations.mockResolvedValue([
    { id: "c1", timestamp: Math.floor(Date.now() / 1000) - 600, messages: [{ role: "user", content: "Plan my week" }], context_notes: [], summary: "" },
  ]);
  ipc.focusStats.mockResolvedValue(stats);
  ipc.getProjectDirs.mockResolvedValue([]);
  ipc.scanProjects.mockResolvedValue([]);
  ipc.getVaultNotes.mockResolvedValue([]);
  ipc.getVaultStats.mockResolvedValue({ note_count: 3, total_tasks: 9, open_tasks: 4, total_cards: 0, total_tags: 7, total_links: 12 });
  ipc.call.mockRejectedValue(new Error("[mock] command cmd_vault_tasks_list not found"));
  ipc.dailyNote.mockResolvedValue(`/vault/daily/${today}.md`);
  ipc.appendDaily.mockResolvedValue(`/vault/daily/${today}.md`);
  ipc.updateTask.mockImplementation(async (id: string) => ({ ...task(id, "Write release notes", today), status: "done" }));

  useAetherStore.setState({
    view: "dashboard",
    vaultPath: "/vault/Second-Brain",
    vaultNotes: [
      { path: "/vault/Second-Brain/Projects/Roadmap.md", name: "Roadmap", mtime: Math.floor(Date.now() / 1000) - 120 },
      { path: "/vault/Second-Brain/Inbox.md", name: "Inbox", mtime: Math.floor(Date.now() / 1000) - 7200 },
    ],
    vaultStats: { note_count: 2, total_tasks: 9, open_tasks: 4, total_cards: 0, total_tags: 7, total_links: 12 },
    projects: [],
    calendarEvents: [],
    selectedNotePath: null,
    indexing: false,
  });
  useHomeStore.setState({ boardTasks: [], taskProjects: [], noteTasks: null, conversations: [], focusStats: null, errors: {}, loading: {}, lastIndex: null, pinsDrawerOpen: false });
  usePinsStore.setState({ groups: defaultPinGroups() });
  useFocusStore.setState({ settings: { ...DEFAULT_POMODORO_SETTINGS }, timer: initialTimer(), focusMode: false, statsVersion: 0 });
  useShellStore.setState({ newNoteOpen: false, launcherOpen: false, settingsOpen: false });
});

describe("Home dashboard", () => {
  it("greets, shows the date and vault, and renders every block", async () => {
    render(<Dashboard />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Good (night|morning|afternoon|evening)$/);
    expect(screen.getByText(/Second-Brain$/)).toBeInTheDocument();
    for (const name of ["Today", "Focus", "Continue", "Pinned", "Vault"]) {
      expect(screen.getByRole("region", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(await screen.findByText("Standup")).toBeInTheDocument();
  });

  it("lists today's and tomorrow's events", async () => {
    render(<Dashboard />);
    const schedule = await screen.findByRole("region", { name: "Schedule" });
    expect(within(schedule).getByText("Standup")).toBeInTheDocument();
    expect(within(schedule).getByText("09:00 – 09:15")).toBeInTheDocument();
    expect(within(schedule).getByText("Room 2")).toBeInTheDocument();
    expect(within(schedule).getByText("Tomorrow")).toBeInTheDocument();
    expect(within(schedule).getByText("Dentist")).toBeInTheDocument();
  });

  it("shows open board tasks due today or overdue and completes them", async () => {
    render(<Dashboard />);
    const due = await screen.findByRole("region", { name: "Due" });
    await within(due).findByText("Fix login bug");
    expect(within(due).getByText("Write release notes")).toBeInTheDocument();
    expect(within(due).queryByText("Future work")).not.toBeInTheDocument();
    expect(within(due).queryByText("Already done")).not.toBeInTheDocument();
    expect(within(due).getByText("3d overdue")).toBeInTheDocument();
    fireEvent.click(within(due).getByRole("checkbox", { name: "Complete Write release notes" }));
    await waitFor(() => expect(ipc.updateTask).toHaveBeenCalledWith("t1", { status: "done" }));
    await waitFor(() => expect(within(due).queryByText("Write release notes")).not.toBeInTheDocument());
  });

  it("tolerates the missing vaulttasks feature", async () => {
    render(<Dashboard />);
    await screen.findByText("Fix login bug");
    expect(ipc.call).toHaveBeenCalledWith("cmd_vault_tasks_list", { filter: { due_before: today } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("creates and opens today's daily note", async () => {
    render(<Dashboard />);
    const row = screen.getByText(`${today} · not created yet`);
    expect(row).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(useAetherStore.getState().view).toBe("editor"));
    expect(ipc.dailyNote).toHaveBeenCalled();
    expect(useAetherStore.getState().selectedNotePath).toBe(`/vault/daily/${today}.md`);
  });

  it("appends a line to the daily note", async () => {
    render(<Dashboard />);
    const input = screen.getByRole("textbox", { name: "Add a line to today's daily note" });
    fireEvent.change(input, { target: { value: "Call the bank" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(ipc.appendDaily).toHaveBeenCalledWith("Call the bank"));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("continues with recent notes and chats, and pins from the list", async () => {
    render(<Dashboard />);
    const cont = screen.getByRole("region", { name: /^Continue/ });
    const rows = within(cont).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Roadmap");
    expect(rows[0]).toHaveTextContent("Projects");
    fireEvent.click(within(cont).getByRole("button", { name: "Pin Roadmap" }));
    expect(usePinsStore.getState().groups[0].items[0]).toMatchObject({ kind: "note", label: "Roadmap" });
    const pinned = screen.getByRole("region", { name: /^Pinned/ });
    expect(within(pinned).getByText("Roadmap")).toBeInTheDocument();

    fireEvent.click(within(cont).getByRole("radio", { name: "Chats" }));
    fireEvent.click(await within(cont).findByText("Plan my week"));
    expect(useAetherStore.getState().chatOpen).toBe(true);
  });

  it("opens a recent note in the editor", () => {
    render(<Dashboard />);
    fireEvent.click(screen.getByText("Inbox"));
    expect(useAetherStore.getState().selectedNotePath).toBe("/vault/Second-Brain/Inbox.md");
    expect(useAetherStore.getState().view).toBe("editor");
  });

  it("shows focus statistics and starts a Pomodoro", async () => {
    render(<Dashboard />);
    const focus = screen.getByRole("region", { name: /^Focus/ });
    await within(focus).findByText("50m");
    expect(within(focus).getByText("4 days")).toBeInTheDocument();
    expect(within(focus).getByRole("img", { name: /Focus minutes, last 7 days/ })).toBeInTheDocument();
    fireEvent.click(within(focus).getByRole("button", { name: "Start focus" }));
    expect(useFocusStore.getState().timer).toMatchObject({ phase: "work", status: "running" });
    expect(within(focus).getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("shows vault tiles and indexes the vault, remembering the run", async () => {
    ipc.indexVault.mockResolvedValue({ total: 2, indexed: 2, skipped: 0 });
    render(<Dashboard />);
    const vault = screen.getByRole("region", { name: /^Vault/ });
    expect(within(vault).getByText("Links")).toBeInTheDocument();
    expect(within(vault).getByText("12")).toBeInTheDocument();
    fireEvent.click(within(vault).getByRole("button", { name: "Index vault for AI" }));
    await within(vault).findByText(/Indexed just now · 2 of 2 embedded/);
    expect(JSON.parse(window.localStorage.getItem("aether-home-last-index") ?? "{}")).toMatchObject({ result: { indexed: 2 } });
  });

  it("shows empty states without a vault or data", async () => {
    ipc.listCalendarEvents.mockResolvedValue([]);
    ipc.listTasks.mockResolvedValue([]);
    ipc.getRecentConversations.mockResolvedValue([]);
    ipc.focusStats.mockResolvedValue({ ...stats, today_minutes: 0, today_sessions: 0, streak_days: 0, total_minutes: 0, by_day: stats.by_day.map((d) => ({ ...d, minutes: 0, sessions: 0 })) });
    useAetherStore.setState({ vaultPath: null, vaultNotes: [], vaultStats: null });
    render(<Dashboard />);
    expect(await screen.findByText("No events today")).toBeInTheDocument();
    expect(screen.getByText("Nothing due")).toBeInTheDocument();
    expect(screen.getAllByText("No vault connected").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Nothing pinned yet")).toBeInTheDocument();
    expect(await screen.findByText("No focus sessions this week")).toBeInTheDocument();
  });

  it("reports a failing source inline without breaking other blocks", async () => {
    ipc.listCalendarEvents.mockRejectedValue(new Error("calendar store unreadable"));
    render(<Dashboard />);
    expect(await screen.findByText("calendar store unreadable")).toBeInTheDocument();
    expect(await screen.findByText("Fix login bug")).toBeInTheDocument();
  });

  it("opens the new-note dialog from the quick actions", () => {
    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(useShellStore.getState().newNoteOpen).toBe(true);
  });
});
