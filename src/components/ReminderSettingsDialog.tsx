import { useEffect, useState } from "react";
import { X, Bell } from "lucide-react";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useAetherStore } from "../lib/store";
import type { ReminderSettings } from "../types";

const LEAD_OPTIONS: { label: string; minutes: number }[] = [
  { label: "1 day before", minutes: 1440 },
  { label: "1 hour before", minutes: 60 },
  { label: "30 minutes before", minutes: 30 },
  { label: "15 minutes before", minutes: 15 },
  { label: "5 minutes before", minutes: 5 },
  { label: "At start", minutes: 0 },
];

export function ReminderSettingsDialog({ onClose }: { onClose: () => void }) {
  const { reminderSettings, setReminderSettings } = useAetherStore();
  const [enabled, setEnabled] = useState(reminderSettings.enabled);
  const [leadTimes, setLeadTimes] = useState<number[]>(reminderSettings.lead_times_minutes);
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void isPermissionGranted()
      .then((g: boolean) => {
        if (!cancelled) setGranted(g);
      })
      .catch(() => {
        if (!cancelled) setGranted(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleLead = (minutes: number) => {
    setLeadTimes((prev) =>
      prev.includes(minutes) ? prev.filter((m) => m !== minutes) : [...prev, minutes].sort((a, b) => b - a)
    );
  };

  const handleRequest = async () => {
    try {
      const g = await requestPermission();
      setGranted(g === "granted");
    } catch {
      setGranted(false);
    }
  };

  const handleSave = () => {
    const next: ReminderSettings = { enabled, lead_times_minutes: leadTimes };
    setReminderSettings(next);
    onClose();
  };

  const preview = (() => {
    if (!enabled) return "Notifications are disabled.";
    const sorted = [...leadTimes].sort((a, b) => b - a);
    const labels = sorted.map((m) =>
      m === 0 ? "at start of each event" : `${m} minutes before each event`
    );
    if (labels.length === 0) return "You will not be notified.";
    if (labels.length === 1) return `You will be notified ${labels[0]}.`;
    return `You will be notified ${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}.`;
  })();

  return (
    <div className="calendar-dialog-overlay" onClick={onClose}>
      <div className="calendar-dialog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="calendar-dialog-header">
          <Bell size={14} />
          <span>Reminder settings</span>
          <button className="btn btn-icon" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="calendar-dialog-body">
          <label className="event-editor-field-row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>Enable notifications</span>
          </label>
          {enabled && (
            <div className="reminder-lead-times">
              <div className="event-editor-field-label">Notify me…</div>
              {LEAD_OPTIONS.map((opt) => (
                <label key={opt.minutes} className="event-editor-field-row">
                  <input
                    type="checkbox"
                    checked={leadTimes.includes(opt.minutes)}
                    onChange={() => toggleLead(opt.minutes)}
                  />
                  <span>
                    {opt.label} ({opt.minutes} min)
                  </span>
                </label>
              ))}
            </div>
          )}
          {enabled && granted === false && (
            <div className="calendar-dialog-status">
              System notifications are not granted. Click below to request permission.
            </div>
          )}
          {granted === false && (
            <button className="btn btn-secondary" onClick={() => void handleRequest()}>
              Request permission
            </button>
          )}
          <div className="reminder-preview">{preview}</div>
        </div>
        <div className="event-editor-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}