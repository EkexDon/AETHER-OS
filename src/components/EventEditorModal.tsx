import { useEffect, useMemo, useRef, useState } from "react";
import { X, Calendar, MapPin, Tag as TagIcon, User, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { useAetherStore } from "../lib/store";
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "../lib/ipc";
import { CALENDAR_COLORS, DEFAULT_CALENDAR_COLOR } from "../lib/calendarColors";
import type { CalendarEvent, CalendarEventPatch } from "../types";

type ChipInputProps = {
  label: string;
  values: string[];
  placeholder: string;
  icon?: React.ReactNode;
  onChange: (next: string[]) => void;
};

function ChipInput({ label, values, placeholder, icon, onChange }: ChipInputProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addValue = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (values.includes(v)) {
      setText("");
      return;
    }
    onChange([...values, v]);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addValue(text);
    } else if (e.key === "Backspace" && !text && values.length > 0) {
      onChange(values.slice(0, -1));
    } else if (e.key === "," && text.trim()) {
      e.preventDefault();
      addValue(text);
    }
  };

  return (
    <div className="event-editor-field">
      <span className="event-editor-field-label">{label}</span>
      <div
        className="event-editor-chip-input"
        onClick={() => inputRef.current?.focus()}
      >
        {values.map((v) => (
          <span key={v} className="event-editor-chip">
            {icon}
            <span>{v}</span>
            <button
              type="button"
              className="event-editor-chip-remove"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="event-editor-chip-input-field"
          type="text"
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => text.trim() && addValue(text)}
        />
      </div>
    </div>
  );
}

export function EventEditorModal({
  event,
  prefilledDate,
  onClose,
}: {
  event: CalendarEvent | null;
  prefilledDate: string | null;
  onClose: () => void;
}) {
  const { upsertCalendarEvent, removeCalendarEvent } = useAetherStore();

  const initial = useMemo(() => {
    if (event) {
      const startDate = event.all_day ? event.start.slice(0, 10) : event.start.slice(0, 10);
      const startTime = event.all_day ? "00:00" : event.start.slice(11, 16);
      const endDate = event.all_day ? event.end.slice(0, 10) : event.end.slice(0, 10);
      const endTime = event.all_day ? "00:00" : event.end.slice(11, 16);
      const dueDate = event.due ? event.due.slice(0, 10) : "";
      const dueTime = event.due && !event.due.includes("T00:00:00") ? event.due.slice(11, 16) : "00:00";
      const dueAllDay = !!event.due && event.due.length === 10;
      return {
        title: event.title,
        description: event.description,
        all_day: event.all_day,
        startDate,
        startTime,
        endDate,
        endTime,
        dueDate,
        dueTime,
        dueAllDay,
        color: event.color || DEFAULT_CALENDAR_COLOR,
        tags: [...event.tags],
        attendees: [...event.attendees],
        location: event.location ?? "",
        source_note_path: event.source_note_path,
      };
    }
    const fallbackDate = prefilledDate ?? new Date().toISOString().slice(0, 10);
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (startHour + 1) % 24;
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      title: "",
      description: "",
      all_day: false,
      startDate: fallbackDate,
      startTime: `${pad(startHour)}:00`,
      endDate: fallbackDate,
      endTime: `${pad(endHour)}:00`,
      dueDate: "",
      dueTime: "00:00",
      dueAllDay: false,
      color: DEFAULT_CALENDAR_COLOR,
      tags: [],
      attendees: [],
      location: "",
      source_note_path: null,
    };
  }, [event, prefilledDate]);

  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [allDay, setAllDay] = useState(initial.all_day);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [dueDate, setDueDate] = useState(initial.dueDate);
  const [dueTime, setDueTime] = useState(initial.dueTime);
  const [dueAllDay, setDueAllDay] = useState(initial.dueAllDay);
  const [color, setColor] = useState(initial.color);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [attendees, setAttendees] = useState<string[]>(initial.attendees);
  const [location, setLocation] = useState(initial.location);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    if (!confirmingDelete) return;
    const t = setTimeout(() => setConfirmingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmingDelete]);

  const parseYmdHm = (date: string, time: string): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    const [_, y, mo, d] = m;
    const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!tm) return null;
    const hh = Number(tm[1]);
    const mm = Number(tm[2]);
    return new Date(Number(y), Number(mo) - 1, Number(d), hh, mm);
  };

  const durationText = useMemo(() => {
    if (allDay) return "—";
    const s = parseYmdHm(startDate, startTime);
    const e = parseYmdHm(endDate, endTime);
    if (!s || !e) return "—";
    const mins = Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }, [allDay, startDate, startTime, endDate, endTime]);

  const isValid = useMemo(() => {
    if (!title.trim()) return false;
    if (allDay) {
      return startDate && endDate && startDate <= endDate;
    }
    const s = parseYmdHm(startDate, startTime);
    const e = parseYmdHm(endDate, endTime);
    return !!s && !!e && e >= s;
  }, [title, allDay, startDate, startTime, endDate, endTime]);

  const handleSave = async () => {
    if (!isValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const tagList = tags;
      const attendeeList = attendees;
      const locTrim = location.trim();

      if (allDay) {
        const start = startDate;
        const end = endDate;
        let due: string | null = null;
        if (dueDate) {
          if (dueAllDay) due = dueDate;
          else {
            const dt = parseYmdHm(dueDate, dueTime);
            if (dt) due = dt.toISOString();
          }
        }
        const input = {
          title: title.trim(),
          description,
          all_day: true,
          start,
          end,
          due,
          color,
          tags: tagList,
          attendees: attendeeList,
          location: locTrim || null,
          source_note_path: event?.source_note_path ?? null,
        };
        if (event) {
          const patch: CalendarEventPatch = { ...input };
          const result = await updateCalendarEvent(event.id, patch);
          upsertCalendarEvent(result);
        } else {
          const result = await createCalendarEvent(input);
          upsertCalendarEvent(result);
        }
      } else {
        const startDt = parseYmdHm(startDate, startTime);
        const endDt = parseYmdHm(endDate, endTime);
        if (!startDt || !endDt) return;
        let due: string | null = null;
        if (dueDate) {
          if (dueAllDay) due = dueDate;
          else {
            const dt = parseYmdHm(dueDate, dueTime);
            if (dt) due = dt.toISOString();
          }
        }
        const input = {
          title: title.trim(),
          description,
          all_day: false,
          start: startDt.toISOString(),
          end: endDt.toISOString(),
          due,
          color,
          tags: tagList,
          attendees: attendeeList,
          location: locTrim || null,
          source_note_path: event?.source_note_path ?? null,
        };
        if (event) {
          const patch: CalendarEventPatch = { ...input };
          const result = await updateCalendarEvent(event.id, patch);
          upsertCalendarEvent(result);
        } else {
          const result = await createCalendarEvent(input);
          upsertCalendarEvent(result);
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!event) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteCalendarEvent(event.id);
      removeCalendarEvent(event.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="event-editor-overlay" onClick={onClose}>
      <div className="event-editor-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="event-editor-header">
          <Calendar size={14} />
          <span>{event ? "Edit event" : "New event"}</span>
          <button className="btn btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="event-editor-body">
          <label className="event-editor-field">
            <span className="event-editor-field-label">Title</span>
            <input
              ref={titleRef}
              className="settings-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>

          <label className="event-editor-field-row">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
            />
            <span>All day</span>
          </label>

          <div className="event-editor-field">
            <span className="event-editor-field-label">Starts</span>
            <div className="event-editor-field-row">
              <input
                className="settings-input"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              {!allDay && (
                <input
                  className="settings-input"
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              )}
            </div>
          </div>

          <div className="event-editor-field">
            <span className="event-editor-field-label">Ends</span>
            <div className="event-editor-field-row">
              <input
                className="settings-input"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
              {!allDay && (
                <input
                  className="settings-input"
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              )}
            </div>
            <span className="event-editor-duration">Duration: {durationText}</span>
          </div>

          <div className="event-editor-field">
            <span className="event-editor-field-label">Reminder deadline</span>
            <div className="event-editor-field-row">
              <input
                className="settings-input"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
              {dueDate && !dueAllDay && (
                <input
                  className="settings-input"
                  type="time"
                  value={dueTime}
                  onChange={(e) => setDueTime(e.target.value)}
                />
              )}
              {dueDate && (
                <>
                  <label className="event-editor-field-row" style={{ gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={dueAllDay}
                      onChange={(e) => setDueAllDay(e.target.checked)}
                    />
                    <span style={{ fontSize: 11 }}>All day</span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setDueDate("");
                      setDueTime("00:00");
                      setDueAllDay(false);
                    }}
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          </div>

          <ChipInput
            label="Tags"
            values={tags}
            placeholder="Type a tag and press Enter"
            icon={<TagIcon size={10} />}
            onChange={setTags}
          />

          <ChipInput
            label="Attendees"
            values={attendees}
            placeholder="Name or email"
            icon={<User size={10} />}
            onChange={setAttendees}
          />

          <label className="event-editor-field">
            <span className="event-editor-field-label">Location</span>
            <div className="event-editor-field-row">
              <MapPin size={12} className="text-tertiary" />
              <input
                className="settings-input"
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Optional location"
              />
            </div>
          </label>

          <label className="event-editor-field">
            <span className="event-editor-field-label">Description (markdown)</span>
            <textarea
              className="settings-input"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="event-editor-field">
            <span className="event-editor-field-label">Color</span>
            <div className="event-editor-color-row">
              {CALENDAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`calendar-color-swatch${c === color ? " selected" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>

          {initial.source_note_path && (
            <div className="event-editor-source-note">
              Source: {initial.source_note_path}
            </div>
          )}

          {error && <div className="calendar-dialog-status error">{error}</div>}
        </div>
        <div className="event-editor-footer">
          <div>
            {event && (
              <button
                type="button"
                className={`event-editor-delete${confirmingDelete ? " confirming" : ""}`}
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                <Trash2 size={12} /> {confirmingDelete ? "Confirm delete" : "Delete"}
              </button>
            )}
          </div>
          <div className="event-editor-footer-right">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSave()}
              disabled={!isValid || saving}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}