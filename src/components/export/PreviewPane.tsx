import { useEffect, useRef, useState } from "react";
import { Eye } from "lucide-react";
import { EmptyState, SegmentedControl, Select, Spinner } from "../../ui";
import { exportPreviewHtml, exportPreviewMarkdown } from "../../lib/ipc";
import type { ExportFlow, ExportOptions, ExportScope, ScopeNote } from "../../types";
import { THEME_OPTIONS } from "./ExportOptionsForm";

/** Wait this long after the last change before re-rendering the preview. */
const PREVIEW_DEBOUNCE_MS = 250;

export interface PreviewPaneProps {
  flow: ExportFlow;
  scope: ExportScope;
  options: ExportOptions;
  /** Notes of the resolved scope (preview candidates). */
  notes: ScopeNote[];
  onThemeChange: (theme: ExportOptions["theme"]) => void;
}

/** Live preview: the rendered page (HTML, site) or the converted Markdown (bundle). */
export function PreviewPane({ flow, scope, options, notes, onThemeChange }: PreviewPaneProps) {
  const [notePath, setNotePath] = useState<string | null>(notes[0]?.path ?? null);
  const [html, setHtml] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  // Keep the previewed note inside the scope.
  useEffect(() => {
    if (!notes.length) setNotePath(null);
    else if (!notePath || !notes.some((n) => n.path === notePath)) setNotePath(notes[0].path);
  }, [notes, notePath]);

  const optionsKey = JSON.stringify(options);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    if (!notePath) {
      setHtml(null);
      setMarkdown(null);
      return;
    }
    const id = ++request.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const run =
        flow === "bundle"
          ? exportPreviewMarkdown(scope, notePath, options).then((md) => {
              if (id === request.current) {
                setMarkdown(md);
                setHtml(null);
              }
            })
          : exportPreviewHtml(notePath, options).then((doc) => {
              if (id === request.current) {
                setHtml(doc);
                setMarkdown(null);
              }
            });
      run
        .then(() => id === request.current && setError(null))
        .catch((e) => id === request.current && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => id === request.current && setLoading(false));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `options`/`scope` are compared by value through their JSON keys.
  }, [flow, notePath, optionsKey, scopeKey]);

  return (
    <div className="export-preview">
      <div className="export-preview-bar">
        <span className="ui-section-label">
          <Eye size={14} /> {flow === "bundle" ? "Markdown preview" : "Page preview"}
        </span>
        <div className="export-preview-controls">
          {notes.length > 1 && (
            <Select
              size="sm"
              aria-label="Note to preview"
              value={notePath ?? ""}
              onChange={(e) => setNotePath(e.target.value)}
              options={notes.slice(0, 200).map((n) => ({ value: n.path, label: n.rel }))}
              className="export-preview-select"
            />
          )}
          {flow !== "bundle" && (
            <SegmentedControl
              aria-label="Preview theme"
              size="sm"
              value={options.theme}
              onChange={onThemeChange}
              options={THEME_OPTIONS}
            />
          )}
        </div>
      </div>
      <div className="export-preview-frame">
        {!notePath ? (
          <EmptyState size="sm" icon={Eye} title="Nothing to preview" description="Choose what to export on the left." />
        ) : error ? (
          <div className="export-preview-error">
            <div className="ui-notice ui-notice-danger" role="alert">
              {error}
            </div>
          </div>
        ) : markdown !== null ? (
          <pre className="export-preview-markdown" tabIndex={0} aria-label="Converted Markdown">
            {markdown}
          </pre>
        ) : html !== null ? (
          // No `allow-scripts`: exported pages never run code in the preview.
          <iframe title="Export preview" className="export-preview-iframe" sandbox="" srcDoc={html} />
        ) : null}
        {loading && (
          <div className="export-preview-loading">
            <Spinner size={14} label="Rendering preview" />
          </div>
        )}
      </div>
    </div>
  );
}
