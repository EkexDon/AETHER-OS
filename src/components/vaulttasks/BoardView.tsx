import { useMemo, useState, type DragEvent } from "react";
import { FileText } from "lucide-react";
import type { VaultTaskItem, VaultTaskStatus } from "../../types";
import { cx } from "../../ui";
import { useVaultTasksStore } from "../../lib/vaultTasksStore";
import { BOARD_COLUMNS, boardColumns, taskKey } from "../../lib/vaulttasks/filters";
import { DueBadge, PriorityBadge } from "./TaskMeta";
import { TaskDetailPopover } from "./TaskDetailPopover";
import { TaskText } from "./TaskText";
import { TaskCheckbox } from "./TaskRow";
import { useTaskActions } from "./useTaskActions";

/** Drag payload type (the task's location key). */
export const DRAG_TYPE = "application/x-aether-vault-task";

function BoardCard({ task, today }: { task: VaultTaskItem; today: string }) {
  const actions = useTaskActions();
  const pending = useVaultTasksStore((s) => !!s.pending[taskKey(task)]);
  const [dragging, setDragging] = useState(false);
  return (
    <article
      className={cx("vt-card", dragging && "is-dragging", pending && "is-pending")}
      data-status={task.status}
      draggable={!pending}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, taskKey(task));
        e.dataTransfer.setData("text/plain", task.text_raw);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      <div className="vt-card-top">
        <TaskCheckbox task={task} />
        <TaskText text={task.text_clean || task.text_raw} onTag={actions.filterByTag} onWikilink={actions.openLink} />
      </div>
      <div className="vt-card-meta">
        <button
          type="button"
          className="vt-card-note"
          title={`Open ${task.note_name} at line ${task.line + 1}`}
          onClick={() => actions.openNote(task)}
        >
          <FileText size={14} aria-hidden="true" />
          <span>{task.note_name}</span>
        </button>
        <span className="vt-card-badges">
          <PriorityBadge priority={task.priority} />
          <DueBadge task={task} today={today} />
          <TaskDetailPopover task={task} today={today} />
        </span>
      </div>
    </article>
  );
}

/**
 * Kanban of note tasks by status. Dropping on Todo / Done toggles the
 * checkbox; In progress / Cancelled rewrite the status character. Keyboard
 * users change the status in the card's details popover.
 */
export function BoardView({ tasks, today }: { tasks: VaultTaskItem[]; today: string }) {
  const actions = useTaskActions();
  const columns = useMemo(() => boardColumns(tasks), [tasks]);
  const [over, setOver] = useState<VaultTaskStatus | null>(null);

  const onDrop = (e: DragEvent, status: VaultTaskStatus) => {
    e.preventDefault();
    setOver(null);
    const key = e.dataTransfer.getData(DRAG_TYPE);
    const task = tasks.find((t) => taskKey(t) === key);
    if (!task || task.status === status) return;
    if (status === "done" || status === "todo") void actions.toggle(task, status === "done");
    else void actions.setStatus(task, status);
  };

  return (
    <div className="vt-board" role="list" aria-label="Task board">
      {BOARD_COLUMNS.map((col) => {
        const list = columns[col.id];
        return (
          <section
            key={col.id}
            role="listitem"
            aria-label={`${col.label}, ${list.length} tasks`}
            className={cx("vt-column", over === col.id && "is-over")}
            data-status={col.id}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (over !== col.id) setOver(col.id);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => onDrop(e, col.id)}
          >
            <header className="vt-column-head">
              <span className="vt-column-dot" aria-hidden="true" />
              <span className="vt-column-title">{col.label}</span>
              <span className="vt-column-count tabular">{list.length}</span>
            </header>
            <div className="vt-column-body">
              {list.length === 0 ? (
                <div className="vt-column-empty">Drop tasks here</div>
              ) : (
                list.map((task) => <BoardCard key={taskKey(task)} task={task} today={today} />)
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
