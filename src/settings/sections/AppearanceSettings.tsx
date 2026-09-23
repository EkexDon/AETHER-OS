import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useThemeStore, type ThemePreference } from "../../lib/theme";
import { ACCENTS, useAppearanceStore, type AccentId, type Density } from "../../lib/appearance";
import { SegmentedControl, Switch, cx } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

/** Theme, accent, density and navigation-label preferences. */
export function AppearanceSettings() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const { accent, setAccent, density, setDensity, railExpanded, setRailExpanded } = useAppearanceStore();

  return (
    <SettingsPage title="Appearance" description="Make AETHER-OS feel like yours. Changes apply instantly.">
      <SettingsGroup>
        <SettingsRow
          label="Theme"
          hint="System follows your macOS appearance."
          control={
            <SegmentedControl<ThemePreference>
              aria-label="Theme"
              value={preference}
              onChange={setPreference}
              options={[
                { value: "system", label: "System", icon: <Monitor size={14} /> },
                { value: "light", label: "Light", icon: <Sun size={14} /> },
                { value: "dark", label: "Dark", icon: <Moon size={14} /> },
              ]}
            />
          }
        />
        <SettingsRow
          label="Accent"
          hint="Used sparingly: primary actions, focus and the active workspace."
          control={
            <div className="accent-picker" role="radiogroup" aria-label="Accent color">
              {ACCENTS.map((a) => {
                const selected = a.id === accent;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={a.label}
                    title={a.label}
                    className={cx("accent-swatch", selected && "is-selected")}
                    data-accent-swatch={a.id}
                    onClick={() => setAccent(a.id as AccentId)}
                  >
                    <span className="accent-swatch-color" style={{ background: a.swatch }} />
                    {selected && <Check size={14} strokeWidth={3} className="accent-swatch-check" />}
                  </button>
                );
              })}
            </div>
          }
        />
        <SettingsRow
          label="Density"
          hint="Compact fits more rows on screen; comfortable adds breathing room."
          control={
            <SegmentedControl<Density>
              aria-label="Density"
              value={density}
              onChange={setDensity}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Navigation labels"
          hint="Show workspace names next to the icons in the left rail."
          control={
            <Switch checked={railExpanded} onChange={setRailExpanded} aria-label="Show navigation labels" />
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
