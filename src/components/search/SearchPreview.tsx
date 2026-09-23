import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, MousePointerClick } from "lucide-react";
import type { CalendarEvent, ChatMessageRecord, SearchHit, TaskItem } from "../../types";
import { getCalendarEvent, getNoteContent, getRecentConversations, getTask, ideReadFile } from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { SECTION_META } from "../../lib/search/kinds";
import { editorLabel } from "../../lib/search/actions";
import { splitNote } from "../../lib/search/preview";
import { Badge, Button, EmptyState, Spinner } from "../../ui";
import { MarkdownRenderer } from "../MarkdownRenderer";

/** Lines of a project file shown in the preview. */
const FILE_PREVIEW_LINES = 400;

type Loaded =
  | { kind: "markdown"; content: string }
  | { kind: "code"; content: string; truncated: boolean }
  | { kind: "conversation"; messages: ChatMessageRecord[] }
  | { kind: "event"; event: CalendarEvent }
  | { kind: "task"; task: TaskItem }
  | { kind: "none" };

async function loadPreview(hit: SearchHit): Promise<Loaded> {
  switch (hit.kind) {
    case "note":
      return { kind: "markdown", content: await getNoteContent(hit.path) };
    case "file": {
      const text = await ideReadFile(hit.path);
      const lines = text.split("\n");
      return {
        kind: "code",
        content: lines.slice(0, FILE_PREVIEW_LINES).join("\n"),
        truncated: lines.length > FILE_PREVIEW_LINES,
      };
    }
    case "conversation": {
      const id = typeof hit.extra?.conversation_id === "string" ? hit.extra.conversation_id : hit.id.replace(/^conversation:/, "");
      const conversation = (await getRecentConversations(500)).find((c) => c.id === id);
      if (!conversation) throw new Error("This conversation no longer exists.");
      return { kind: "conversation", messages: conversation.messages };
    }
    case "event": {
      const id = typeof hit.extra?.event_id === "string" ? hit.extra.event_id : hit.id.replace(/^event:/, "");
      return { kind: "event", event: await getCalendarEvent(id) };
    }
    case "task": {
      const id = typeof hit.extra?.task_id === "string" ? hit.extra.task_id : hit.id.replace(/^task:/, "");
      return { kind: "task", task: await getTask(id) };
    }
    default:
      return { kind: "none" };
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="usearch-preview-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A note: frontmatter as a compact field list, then the rendered body. */
function NotePreview({ content }: { content: string }) {
  const { body, fields } = splitNote(content);
  return (
    <>
      {fields.length > 0 && (
        <dl className="usearch-preview-fields">
          {fields.map((f) => (
            <Field key={f.key} label={f.key}>
              {f.value.replace(/^\[|\]$/g, "")}
            </Field>
          ))}
        </dl>
      )}
      <MarkdownRenderer content={body} />
    </>
  );
}

function openLabels(hit: SearchHit, editor: string): { primary: string; alternate: string | null } {
  switch (hit.kind) {
    case "note":
      return { primary: "Open note", alternate: "Open in IDE" };
    case "project":
    case "file":
      return { primary: "Open in IDE", alternate: `Open in ${editorLabel(editor)}` };
    case "app":
      return { primary: "Launch", alternate: null };
    case "event":
      return { primary: "Show day", alternate: "Show week" };
    case "task":
      return { primary: "Open task", alternate: "Show board" };
    case "memory":
      return { primary: "Open Memory", alternate: null };
    case "conversation":
      return { primary: "Open AI agent", alternate: null };
  }
}

/**
 * Right-hand preview of the selected result: rendered Markdown for notes,
 * the transcript for conversations, the first lines of a project file,
 * details for events and tasks, plus open actions.
 */
export function SearchPreview({
  hit,
  onOpen,
}: {
  hit: SearchHit | null;
  onOpen: (hit: SearchHit, alternate: boolean) => void;
}) {
  const preferredEditor = useAetherStore((s) => s.preferredEditor);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!hit) return;
    let cancelled = false;
    loadPreview(hit)
      .then((result) => {
        if (!cancelled) setLoaded(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [hit]);

  if (!hit) {
    return (
      <EmptyState
        icon={MousePointerClick}
        size="sm"
        title="Nothing selected"
        description="Pick a result to preview it here. ↑/↓ move, Enter opens."
      />
    );
  }

  const meta = SECTION_META[hit.kind];
  const Icon = meta.icon;
  // Conversations open in the agent panel from here (the preview already shows them).
  const labels = openLabels(hit, preferredEditor);
  const primaryAlternate = hit.kind === "conversation";

  return (
    <div className="usearch-preview-inner">
      <header className="usearch-preview-header">
        <span className="usearch-preview-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <div className="usearch-preview-titles">
          <h2 className="usearch-preview-title">{hit.title}</h2>
          <p className="usearch-preview-subtitle">{hit.subtitle}</p>
        </div>
      </header>
      <div className="usearch-preview-actions">
        <Button variant="primary" size="sm" onClick={() => onOpen(hit, primaryAlternate)}>
          {labels.primary}
        </Button>
        {labels.alternate && (
          <Button size="sm" iconLeft={<ExternalLink size={13} />} onClick={() => onOpen(hit, true)}>
            {labels.alternate}
          </Button>
        )}
      </div>

      <div className="usearch-preview-body">
        {error ? (
          <div className="ui-notice ui-notice-danger" role="alert">
            {error}
          </div>
        ) : !loaded ? (
          <div className="usearch-preview-loading">
            <Spinner size={16} label="Loading preview" />
          </div>
        ) : loaded.kind === "markdown" ? (
          <NotePreview content={loaded.content} />
        ) : loaded.kind === "code" ? (
          <>
            <pre className="usearch-preview-code mono">{loaded.content}</pre>
            {loaded.truncated && <p className="usearch-preview-note">First {FILE_PREVIEW_LINES} lines shown.</p>}
          </>
        ) : loaded.kind === "conversation" ? (
          <ol className="usearch-preview-messages">
            {loaded.messages.map((m, i) => (
              <li key={i} className={`usearch-preview-message is-${m.role === "user" ? "user" : "assistant"}`}>
                <span className="ui-section-label">{m.role === "user" ? "You" : "AETHER"}</span>
                <MarkdownRenderer content={m.content} />
              </li>
            ))}
          </ol>
        ) : loaded.kind === "event" ? (
          <>
            <dl className="usearch-preview-fields">
              <Field label="When">{hit.subtitle}</Field>
              {loaded.event.location && <Field label="Where">{loaded.event.location}</Field>}
              {loaded.event.attendees.length > 0 && <Field label="With">{loaded.event.attendees.join(", ")}</Field>}
              {loaded.event.tags.length > 0 && (
                <Field label="Tags">
                  {loaded.event.tags.map((t) => (
                    <Badge key={t} size="sm">
                      {t}
                    </Badge>
                  ))}
                </Field>
              )}
            </dl>
            {loaded.event.description.trim() && <MarkdownRenderer content={loaded.event.description} />}
          </>
        ) : loaded.kind === "task" ? (
          <>
            <dl className="usearch-preview-fields">
              <Field label="Status">{loaded.task.status.replace(/_/g, " ")}</Field>
              <Field label="Priority">{loaded.task.priority}</Field>
              {loaded.task.due_date && <Field label="Due">{loaded.task.due_date}</Field>}
              {loaded.task.labels.length > 0 && (
                <Field label="Labels">
                  {loaded.task.labels.map((l) => (
                    <Badge key={l} size="sm">
                      {l}
                    </Badge>
                  ))}
                </Field>
              )}
            </dl>
            {loaded.task.description.trim() && <MarkdownRenderer content={loaded.task.description} />}
          </>
        ) : (
          <dl className="usearch-preview-fields">
            {hit.kind === "memory" && typeof hit.extra?.fact === "string" && <Field label="Fact">{hit.extra.fact}</Field>}
            {hit.kind === "memory" && typeof hit.extra?.category === "string" && (
              <Field label="Category">{hit.extra.category}</Field>
            )}
            {hit.kind === "project" && typeof hit.extra?.branch === "string" && <Field label="Branch">{hit.extra.branch}</Field>}
            {hit.kind === "project" && typeof hit.extra?.language === "string" && (
              <Field label="Language">{hit.extra.language}</Field>
            )}
            {hit.kind === "app" && typeof hit.extra?.bundle_id === "string" && (
              <Field label="Bundle id">
                <span className="mono">{hit.extra.bundle_id}</span>
              </Field>
            )}
            {hit.path && (
              <Field label="Path">
                <span className="mono usearch-preview-path">{hit.path}</span>
              </Field>
            )}
            {hit.updated_at > 0 && <Field label="Updated">{new Date(hit.updated_at * 1000).toLocaleString()}</Field>}
          </dl>
        )}
      </div>
    </div>
  );
}
