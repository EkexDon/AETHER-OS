import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  X, CheckSquare, Trash2, Calendar as CalendarIcon, Tag, AlertCircle,
  Clock, CheckCircle2, Circle, ArrowUpCircle, Flame, Plus, Check,
} from "lucide-react";
import { useAetherStore } from "../lib/store";
import { createTask, updateTask, deleteTask } from "../lib/ipc";
import type { TaskItem, TaskPriority, TaskStatus } from "../types";

export const TASK_STATUSES: { id: TaskStatus; label: string; color: string }[] = [
  { id: "backlog", label: "Backlog", color: "#6b7280" },
  { id: "todo", label: "Todo", color: "#3b82f6" },
  { id: "in_progress", label: "In Progress", color: "#f59e0b" },
  { id: "done", label: "Done", color: "#10b981" },
];

export const TASK_PRIORITIES: { id: TaskPriority; label: string; color: string; icon: React.ReactNode }[] = [
  { id: "none", label: "None", color: "#6b7280", icon: <Circle size={12} /> },
  { id: "low", label: "Low", color: "#3b82f6", icon: <ArrowUpCircle size={12} /> },
  { id: "medium", label: "Medium", color: "#f59e0b", icon: <AlertCircle size={12} /> },
  { id: "high", label: "High", color: "#f97316", icon: <AlertCircle size={12} /> },
  { id: "urgent", label: "Urgent", color: "#ef4444", icon: <Flame size={12} /> },
];

