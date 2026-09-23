import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";
import "../../styles/views/home.css";
import type { PomodoroSettings } from "../../types";
import { useFocusStore } from "../../lib/focusStore";
import { POMODORO_LIMITS } from "../../lib/home/pomodoro";
import { ensureNotificationPermission, playChime } from "../../lib/home/notify";
import { isTauriRuntime } from "../../lib/ipc";
import { Button, Input, Kbd, Switch, toast } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../../settings/layout";

type NumericKey = keyof typeof POMODORO_LIMITS;

/**
 * A number field that keeps the typed text while editing and commits a
 * clamped value on blur / Enter (so "1" on the way to "15" is not saved).
 */
function MinutesField({ id, field, value, unit }: { id: string; field: NumericKey; value: number; unit: string }) {
  const update = useFocusStore((s) => s.updateSettings);
  const [text, setText] = useState(String(value));
  const { min, max } = POMODORO_LIMITS[field];

  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const n = Number(text);
    if (!text.trim() || !Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    update({ [field]: n } as Partial<PomodoroSettings>);
    // Show the clamped value even when the store did not change.
    setText(String(Math.min(max, Math.max(min, Math.round(n)))));
  };

  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      size="sm"
      className="home-settings-number"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      suffix={<span className="home-settings-unit">{unit}</span>}
    />
  );
}

/** Settings → Focus & Pomodoro. */
export function FocusSettings() {
  const settings = useFocusStore((s) => s.settings);
  const update = useFocusStore((s) => s.updateSettings);
  const reset = useFocusStore((s) => s.resetSettings);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const desktop = isTauriRuntime();

  const setNotifications = async (on: boolean) => {
    update({ notifications: on });
    if (!on || !desktop) return;
    const granted = await ensureNotificationPermission();
    setPermission(granted ? "granted" : "denied");
    if (!granted) {
      toast.error("Notifications are blocked", {
        description: "Allow AETHER-OS in System Settings → Notifications. Home still shows an in-app message.",
      });
    }
  };

  return (
    <SettingsPage
      title="Focus & Pomodoro"
      description="Work in focused intervals with short breaks. Completed sessions feed the focus statistics on Home."
    >
      <SettingsGroup title="Durations">
        <SettingsRow
          label="Focus session"
          hint="Length of one work interval."
          htmlFor="home-focus-work"
          control={<MinutesField id="home-focus-work" field="workMinutes" value={settings.workMinutes} unit="min" />}
        />
        <SettingsRow
          label="Short break"
          htmlFor="home-focus-break"
          control={<MinutesField id="home-focus-break" field="breakMinutes" value={settings.breakMinutes} unit="min" />}
        />
        <SettingsRow
          label="Long break"
          htmlFor="home-focus-long"
          control={<MinutesField id="home-focus-long" field="longBreakMinutes" value={settings.longBreakMinutes} unit="min" />}
        />
        <SettingsRow
          label="Sessions before a long break"
          hint="A full cycle ends with the long break."
          htmlFor="home-focus-cycles"
          control={
            <MinutesField id="home-focus-cycles" field="cyclesBeforeLongBreak" value={settings.cyclesBeforeLongBreak} unit="×" />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Behaviour">
        <SettingsRow
          label="Start breaks automatically"
          hint="When a focus session ends the break begins right away. Focus sessions always wait for you."
          control={
            <Switch
              checked={settings.autoStartBreaks}
              onChange={(v) => update({ autoStartBreaks: v })}
              aria-label="Start breaks automatically"
            />
          }
        />
        <SettingsRow
          label="Desktop notifications"
          hint={
            desktop
              ? permission === "denied"
                ? "Blocked by the system — allow AETHER-OS in System Settings → Notifications."
                : "Notify when a session or break ends."
              : "Available in the desktop app; the browser preview shows in-app messages only."
          }
          control={
            <Switch
              checked={settings.notifications}
              onChange={(v) => void setNotifications(v)}
              aria-label="Desktop notifications"
            />
          }
        />
        <SettingsRow
          label="Sound"
          hint="A short chime when a phase ends."
          control={
            <div className="home-settings-inline">
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<Volume2 size={13} />}
                onClick={() => {
                  if (!playChime()) toast.error("Sound is not available on this system");
                }}
              >
                Test
              </Button>
              <Switch checked={settings.sound} onChange={(v) => update({ sound: v })} aria-label="Sound" />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Shortcuts">
        <SettingsRow label="Start or pause the timer" control={<Kbd shortcut="mod+alt+t" />} />
        <SettingsRow label="Focus mode (press Esc twice to leave)" control={<Kbd shortcut="mod+shift+f" />} />
        <SettingsRow
          label="Reset to defaults"
          hint="25 / 5 / 15 minutes, long break after 4 sessions."
          control={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                reset();
                toast.success("Pomodoro settings reset");
              }}
            >
              Reset
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
