import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ChevronsUpDown, FileWarning } from "lucide-react";
import {
  collapseUnchanged,
  diffLines,
  hasChanges,
  pairInlineChanges,
  toSplitRows,
  type DiffLine,
  type DiffSegment,
  type InlineSpan,
} from "../../lib/history/diff";
import type { DiffLayout } from "../../lib/historyStore";
import type { FileDiff } from "../../types";
import { EmptyState, cx } from "../../ui";

/** Lines rendered before the view asks to show the rest (keeps huge diffs responsive). */
const RENDER_LIMIT = 4000;

export interface HistoryDiffViewProps {
  diff: FileDiff;
  layout: DiffLayout;
  /** Label of the old side ("Previous version", "This version"). */
  oldLabel: string;
  /** Label of the new side ("This version", "Current file"). */
  newLabel: string;
}

function renderText(text: string, span: InlineSpan | undefined): ReactNode {
  if (!text) return " ";
  if (!span || span.end <= span.start) return text;
  return (
    <>
      {text.slice(0, span.start)}
      <mark className="history-diff-mark">{text.slice(span.start, span.end)}</mark>
      {text.slice(span.end)}
    </>
  );
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", remove: "−", equal: " " };
const KIND_LABEL: Record<DiffLine["kind"], string> = { add: "added", remove: "removed", equal: "unchanged" };

function UnifiedLine({ line, span }: { line: DiffLine; span: InlineSpan | undefined }) {
  return (
    <div className={cx("history-diff-row", `is-${line.kind}`)} role="row">
      <span className="history-diff-num" role="cell" aria-hidden="true">
        {line.oldNumber ?? ""}
      </span>
      <span className="history-diff-num" role="cell" aria-hidden="true">
        {line.newNumber ?? ""}
      </span>
      <span className="history-diff-sign" role="cell" aria-hidden="true">
        {SIGN[line.kind]}
      </span>
      <span className="history-diff-text" role="cell">
        <span className="sr-only">{KIND_LABEL[line.kind]}: </span>
        {renderText(line.text, span)}
      </span>
    </div>
  );
}

function SplitCell({ line, side, span }: { line: DiffLine | null; side: "old" | "new"; span: InlineSpan | undefined }) {
  if (!line) return <span className="history-diff-cell is-empty" role="cell" aria-hidden="true" />;
  const number = side === "old" ? line.oldNumber : line.newNumber;
  return (
    <span className={cx("history-diff-cell", `is-${line.kind}`)} role="cell">
      <span className="history-diff-num" aria-hidden="true">
        {number ?? ""}
      </span>
      <span className="history-diff-text">
        {line.kind !== "equal" && <span className="sr-only">{KIND_LABEL[line.kind]}: </span>}
        {renderText(line.text, span)}
      </span>
    </span>
  );
}

function FoldButton({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button type="button" className="history-diff-fold" onClick={onExpand}>
      <ChevronsUpDown size={12} aria-hidden="true" />
      <span>
        Show {count} unchanged line{count === 1 ? "" : "s"}
      </span>
    </button>
  );
}

/**
 * Line diff of two versions of a note, unified or side by side, with long
 * unchanged regions folded and changed spans highlighted inside modified
 * lines. Colors come from the success/danger tokens.
 */
export function HistoryDiffView({ diff, layout, oldLabel, newLabel }: HistoryDiffViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);

  const lines = useMemo(() => diffLines(diff.old_content, diff.new_content), [diff.old_content, diff.new_content]);
  const spans = useMemo(() => {
    const byIndex = pairInlineChanges(lines);
    const byLine = new Map<DiffLine, InlineSpan>();
    byIndex.forEach((span, index) => byLine.set(lines[index], span));
    return byLine;
  }, [lines]);
  const segments = useMemo<DiffSegment[]>(() => {
    const folded = collapseUnchanged(lines);
    return folded.map((segment) =>
      segment.type === "collapsed" && expanded.has(segment.key) ? { type: "lines", lines: segment.lines } : segment
    );
  }, [lines, expanded]);

  if (diff.is_binary) {
    return (
      <EmptyState
        size="sm"
        icon={FileWarning}
        title="Binary file"
        description="This version cannot be shown as text."
      />
    );
  }

  const identical = !hasChanges(lines);
  let budget = showAll ? Number.POSITIVE_INFINITY : RENDER_LIMIT;
  const truncated = !showAll && lines.length > RENDER_LIMIT;
  const expand = (key: string) => setExpanded((prev) => new Set(prev).add(key));

  const rendered = segments.map((segment, index) => {
    if (budget <= 0) return null;
    if (segment.type === "collapsed") {
      return (
        <div key={segment.key} className="history-diff-fold-row" role="row">
          <FoldButton count={segment.lines.length} onExpand={() => expand(segment.key)} />
        </div>
      );
    }
    const visible = segment.lines.slice(0, budget);
    budget -= visible.length;
    if (layout === "split") {
      return (
        <Fragment key={`s-${index}`}>
          {toSplitRows(visible).map((row, r) => (
            <div key={r} className="history-diff-split-row" role="row">
              <SplitCell line={row.left} side="old" span={row.left ? spans.get(row.left) : undefined} />
              <SplitCell line={row.right} side="new" span={row.right ? spans.get(row.right) : undefined} />
            </div>
          ))}
        </Fragment>
      );
    }
    return (
      <Fragment key={`u-${index}`}>
        {visible.map((line, i) => (
          <UnifiedLine key={i} line={line} span={spans.get(line)} />
        ))}
      </Fragment>
    );
  });

  return (
    <div className={cx("history-diff", `is-${layout}`)}>
      {identical && (
        <p className="history-diff-identical" role="status">
          No differences — both sides have the same content.
        </p>
      )}
      {layout === "split" && (
        <div className="history-diff-split-head" aria-hidden="true">
          <span>{oldLabel}</span>
          <span>{newLabel}</span>
        </div>
      )}
      {lines.length === 0 ? (
        <p className="history-diff-identical">Both sides are empty.</p>
      ) : (
        <div className="history-diff-body" role="table" aria-label={`Changes from ${oldLabel} to ${newLabel}`}>
          {rendered}
        </div>
      )}
      {truncated && (
        <button type="button" className="history-diff-fold history-diff-more" onClick={() => setShowAll(true)}>
          Show all {lines.length} lines
        </button>
      )}
    </div>
  );
}
