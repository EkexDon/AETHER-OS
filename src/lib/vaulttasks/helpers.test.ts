import { describe, expect, it } from "vitest";
import { addDaysIso, daysBetween, dueUrgency, formatShortDate, relativeDueLabel, toIsoDate } from "./dates";
import {
  applyViewFilters,
  boardColumns,
  collectTags,
  DEFAULT_FILTERS,
  groupByDue,
  groupByNote,
  hasActiveFilters,
  matchesFilter,
  taskKey,
} from "./filters";
import { parseTasks } from "./parser";
import { plainTaskTitle, taskSegments } from "./segments";
import { computeStats } from "./stats";

const TODAY = "2026-09-22";

const WORK = parseTasks(
  "/v/Work.md",
  [
    "## Sprint",
    "- [ ] Write spec 📅 2026-09-25 #work/docs ⏫",
    "- [x] Ship 📅 2026-09-20 #work ✅ 2026-09-21",
    "- [ ] Late review 📅 2026-09-19",
    "- [/] Today thing 📅 2026-09-22",
    "- [ ] Someday",
    "- [-] Dropped",
    "- [ ] Far away 📅 2026-12-01 #Home",
  ].join("\n")
);
const HOME = parseTasks("/v/Home.md", "- [x] Groceries #home\n");
const ALL = [...WORK, ...HOME];

describe("dates", () => {
  it("does day arithmetic across month and year ends", () => {
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysBetween("2026-09-22", "2026-10-02")).toBe(10);
    expect(toIsoDate(new Date(2026, 8, 5))).toBe("2026-09-05");
  });

  it("labels due dates relative to today", () => {
    expect(relativeDueLabel(TODAY, TODAY)).toBe("Today");
    expect(relativeDueLabel("2026-09-23", TODAY)).toBe("Tomorrow");
    expect(relativeDueLabel("2026-09-21", TODAY)).toBe("Yesterday");
    expect(relativeDueLabel("2026-09-19", TODAY)).toBe("3d overdue");
    expect(relativeDueLabel("2026-09-25", TODAY)).toBe("Fri");
    expect(relativeDueLabel("2026-10-30", TODAY)).toBe("Oct 30");
    expect(formatShortDate("2027-01-02", TODAY)).toBe("Jan 2, 2027");
  });

  it("classifies urgency", () => {
    expect(dueUrgency("2026-09-20", TODAY)).toBe("overdue");
    expect(dueUrgency(TODAY, TODAY)).toBe("today");
    expect(dueUrgency("2026-09-25", TODAY)).toBe("soon");
    expect(dueUrgency("2026-09-26", TODAY)).toBe("later");
  });
});

describe("computeStats", () => {
  it("mirrors the Rust counters", () => {
    const stats = computeStats(ALL, TODAY);
    expect(stats).toMatchObject({
      total: 8,
      open: 5,
      in_progress: 1,
      done: 2,
      cancelled: 1,
      overdue: 1,
      due_today: 1,
      due_this_week: 2,
    });
    expect(stats.by_note.map((n) => [n.note_name, n.open])).toEqual([
      ["Work", 5],
      ["Home", 0],
    ]);
  });
});

describe("matchesFilter (backend semantics)", () => {
  const run = (f: Parameters<typeof matchesFilter>[1]) => WORK.filter((t) => matchesFilter(t, f)).map((t) => t.text_clean);

  it("combines status, due bounds, tags, note and query", () => {
    expect(run({ status: "open" })).toHaveLength(5);
    expect(run({ status: "cancelled" })).toEqual(["Dropped"]);
    expect(run({ tag: "#WORK" })).toEqual(["Write spec #work/docs", "Ship #work"]);
    expect(run({ due_before: "2026-09-20" })).toEqual(["Ship #work", "Late review"]);
    expect(run({ due_after: "2026-09-22", due_before: "2026-09-30" })).toEqual(["Write spec #work/docs", "Today thing"]);
    expect(run({ query: "sprint LATE" })).toEqual(["Late review"]);
    expect(run({ note_path: "/v/Other.md" })).toEqual([]);
  });
});

