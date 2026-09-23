import { describe, expect, it } from "vitest";
import type { CalendarEvent, Conversation, Project, TaskItem, TaskProject, VaultNote } from "../../types";
import { agendaFor, eventOccursOn, eventTimeLabel, isEventNow, isEventPast } from "./agenda";
import { boardTasksDue, dueLabel, noteTasksDue, parseNoteTasks } from "./dueTasks";
import { conversationTitle, gitStatusLabel, gitStatusTone, recentConversations, recentNotes, recentProjects } from "./recent";
import { toLocalRfc3339 } from "./format";

const local = (y: number, m: number, d: number, h = 0, min = 0) => toLocalRfc3339(new Date(y, m - 1, d, h, min).getTime());

function event(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: partial.id ?? partial.title ?? "e",
    uid: "uid",
    title: "Event",
    description: "",
    all_day: false,
    start: local(2026, 9, 22, 9),
    end: local(2026, 9, 22, 10),
    due: null,
    color: "#3fb0a3",
    tags: [],
    attendees: [],
    location: null,
    source_note_path: null,
    created_at: "",
    updated_at: "",
    ...partial,
  };
}

describe("agenda", () => {
  it("matches all-day events with an exclusive end", () => {
    const single = event({ all_day: true, start: "2026-09-22", end: "2026-09-22" });
    const multi = event({ all_day: true, start: "2026-09-21", end: "2026-09-23" });
    expect(eventOccursOn(single, "2026-09-22")).toBe(true);
    expect(eventOccursOn(single, "2026-09-23")).toBe(false);
    expect(eventOccursOn(multi, "2026-09-22")).toBe(true);
    expect(eventOccursOn(multi, "2026-09-23")).toBe(false);
  });

  it("matches timed events on every local day they touch", () => {
    const overnight = event({ start: local(2026, 9, 21, 22), end: local(2026, 9, 22, 1) });
    expect(eventOccursOn(overnight, "2026-09-21")).toBe(true);
    expect(eventOccursOn(overnight, "2026-09-22")).toBe(true);
    expect(eventOccursOn(overnight, "2026-09-23")).toBe(false);
    expect(eventOccursOn(event({ start: "garbage", end: "garbage" }), "2026-09-22")).toBe(false);
    expect(eventTimeLabel(overnight, "2026-09-21")).toBe("from 22:00");
    expect(eventTimeLabel(overnight, "2026-09-22")).toBe("until 01:00");
  });

  it("sorts all-day first, then by start", () => {
    const list = agendaFor(
      [
        event({ id: "late", title: "Late", start: local(2026, 9, 22, 16), end: local(2026, 9, 22, 17) }),
        event({ id: "day", title: "Holiday", all_day: true, start: "2026-09-22", end: "2026-09-22" }),
        event({ id: "early", title: "Early", start: local(2026, 9, 22, 8, 30), end: local(2026, 9, 22, 9) }),
        event({ id: "other", title: "Tomorrow", start: local(2026, 9, 23, 8), end: local(2026, 9, 23, 9) }),
      ],
      "2026-09-22"
    );
    expect(list.map((e) => e.id)).toEqual(["day", "early", "late"]);
    expect(eventTimeLabel(list[0], "2026-09-22")).toBe("All day");
    expect(eventTimeLabel(list[1], "2026-09-22")).toBe("08:30 – 09:00");
  });

  it("knows ongoing and past events", () => {
    const e = event({});
    expect(isEventNow(e, new Date(2026, 8, 22, 9, 30))).toBe(true);
    expect(isEventNow(e, new Date(2026, 8, 22, 10, 0))).toBe(false);
    expect(isEventPast(e, new Date(2026, 8, 22, 10, 0))).toBe(true);
    expect(isEventPast(event({ all_day: true }), new Date(2030, 0, 1))).toBe(false);
  });
});

function task(partial: Partial<TaskItem>): TaskItem {
  return {
    id: partial.id ?? "t",
    project_id: "p1",
    title: partial.id ?? "Task",
    description: "",
    status: "todo",
    priority: "none",
    due_date: null,
    labels: [],
    order: 0,
    created_at: "",
    updated_at: "",
    ...partial,
  };
}

const projects: TaskProject[] = [
  { id: "p1", name: "Alpha", description: "", color: "#10b981", created_at: "", updated_at: "" },
];

