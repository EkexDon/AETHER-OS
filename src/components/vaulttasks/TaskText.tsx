import { useMemo } from "react";
import { taskSegments } from "../../lib/vaulttasks/segments";

export interface TaskTextProps {
  text: string;
  /** Clicking a `#tag` chip (e.g. to filter by it). */
  onTag?: (tag: string) => void;
  /** Clicking a `[[wikilink]]` chip (e.g. to open the note). */
  onWikilink?: (target: string) => void;
}

/** Task text with inline `[[wikilinks]]`, `#tags` and code rendered as chips. */
export function TaskText({ text, onTag, onWikilink }: TaskTextProps) {
  const segments = useMemo(() => taskSegments(text), [text]);
  return (
    <span className="vt-text">
      {segments.map((s, i) => {
        switch (s.kind) {
          case "code":
            return (
              <code key={i} className="vt-code">
                {s.text}
              </code>
            );
          case "wikilink":
            return onWikilink ? (
              <button
                key={i}
                type="button"
                className="vt-chip vt-chip-link"
                title={`Open ${s.target}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onWikilink(s.target);
                }}
              >
                {s.label}
              </button>
            ) : (
              <span key={i} className="vt-chip vt-chip-link">
                {s.label}
              </span>
            );
          case "tag":
            return onTag ? (
              <button
                key={i}
                type="button"
                className="vt-chip vt-chip-tag"
                title={`Filter by #${s.tag}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTag(s.tag);
                }}
              >
                #{s.tag}
              </button>
            ) : (
              <span key={i} className="vt-chip vt-chip-tag">
                #{s.tag}
              </span>
            );
          case "link":
            return (
              <span key={i} className="vt-link-text" title={s.url}>
                {s.label}
              </span>
            );
          default:
            return <span key={i}>{s.text}</span>;
        }
      })}
    </span>
  );
}
