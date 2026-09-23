import { useMemo } from "react";
import { parseMarkedSnippet, segmentsFromPositions, type Segment } from "../../lib/search/highlight";
import { cx } from "../../ui";

function renderSegments(segments: Segment[]) {
  return segments.map((s, i) =>
    s.mark ? (
      <mark key={i} className="search-mark">
        {s.text}
      </mark>
    ) : (
      <span key={i}>{s.text}</span>
    )
  );
}

/**
 * Render a backend `snippet_html` safely: only the `<mark>` pairs become
 * elements, every other character is plain React text.
 */
export function HighlightedSnippet({ html, className }: { html: string; className?: string }) {
  const segments = useMemo(() => parseMarkedSnippet(html), [html]);
  return <span className={cx("search-snippet", className)}>{renderSegments(segments)}</span>;
}

/** Text with the characters at `positions` highlighted (client-side fuzzy matches). */
export function HighlightedText({ text, positions, className }: { text: string; positions: number[]; className?: string }) {
  const segments = useMemo(() => segmentsFromPositions(text, positions), [text, positions]);
  return <span className={className}>{renderSegments(segments)}</span>;
}