describe("view filters and grouping", () => {
  it("hides completed tasks unless asked", () => {
    expect(applyViewFilters(ALL, DEFAULT_FILTERS, TODAY)).toHaveLength(5);
    expect(applyViewFilters(ALL, { ...DEFAULT_FILTERS, showCompleted: true }, TODAY)).toHaveLength(8);
    expect(applyViewFilters(ALL, DEFAULT_FILTERS, TODAY, true)).toHaveLength(8);
  });

  it("filters by due window, priority and tag", () => {
    const f = (patch: Partial<typeof DEFAULT_FILTERS>) =>
      applyViewFilters(ALL, { ...DEFAULT_FILTERS, showCompleted: true, ...patch }, TODAY).map((t) => t.text_clean);
    expect(f({ due: "today" })).toEqual(["Today thing"]);
    expect(f({ due: "week" })).toEqual(["Write spec #work/docs", "Today thing"]);
    expect(f({ due: "overdue" })).toEqual(["Late review"]);
    expect(f({ due: "none" })).toEqual(["Someday", "Dropped", "Groceries #home"]);
    expect(f({ priority: "high" })).toEqual(["Write spec #work/docs"]);
    expect(f({ tag: "home" })).toEqual(["Far away #Home", "Groceries #home"]);
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, tag: "x" })).toBe(true);
  });

  it("groups open tasks by due bucket and completed ones last", () => {
    const groups = groupByDue(ALL, TODAY);
    expect(groups.map((g) => [g.id, g.tasks.map((t) => t.text_clean)])).toEqual([
      ["overdue", ["Late review"]],
      ["today", ["Today thing"]],
      ["week", ["Write spec #work/docs"]],
      ["later", ["Far away #Home"]],
      ["none", ["Someday"]],
      ["completed", ["Ship #work", "Groceries #home", "Dropped"]],
    ]);
  });

  it("groups by note with progress", () => {
    const groups = groupByNote(ALL, TODAY);
    expect(groups.map((g) => g.noteName)).toEqual(["Work", "Home"]);
    expect(groups[0]).toMatchObject({ total: 7, open: 5, done: 1, overdue: 1 });
    expect(groups[0].progress).toBeCloseTo(1 / 6);
    expect(groups[1].progress).toBe(1);
  });

  it("builds board columns", () => {
    const cols = boardColumns(ALL);
    expect(cols.todo.map((t) => t.text_clean)).toEqual([
      "Late review",
      "Write spec #work/docs",
      "Far away #Home",
      "Someday",
    ]);
    expect(cols.in_progress).toHaveLength(1);
    expect(cols.done.map((t) => t.text_clean)).toEqual(["Ship #work", "Groceries #home"]);
    expect(cols.cancelled).toHaveLength(1);
  });

  it("collects tags case-insensitively and keys tasks by location", () => {
    expect(collectTags(ALL)).toEqual(["Home", "work", "work/docs"]);
    expect(taskKey(WORK[0])).toBe("/v/Work.md\u00001");
  });
});

describe("taskSegments", () => {
  it("splits code, wikilinks, links and tags", () => {
    expect(taskSegments("Read [[Book|the book]] and [[Note#Part]] `x #no` [site](https://a.b) (#tag) #42 end")).toEqual([
      { kind: "text", text: "Read " },
      { kind: "wikilink", target: "Book", label: "the book" },
      { kind: "text", text: " and " },
      { kind: "wikilink", target: "Note", label: "Note › Part" },
      { kind: "text", text: " " },
      { kind: "code", text: "x #no" },
      { kind: "text", text: " " },
      { kind: "link", label: "site", url: "https://a.b" },
      { kind: "text", text: " (" },
      { kind: "tag", tag: "tag" },
      { kind: "text", text: ") #42 end" },
    ]);
    expect(taskSegments("#first word")).toEqual([
      { kind: "tag", tag: "first" },
      { kind: "text", text: " word" },
    ]);
  });
});

describe("plainTaskTitle", () => {
  it("flattens links and drops tags", () => {
    expect(plainTaskTitle("Call [[Umzug Berlin|the movers]] about `boxes` #umzug (#home)")).toBe("Call the movers about boxes");
    expect(plainTaskTitle("#only")).toBe("");
  });
});
