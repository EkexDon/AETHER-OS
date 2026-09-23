import { useMemo, useState, type CSSProperties } from "react";
import { ArrowUpRight, CalendarCheck, CalendarDays, CalendarPlus, FileText, ListTodo, Plus, Sun, Zap } from "lucide-react";
import type { CalendarEvent, TaskItem, TaskProject, VaultNote } from "../../types";
import type { HomeNoteTask } from "../../lib/home/dueTasks";
import { boardTasksDue, dueLabel, noteTasksDue } from "../../lib/home/dueTasks";
import { agendaFor, eventTimeLabel, isEventNow, isEventPast } from "../../lib/home/agenda";
import { shiftDateKey } from "../../lib/home/focusStats";
import { relativeTime } from "../../lib/home/format";
import { Badge, Button, Checkbox, EmptyState, Input, ListRow, Spinner, cx } from "../../ui";
import { HomeBlock } from "./HomeBlock";

/** Most rows each list shows before "+N more". */
const MAX_EVENTS = 6;
const MAX_TOMORROW = 3;
const MAX_TASKS = 7;

export interface TodayBlockProps {
  now: number;
  today: string;
  vaultPath: string | null;
  notes: VaultNote[];
  events: CalendarEvent[];
  boardTasks: TaskItem[];
  taskProjects: TaskProject[];
  noteTasks: HomeNoteTask[] | null;
  loadingEvents?: boolean;
  loadingTasks?: boolean;
  eventsError?: string | null;
  tasksError?: string | null;
  onOpenDailyNote: () => Promise<void>;
  onAppendDaily: (text: string) => Promise<void>;
  onOpenEvent: (event: CalendarEvent, day: string) => void;
  onNewEvent: () => void;
  onOpenCalendar: () => void;
  onOpenTask: (task: TaskItem) => void;
  onCompleteTask: (id: string) => void;
  onOpenNoteTask: (task: HomeNoteTask) => void;
  onNewTask: () => void;
  onOpenTasks: () => void;
}

