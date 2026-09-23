import { useMemo } from "react";
import type { VaultTaskItem } from "../../types";
import { groupByDue, taskKey } from "../../lib/vaulttasks/filters";
import { TaskRow } from "./TaskRow";

/** Tasks grouped Overdue / Today / This week / Later / No date (+ Completed). */
export function ListView({ tasks, today }: { tasks: VaultTaskItem[]; today: string }) {
  const groups = useMemo(() => groupByDue(tasks, today), [tasks, today]);
  return (
    <div className="vt-list">
      {groups.map((group) => (
        <section key={group.id} className="vt-group" data-group={group.id} aria-labelledby={`vt-group-${group.id}`}>
          <h2 className="ui-section-label vt-group-label" id={`vt-group-${group.id}`}>
            <span>{group.label}</span>
            <span className="vt-group-count tabular">{group.tasks.length}</span>
          </h2>
          <div className="vt-rows">
            {group.tasks.map((task) => (
              <TaskRow key={taskKey(task)} task={task} today={today} showNote />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
