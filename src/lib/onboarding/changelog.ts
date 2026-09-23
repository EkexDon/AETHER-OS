/**
 * Minimal Keep-a-Changelog parser for the "What's new" dialog. Sections are
 * `## …` headings such as `## [0.2.0] - 2026-10-01`, `## 0.2.0 (2026-10-01)`
 * or `## Unreleased`.
 */
import { compareVersions, parseVersion } from "./version";

/** One version section of the changelog. */
export interface ChangelogSection {
  /** `"0.2.0"` or `"Unreleased"`. */
  version: string;
  /** `YYYY-MM-DD` when the heading carries a date. */
  date: string | null;
  /** Markdown below the heading (without it), trimmed. */
  body: string;
}

const HEADING = /^##\s+(?!#)(.+?)\s*$/;
const DATE = /(\d{4}-\d{2}-\d{2})/;

function parseHeading(text: string): { version: string; date: string | null } {
  const date = DATE.exec(text)?.[1] ?? null;
  const cleaned = text.replace(DATE, "").replace(/[()[\]]/g, " ").replace(/\s+-\s*$/, "").trim();
  if (/^unreleased\b/i.test(cleaned)) return { version: "Unreleased", date };
  const token = cleaned.split(/\s+/)[0] ?? cleaned;
  const version = parseVersion(token) ? token.replace(/^v/, "") : cleaned;
  return { version, date };
}

/** Split a changelog into its `##` sections, in file order. */
export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { version: string; date: string | null; lines: string[] } | null = null;
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      if (current) sections.push({ version: current.version, date: current.date, body: current.lines.join("\n").trim() });
      current = { ...parseHeading(heading[1]), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ version: current.version, date: current.date, body: current.lines.join("\n").trim() });
  return sections;
}

/**
 * Release notes to show for `version`: its own section, else the
 * `Unreleased` section (development builds), else the newest release, else
 * `null` when the changelog has no sections with content.
 */
export function releaseNotesFor(markdown: string, version: string): ChangelogSection | null {
  const sections = parseChangelog(markdown).filter((s) => s.body.length > 0);
  const exact = sections.find((s) => s.version !== "Unreleased" && compareVersions(s.version, version) === 0);
  if (exact) return exact;
  const unreleased = sections.find((s) => s.version === "Unreleased");
  if (unreleased) return unreleased;
  const releases = sections.filter((s) => parseVersion(s.version));
  releases.sort((a, b) => compareVersions(b.version, a.version));
  return releases[0] ?? null;
}
