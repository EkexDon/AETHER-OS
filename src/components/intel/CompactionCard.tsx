import { useMemo, useState } from "react";
import { Archive, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Badge, Button, cx } from "../../ui";
import { parseSummary } from "../../lib/intel/summary";
import type { CompactionState } from "../../lib/intelStore";

export interface CompactionCardProps {
  compaction: CompactionState;
  /** Whether the summarised messages are shown above the recent ones. */
  showEarlier: boolean;
  onToggleEarlier: () => void;
  /** Start expanded (tests, freshly compacted). */
  defaultOpen?: boolean;
}

/**
 * Collapsible "Conversation summary" card at the top of the chat. The
 * summary replaces the older messages in what is sent to the model; the
 * full transcript stays saved and can be revealed here.
 */
export function CompactionCard({ compaction, showEarlier, onToggleEarlier, defaultOpen = false }: CompactionCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const parsed = useMemo(() => parseSummary(compaction.summary), [compaction.summary]);
  const count = compaction.compactedCount;
  const saved = compaction.tokensBefore > 0 ? compaction.tokensBefore - compaction.tokensAfter : 0;
  const meta = [
    `${count} earlier message${count === 1 ? "" : "s"}`,
    saved > 0 ? `≈ ${saved.toLocaleString()} tokens saved` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className={cx("intel-summary", open && "is-open")} aria-label="Conversation summary">
      <button type="button" className="intel-summary-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="intel-summary-icon" aria-hidden="true">
          <Archive size={14} />
        </span>
        <span className="intel-summary-titles">
          <span className="intel-summary-title">Conversation summary</span>
          <span className="intel-summary-meta">{parsed.topic ? `${parsed.topic} · ${meta}` : meta}</span>
        </span>
        {compaction.source === "extractive" && (
          <Badge variant="warning" title={compaction.modelError ?? "The model did not return a usable summary."}>
            fallback
          </Badge>
        )}
        <ChevronDown size={14} className="intel-summary-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="intel-summary-body">
          {parsed.topic && <p className="intel-summary-topic">{parsed.topic}</p>}
          {parsed.sections
            .filter((s) => s.items.length > 0)
            .map((s) => (
              <div key={s.title} className="intel-summary-section">
                <h4>{s.title}</h4>
                <ul>
                  {s.items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          <div className="intel-summary-footer">
            <span className="intel-summary-meta">
              {compaction.source === "extractive"
                ? "Built from your messages because the model was unavailable."
                : "Written by the chat model. Older messages are no longer sent verbatim."}
            </span>
            {count > 0 && (
              <Button
                size="sm"
                variant="ghost"
                iconLeft={showEarlier ? <EyeOff size={14} /> : <Eye size={14} />}
                onClick={onToggleEarlier}
              >
                {showEarlier ? "Hide earlier messages" : `Show ${count} earlier`}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
