import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({
  isDesktopRuntime: () => false,
  listCalendarEvents: vi.fn().mockResolvedValue([]),
  deleteCalendarEvent: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  exportCalendarIcs: vi.fn(),
  importCalendarIcs: vi.fn(),
  readIcsFromPath: vi.fn(),
  writeIcsToPath: vi.fn(),
  getReminderSettings: vi.fn(),
  setReminderSettings: vi.fn(),
  requestNotificationPermission: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  requestPermission: vi.fn().mockResolvedValue("denied"),
}));

import { render, screen } from "@testing-library/react";
import {
  Calendar,
  eventsForDay,
  eventsOverlapRange,
  computeTimedEventLayouts,
} from "./Calendar";
import type { CalendarEvent } from "../types";

describe("Calendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the toolbar", () => {
    render(<Calendar />);
    expect(screen.getByText(/Today/i)).toBeInTheDocument();
    expect(screen.getAllByText(/New event/i).length).toBeGreaterThan(0);
  });
});

describe("eventsForDay (timezone-safe day filter)", () => {
  // The event's start is 13:00 UTC. In Central European time that's 15:00
  // local. The "day" arg is local midnight. The old filter did
  // `day >= start` which is `00:00 >= 15:00` → false even though the
  // event IS on that day. This test pins the date-string-based fix.
  const timed = {
    id: "1",
    uid: "1@aether-os.local",
    title: "Lunch",
    description: "",
    all_day: false,
    start: "2026-09-03T13:00:00.000Z",
    end: "2026-09-03T13:30:00.000Z",
    due: null,
    color: "#3b82f6",
    tags: [],
    attendees: [],
    location: null,
    source_note_path: null,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  } satisfies CalendarEvent;

  it("includes a timed event on its local day even when the UTC hour is the next day in some zones", () => {
    const day = new Date(2026, 8, 3); // local Sep 3, 00:00
    const result = eventsForDay([timed], day);
    expect(result.map((e) => e.id)).toEqual(["1"]);
  });

  it("excludes a timed event on a different day", () => {
    const day = new Date(2026, 8, 4); // Sep 4
    const result = eventsForDay([timed], day);
    expect(result).toEqual([]);
  });

  it("includes a single-day all-day event on its day", () => {
    const allDay = { ...timed, id: "2", all_day: true, start: "2026-09-03", end: "2026-09-04" };
    const day = new Date(2026, 8, 3);
    expect(eventsForDay([allDay], day).map((e) => e.id)).toEqual(["2"]);
    // End is exclusive — Sep 4 should NOT include the event.
    const dayAfter = new Date(2026, 8, 4);
    expect(eventsForDay([allDay], dayAfter)).toEqual([]);
  });

  it("includes a single-day all-day event where start === end", () => {
    const singleDay = { ...timed, id: "same", all_day: true, start: "2026-09-03", end: "2026-09-03" };
    expect(eventsForDay([singleDay], new Date(2026, 8, 3)).map((e) => e.id)).toEqual(["same"]);
    expect(eventsForDay([singleDay], new Date(2026, 8, 4))).toEqual([]);
  });

  it("includes a multi-day all-day event on every intermediate day", () => {
    const allDay = { ...timed, id: "3", all_day: true, start: "2026-09-03", end: "2026-09-06" };
    expect(eventsForDay([allDay], new Date(2026, 8, 3)).map((e) => e.id)).toEqual(["3"]);
    expect(eventsForDay([allDay], new Date(2026, 8, 4)).map((e) => e.id)).toEqual(["3"]);
    expect(eventsForDay([allDay], new Date(2026, 8, 5)).map((e) => e.id)).toEqual(["3"]);
    // End-exclusive
    expect(eventsForDay([allDay], new Date(2026, 8, 6))).toEqual([]);
  });
});

describe("eventsOverlapRange", () => {
  const timed = {
    id: "1",
    uid: "1@aether-os.local",
    title: "Lunch",
    description: "",
    all_day: false,
    start: "2026-09-03T13:00:00.000Z",
    end: "2026-09-03T13:30:00.000Z",
    due: null,
    color: "#3b82f6",
    tags: [],
    attendees: [],
    location: null,
    source_note_path: null,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  } satisfies CalendarEvent;

  it("includes a timed event that falls inside the range", () => {
    const start = new Date(2026, 8, 3);
    const end = new Date(2026, 8, 4);
    expect(eventsOverlapRange([timed], start, end).map((e) => e.id)).toEqual(["1"]);
  });

  it("excludes a timed event outside the range", () => {
    const start = new Date(2026, 8, 4);
    const end = new Date(2026, 8, 5);
    expect(eventsOverlapRange([timed], start, end)).toEqual([]);
  });
});

describe("computeTimedEventLayouts", () => {
  it("positions non-overlapping events across the full column width", () => {
    const ev: CalendarEvent = {
      id: "ev1",
      uid: "ev1@aether-os.local",
      title: "Team Standup",
      description: "",
      all_day: false,
      start: "2026-09-03T10:00:00",
      end: "2026-09-03T11:00:00",
      due: null,
      color: "#3b82f6",
      tags: [],
      attendees: [],
      location: null,
      source_note_path: null,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    };
    const layouts = computeTimedEventLayouts([ev], 48);
    expect(layouts).toHaveLength(1);
    expect(layouts[0].top).toBe(10 * 48); // 480px at 10 AM
    expect(layouts[0].height).toBe(48); // 1 hour = 48px
    expect(layouts[0].leftPercent).toBe(0);
    expect(layouts[0].widthPercent).toBe(100);
  });

  it("places overlapping events into side-by-side lanes with shared width", () => {
    const ev1: CalendarEvent = {
      id: "ev1",
      uid: "ev1@aether-os.local",
      title: "Claude reset",
      description: "",
      all_day: false,
      start: "2026-09-03T14:00:00",
      end: "2026-09-03T15:00:00",
      due: null,
      color: "#14b8a6",
      tags: [],
      attendees: [],
      location: null,
      source_note_path: null,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    };
    const ev2: CalendarEvent = {
      ...ev1,
      id: "ev2",
      title: "Claude meeting",
      start: "2026-09-03T14:15:00",
      end: "2026-09-03T15:00:00",
    };
    const layouts = computeTimedEventLayouts([ev1, ev2], 48);
    expect(layouts).toHaveLength(2);
    // Both should share 50% width
    expect(layouts[0].widthPercent).toBe(50);
    expect(layouts[1].widthPercent).toBe(50);
    expect(layouts[0].leftPercent).toBe(0);
    expect(layouts[1].leftPercent).toBe(50);
    expect(layouts[1].top).toBe((14 * 60 + 15) * (48 / 60)); // 692px
  });
});