import { useId, useMemo } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { VaultTaskItem } from "../../types";
import { Badge, IconButton, cx } from "../../ui";
import { useVaultTasksStore } from "../../lib/vaultTasksStore";
import { groupByNote, taskKey, type NoteGroup } from "../../lib/vaulttasks/filters";
import { useAetherStore } from "../../lib/store";
import { TaskRow } from "./TaskRow";

function NoteGroupCard({ group, rows, today }: { group: NoteGroup; rows: VaultTaskItem[]; today: string }) {
  const collapsed = useVaultTasksStore((s) => !!s.collapsedNotes[group.notePath]);
  const toggle = useVaultTasksStore((s) => s.toggleNoteCollapsed);
  const bodyId = useId();
  const countable = group.tasks.filter((t) => t.status !== "cancelled").length;
  const percent = Math.round(group.progress * 100);
  const openNote = () => {
    const aether = useAetherStore.getState();
    aether.selectNote(group.notePath);
    aether.setView("editor");
  };
  let lastSection: string | null | undefined;

  return (
    <section className={cx("vt-note", collapsed && "is-collapsed")}>
      <div className="vt-note-head">
        <button
          type="button"
          className="vt-note-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => toggle(group.notePath)}
        >
          <ChevronRight size={14} className="vt-note-chevron" aria-hidden="true" />
          <span className="vt-note-name">{group.noteName}</span>
          <span className="vt-note-count tabular">
            {group.done}/{countable}
          </span>
          {group.overdue > 0 && (
            <Badge variant="danger" size="sm">
              {group.overdue} overdue
            </Badge>
          )}
        </button>
        <div
          className="vt-progress"
          role="progressbar"
          aria-label={`${group.noteName} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className="vt-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <IconButton size="sm" label={`Open ${group.noteName}`} icon={<ArrowUpRight size={14} />} onClick={openNote} />
      </div>
      {!collapsed && (
        <div className="vt-rows vt-note-body" id={bodyId}>
          {rows.map((task) => {
            const showSection = task.section !== lastSection && !!task.section;
            lastSection = task.section;
            return (
              <div key={taskKey(task)}>
                {showSection && <div className="vt-note-section">{task.section}</div>}
                <TaskRow task={task} today={today} nested />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Collapsible groups per note with a progress bar. Counters use every task
 * of the note in `scope`; only tasks in `visible` are listed, and notes
 * without visible tasks are left out.
 */
export function NoteGroupsView({
  scope,
  visible,
  today,
}: {
  scope: VaultTaskItem[];
  visible: VaultTaskItem[];
  today: string;
}) {
  const groups = useMemo(() => {
    const shown = new Set(visible.map(taskKey));
    return groupByNote(scope, today)
      .map((group) => ({ group, rows: group.tasks.filter((t) => shown.has(taskKey(t))) }))
      .filter((g) => g.rows.length > 0);
  }, [scope, visible, today]);
  return (
    <div className="vt-notes">
      {groups.map(({ group, rows }) => (
        <NoteGroupCard key={group.notePath} group={group} rows={rows} today={today} />
      ))}
    </div>
  );
}
