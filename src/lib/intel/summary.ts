/**
 * Helpers for the compaction summary format produced by
 * `src-tauri/src/engine/intel/compaction.rs`:
 *
 * ```
 * Topic: <one line>
 * Facts:
 * - …
 * Decisions:
 * - …
 * Open questions:
 * - …
 * User preferences:
 * - …
 * ```
 *
 * The same `summary` field of a conversation holds either such a summary
 * (compacted sessions) or a plain title (the first 80 characters of the
 * first message), so everything here degrades gracefully.
 */

/** Section headings, in order. */
export const SUMMARY_SECTIONS = ["Facts", "Decisions", "Open questions", "User preferences"] as const;

/** A parsed summary. */
export interface ParsedSummary {
  topic: string | null;
  sections: { title: (typeof SUMMARY_SECTIONS)[number]; items: string[] }[];
}

const HEADING = new RegExp(`^(${SUMMARY_SECTIONS.join("|")}):\\s*$`);

/** True for summaries in the compaction format. */
export function isCompactionSummary(summary: string | null | undefined): boolean {
  if (!summary) return false;
  const lines = summary.split(/\r?\n/);
  return (lines[0] ?? "").trim().startsWith("Topic:") && lines.some((l) => HEADING.test(l.trim()));
}

/** Parse a compaction summary. `none` placeholders are dropped. */
export function parseSummary(summary: string): ParsedSummary {
  const parsed: ParsedSummary = {
    topic: null,
    sections: SUMMARY_SECTIONS.map((title) => ({ title, items: [] })),
  };
  let current: number | null = null;
  for (const raw of summary.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("Topic:")) {
      const topic = line.slice("Topic:".length).trim();
      parsed.topic = topic || null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      current = SUMMARY_SECTIONS.indexOf(heading[1] as (typeof SUMMARY_SECTIONS)[number]);
      continue;
    }
    const item = line.replace(/^[-*•]\s*/, "").trim();
    if (!item || /^(none|n\/a|none recorded)\.?$/i.test(item)) continue;
    if (current === null) current = 0;
    parsed.sections[current].items.push(item);
  }
  return parsed;
}

/** Number of bullets across all sections. */
export function summaryItemCount(parsed: ParsedSummary): number {
  return parsed.sections.reduce((n, s) => n + s.items.length, 0);
}

/** One-line title of a conversation for the history list. */
export function conversationTitle(summary: string | null | undefined): string {
  const text = (summary ?? "").trim();
  if (!text) return "Conversation";
  const first = text.split(/\r?\n/)[0].trim();
  const title = isCompactionSummary(text) ? first.slice("Topic:".length).trim() : first;
  const chars = [...title];
  return chars.length > 81 ? `${chars.slice(0, 80).join("")}…` : title || "Conversation";
}
