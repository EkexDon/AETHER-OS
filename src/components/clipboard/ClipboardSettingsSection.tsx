import { useEffect, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import type { ClipboardSettings } from "../../types";
import { useClipboardStore } from "../../lib/clipboardStore";
import { formatBytes } from "../../lib/clipboard/format";
import { SettingsGroup, SettingsPage, SettingsRow } from "../../settings/layout";
import { Button, Input, Select, Spinner, Switch, useToast } from "../../ui";
import { ClearHistoryModal } from "./ClearHistoryModal";

const KEEP_PRESETS = [1, 7, 14, 30, 90, 180, 365];
const MAX_ITEMS_MIN = 10;
const MAX_ITEMS_MAX = 10_000;

/** Options for the retention select; keeps a custom value from settings.json. */
export function keepDayOptions(current: number): { value: string; label: string }[] {
  const days = new Set(KEEP_PRESETS);
  if (current > 0) days.add(current);
  const options = [...days]
    .sort((a, b) => a - b)
    .map((d) => ({ value: String(d), label: d === 1 ? "1 day" : d === 7 ? "1 week" : d === 30 ? "30 days" : d === 365 ? "1 year" : `${d} days` }));
  return [...options, { value: "0", label: "Forever" }];
}

/** Settings → Clipboard: capture switches, retention, clear history. */
export function ClipboardSettingsSection() {
  const toast = useToast();
  const settings = useClipboardStore((s) => s.settings);
  const stats = useClipboardStore((s) => s.stats);
  const saveSettings = useClipboardStore((s) => s.saveSettings);
  const [maxItems, setMaxItems] = useState("");
  const [clearOpen, setClearOpen] = useState(false);

  useEffect(() => {
    const state = useClipboardStore.getState();
    void state.loadSettings();
    void state.refreshStats();
  }, []);

  useEffect(() => {
    if (settings) setMaxItems(String(settings.max_items));
  }, [settings]);

  const save = async (patch: Partial<ClipboardSettings>) => {
    if (!settings) return;
    try {
      await saveSettings({ ...settings, ...patch });
    } catch (e) {
      toast.error("Could not save clipboard settings", { description: e instanceof Error ? e.message : String(e) });
      setMaxItems(String(settings.max_items));
    }
  };

  const parsedMax = Number(maxItems);
  const maxInvalid = !Number.isInteger(parsedMax) || parsedMax < MAX_ITEMS_MIN || parsedMax > MAX_ITEMS_MAX;
  const commitMax = () => {
    if (!settings || maxInvalid || parsedMax === settings.max_items) return;
    void save({ max_items: parsedMax });
  };

  if (!settings) {
    return (
      <SettingsPage title="Clipboard" description="System-wide clipboard history.">
        <div className="view-loading">
          <Spinner size={14} /> Loading…
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Clipboard"
      description="Everything you copy on this Mac — text, links, code, colors and images — searchable in one place. The history never leaves this machine."
    >
      <SettingsGroup title="Capture">
        <SettingsRow
          label="Record clipboard history"
          hint="Turn off to stop recording without deleting the history."
          control={<Switch checked={settings.enabled} onChange={(enabled) => void save({ enabled })} aria-label="Record clipboard history" />}
        />
        <SettingsRow
          label="Capture images"
          hint="Screenshots and copied pictures are stored as PNG files."
          control={
            <Switch
              checked={settings.capture_images}
              disabled={!settings.enabled}
              onChange={(capture_images) => void save({ capture_images })}
              aria-label="Capture images"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Retention" description="Pinned clips are always kept and do not count towards the limit.">
        <SettingsRow
          label="Maximum clips"
          hint={`Oldest unpinned clips are removed beyond this (${MAX_ITEMS_MIN}–${MAX_ITEMS_MAX.toLocaleString("en-US")}).`}
          htmlFor="clip-max-items"
          control={
            <Input
              id="clip-max-items"
              className="clip-settings-number"
              type="number"
              inputMode="numeric"
              min={MAX_ITEMS_MIN}
              max={MAX_ITEMS_MAX}
              step={50}
              size="sm"
              value={maxItems}
              invalid={maxInvalid}
              onChange={(e) => setMaxItems(e.target.value)}
              onBlur={commitMax}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitMax();
              }}
            />
          }
        />
        <SettingsRow
          label="Keep clips for"
          hint="Unpinned clips not copied again within this time are removed."
          htmlFor="clip-keep-days"
          control={
            <Select
              id="clip-keep-days"
              size="sm"
              value={String(settings.keep_days)}
              options={keepDayOptions(settings.keep_days)}
              onChange={(e) => void save({ keep_days: Number(e.target.value) })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Privacy">
        <div className="clip-settings-privacy">
          <ShieldCheck size={16} />
          <p>
            Text that looks like a password, API key, access token, private key or card number is never recorded
            {stats && stats.skipped_secrets > 0
              ? ` (${stats.skipped_secrets} skipped this session)`
              : ""}
            . Pause capture from the Clipboard view or the command palette while you handle sensitive data.
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup title="History">
        <SettingsRow
          label="Clear history"
          hint={
            stats
              ? `${stats.total.toLocaleString("en-US")} clips · ${stats.pinned} pinned · ${formatBytes(stats.bytes)} on disk`
              : "Delete every clip from this Mac."
          }
          control={
            <Button variant="danger" size="sm" iconLeft={<Trash2 size={14} />} disabled={!stats || stats.total === 0} onClick={() => setClearOpen(true)}>
              Clear history…
            </Button>
          }
        />
      </SettingsGroup>
      <ClearHistoryModal open={clearOpen} onClose={() => setClearOpen(false)} />
    </SettingsPage>
  );
}