export function TaskDetailModal({
  task,
  defaultStatus,
  onClose,
}: {
  task: TaskItem | null;
  defaultStatus?: TaskStatus;
  onClose: () => void;
}) {
  const {
    taskProjects,
    selectedProjectId,
    upsertTaskItem,
    removeTaskItem,
  } = useAetherStore();

  const projectId = task?.project_id ?? selectedProjectId ?? taskProjects[0]?.id ?? "";

  const [currentProjectId, setCurrentProjectId] = useState(projectId);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? defaultStatus ?? "todo");
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "none");
  const [dueDate, setDueDate] = useState(task?.due_date ?? "");
  const [labels, setLabels] = useState<string[]>(task?.labels ?? []);
  const [newLabelText, setNewLabelText] = useState("");
  const [newChecklistText, setNewChecklistText] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    if (!confirmingDelete) return;
    const t = setTimeout(() => setConfirmingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmingDelete]);

  // Parse checklist items from description: "- [ ] Item" or "- [x] Item"
  const checklistItems = useMemo(() => {
    const lines = description.split("\n");
    const items: { lineIndex: number; checked: boolean; text: string }[] = [];
    lines.forEach((line, i) => {
      const match = /^(\s*[-*]\s*\[([ xX])\]\s*)(.*)$/.exec(line);
      if (match) {
        items.push({
          lineIndex: i,
          checked: match[2].toLowerCase() === "x",
          text: match[3].trim(),
        });
      }
    });
    return items;
  }, [description]);

  const toggleChecklistItem = (lineIndex: number) => {
    const lines = description.split("\n");
    const line = lines[lineIndex];
    if (!line) return;
    if (line.includes("[ ]")) {
      lines[lineIndex] = line.replace("[ ]", "[x]");
    } else if (line.includes("[x]") || line.includes("[X]")) {
      lines[lineIndex] = line.replace(/\[[xX]\]/, "[ ]");
    }
    setDescription(lines.join("\n"));
  };

  const addChecklistItem = () => {
    const trimmed = newChecklistText.trim();
    if (!trimmed) return;
    const addition = `- [ ] ${trimmed}`;
    const nextDesc = description ? `${description.trimEnd()}\n${addition}` : addition;
    setDescription(nextDesc);
    setNewChecklistText("");
  };

  const addLabel = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (!v) return;
    if (!labels.includes(v)) {
      setLabels([...labels, v]);
    }
    setNewLabelText("");
  };

  const removeLabel = (label: string) => {
    setLabels(labels.filter((l) => l !== label));
  };

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (task) {
        const updated = await updateTask(task.id, {
          project_id: currentProjectId,
          title: trimmedTitle,
          description,
          status,
          priority,
          due_date: dueDate ? dueDate : null,
          labels,
        });
        upsertTaskItem(updated);
      } else {
        const created = await createTask({
          projectId: currentProjectId,
          title: trimmedTitle,
          description,
          status,
          priority,
          dueDate: dueDate ? dueDate : null,
          labels,
        });
        upsertTaskItem(created);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteTask(task.id);
      removeTaskItem(task.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="event-editor-overlay" onClick={onClose}>
      <div
        className="event-editor-modal task-detail-modal"
        style={{ width: 620 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="event-editor-header">
          <CheckSquare size={15} className="text-primary" />
          <span>{task ? "Task Details" : "New Task"}</span>
          <button className="btn btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="event-editor-body">
          {/* Title */}
          <label className="event-editor-field">
            <span className="event-editor-field-label">Title</span>
            <input
              ref={titleRef}
              className="settings-input"
              type="text"
              placeholder="What needs to be done?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>

          {/* Project & Status & Priority row */}
          <div className="task-detail-meta-grid">
            <label className="event-editor-field">
              <span className="event-editor-field-label">Project</span>
              <select
                className="settings-input"
                value={currentProjectId}
                onChange={(e) => setCurrentProjectId(e.target.value)}
              >
                {taskProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="event-editor-field">
              <span className="event-editor-field-label">Status</span>
              <select
                className="settings-input"
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                {TASK_STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="event-editor-field">
              <span className="event-editor-field-label">Priority</span>
              <select
                className="settings-input"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Due date & Labels */}
          <div className="task-detail-meta-grid" style={{ marginTop: 8 }}>
            <label className="event-editor-field">
              <span className="event-editor-field-label">Due Date</span>
              <div className="event-editor-field-row">
                <CalendarIcon size={12} className="text-tertiary" />
                <input
                  className="settings-input"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
                {dueDate && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setDueDate("")}
                  >
                    Clear
                  </button>
                )}
              </div>
            </label>

            <div className="event-editor-field" style={{ gridColumn: "span 2" }}>
              <span className="event-editor-field-label">Labels</span>
              <div className="task-label-chips-wrap">
                {labels.map((l) => (
                  <span key={l} className="task-label-chip">
                    <Tag size={10} />
                    <span>{l}</span>
                    <button
                      type="button"
                      onClick={() => removeLabel(l)}
                      aria-label={`Remove label ${l}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <input
                  className="task-label-inline-input"
                  type="text"
                  placeholder="+ Add label (Enter)"
                  value={newLabelText}
                  onChange={(e) => setNewLabelText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addLabel(newLabelText);
                    }
                  }}
                  onBlur={() => newLabelText.trim() && addLabel(newLabelText)}
                />
              </div>
            </div>
          </div>

          {/* Checklist subtasks if any */}
          {checklistItems.length > 0 && (
            <div className="event-editor-field" style={{ marginTop: 12 }}>
              <div className="task-checklist-header">
                <span className="event-editor-field-label">Checklist</span>
                <span className="task-checklist-progress">
                  {checklistItems.filter((c) => c.checked).length} / {checklistItems.length} completed
                </span>
              </div>
              <div className="task-checklist-list">
                {checklistItems.map((item) => (
                  <label key={item.lineIndex} className="task-checklist-row">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={() => toggleChecklistItem(item.lineIndex)}
                    />
                    <span className={item.checked ? "task-checklist-done" : ""}>
                      {item.text}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Add Checklist Item input */}
          <div className="task-add-checklist-row" style={{ marginTop: 6 }}>
            <input
              className="settings-input task-checklist-input"
              type="text"
              placeholder="+ Add checklist item..."
              value={newChecklistText}
              onChange={(e) => setNewChecklistText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addChecklistItem();
                }
              }}
            />
            {newChecklistText.trim() && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={addChecklistItem}
              >
                <Plus size={12} /> Add
              </button>
            )}
          </div>

          {/* Description */}
          <label className="event-editor-field" style={{ marginTop: 12 }}>
            <span className="event-editor-field-label">Description (Markdown supported)</span>
            <textarea
              className="settings-input"
              rows={5}
              placeholder="Add details, notes, or use - [ ] for checklists..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {error && <div className="calendar-dialog-status error">{error}</div>}
        </div>

        <div className="event-editor-footer">
          <div>
            {task && (
              <button
                type="button"
                className={`event-editor-delete${confirmingDelete ? " confirming" : ""}`}
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                <Trash2 size={12} /> {confirmingDelete ? "Confirm Delete" : "Delete Task"}
              </button>
            )}
          </div>
          <div className="event-editor-footer-right">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSave()}
              disabled={!title.trim() || saving}
            >
              {task ? "Save Changes" : "Create Task"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
