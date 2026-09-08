import { useState } from "react";
import { Download, Upload, X, ChevronDown, ChevronRight } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportCalendarIcs,
  importCalendarIcs,
  readIcsFromPath,
  writeIcsToPath,
} from "../lib/ipc";
import { CALENDAR_COLORS, DEFAULT_CALENDAR_COLOR } from "../lib/calendarColors";
import type { IcsImportResult } from "../types";

type Tab = "export" | "import";

export function CalendarImportExportDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("export");

  const todayIso = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const monthAhead = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(monthAhead);
  const [calendarName, setCalendarName] = useState("AETHER-OS");
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const [overwrite, setOverwrite] = useState(false);
  const [defaultColor, setDefaultColor] = useState<string>(DEFAULT_CALENDAR_COLOR);
  const [importResult, setImportResult] = useState<IcsImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    setExportStatus(null);
    try {
      const content = await exportCalendarIcs(from, to, calendarName.trim() || "AETHER-OS");
      const path = await save({
        defaultPath: "aether-calendar.ics",
        filters: [{ name: "iCalendar", extensions: ["ics"] }],
      });
      if (!path) return;
      await writeIcsToPath(path, content);
      setExportStatus(`Exported to ${path}`);
    } catch (e) {
      setExportStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleCopyToClipboard = async () => {
    setExportStatus(null);
    try {
      const content = await exportCalendarIcs(from, to, calendarName.trim() || "AETHER-OS");
      await navigator.clipboard.writeText(content);
      setExportStatus("Copied ICS to clipboard");
    } catch (e) {
      setExportStatus(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleImportFile = async () => {
    setImportError(null);
    setImportResult(null);
    setImporting(true);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "iCalendar", extensions: ["ics"] }],
      });
      if (!path || typeof path !== "string") {
        setImporting(false);
        return;
      }
      const content = await readIcsFromPath(path);
      const result = await importCalendarIcs(content, overwrite, defaultColor);
      setImportResult(result);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="calendar-dialog-overlay" onClick={onClose}>
      <div className="calendar-dialog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="calendar-dialog-header">
          <span>Calendar Import / Export</span>
          <button className="btn btn-icon" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="calendar-dialog-tabs">
          <button
            className={`calendar-dialog-tab${tab === "export" ? " selected" : ""}`}
            onClick={() => setTab("export")}
          >
            <Download size={12} /> Export
          </button>
          <button
            className={`calendar-dialog-tab${tab === "import" ? " selected" : ""}`}
            onClick={() => setTab("import")}
          >
            <Upload size={12} /> Import
          </button>
        </div>
        <div className="calendar-dialog-body">
          {tab === "export" && (
            <div className="calendar-dialog-section">
              <label className="event-editor-field">
                <span className="event-editor-field-label">From</span>
                <input
                  className="settings-input"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="event-editor-field">
                <span className="event-editor-field-label">To</span>
                <input
                  className="settings-input"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label className="event-editor-field">
                <span className="event-editor-field-label">Calendar name</span>
                <input
                  className="settings-input"
                  type="text"
                  value={calendarName}
                  onChange={(e) => setCalendarName(e.target.value)}
                />
              </label>
              <div className="calendar-dialog-actions">
                <button className="btn btn-primary" onClick={() => void handleExport()}>
                  <Download size={12} /> Export .ics
                </button>
                <button className="btn btn-secondary" onClick={() => void handleCopyToClipboard()}>
                  Copy to clipboard
                </button>
              </div>
              {exportStatus && <div className="calendar-dialog-status">{exportStatus}</div>}
            </div>
          )}
          {tab === "import" && (
            <div className="calendar-dialog-section">
              <button
                className="btn btn-primary"
                onClick={() => void handleImportFile()}
                disabled={importing}
              >
                <Upload size={12} /> Choose .ics file
              </button>
              <label className="event-editor-field-row">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                />
                <span>Overwrite existing events with the same UID</span>
              </label>
              <div className="event-editor-field">
                <span className="event-editor-field-label">Default color (when X-AETHER-COLORS missing)</span>
                <div className="event-editor-color-row">
                  {CALENDAR_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`calendar-color-swatch${c === defaultColor ? " selected" : ""}`}
                      style={{ background: c }}
                      onClick={() => setDefaultColor(c)}
                      aria-label={`Color ${c}`}
                    />
                  ))}
                </div>
              </div>
              {importError && <div className="calendar-dialog-status error">{importError}</div>}
              {importResult && (
                <div className="calendar-import-result">
                  <div className="calendar-import-stats">
                    <span className="calendar-stat-pill">{importResult.added} added</span>
                    <span className="calendar-stat-pill">{importResult.updated} updated</span>
                    <span className="calendar-stat-pill">{importResult.skipped} skipped</span>
                    <span className="calendar-stat-pill">{importResult.errors.length} errors</span>
                  </div>
                  {importResult.errors.length > 0 && (
                    <div className="calendar-import-errors">
                      <button
                        className="calendar-import-errors-toggle"
                        onClick={() => setShowErrors((v) => !v)}
                      >
                        {showErrors ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        Error details
                      </button>
                      {showErrors && (
                        <ul className="calendar-import-errors-list">
                          {importResult.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}