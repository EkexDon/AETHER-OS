import type { VaultTaskItem, VaultTaskPriority } from "../../types";
import { Badge, type BadgeVariant } from "../../ui";
import { dueUrgency, formatLongDate, formatShortDate, relativeDueLabel } from "../../lib/vaulttasks/dates";
import { isOpenStatus } from "../../lib/vaulttasks/parser";

const PRIORITY_LABEL: Record<VaultTaskPriority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const PRIORITY_VARIANT: Record<VaultTaskPriority, BadgeVariant> = {
  none: "neutral",
  low: "neutral",
  medium: "info",
  high: "warning",
  urgent: "danger",
};

/** Human label of a priority. */
export function priorityLabel(priority: VaultTaskPriority): string {
  return PRIORITY_LABEL[priority];
}

/** Priority badge (nothing for `none`). */
export function PriorityBadge({ priority }: { priority: VaultTaskPriority }) {
  if (priority === "none") return null;
  return (
    <Badge variant={PRIORITY_VARIANT[priority]} dot className="vt-priority" title={`${PRIORITY_LABEL[priority]} priority`}>
      {PRIORITY_LABEL[priority]}
    </Badge>
  );
}

const URGENCY_VARIANT: Record<ReturnType<typeof dueUrgency>, BadgeVariant> = {
  overdue: "danger",
  today: "warning",
  soon: "info",
  later: "neutral",
};

/**
 * Due date: relative and colored by urgency while open; a plain neutral
 * date once the task is closed (a done task is never "overdue").
 */
export function DueBadge({ task, today }: { task: VaultTaskItem; today: string }) {
  if (!task.due) return null;
  const open = isOpenStatus(task.status);
  return (
    <Badge
      variant={open ? URGENCY_VARIANT[dueUrgency(task.due, today)] : "neutral"}
      className="vt-due tabular"
      title={`Due ${formatLongDate(task.due)}`}
    >
      {open ? relativeDueLabel(task.due, today) : formatShortDate(task.due, today)}
    </Badge>
  );
}

/** Scheduled date (`⏳`), shown when it differs from the due date. */
export function ScheduledBadge({ task, today }: { task: VaultTaskItem; today: string }) {
  if (!task.scheduled || task.scheduled === task.due || !isOpenStatus(task.status)) return null;
  return (
    <Badge variant="neutral" outline className="vt-scheduled tabular" title={`Scheduled ${formatLongDate(task.scheduled)}`}>
      Scheduled {formatShortDate(task.scheduled, today)}
    </Badge>
  );
}
