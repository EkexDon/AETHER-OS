import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { PluginInfo, PluginSettingSpec, PluginSettingsValues } from "../../types";
import { getPluginSettings } from "../../lib/ipc";
import { usePluginsStore } from "../../lib/pluginsStore";
import { getPluginHost } from "../../lib/plugins/host";
import { defaultSettingValue, settingValueProblem } from "../../lib/plugins/manifest";
import { Button, Input, Select, Spinner, Switch, useToast } from "../../ui";

/** Draft values: numbers are edited as text until they are saved. */
type Draft = Record<string, string | boolean>;

function toDraft(specs: PluginSettingSpec[], values: PluginSettingsValues): Draft {
  const draft: Draft = {};
  for (const spec of specs) {
    const value = values[spec.key] ?? defaultSettingValue(spec);
    draft[spec.key] = typeof value === "boolean" ? value : String(value);
  }
  return draft;
}

/** Convert a draft entry back to a typed value (numbers parsed). */
export function parseDraftValue(spec: PluginSettingSpec, value: string | boolean): string | number | boolean {
  if (spec.type === "number") {
    const text = String(value).trim();
    return text === "" ? Number.NaN : Number(text);
  }
  return value;
}

/** Settings form generated from a plugin manifest's `settings`. */
export function PluginSettingsForm({ plugin }: { plugin: PluginInfo }) {
  const id = plugin.manifest.id;
  const specs = plugin.manifest.settings;
  const toast = useToast();
  const saveSettings = usePluginsStore((s) => s.saveSettings);
  const [saved, setSaved] = useState<PluginSettingsValues | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    getPluginSettings(id)
      .then((values) => {
        if (!active) return;
        setSaved(values);
        setDraft(toDraft(specs, values));
      })
      .catch((error) => active && setLoadError(error instanceof Error ? error.message : String(error)));
    return () => {
      active = false;
    };
  }, [id, specs]);

  const problems = useMemo(() => {
    const out: Record<string, string> = {};
    for (const spec of specs) {
      if (!(spec.key in draft)) continue;
      const problem = settingValueProblem(spec, parseDraftValue(spec, draft[spec.key]));
      if (problem) out[spec.key] = `${spec.label} ${problem}`;
    }
    return out;
  }, [draft, specs]);

  const changed = useMemo(() => {
    if (!saved) return {};
    const out: Partial<PluginSettingsValues> = {};
    for (const spec of specs) {
      if (!(spec.key in draft)) continue;
      const value = parseDraftValue(spec, draft[spec.key]);
      if (value !== saved[spec.key]) out[spec.key] = value;
    }
    return out;
  }, [draft, saved, specs]);

  if (loadError) return <div className="ui-notice ui-notice-danger">Settings could not be loaded: {loadError}</div>;
  if (!saved) {
    return (
      <div className="plugin-settings-loading">
        <Spinner size={14} label="Loading settings" />
      </div>
    );
  }

  const dirty = Object.keys(changed).length > 0;
  const invalid = Object.keys(problems).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const values = await saveSettings(id, changed);
      setSaved(values);
      setDraft(toDraft(specs, values));
      getPluginHost().notifySettingsChanged(id, values);
      toast.success(`${plugin.manifest.name} settings saved`);
    } catch (error) {
      toast.error("Settings were not saved", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = () => {
    const defaults: PluginSettingsValues = {};
    for (const spec of specs) defaults[spec.key] = defaultSettingValue(spec);
    setDraft(toDraft(specs, defaults));
  };

  const set = (key: string, value: string | boolean) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <form
      className="plugin-settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) void save();
      }}
    >
      {specs.map((spec) => {
        const fieldId = `plugin-setting-${id}-${spec.key}`;
        const value = draft[spec.key];
        if (spec.type === "boolean") {
          return (
            <div key={spec.key} className="plugin-settings-row">
              <Switch
                id={fieldId}
                checked={value === true}
                onChange={(checked) => set(spec.key, checked)}
                label={spec.label}
                description={spec.description ?? undefined}
              />
            </div>
          );
        }
        return (
          <div key={spec.key} className="ui-field plugin-settings-row">
            <label className="ui-field-label" htmlFor={fieldId}>
              {spec.label}
            </label>
            {spec.type === "select" ? (
              <Select
                id={fieldId}
                size="sm"
                value={String(value ?? "")}
                onChange={(e) => set(spec.key, e.target.value)}
                options={(spec.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
              />
            ) : (
              <Input
                id={fieldId}
                size="sm"
                type={spec.type === "number" ? "number" : "text"}
                inputMode={spec.type === "number" ? "decimal" : undefined}
                min={spec.min ?? undefined}
                max={spec.max ?? undefined}
                value={String(value ?? "")}
                invalid={!!problems[spec.key]}
                onChange={(e) => set(spec.key, e.target.value)}
                aria-describedby={spec.description || problems[spec.key] ? `${fieldId}-hint` : undefined}
              />
            )}
            {(problems[spec.key] || spec.description) && (
              <span id={`${fieldId}-hint`} className={problems[spec.key] ? "ui-field-error" : "ui-field-hint"}>
                {problems[spec.key] ?? spec.description}
              </span>
            )}
          </div>
        );
      })}
      <div className="plugin-settings-actions">
        <Button variant="ghost" size="sm" iconLeft={<RotateCcw size={14} />} onClick={resetToDefaults}>
          Defaults
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirty || invalid}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
