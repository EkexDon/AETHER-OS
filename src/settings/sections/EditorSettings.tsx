import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { editorNameProblem } from "../../lib/editors";
import { EDITOR_FONT_SIZE, EDITOR_LINE_WIDTH, useOnboardingStore } from "../../lib/onboardingStore";
import { Button, IconButton, Input, Select } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

const KNOWN_EDITORS = [
  { value: "devin", label: "Devin" },
  { value: "windsurf", label: "Windsurf" },
  { value: "cursor", label: "Cursor" },
  { value: "code", label: "VS Code" },
];

function isKnown(editor: string): boolean {
  return KNOWN_EDITORS.some((e) => e.value === editor);
}

/** A labelled range slider with its value and a reset button. */
function RangeControl({
  id,
  value,
  min,
  max,
  step,
  unit,
  defaultValue,
  onChange,
  label,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  defaultValue: number;
  onChange: (value: number) => void;
  label: string;
}) {
  return (
    <div className="obs-slider">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${value} ${unit}`}
      />
      <span className="obs-slider-value tabular">
        {value} {unit}
      </span>
      <IconButton
        size="sm"
        label={`Reset ${label}`}
        icon={<RotateCcw size={14} />}
        disabled={value === defaultValue}
        onClick={() => onChange(defaultValue)}
      />
    </div>
  );
}

/** Note editor typography and the external editor used to open projects. */
export function EditorSettings() {
  const editorFontSize = useOnboardingStore((s) => s.prefs.editorFontSize);
  const editorLineWidth = useOnboardingStore((s) => s.prefs.editorLineWidth);
  const setPrefs = useOnboardingStore((s) => s.setPrefs);
  const { preferredEditor, setPreferredEditor } = useAetherStore();
  const [customMode, setCustomMode] = useState(false);
  const [customEditor, setCustomEditor] = useState(() => (isKnown(preferredEditor) ? "" : preferredEditor));
  const known = isKnown(preferredEditor);
  const showCustom = !known || customMode;

  const customProblem = customEditor.trim() ? editorNameProblem(customEditor) : null;
  const applyCustom = () => {
    const name = customEditor.trim();
    if (!name || editorNameProblem(name)) return;
    setPreferredEditor(name);
    setCustomMode(false);
  };

  return (
    <SettingsPage title="Editor" description="How notes look while you write, and how AETHER-OS opens code outside the built-in IDE.">
      <SettingsGroup title="Note editor" description="Applies instantly to the Notes view.">
        <SettingsRow
          label="Text size"
          hint="Body text of notes; headings scale with it."
          htmlFor="settings-editor-font-size"
          control={
            <RangeControl
              id="settings-editor-font-size"
              label="text size"
              value={editorFontSize}
              min={EDITOR_FONT_SIZE.min}
              max={EDITOR_FONT_SIZE.max}
              step={1}
              unit="px"
              defaultValue={EDITOR_FONT_SIZE.default}
              onChange={(v) => setPrefs({ editorFontSize: v })}
            />
          }
        />
        <SettingsRow
          label="Line width"
          hint="Maximum width of the writing column."
          htmlFor="settings-editor-line-width"
          control={
            <RangeControl
              id="settings-editor-line-width"
              label="line width"
              value={editorLineWidth}
              min={EDITOR_LINE_WIDTH.min}
              max={EDITOR_LINE_WIDTH.max}
              step={EDITOR_LINE_WIDTH.step}
              unit="px"
              defaultValue={EDITOR_LINE_WIDTH.default}
              onChange={(v) => setPrefs({ editorLineWidth: v })}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="External editor">
        <SettingsRow
          label="Default external editor"
          hint="Used when you open a project from the Projects view."
          htmlFor="settings-editor"
          control={
            <Select
              id="settings-editor"
              value={known && !customMode ? preferredEditor : "custom"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") {
                  setCustomMode(true);
                  setCustomEditor(known ? "" : preferredEditor);
                } else {
                  setCustomMode(false);
                  setPreferredEditor(v);
                }
              }}
              options={[...KNOWN_EDITORS, { value: "custom", label: "Custom…" }]}
              className="settings-select"
            />
          }
        />
        {showCustom && (
          <SettingsRow
            label="Custom app"
            hint="The app's name exactly as it appears in Applications, e.g. Zed or Sublime Text — not a path. AETHER-OS opens it with “open -a”."
            stacked
            htmlFor="settings-editor-custom"
          >
            <div className="ui-field-row">
              <Input
                id="settings-editor-custom"
                placeholder="Zed"
                value={customEditor}
                invalid={!!customProblem}
                aria-invalid={customProblem ? true : undefined}
                aria-describedby={customProblem ? "settings-editor-custom-error" : undefined}
                onChange={(e) => setCustomEditor(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCustom();
                }}
              />
              <Button
                variant="primary"
                disabled={!customEditor.trim() || !!customProblem || customEditor.trim() === preferredEditor}
                onClick={applyCustom}
              >
                Use
              </Button>
            </div>
            {customProblem && (
              <span className="ui-field-error" id="settings-editor-custom-error" role="alert">
                {customProblem}
              </span>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
