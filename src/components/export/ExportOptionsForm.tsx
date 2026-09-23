import { useId } from "react";
import { Input, SegmentedControl, Switch } from "../../ui";
import type { ExportFlow, ExportOptions, ExportTheme } from "../../types";

export interface ExportOptionsFormProps {
  flow: ExportFlow;
  options: ExportOptions;
  onChange: (patch: Partial<ExportOptions>) => void;
  /** Placeholder for the site title (the vault name). */
  vaultName: string;
}

/** Theme choices of exported HTML. */
export const THEME_OPTIONS: { value: ExportTheme; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Per-flow export options. */
export function ExportOptionsForm({ flow, options, onChange, vaultName }: ExportOptionsFormProps) {
  const id = useId();
  const html = flow !== "bundle";
  return (
    <div className="export-options">
      {flow === "site" && (
        <div className="export-options-fields">
          <div className="ui-field">
            <label className="ui-field-label" htmlFor={`${id}-title`}>
              Site title
            </label>
            <Input
              id={`${id}-title`}
              size="sm"
              value={options.site_title}
              placeholder={vaultName}
              onChange={(e) => onChange({ site_title: e.target.value })}
            />
          </div>
          <div className="ui-field">
            <label className="ui-field-label" htmlFor={`${id}-desc`}>
              Description
            </label>
            <Input
              id={`${id}-desc`}
              size="sm"
              value={options.site_description}
              placeholder="One line under the title on the index page"
              onChange={(e) => onChange({ site_description: e.target.value })}
            />
          </div>
        </div>
      )}

      {html && (
        <div className="export-options-row">
          <span className="export-options-label" id={`${id}-theme`}>
            Theme
          </span>
          <SegmentedControl
            aria-label="Export theme"
            size="sm"
            value={options.theme}
            onChange={(theme) => onChange({ theme })}
            options={THEME_OPTIONS}
          />
        </div>
      )}

      <div className="export-options-switches">
        {html && (
          <Switch
            size="sm"
            checked={options.include_frontmatter}
            onChange={(v) => onChange({ include_frontmatter: v })}
            label="Header from frontmatter"
            description="Date, description and tags above the note"
          />
        )}
        {html && (
          <Switch
            size="sm"
            checked={options.include_backlinks}
            onChange={(v) => onChange({ include_backlinks: v })}
            label="“Linked from” section"
            description="Notes that link to each page"
          />
        )}
        {flow === "bundle" && (
          <Switch
            size="sm"
            checked={options.convert_wikilinks}
            onChange={(v) => onChange({ convert_wikilinks: v })}
            label="Convert wikilinks"
            description="[[Note]] becomes a relative Markdown link; links to notes outside the bundle become text"
          />
        )}
        <Switch
          size="sm"
          checked={options.include_attachments}
          onChange={(v) => onChange({ include_attachments: v })}
          label={flow === "html" ? "Embed images" : "Include attachments"}
          description={
            flow === "html"
              ? "Inline images as data so the file works on its own"
              : "Copy images and files the notes reference"
          }
        />
        {html && (
          <Switch
            size="sm"
            checked={options.include_mermaid_script}
            onChange={(v) => onChange({ include_mermaid_script: v })}
            label="Render mermaid diagrams"
            description="Adds a script from cdn.jsdelivr.net — the only network request an export can make"
          />
        )}
      </div>

      {flow === "site" && (
        <details className="export-advanced">
          <summary>Hosting</summary>
          <div className="export-options-fields">
            <div className="ui-field">
              <label className="ui-field-label" htmlFor={`${id}-base`}>
                Public URL
              </label>
              <Input
                id={`${id}-base`}
                size="sm"
                value={options.base_path}
                placeholder="https://notes.example.com"
                onChange={(e) => onChange({ base_path: e.target.value })}
              />
              <span className="ui-field-hint">Used for sitemap.xml. Leave empty to skip the sitemap.</span>
            </div>
            <div className="ui-field">
              <label className="ui-field-label" htmlFor={`${id}-cname`}>
                Custom domain (CNAME)
              </label>
              <Input
                id={`${id}-cname`}
                size="sm"
                value={options.cname}
                placeholder="notes.example.com"
                onChange={(e) => onChange({ cname: e.target.value })}
              />
              <span className="ui-field-hint">Writes a CNAME file for GitHub Pages.</span>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
