import { useEffect } from "react";
import { ClipboardList, Copy, ExternalLink, FilePlus2, Pin, PinOff, Trash2 } from "lucide-react";
import type { ClipItem } from "../../types";
import { useClipboardStore } from "../../lib/clipboardStore";
import { absoluteTime, formatBytes, kindLabel, lineCount, relativeTime, urlHref, wordCount } from "../../lib/clipboard/format";
import { Badge, Button, EmptyState, Spinner, Tooltip } from "../../ui";
import { ClipContent, openClipLink } from "./ClipContent";
import { KIND_ICONS } from "./ClipThumb";

export interface ClipDetailProps {
  item: ClipItem | null;
  now: Date;
  onCopy: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveAsNote: (item: ClipItem) => void;
}

/** Facts line under the header: counts, times, size. */
function facts(item: ClipItem, now: Date): string[] {
  const out = [`Copied ${item.copy_count}×`, `last ${relativeTime(item.last_copied_at, now)}`];
  if (item.kind === "text" || item.kind === "code") {
    const lines = lineCount(item.content);
    out.push(lines > 1 ? `${lines.toLocaleString("en-US")} lines` : `${wordCount(item.content).toLocaleString("en-US")} words`);
  }
  out.push(formatBytes(item.byte_len));
  return out;
}

/** Right pane: the full clip plus Copy / Pin / Save as note / Delete. */
export function ClipDetail({ item, now, onCopy, onTogglePin, onDelete, onSaveAsNote }: ClipDetailProps) {
  const detail = useClipboardStore((s) => (item ? s.details[item.id] : undefined));
  const loadDetail = useClipboardStore((s) => s.loadDetail);

  useEffect(() => {
    if (item?.truncated && !detail) void loadDetail(item.id);
  }, [item, detail, loadDetail]);

  if (!item) {
    return (
      <section className="clip-detail is-empty" aria-label="Clip details">
        <EmptyState icon={ClipboardList} size="sm" title="Select a clip" description="Its full content and actions appear here." />
      </section>
    );
  }

  const full = item.truncated ? detail ? { ...detail, pinned: item.pinned, copy_count: item.copy_count, last_copied_at: item.last_copied_at } : null : item;
  const KindIcon = KIND_ICONS[item.kind];
  const href = item.kind === "url" ? urlHref(item.content) : null;

  return (
    <section className="clip-detail" aria-label="Clip details" aria-live="polite">
      <header className="clip-detail-header">
        <div className="clip-detail-badges">
          <Badge icon={<KindIcon size={14} />}>{kindLabel(item.kind)}</Badge>
          {item.pinned && (
            <Badge variant="accent" icon={<Pin size={14} />}>
              Pinned
            </Badge>
          )}
        </div>
        <p className="clip-detail-facts" title={`First copied ${absoluteTime(item.created_at)}`}>
          {facts(full ?? item, now).join(" · ")}
        </p>
      </header>

      <div className="clip-detail-actions" role="toolbar" aria-label="Clip actions">
        <Tooltip content="Copy to the clipboard" shortcut="enter">
          <Button variant="primary" size="sm" iconLeft={<Copy size={14} />} onClick={() => onCopy(item.id)}>
            Copy
          </Button>
        </Tooltip>
        {href && (
          <Button size="sm" iconLeft={<ExternalLink size={14} />} onClick={() => void openClipLink(href)}>
            Open link
          </Button>
        )}
        <Tooltip content={item.pinned ? "Unpin — pruning may remove it again" : "Pin — never pruned"} shortcut="p">
          <Button
            size="sm"
            iconLeft={item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            aria-pressed={item.pinned}
            onClick={() => onTogglePin(item.id)}
          >
            {item.pinned ? "Unpin" : "Pin"}
          </Button>
        </Tooltip>
        <Button size="sm" iconLeft={<FilePlus2 size={14} />} onClick={() => full && onSaveAsNote(full)} disabled={!full}>
          Save as note
        </Button>
        <span className="clip-detail-actions-spacer" />
        <Tooltip content="Delete (undo for 5 s)" shortcut="backspace">
          <Button variant="danger" size="sm" iconLeft={<Trash2 size={14} />} onClick={() => onDelete(item.id)}>
            Delete
          </Button>
        </Tooltip>
      </div>

      <div className="clip-detail-body">
        {full ? (
          <ClipContent item={full} />
        ) : (
          <div className="clip-detail-loading">
            <Spinner size={14} label="Loading the full clip" />
          </div>
        )}
      </div>
    </section>
  );
}
