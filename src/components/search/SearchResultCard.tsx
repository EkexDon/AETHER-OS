import { memo, type KeyboardEvent, type MouseEvent } from "react";
import { Sparkles } from "lucide-react";
import type { SearchHit } from "../../types";
import { SECTION_META } from "../../lib/search/kinds";
import { matchPositions } from "../../lib/search/fuzzy";
import { Badge, cx } from "../../ui";
import { HighlightedSnippet, HighlightedText } from "./Highlighted";

/** Relative "2 d ago" style age for a Unix timestamp (empty for 0). */
export function relativeAge(unixSeconds: number, now: number = Date.now()): string {
  if (!unixSeconds) return "";
  const diff = Math.max(0, Math.floor(now / 1000) - unixSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)} d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export interface SearchResultCardProps {
  hit: SearchHit;
  /** The text the title is highlighted with. */
  query: string;
  selected: boolean;
  index: number;
  onSelect: (index: number) => void;
  onOpen: (hit: SearchHit, alternate: boolean) => void;
}

/**
 * One result of the Universal Search view: kind icon, highlighted title,
 * subtitle, snippet with marked matches, a "Semantic" badge for vector
 * matches and the age. Click selects (preview), double-click or Enter opens.
 */
export const SearchResultCard = memo(function SearchResultCard({
  hit,
  query,
  selected,
  index,
  onSelect,
  onOpen,
}: SearchResultCardProps) {
  const meta = SECTION_META[hit.kind];
  const Icon = meta.icon;
  const age = relativeAge(hit.updated_at);
  const semantic = hit.matched.includes("semantic");

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen(hit, e.metaKey || e.ctrlKey);
    }
  };

  return (
    <div
      role="option"
      id={`usearch-result-${index}`}
      data-index={index}
      aria-selected={selected}
      tabIndex={-1}
      className={cx("usearch-card", selected && "is-selected")}
      onClick={() => onSelect(index)}
      onDoubleClick={(e: MouseEvent) => onOpen(hit, e.metaKey || e.ctrlKey)}
      onKeyDown={onKeyDown}
    >
      <span className="usearch-card-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="usearch-card-main">
        <div className="usearch-card-head">
          <HighlightedText className="usearch-card-title" text={hit.title} positions={matchPositions(query, hit.title)} />
          <span className="usearch-card-kind">{meta.singular}</span>
          {semantic && (
            <Badge size="sm" variant="accent" icon={<Sparkles size={10} />} title="Found by meaning (semantic search)">
              Semantic
            </Badge>
          )}
          {age && <span className="usearch-card-age tabular">{age}</span>}
        </div>
        {hit.subtitle && <div className="usearch-card-subtitle">{hit.subtitle}</div>}
        {hit.snippet_html && <HighlightedSnippet className="usearch-card-snippet" html={hit.snippet_html} />}
      </div>
    </div>
  );
});
