/**
 * Split a task's clean text into renderable segments: plain text, inline
 * code, `[[wikilinks]]`, Markdown links and `#tags`.
 */

/** One piece of task text. */
export type TaskSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "wikilink"; target: string; label: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "tag"; tag: string };

const SEGMENT_RE =
  /(`[^`]*`)|\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|(^|[ \t(])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
const ALPHABETIC_RE = /\p{Alphabetic}/u;

/** Segments of `text`, adjacent plain text merged. */
export function taskSegments(text: string): TaskSegment[] {
  const out: TaskSegment[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += value;
    else out.push({ kind: "text", text: value });
  };
  let cursor = 0;
  for (const m of text.matchAll(SEGMENT_RE)) {
    const start = m.index ?? 0;
    pushText(text.slice(cursor, start));
    cursor = start + m[0].length;
    if (m[1] !== undefined) {
      out.push({ kind: "code", text: m[1].slice(1, -1) });
    } else if (m[2] !== undefined) {
      const target = m[2].trim();
      const heading = m[3]?.trim();
      const alias = m[4]?.trim();
      out.push({ kind: "wikilink", target, label: alias || (heading ? `${target} › ${heading}` : target) });
    } else if (m[5] !== undefined && m[6] !== undefined) {
      out.push({ kind: "link", label: m[5], url: m[6] });
    } else if (m[8] !== undefined) {
      pushText(m[7] ?? "");
      if (ALPHABETIC_RE.test(m[8])) out.push({ kind: "tag", tag: m[8] });
      else pushText(`#${m[8]}`);
    }
  }
  pushText(text.slice(cursor));
  return out;
}

/**
 * Readable one-line title of a task text: wikilink aliases, link labels and
 * code as plain text, `#tags` dropped (they become labels elsewhere).
 */
export function plainTaskTitle(text: string): string {
  const parts = taskSegments(text).map((s) => {
    switch (s.kind) {
      case "tag":
        return "";
      case "wikilink":
      case "link":
        return s.label;
      default:
        return s.text;
    }
  });
  return parts.join("").replace(/\s+/g, " ").replace(/\(\s*\)/g, "").trim();
}