/** Today's daily note, schedule for today/tomorrow and what is due. */
export function TodayBlock(props: TodayBlockProps) {
  const { now, today, notes, events, vaultPath } = props;
  const tomorrow = shiftDateKey(today, 1);
  const daily = useMemo(
    () => notes.find((n) => n.path.replace(/\\/g, "/").endsWith(`/daily/${today}.md`)) ?? null,
    [notes, today]
  );
  const todayEvents = useMemo(() => agendaFor(events, today), [events, today]);
  const tomorrowEvents = useMemo(() => agendaFor(events, tomorrow), [events, tomorrow]);
  const dueBoard = useMemo(() => boardTasksDue(props.boardTasks, props.taskProjects, today), [props.boardTasks, props.taskProjects, today]);
  const dueNotes = useMemo(() => (props.noteTasks ? noteTasksDue(props.noteTasks, today) : []), [props.noteTasks, today]);
  const dueCount = dueBoard.length + dueNotes.length;

  return (
    <HomeBlock
      title="Today"
      icon={Sun}
      count={todayEvents.length + dueCount}
      actionLabel="Calendar"
      onAction={props.onOpenCalendar}
      className="home-today"
    >
      {vaultPath && <DailyNoteStrip daily={daily} today={today} now={now} onOpen={props.onOpenDailyNote} onAppend={props.onAppendDaily} />}

      <div className="home-today-columns">
        <section className="home-subsection" aria-label="Schedule">
          <header className="home-subsection-header">
            <span className="ui-section-label">
              <CalendarDays size={12} aria-hidden="true" /> Schedule
            </span>
            {props.loadingEvents && <Spinner size={11} label="Loading events" />}
            <Button variant="ghost" size="sm" iconLeft={<CalendarPlus size={13} />} onClick={props.onNewEvent}>
              New event
            </Button>
          </header>
          {props.eventsError ? (
            <p className="ui-notice ui-notice-danger">{props.eventsError}</p>
          ) : todayEvents.length === 0 ? (
            <EmptyState
              size="sm"
              icon={CalendarDays}
              title="No events today"
              description={tomorrowEvents.length > 0 ? "Your day is free. Tomorrow is below." : "Your day is free."}
            />
          ) : (
            <ul className="home-events">
              {todayEvents.slice(0, MAX_EVENTS).map((e) => (
                <EventRow key={e.id} event={e} day={today} now={now} onOpen={props.onOpenEvent} />
              ))}
              {todayEvents.length > MAX_EVENTS && (
                <li>
                  <button type="button" className="home-more" onClick={props.onOpenCalendar}>
                    +{todayEvents.length - MAX_EVENTS} more today
                  </button>
                </li>
              )}
            </ul>
          )}
          {tomorrowEvents.length > 0 && (
            <div className="home-tomorrow">
              <span className="home-tomorrow-label">Tomorrow</span>
              <ul className="home-events is-muted">
                {tomorrowEvents.slice(0, MAX_TOMORROW).map((e) => (
                  <EventRow key={e.id} event={e} day={tomorrow} now={now} onOpen={props.onOpenEvent} />
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="home-subsection" aria-label="Due">
          <header className="home-subsection-header">
            <span className="ui-section-label">
              <ListTodo size={12} aria-hidden="true" /> Due
            </span>
            {props.loadingTasks && <Spinner size={11} label="Loading tasks" />}
            <Button variant="ghost" size="sm" iconRight={<ArrowUpRight size={13} />} onClick={props.onOpenTasks}>
              Board
            </Button>
          </header>
          {props.tasksError && <p className="ui-notice ui-notice-danger">{props.tasksError}</p>}
          {dueCount === 0 && !props.tasksError ? (
            <EmptyState
              size="sm"
              icon={ListTodo}
              title="Nothing due"
              description="Tasks due today or earlier show up here."
              action={
                <Button size="sm" variant="secondary" iconLeft={<Plus size={13} />} onClick={props.onNewTask}>
                  New task
                </Button>
              }
            />
          ) : (
            <ul className="home-due">
              {dueBoard.slice(0, MAX_TASKS).map(({ task, due, projectName, projectColor }) => {
                const badge = dueLabel(due, today);
                return (
                  <li key={task.id} className="home-due-item">
                    <Checkbox
                      checked={task.status === "done"}
                      aria-label={`Complete ${task.title}`}
                      onChange={(checked) => {
                        if (checked) props.onCompleteTask(task.id);
                      }}
                    />
                    <ListRow
                      className="home-due-row"
                      title={task.title}
                      description={
                        <span className="home-due-project">
                          <span
                            className="home-color-dot"
                            style={projectColor ? ({ "--dot-color": projectColor } as CSSProperties) : undefined}
                            aria-hidden="true"
                          />
                          {projectName}
                        </span>
                      }
                      meta={<Badge variant={badge.tone}>{badge.label}</Badge>}
                      onClick={() => props.onOpenTask(task)}
                    />
                  </li>
                );
              })}
              {dueNotes.slice(0, Math.max(0, MAX_TASKS - dueBoard.length)).map((t) => {
                const badge = dueLabel(t.due ?? today, today);
                return (
                  <li key={t.id} className="home-due-item">
                    <span className="home-due-note-icon" aria-hidden="true">
                      <FileText size={13} />
                    </span>
                    <ListRow
                      className="home-due-row"
                      title={t.text}
                      description={`${t.noteName} · line ${t.line + 1}`}
                      meta={<Badge variant={badge.tone}>{badge.label}</Badge>}
                      onClick={() => props.onOpenNoteTask(t)}
                    />
                  </li>
                );
              })}
              {dueCount > MAX_TASKS && (
                <li>
                  <button type="button" className="home-more" onClick={props.onOpenTasks}>
                    +{dueCount - MAX_TASKS} more due
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>
      </div>
    </HomeBlock>
  );
}

function EventRow({
  event,
  day,
  now,
  onOpen,
}: {
  event: CalendarEvent;
  day: string;
  now: number;
  onOpen: (event: CalendarEvent, day: string) => void;
}) {
  const current = new Date(now);
  const live = isEventNow(event, current);
  const past = isEventPast(event, current);
  return (
    <li>
      <button
        type="button"
        className={cx("home-event", live && "is-now", past && "is-past")}
        style={{ "--event-color": event.color } as CSSProperties}
        onClick={() => onOpen(event, day)}
      >
        <span className="home-event-time tabular">{eventTimeLabel(event, day)}</span>
        <span className="home-event-bar" aria-hidden="true" />
        <span className="home-event-body">
          <span className="home-event-title">{event.title}</span>
          {event.location && <span className="home-event-meta">{event.location}</span>}
        </span>
        {live && <Badge variant="accent">Now</Badge>}
      </button>
    </li>
  );
}

function DailyNoteStrip({
  daily,
  today,
  now,
  onOpen,
  onAppend,
}: {
  daily: VaultNote | null;
  today: string;
  now: number;
  onOpen: () => Promise<void>;
  onAppend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"open" | "append" | null>(null);

  const open = async () => {
    setBusy("open");
    try {
      await onOpen();
    } finally {
      setBusy(null);
    }
  };

  const append = async () => {
    const value = text.trim();
    if (!value) return;
    setBusy("append");
    try {
      await onAppend(value);
      setText("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="home-daily">
      <ListRow
        className="home-daily-row"
        icon={<CalendarCheck size={15} />}
        title="Daily note"
        description={daily ? `${today} · edited ${relativeTime(daily.mtime * 1000, now)}` : `${today} · not created yet`}
        meta={
          <Button size="sm" variant={daily ? "ghost" : "secondary"} loading={busy === "open"} onClick={(e) => { e.stopPropagation(); void open(); }}>
            {daily ? "Open" : "Create"}
          </Button>
        }
        onClick={() => void open()}
      />
      <form
        className="home-daily-capture"
        onSubmit={(e) => {
          e.preventDefault();
          void append();
        }}
      >
        <Input
          size="sm"
          iconLeft={<Zap size={13} />}
          aria-label="Add a line to today's daily note"
          placeholder="Add a line to today's note…"
          value={text}
          disabled={busy === "append"}
          onChange={(e) => setText(e.target.value)}
          suffix={busy === "append" ? <Spinner size={11} label="Saving" /> : undefined}
        />
      </form>
    </div>
  );
}
