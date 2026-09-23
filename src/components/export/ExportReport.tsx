import { CircleCheck, ExternalLink, FolderOpen, TriangleAlert } from "lucide-react";
import { Button } from "../../ui";
import { formatBytes, formatDuration, plural } from "../../lib/export/format";
import type { BundleReport, NoteExportReport, SiteReport } from "../../types";

/** A finished export. */
export type ExportResult =
  | { flow: "html"; report: NoteExportReport }
  | { flow: "site"; report: SiteReport }
  | { flow: "bundle"; report: BundleReport };

export interface ExportReportProps {
  result: ExportResult;
  onOpen: (path: string, reveal: boolean) => void;
}

interface Stat {
  label: string;
  value: string;
  tone?: "warning";
}

function statsFor(result: ExportResult): Stat[] {
  switch (result.flow) {
    case "html": {
      const r = result.report;
      return [
        { label: "Images inlined", value: String(r.attachments) },
        { label: "Unresolved links", value: String(r.missing_links), tone: r.missing_links ? "warning" : undefined },
        { label: "Size", value: formatBytes(r.bytes) },
        { label: "Time", value: formatDuration(r.ms) },
      ];
    }
    case "site": {
      const r = result.report;
      return [
        { label: "Pages", value: r.pages.toLocaleString() },
        { label: "Tag pages", value: r.tag_pages.toLocaleString() },
        { label: "Attachments", value: r.attachments.toLocaleString() },
        {
          label: "Missing links",
          value: r.missing_link_count.toLocaleString(),
          tone: r.missing_link_count ? "warning" : undefined,
        },
        { label: "Size", value: formatBytes(r.bytes) },
        { label: "Time", value: formatDuration(r.ms) },
      ];
    }
    case "bundle": {
      const r = result.report;
      return [
        { label: "Notes", value: r.notes.toLocaleString() },
        { label: "Attachments", value: r.attachments.toLocaleString() },
        { label: "Links converted", value: r.converted_links.toLocaleString() },
        {
          label: "Links to outside",
          value: r.unresolved_links.toLocaleString(),
          tone: r.unresolved_links ? "warning" : undefined,
        },
        { label: "Size", value: formatBytes(r.bytes) },
        { label: "Time", value: formatDuration(r.ms) },
      ];
    }
  }
}

function headline(result: ExportResult): string {
  switch (result.flow) {
    case "html":
      return `“${result.report.title}” exported`;
    case "site":
      return `Site published — ${plural(result.report.pages, "page")}`;
    case "bundle":
      return `Bundle created — ${plural(result.report.notes, "note")}`;
  }
}

/** Summary of a finished export with shortcuts to open or reveal it. */
export function ExportReport({ result, onOpen }: ExportReportProps) {
  const stats = statsFor(result);
  const path = result.flow === "site" ? result.report.out_dir : result.report.path;
  const notices: string[] = [...result.report.warnings];
  if (result.flow === "site") {
    if (result.report.skipped) {
      notices.unshift(`${plural(result.report.skipped, "note")} skipped because of \`publish: false\`.`);
    }
    if (result.report.removed_stale) {
      notices.push(`${plural(result.report.removed_stale, "file")} from the previous export removed.`);
    }
  }
  return (
    <div className="export-report" role="status" aria-live="polite">
      <div className="export-report-head">
        <span className="export-report-icon" aria-hidden="true">
          <CircleCheck size={18} />
        </span>
        <div className="export-report-titles">
          <h3 className="export-report-title">{headline(result)}</h3>
          <p className="export-report-path mono" title={path}>
            {path}
          </p>
        </div>
      </div>

      <dl className="export-report-stats">
        {stats.map((s) => (
          <div key={s.label} className={s.tone === "warning" ? "export-stat is-warning" : "export-stat"}>
            <dt>{s.label}</dt>
            <dd className="tabular">{s.value}</dd>
          </div>
        ))}
      </dl>

      {notices.length > 0 && (
        <ul className="export-report-notices">
          {notices.map((n) => (
            <li key={n} className="ui-notice ui-notice-warning">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      {result.flow === "site" && result.report.missing_links.length > 0 && (
        <details className="export-missing">
          <summary>
            Unresolved links ({result.report.missing_link_count.toLocaleString()}) — rendered as plain text
          </summary>
          <ul>
            {result.report.missing_links.map((m, i) => (
              <li key={`${m.note}-${m.target}-${i}`}>
                <span className="export-missing-note">{m.note}</span>
                <span aria-hidden="true">→</span>
                <span className="mono">{m.target}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="export-report-actions">
        {result.flow === "site" && (
          <Button
            variant="primary"
            iconLeft={<ExternalLink size={14} />}
            onClick={() => onOpen(result.report.index_path, false)}
          >
            Open site in browser
          </Button>
        )}
        {result.flow === "html" && (
          <Button variant="primary" iconLeft={<ExternalLink size={14} />} onClick={() => onOpen(result.report.path, false)}>
            Open in browser
          </Button>
        )}
        <Button
          variant={result.flow === "bundle" ? "primary" : "secondary"}
          iconLeft={<FolderOpen size={14} />}
          onClick={() => onOpen(path, true)}
        >
          Reveal in Finder
        </Button>
      </div>
    </div>
  );
}