describe("due tasks", () => {
  it("selects open board tasks due today or earlier", () => {
    const due = boardTasksDue(
      [
        task({ id: "today-low", due_date: "2026-09-22", priority: "low" }),
        task({ id: "today-urgent", due_date: "2026-09-22", priority: "urgent" }),
        task({ id: "overdue", due_date: "2026-09-18T00:00:00Z" }),
        task({ id: "done", due_date: "2026-09-20", status: "done" }),
        task({ id: "future", due_date: "2026-09-23" }),
        task({ id: "undated" }),
        task({ id: "orphan", due_date: "2026-09-22", project_id: "gone" }),
      ],
      projects,
      "2026-09-22"
    );
    expect(due.map((d) => d.task.id)).toEqual(["overdue", "today-urgent", "today-low", "orphan"]);
    expect(due[0]).toMatchObject({ due: "2026-09-18", projectName: "Alpha", projectColor: "#10b981" });
    expect(due[3]).toMatchObject({ projectName: "Tasks", projectColor: null });
  });

  it("parses note tasks defensively and filters due ones", () => {
    const parsed = parseNoteTasks([
      { id: "a", note_path: "/v/daily/2026-09-22.md", note_name: "2026-09-22", line: 3, text_clean: "Ship it", checked: false, due: "2026-09-22", priority: "high" },
      { note_path: "/v/Projects/Plan.md", line: 7, text_raw: "- [ ] Review", checked: false, due: "2026-09-20", priority: "weird" },
      { note_path: "/v/a.md", text_clean: "Done", checked: true, due: "2026-09-01" },
      { note_path: "/v/b.md", text_clean: "Later", checked: false, due: "2026-10-01" },
      { note_path: "/v/c.md", text_clean: "No date", checked: false, due: null },
      { text_clean: "no path" },
      "junk",
      null,
    ]);
    expect(parsed).toHaveLength(5);
    expect(parsed[1]).toMatchObject({ id: "/v/Projects/Plan.md:7", noteName: "Plan", priority: "none", text: "- [ ] Review" });
    expect(noteTasksDue(parsed, "2026-09-22").map((t) => t.text)).toEqual(["- [ ] Review", "Ship it"]);
    expect(parseNoteTasks({ not: "an array" })).toEqual([]);
  });

  it("labels due dates", () => {
    expect(dueLabel("2026-09-22", "2026-09-22")).toEqual({ label: "Today", tone: "warning" });
    expect(dueLabel("2026-09-21", "2026-09-22")).toEqual({ label: "Yesterday", tone: "danger" });
    expect(dueLabel("2026-09-12", "2026-09-22")).toEqual({ label: "10d overdue", tone: "danger" });
    expect(dueLabel("2026-09-23", "2026-09-22")).toEqual({ label: "Tomorrow", tone: "neutral" });
  });
});

describe("recent", () => {
  it("orders notes by mtime", () => {
    const notes: VaultNote[] = [
      { path: "/v/a.md", name: "a", mtime: 10 },
      { path: "/v/b.md", name: "b", mtime: 30 },
      { path: "/v/c.md", name: "c", mtime: 20 },
    ];
    expect(recentNotes(notes, 2).map((n) => n.name)).toEqual(["b", "c"]);
    expect(notes[0].name).toBe("a");
  });

  it("orders projects by last commit and describes git status", () => {
    const p = (name: string, date: number | null, status: string | null): Project => ({
      name,
      path: `/dev/${name}`,
      git_branch: "main",
      git_status: status,
      last_commit_msg: null,
      last_commit_date: date,
      language: "TypeScript",
    });
    expect(recentProjects([p("old", 1, "clean"), p("none", null, null), p("new", 9, "2 modified, 1 untracked")], 5).map((x) => x.name)).toEqual([
      "new",
      "old",
      "none",
    ]);
    expect(gitStatusLabel("2 modified, 1 untracked")).toBe("3 changed");
    expect(gitStatusLabel("clean")).toBe("clean");
    expect(gitStatusLabel(null)).toBe("no git");
    expect(gitStatusTone("clean")).toBe("success");
    expect(gitStatusTone("1 modified")).toBe("warning");
    expect(gitStatusTone(null)).toBe("neutral");
  });

  it("titles conversations", () => {
    const conv = (summary: string, content: string): Conversation => ({
      id: summary || content,
      timestamp: summary.length,
      messages: content ? [{ role: "user", content }] : [],
      context_notes: [],
      summary,
    });
    expect(conversationTitle(conv("Weekly plan", "hi"))).toBe("Weekly plan");
    expect(conversationTitle(conv("", "  What   is\nnew? "))).toBe("What is new?");
    expect(conversationTitle(conv("", ""))).toBe("Conversation");
    expect(conversationTitle(conv("x".repeat(100), ""), 10)).toBe("xxxxxxxxx…");
    expect(recentConversations([conv("a", ""), conv("bbb", "")], 1)[0].summary).toBe("bbb");
  });
});
