import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, FileText, SlidersHorizontal, SquareKanban } from "lucide-react";
import type { TaskProject, TaskStatus, VaultTaskItem, VaultTaskPriority, VaultTaskStatus } from "../../types";
import { Button, IconButton, Input, Popover, Select, Spinner, useToast } from "../../ui";
import { createTask, listTaskProjects } from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { addDaysIso } from "../../lib/vaulttasks/dates";
import { isValidIsoDate } from "../../lib/vaulttasks/parser";
import { plainTaskTitle } from "../../lib/vaulttasks/segments";
import { TaskText } from "./TaskText";
import { useTaskActions } from "./useTaskActions";

const STATUS_OPTIONS: Array<{ value: VaultTaskStatus; label: string }> = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const PRIORITY_OPTIONS: Array<{ value: VaultTaskPriority; label: string }> = [
  { value: "none", label: "No priority" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

/** Board column a promoted task lands in. */
const BOARD_STATUS: Record<VaultTaskStatus, TaskStatus> = {
  todo: "todo",
  in_progress: "in_progress",
  done: "done",
  cancelled: "backlog",
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface DetailProps {
  task: VaultTaskItem;
  today: string;
  close: () => void;
}

function DueEditor({ task, today }: { task: VaultTaskItem; today: string }) {
  const actions = useTaskActions();
  const [draft, setDraft] = useState(task.due ?? "");
  const id = useId();
  useEffect(() => setDraft(task.due ?? ""), [task.due]);

  const commit = (value: string) => {
    const next = value.trim() || null;
    if (next === task.due) return;
    if (next && !isValidIsoDate(next)) {
      setDraft(task.due ?? "");
      return;
    }
    void actions.setDue(task, next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(draft);
    }
  };
  const quick = (label: string, value: string | null) => (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        setDraft(value ?? "");
        commit(value ?? "");
      }}
      disabled={value === task.due}
    >
      {label}
    </Button>
  );

  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>
        Due date
      </label>
      <Input
        id={id}
        type="date"
        size="sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={onKeyDown}
      />
      <div className="vt-detail-quick">
        {quick("Today", today)}
        {quick("Tomorrow", addDaysIso(today, 1))}
        {quick("Next week", addDaysIso(today, 7))}
        {quick("Clear", null)}
      </div>
    </div>
  );
}

function PromoteSection({ task }: { task: VaultTaskItem }) {
  const toast = useToast();
  const [projects, setProjects] = useState<TaskProject[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let alive = true;
    listTaskProjects()
      .then((list) => {
        if (!alive) return;
        setProjects(list);
        setProjectId((current) => current || list[0]?.id || "");
      })
      .catch((e) => alive && setLoadError(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);

  const promote = async () => {
    const project = projects?.find((p) => p.id === projectId);
    if (!project) return;
    setBusy(true);
    try {
      const title = plainTaskTitle(task.text_clean) || task.text_clean || task.text_raw;
      await createTask({
        projectId: project.id,
        title,
        description: `From [[${task.note_name}]] (line ${task.line + 1})${task.section ? ` · ${task.section}` : ""}`,
        status: BOARD_STATUS[task.status],
        priority: task.priority,
        dueDate: task.due,
        labels: task.tags,
      });
      toast.success(`Promoted to ${project.name}`, {
        description: "The note keeps its checkbox; the card lives on the Tasks board.",
        action: {
          label: "Open board",
          onClick: () => {
            const aether = useAetherStore.getState();
            aether.setSelectedProjectId(project.id);
            aether.setView("tasks");
          },
        },
      });
    } catch (e) {
      toast.error("Couldn't promote the task", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>
        Promote to project task
      </label>
      {loadError ? (
        <span className="ui-field-error">{loadError}</span>
      ) : projects === null ? (
        <Spinner size={14} label="Loading projects" />
      ) : projects.length === 0 ? (
        <span className="ui-field-hint">Create a project on the Tasks board first.</span>
      ) : (
        <div className="vt-detail-row">
          <Select
            id={id}
            size="sm"
            className="vt-detail-grow"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Button size="sm" iconLeft={<SquareKanban size={14} />} loading={busy} onClick={() => void promote()}>
            Promote
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskDetail({ task, today, close }: DetailProps) {
  const actions = useTaskActions();
  const statusId = useId();
  const priorityId = useId();
  return (
    <div className="vt-detail">
      <div className="vt-detail-head">
        <div className="vt-detail-title">
          <TaskText text={task.text_clean || task.text_raw} />
        </div>
        <div className="vt-detail-meta">
          {task.note_name} · line {task.line + 1}
          {task.section ? ` · ${task.section}` : ""}
        </div>
      </div>
      <div className="vt-detail-grid">
        <div className="ui-field">
          <label className="ui-field-label" htmlFor={statusId}>
            Status
          </label>
          <Select
            id={statusId}
            size="sm"
            value={task.status}
            onChange={(e) => void actions.setStatus(task, e.target.value as VaultTaskStatus)}
            options={STATUS_OPTIONS}
          />
        </div>
        <div className="ui-field">
          <label className="ui-field-label" htmlFor={priorityId}>
            Priority
          </label>
          <Select
            id={priorityId}
            size="sm"
            value={task.priority}
            onChange={(e) => void actions.setPriority(task, e.target.value as VaultTaskPriority)}
            options={PRIORITY_OPTIONS}
          />
        </div>
      </div>
      <DueEditor task={task} today={today} />
      <div className="vt-detail-divider" role="separator" />
      <PromoteSection task={task} />
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        iconLeft={<FileText size={14} />}
        iconRight={<ArrowUpRight size={14} />}
        onClick={() => {
          close();
          actions.openNote(task);
        }}
      >
        Open note at line {task.line + 1}
      </Button>
    </div>
  );
}

/** "Details" button of a task row / card with status, due, priority and promote. */
export function TaskDetailPopover({ task, today }: { task: VaultTaskItem; today: string }) {
  return (
    <Popover
      placement="bottom-end"
      width={312}
      aria-label="Task details"
      trigger={<IconButton size="sm" label="Task details" icon={<SlidersHorizontal size={14} />} />}
    >
      {(close) => <TaskDetail task={task} today={today} close={close} />}
    </Popover>
  );
}
