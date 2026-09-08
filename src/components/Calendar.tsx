import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Plus, Bell, Download, Trash2, MapPin, Users, Tag, X,
} from "lucide-react";
import {
  format, parseISO, startOfWeek, endOfWeek, addDays, subDays, addMonths, subMonths,
  startOfMonth, endOfMonth, addWeeks, subWeeks, isSameDay, eachDayOfInterval,
} from "date-fns";
import { useAetherStore } from "../lib/store";
import { listCalendarEvents, deleteCalendarEvent } from "../lib/ipc";
import { CALENDAR_COLORS, DEFAULT_CALENDAR_COLOR } from "../lib/calendarColors";
import type { CalendarEvent, CalendarView as CalendarViewType } from "../types";
import { EventEditorModal } from "./EventEditorModal";
import { CalendarImportExportDialog } from "./CalendarImportExportDialog";
import { ReminderSettingsDialog } from "./ReminderSettingsDialog";

const HOUR_HEIGHT_PX = 48;
const HOURS_IN_DAY = 24;
const MONTH_CELL_ROWS = 6;
const MAX_DOTS_PER_CELL = 3;

export interface TimedEventLayout {
  event: CalendarEvent;
  top: number;
  height: number;
  leftPercent: number;
  widthPercent: number;
  isCompact: boolean;
}

function computeTimedEventLayouts(
  events: CalendarEvent[],
  hourHeightPx: number = HOUR_HEIGHT_PX
): TimedEventLayout[] {
  if (events.length === 0) return [];

  interface ParsedEvent {
    event: CalendarEvent;
    startMin: number;
    endMin: number;
  }

  const parsed: ParsedEvent[] = events.map((ev) => {
    const s = parseEventStart(ev);
    const e = parseEventEnd(ev);
    const startMin = s.getHours() * 60 + s.getMinutes();
    let endMin = e.getHours() * 60 + e.getMinutes();
    if (endMin <= startMin) {
      endMin = Math.min(24 * 60, startMin + 30);
    }
    return { event: ev, startMin, endMin };
  });

  parsed.sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return (b.endMin - b.startMin) - (a.endMin - a.startMin);
  });

  const clusters: ParsedEvent[][] = [];
  let currentCluster: ParsedEvent[] = [];
  let clusterEnd = -1;

  for (const item of parsed) {
    if (currentCluster.length === 0) {
      currentCluster.push(item);
      clusterEnd = item.endMin;
    } else if (item.startMin < clusterEnd) {
      currentCluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMin);
    } else {
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterEnd = item.endMin;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const layouts: TimedEventLayout[] = [];

  for (const cluster of clusters) {
    const lanes: number[] = [];
    const eventLanes: number[] = [];

    for (const item of cluster) {
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] <= item.startMin) {
          lanes[i] = item.endMin;
          eventLanes.push(i);
          placed = true;
          break;
        }
      }
      if (!placed) {
        eventLanes.push(lanes.length);
        lanes.push(item.endMin);
      }
    }

    const numCols = Math.max(lanes.length, 1);
    for (let i = 0; i < cluster.length; i++) {
      const item = cluster[i];
      const lane = eventLanes[i];
      const top = item.startMin * (hourHeightPx / 60);
      const rawHeight = (item.endMin - item.startMin) * (hourHeightPx / 60);
      const height = Math.max(26, rawHeight);
      const isCompact = height < 42;

      layouts.push({
        event: item.event,
        top,
        height,
        leftPercent: (lane / numCols) * 100,
        widthPercent: (1 / numCols) * 100,
        isCompact,
      });
    }
  }

  return layouts;
}

function parseEventStart(event: CalendarEvent): Date {
  return event.all_day ? parseISO(`${event.start}T00:00:00`) : parseISO(event.start);
}

function parseEventEnd(event: CalendarEvent): Date {
  return event.all_day ? parseISO(`${event.end}T00:00:00`) : parseISO(event.end);
}

function eventDurationMinutes(event: CalendarEvent): number {
  if (event.all_day) return 0;
  return Math.max(0, (parseEventEnd(event).getTime() - parseEventStart(event).getTime()) / 60000);
}

function eventTimeRange(event: CalendarEvent): string {
  if (event.all_day) return "All day";
  const s = parseEventStart(event);
  const e = parseEventEnd(event);
  return `${format(s, "h:mm a")} – ${format(e, "h:mm a")}`;
}

function eventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  // Compare by local YYYY-MM-DD, not by timestamp. The event's `start`/
  // `end` carry hour info (or for all-day, no hour info); the `day` arg
  // is local midnight. Doing `day >= start` would be `00:00 >= 15:00` →
  // false even when the event IS on that day. So we normalise both sides
  // to "yyyy-MM-dd" in local time and compare strings.
  const dayKey = format(day, "yyyy-MM-dd");
  return events.filter((ev) => {
    if (ev.all_day) {
      const startKey = ev.start;
      const endKey = ev.end;
      if (startKey === endKey) {
        return dayKey === startKey;
      }
      return startKey <= dayKey && dayKey < endKey;
    }
    const startKey = format(parseEventStart(ev), "yyyy-MM-dd");
    const endKey = format(parseEventEnd(ev), "yyyy-MM-dd");
    return startKey <= dayKey && dayKey <= endKey;
  });
}

function formatDateInputValue(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

function formatTimeInputValue(d: Date): string {
  return format(d, "HH:mm");
}

function eventsOverlapRange(
  events: CalendarEvent[],
  rangeStart: Date,
  rangeEnd: Date
): CalendarEvent[] {
  // Same fix as eventsForDay: normalise to local YYYY-MM-DD before
  // comparing, so an event at 15:00 on day X is correctly identified as
  // overlapping a [day-X 00:00, day-X+1 00:00) range.
  const startKey = format(rangeStart, "yyyy-MM-dd");
  // rangeEnd is exclusive at the day level — bump back by one day to make
  // the inclusive comparison work.
  const endKey = format(addDays(rangeEnd, -1), "yyyy-MM-dd");
  return events.filter((ev) => {
    if (ev.all_day) {
      if (ev.start === ev.end) {
        return ev.start >= startKey && ev.start <= endKey;
      }
      return ev.start <= endKey && startKey < ev.end;
    }
    const sKey = format(parseEventStart(ev), "yyyy-MM-dd");
    const eKey = format(parseEventEnd(ev), "yyyy-MM-dd");
    return sKey <= endKey && eKey >= startKey;
  });
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || trimmed[0]?.toUpperCase() || "?";
}

export function Calendar() {
  const {
    calendarEvents,
    calendarView,
    calendarDate,
    setCalendarEvents,
    setCalendarView,
    setCalendarDate,
    calendarImportExportOpen,
    setCalendarImportExportOpen,
    calendarRemindersOpen,
    setCalendarRemindersOpen,
    upsertCalendarEvent,
    removeCalendarEvent,
  } = useAetherStore();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [prefilledDate, setPrefilledDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listCalendarEvents()
      .then((events) => {
        if (!cancelled) setCalendarEvents(events);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setCalendarEvents]);

  const focusedDate = useMemo(() => parseISO(calendarDate), [calendarDate]);

  const openCreateForDate = (dateStr: string) => {
    setEditingEvent(null);
    setPrefilledDate(dateStr);
    setEditorOpen(true);
  };

  const openCreateForToday = () => {
    openCreateForDate(calendarDate);
  };

  const handleEdit = (event: CalendarEvent) => {
    setEditingEvent(event);
    setPrefilledDate(null);
    setEditorOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCalendarEvent(id);
      removeCalendarEvent(id);
    } catch {
      // swallow — UI doesn't surface individual errors for delete yet
    }
  };

  return (
    <div className="calendar-view">
      <CalendarToolbar
        view={calendarView}
        date={calendarDate}
        focusedDate={focusedDate}
        onViewChange={setCalendarView}
        onDateChange={setCalendarDate}
        onNewEvent={openCreateForToday}
        onOpenImportExport={() => setCalendarImportExportOpen(true)}
        onOpenReminders={() => setCalendarRemindersOpen(true)}
      />
      <div className="calendar-body">
        <div className="calendar-grid-wrap">
          {calendarView === "month" && (
            <CalendarMonthGrid
              date={focusedDate}
              events={calendarEvents}
              onSelectDay={(d) => setCalendarDate(formatDateInputValue(d))}
              onEditEvent={handleEdit}
              onCreateForDay={(d) => openCreateForDate(formatDateInputValue(d))}
            />
          )}
          {calendarView === "week" && (
            <CalendarWeekGrid
              date={focusedDate}
              events={calendarEvents}
              onEditEvent={handleEdit}
              onCreateAt={(d) => openCreateForDate(formatDateInputValue(d))}
            />
          )}
          {calendarView === "day" && (
            <CalendarDayGrid
              date={focusedDate}
              events={calendarEvents}
              onEditEvent={handleEdit}
              onCreateAt={(d) => openCreateForDate(formatDateInputValue(d))}
            />
          )}
        </div>
        <CalendarEventList
          date={calendarDate}
          events={eventsForDay(calendarEvents, focusedDate)}
          onEditEvent={handleEdit}
          onDeleteEvent={(id) => void handleDelete(id)}
          onNewEvent={openCreateForToday}
        />
      </div>
      {editorOpen && (
        <EventEditorModal
          event={editingEvent}
          prefilledDate={prefilledDate}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {calendarImportExportOpen && (
        <CalendarImportExportDialog onClose={() => setCalendarImportExportOpen(false)} />
      )}
      {calendarRemindersOpen && (
        <ReminderSettingsDialog onClose={() => setCalendarRemindersOpen(false)} />
      )}
    </div>
  );
}

function CalendarToolbar({
  view,
  date,
  focusedDate,
  onViewChange,
  onDateChange,
  onNewEvent,
  onOpenImportExport,
  onOpenReminders,
}: {
  view: CalendarViewType;
  date: string;
  focusedDate: Date;
  onViewChange: (v: CalendarViewType) => void;
  onDateChange: (d: string) => void;
  onNewEvent: () => void;
  onOpenImportExport: () => void;
  onOpenReminders: () => void;
}) {
  const step = (direction: 1 | -1) => {
    if (view === "month") {
      const next = direction === 1 ? addMonths(focusedDate, 1) : subMonths(focusedDate, 1);
      onDateChange(formatDateInputValue(next));
    } else if (view === "week") {
      const next = direction === 1 ? addWeeks(focusedDate, 1) : subWeeks(focusedDate, 1);
      onDateChange(formatDateInputValue(next));
    } else {
      const next = direction === 1 ? addDays(focusedDate, 1) : subDays(focusedDate, 1);
      onDateChange(formatDateInputValue(next));
    }
  };

  const goToday = () => onDateChange(formatDateInputValue(new Date()));

  const title = (() => {
    if (view === "month") return format(focusedDate, "MMMM yyyy");
    if (view === "week") {
      const ws = startOfWeek(focusedDate, { weekStartsOn: 1 });
      const we = endOfWeek(focusedDate, { weekStartsOn: 1 });
      if (format(ws, "MMM yyyy") === format(we, "MMM yyyy")) {
        return `${format(ws, "MMM d")} – ${format(we, "d, yyyy")}`;
      }
      return `${format(ws, "MMM d")} – ${format(we, "MMM d, yyyy")}`;
    }
    return format(focusedDate, "EEEE, MMMM d, yyyy");
  })();

  return (
    <div className="calendar-toolbar">
      <div className="calendar-toolbar-nav">
        <button className="btn btn-icon" onClick={() => step(-1)} title="Previous">
          <ChevronLeft size={16} />
        </button>
        <button className="btn btn-secondary" onClick={goToday}>Today</button>
        <button className="btn btn-icon" onClick={() => step(1)} title="Next">
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="calendar-toolbar-title">{title}</div>
      <div className="calendar-view-toggle" role="tablist" aria-label="Calendar view">
        {(["month", "week", "day"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={`calendar-view-toggle-btn${view === v ? " selected" : ""}`}
            onClick={() => onViewChange(v)}
          >
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      <div className="calendar-toolbar-actions">
        <button className="btn btn-icon" onClick={onOpenReminders} title="Reminders">
          <Bell size={16} />
        </button>
        <button className="btn btn-icon" onClick={onOpenImportExport} title="Import / Export">
          <Download size={16} />
        </button>
        <button className="btn btn-primary" onClick={onNewEvent}>
          <Plus size={14} /> New
        </button>
      </div>
      <input type="hidden" value={date} readOnly />
    </div>
  );
}

function CalendarMonthGrid({
  date,
  events,
  onSelectDay,
  onEditEvent,
  onCreateForDay,
}: {
  date: Date;
  events: CalendarEvent[];
  onSelectDay: (d: Date) => void;
  onEditEvent: (e: CalendarEvent) => void;
  onCreateForDay: (d: Date) => void;
}) {
  const monthStart = startOfMonth(date);
  const monthEnd = endOfMonth(date);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const today = new Date();
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      map.set(key, eventsForDay(events, day));
    }
    return map;
  }, [events, days]);

  return (
    <div className="calendar-month-grid-wrap">
      <div className="calendar-weekday-header">
        {Array.from({ length: 7 }, (_, i) => addDays(gridStart, i)).map((d) => (
          <div key={d.toISOString()} className="calendar-weekday-cell">
            {format(d, "EEE")}
          </div>
        ))}
      </div>
      <div
        className="calendar-month-grid"
        style={{ gridTemplateRows: `repeat(${MONTH_CELL_ROWS}, minmax(96px, 1fr))` }}
      >
        {days.map((day: Date) => {
          const key = format(day, "yyyy-MM-dd");
          const dayEvents = eventsByDay.get(key) ?? [];
          const isOtherMonth = day.getMonth() !== date.getMonth();
          const isToday = isSameDay(day, today);
          const visible = dayEvents.slice(0, MAX_DOTS_PER_CELL);
          const overflow = Math.max(0, dayEvents.length - MAX_DOTS_PER_CELL);
          return (
            <div
              key={key}
              className={`calendar-month-cell${isOtherMonth ? " calendar-month-cell-other" : ""}${isToday ? " calendar-month-cell-today" : ""}`}
              onClick={() => onSelectDay(day)}
              onDoubleClick={() => onCreateForDay(day)}
            >
              <div className="calendar-month-cell-num">{format(day, "d")}</div>
              <div className="calendar-month-cell-events">
                {visible.map((ev) => (
                  <button
                    key={ev.id}
                    className="calendar-event-pill"
                    style={{ background: ev.color }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditEvent(ev);
                    }}
                    title={ev.title}
                  >
                    {ev.title}
                  </button>
                ))}
                {dayEvents.length > MAX_DOTS_PER_CELL && (
                  <div className="calendar-event-dots">
                    {visible.map((ev) => (
                      <span
                        key={ev.id}
                        className="calendar-event-dot"
                        style={{ background: ev.color }}
                      />
                    ))}
                    <span className="calendar-event-overflow">+{overflow} more</span>
                  </div>
                )}
                {dayEvents.length === 0 && (
                  <div className="calendar-month-cell-empty" onClick={(e) => { e.stopPropagation(); onCreateForDay(day); }}>
                    +
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarWeekGrid({
  date,
  events,
  onEditEvent,
  onCreateAt,
}: {
  date: Date;
  events: CalendarEvent[];
  onEditEvent: (e: CalendarEvent) => void;
  onCreateAt: (d: Date) => void;
}) {
  const weekStart = startOfWeek(date, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(date, { weekStartsOn: 1 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();
  const scrollRef = useRef<HTMLDivElement>(null);

  const allDayByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      map[key] = eventsForDay(events, day).filter((ev) => ev.all_day);
    }
    return map;
  }, [events, days]);

  const timedByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      map[key] = eventsForDay(events, day).filter((ev) => !ev.all_day);
    }
    return map;
  }, [events, days]);

  const layoutsByDay = useMemo(() => {
    const map: Record<string, TimedEventLayout[]> = {};
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      map[key] = computeTimedEventLayouts(timedByDay[key] ?? [], HOUR_HEIGHT_PX);
    }
    return map;
  }, [days, timedByDay]);

  useEffect(() => {
    if (scrollRef.current) {
      let earliestHour = 8;
      for (const day of days) {
        const key = format(day, "yyyy-MM-dd");
        for (const ev of timedByDay[key] ?? []) {
          const h = parseEventStart(ev).getHours();
          if (h < earliestHour) earliestHour = h;
        }
      }
      const target = Math.max(0, earliestHour - 1) * HOUR_HEIGHT_PX;
      scrollRef.current.scrollTop = target;
    }
  }, [date]);

  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowTopPx = nowMinutes * (HOUR_HEIGHT_PX / 60);

  return (
    <div className="calendar-week-grid-wrap">
      <div className="calendar-week-header">
        {days.map((d) => {
          const key = format(d, "yyyy-MM-dd");
          const allDayEvents = allDayByDay[key] ?? [];
          return (
            <div key={key} className="calendar-week-header-cell">
              <div className={`calendar-week-header-label${isSameDay(d, today) ? " today" : ""}`}>
                {format(d, "EEE d")}
              </div>
              <div className="calendar-week-allday-strip">
                {allDayEvents.map((ev) => (
                  <button
                    key={ev.id}
                    className="calendar-event-pill"
                    style={{ background: ev.color }}
                    onClick={() => onEditEvent(ev)}
                    title={ev.title}
                  >
                    {ev.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="calendar-week-scroll" ref={scrollRef}>
        <div
          className="calendar-week-grid"
          style={{
            gridTemplateColumns: `60px repeat(7, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${HOURS_IN_DAY}, ${HOUR_HEIGHT_PX}px)`,
          }}
        >
          {Array.from({ length: HOURS_IN_DAY }, (_, hour) => (
            <React.Fragment key={`h-${hour}`}>
              <div className="calendar-time-gutter" style={{ gridRow: hour + 1, gridColumn: 1 }}>
                {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
              </div>
              {days.map((d, colIdx) => {
                const key = format(d, "yyyy-MM-dd");
                return (
                  <div
                    key={`${key}-${hour}`}
                    className="calendar-week-cell"
                    style={{ gridRow: hour + 1, gridColumn: colIdx + 2 }}
                    onDoubleClick={() => {
                      const target = new Date(d);
                      target.setHours(hour, 0, 0, 0);
                      onCreateAt(target);
                    }}
                  />
                );
              })}
            </React.Fragment>
          ))}

          {days.map((d, colIdx) => {
            const key = format(d, "yyyy-MM-dd");
            const layouts = layoutsByDay[key] ?? [];
            const isToday = isSameDay(d, today);
            return (
              <div
                key={`day-layer-${key}`}
                className="calendar-day-events-column"
                style={{
                  gridRow: `1 / span ${HOURS_IN_DAY}`,
                  gridColumn: colIdx + 2,
                }}
              >
                {isToday && (
                  <div className="calendar-now-indicator" style={{ top: nowTopPx }} title="Current time">
                    <span className="calendar-now-dot" />
                  </div>
                )}
                {layouts.map((layout) => {
                  const ev = layout.event;
                  const timeDisplay = layout.isCompact
                    ? format(parseEventStart(ev), "h:mm a")
                    : eventTimeRange(ev);
                  return (
                    <button
                      key={ev.id}
                      className={`calendar-event-block${layout.isCompact ? " compact" : ""}`}
                      style={{
                        top: layout.top,
                        height: layout.height,
                        left: `calc(${layout.leftPercent}% + 2px)`,
                        width: `calc(${layout.widthPercent}% - 4px)`,
                        background: ev.color,
                        pointerEvents: "auto",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditEvent(ev);
                      }}
                      title={`${ev.title} (${eventTimeRange(ev)})`}
                    >
                      <span className="calendar-event-block-title">{ev.title}</span>
                      <span className="calendar-event-block-time">{timeDisplay}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CalendarDayGrid({
  date,
  events,
  onEditEvent,
  onCreateAt,
}: {
  date: Date;
  events: CalendarEvent[];
  onEditEvent: (e: CalendarEvent) => void;
  onCreateAt: (d: Date) => void;
}) {
  const allDayEvents = eventsForDay(events, date).filter((ev) => ev.all_day);
  const timedEvents = eventsForDay(events, date).filter((ev) => !ev.all_day);
  const today = new Date();
  const scrollRef = useRef<HTMLDivElement>(null);

  const layouts = useMemo(() => {
    return computeTimedEventLayouts(timedEvents, HOUR_HEIGHT_PX);
  }, [timedEvents]);

  useEffect(() => {
    if (scrollRef.current) {
      let earliestHour = 8;
      for (const ev of timedEvents) {
        const h = parseEventStart(ev).getHours();
        if (h < earliestHour) earliestHour = h;
      }
      const target = Math.max(0, earliestHour - 1) * HOUR_HEIGHT_PX;
      scrollRef.current.scrollTop = target;
    }
  }, [date]);

  const isToday = isSameDay(date, today);
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowTopPx = nowMinutes * (HOUR_HEIGHT_PX / 60);

  return (
    <div className="calendar-day-grid-wrap">
      <div className="calendar-day-header">
        <div className={`calendar-day-header-label${isToday ? " today" : ""}`}>
          {format(date, "EEEE, MMMM d, yyyy")}
        </div>
        <div className="calendar-week-allday-strip">
          {allDayEvents.map((ev) => (
            <button
              key={ev.id}
              className="calendar-event-pill"
              style={{ background: ev.color }}
              onClick={() => onEditEvent(ev)}
              title={ev.title}
            >
              {ev.title}
            </button>
          ))}
        </div>
      </div>
      <div className="calendar-week-scroll" ref={scrollRef}>
        <div
          className="calendar-day-grid"
          style={{
            gridTemplateColumns: `60px 1fr`,
            gridTemplateRows: `repeat(${HOURS_IN_DAY}, ${HOUR_HEIGHT_PX}px)`,
          }}
        >
          {Array.from({ length: HOURS_IN_DAY }, (_, hour) => (
            <React.Fragment key={`dh-${hour}`}>
              <div className="calendar-time-gutter" style={{ gridRow: hour + 1, gridColumn: 1 }}>
                {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
              </div>
              <div
                className="calendar-week-cell"
                style={{ gridRow: hour + 1, gridColumn: 2 }}
                onDoubleClick={() => {
                  const target = new Date(date);
                  target.setHours(hour, 0, 0, 0);
                  onCreateAt(target);
                }}
              />
            </React.Fragment>
          ))}

          <div
            className="calendar-day-events-column"
            style={{
              gridRow: `1 / span ${HOURS_IN_DAY}`,
              gridColumn: 2,
            }}
          >
            {isToday && (
              <div className="calendar-now-indicator" style={{ top: nowTopPx }} title="Current time">
                <span className="calendar-now-dot" />
              </div>
            )}
            {layouts.map((layout) => {
              const ev = layout.event;
              const timeDisplay = layout.isCompact
                ? format(parseEventStart(ev), "h:mm a")
                : eventTimeRange(ev);
              return (
                <button
                  key={ev.id}
                  className={`calendar-event-block${layout.isCompact ? " compact" : ""}`}
                  style={{
                    top: layout.top,
                    height: layout.height,
                    left: `calc(${layout.leftPercent}% + 2px)`,
                    width: `calc(${layout.widthPercent}% - 4px)`,
                    background: ev.color,
                    pointerEvents: "auto",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditEvent(ev);
                  }}
                  title={`${ev.title} (${eventTimeRange(ev)})`}
                >
                  <span className="calendar-event-block-title">{ev.title}</span>
                  <span className="calendar-event-block-time">{timeDisplay}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function CalendarEventList({
  date,
  events,
  onEditEvent,
  onDeleteEvent,
  onNewEvent,
}: {
  date: string;
  events: CalendarEvent[];
  onEditEvent: (e: CalendarEvent) => void;
  onDeleteEvent: (id: string) => void;
  onNewEvent: () => void;
}) {
  const headingDate = useMemo(() => {
    try {
      return format(parseISO(date), "EEEE, MMMM d");
    } catch {
      return date;
    }
  }, [date]);

  const handleDeleteClick = (id: string) => {
    if (window.confirm("Delete this event?")) onDeleteEvent(id);
  };

  return (
    <div className="calendar-event-list">
      <div className="calendar-event-list-title">Events on {headingDate}</div>
      {events.length === 0 ? (
        <div className="calendar-event-list-empty">
          <p>No events for this day</p>
          <button className="btn btn-secondary btn-sm" onClick={onNewEvent}>
            <Plus size={12} /> New event
          </button>
        </div>
      ) : (
        <ul className="calendar-event-list-items">
          {events.map((ev) => (
            <li
              key={ev.id}
              className="calendar-event-row"
              onClick={() => onEditEvent(ev)}
            >
              <span className="calendar-event-row-color-stripe" style={{ background: ev.color }} />
              <div className="calendar-event-row-body">
                <div className="calendar-event-row-title">{ev.title}</div>
                <div className="calendar-event-row-time">{eventTimeRange(ev)}</div>
                {ev.location && (
                  <div className="calendar-event-row-meta">
                    <span className="calendar-meta-chip">
                      <MapPin size={10} /> {ev.location}
                    </span>
                  </div>
                )}
                {ev.attendees.length > 0 && (
                  <div className="calendar-event-row-meta">
                    {ev.attendees.map((a) => (
                      <span key={a} className="calendar-attendee-chip" title={a}>
                        <Users size={10} /> {initialsOf(a)}
                      </span>
                    ))}
                  </div>
                )}
                {ev.tags.length > 0 && (
                  <div className="calendar-event-row-meta">
                    {ev.tags.map((t) => (
                      <span key={t} className="calendar-tag-chip">
                        <Tag size={10} /> {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="calendar-event-row-actions">
                <button
                  className="btn btn-icon btn-icon-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteClick(ev.id);
                  }}
                  title="Delete event"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Re-exports for use by other components if needed.
export {
  eventsForDay,
  eventTimeRange,
  eventDurationMinutes,
  parseEventStart,
  parseEventEnd,
  formatDateInputValue,
  formatTimeInputValue,
  eventsOverlapRange,
  computeTimedEventLayouts,
  HOUR_HEIGHT_PX,
  CALENDAR_COLORS,
  DEFAULT_CALENDAR_COLOR,
};