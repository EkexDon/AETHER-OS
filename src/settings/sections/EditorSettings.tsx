import { useState } from "react";
import { useAetherStore } from "../../lib/store";
import { Button, Input, Select } from "../../ui";
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

/** External editor used to open projects (moved from the former SettingsPanel). */
export function EditorSettings() {
  const { preferredEditor, setPreferredEditor } = useAetherStore();
  const [customMode, setCustomMode] = useState(false);
  const [customEditor, setCustomEditor] = useState(() => (isKnown(preferredEditor) ? "" : preferredEditor));
  const known = isKnown(preferredEditor);
  const showCustom = !known || customMode;

  const applyCustom = () => {
    const name = customEditor.trim();
    if (!name) return;
    setPreferredEditor(name);
    setCustomMode(false);
  };

  return (
    <SettingsPage title="Editor" description="How AETHER-OS opens code outside the built-in IDE.">
      <SettingsGroup>
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
          <SettingsRow label="Custom app" hint="The exact macOS application name, e.g. Zed." stacked htmlFor="settings-editor-custom">
            <div className="ui-field-row">
              <Input
                id="settings-editor-custom"
                placeholder="Zed"
                value={customEditor}
                onChange={(e) => setCustomEditor(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCustom();
                }}
              />
              <Button
                variant="primary"
                disabled={!customEditor.trim() || customEditor.trim() === preferredEditor}
                onClick={applyCustom}
              >
                Use
              </Button>
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
