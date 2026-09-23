import type { CSSProperties } from "react";
import { FileText } from "lucide-react";
import type { VaultTaskItem } from "../../types";
import { Badge, Button, Checkbox, cx } from "../../ui";
import { useVaultTasksStore } from "../../lib/vaultTasksStore";
import { taskKey } from "../../lib/vaulttasks/filters";
import { DueBadge, PriorityBadge, ScheduledBadge } from "./TaskMeta";
import { TaskDetailPopover } from "./TaskDetailPopover";
import { TaskText } from "./TaskText";
import { useTaskActions } from "./useTaskActions";

export interface TaskRowProps {
  task: VaultTaskItem;
  today: string;
  /** Show the source note link (List view). */
  showNote?: boolean;
  /** Indent by nesting depth (By note view). */
  nested?: boolean;
}

/** The checkbox of a task: indeterminate while in progress. */
export function TaskCheckbox({ task }: { task: VaultTaskItem }) {
  const actions = useTaskActions();
  const pending = useVaultTasksStore((s) => !!s.pending[taskKey(task)]);
  const text = task.text_clean || task.text_raw;
  return (
    <Checkbox
      className="vt-check"
      checked={task.checked}
      indeterminate={task.status === "in_progress"}
      disabled={pending}
      aria-label={task.checked ? `Reopen "${text}"` : `Complete "${text}"`}
      onChange={(checked) => void actions.toggle(task, checked)}
    />
  );
}

/** One task in the List and By note views. */
export function TaskRow({ task, today, showNote = false, nested = false }: TaskRowProps) {
  const actions = useTaskActions();
  const pending = useVaultTasksStore((s) => !!s.pending[taskKey(task)]);
  const style = nested ? ({ "--vt-depth": task.depth } as CSSProperties) : undefined;
  return (
    <div
      className={cx(
        "vt-row",
        nested && "is-nested",
        task.status === "done" && "is-done",
        task.status === "cancelled" && "is-cancelled",
        pending && "is-pending"
      )}
      style={style}
      data-status={task.status}
    >
      <TaskCheckbox task={task} />
      <div className="vt-row-main">
        <TaskText text={task.text_clean || task.text_raw} onTag={actions.filterByTag} onWikilink={actions.openLink} />
        {task.status === "cancelled" && <span className="vt-row-note">Cancelled</span>}
      </div>
      <div className="vt-row-meta">
        {task.status === "in_progress" && (
          <Badge variant="info" size="sm">
            In progress
          </Badge>
        )}
        <PriorityBadge priority={task.priority} />
        <ScheduledBadge task={task} today={today} />
        <DueBadge task={task} today={today} />
        {showNote && (
          <Button
            variant="ghost"
            size="sm"
            className="vt-note-link"
            iconLeft={<FileText size={14} />}
            title={`${task.note_path} · line ${task.line + 1}`}
            onClick={() => actions.openNote(task)}
          >
            <span className="vt-note-link-text">{task.note_name}</span>
          </Button>
        )}
        <TaskDetailPopover task={task} today={today} />
      </div>
    </div>
  );
}
