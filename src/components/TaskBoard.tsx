import React, { useEffect, useMemo, useState } from "react";
import {
  FolderKanban, Plus, Search, Filter, LayoutGrid, List, MoreVertical,
  CheckCircle2, Circle, Clock, Flame, AlertCircle, ArrowUpCircle,
  Tag, Calendar as CalendarIcon, CheckSquare, Settings2, Trash2,
} from "lucide-react";
import { useAetherStore } from "../lib/store";
import {
  listTaskProjects,
  listTasks,
  createTask,
  updateTask,
  createTaskProject,
} from "../lib/ipc";
import type { TaskItem, TaskProject, TaskStatus, TaskPriority } from "../types";
import { ProjectModal } from "./ProjectModal";
import {
  TaskDetailModal,
  TASK_STATUSES,
  TASK_PRIORITIES,
} from "./TaskDetailModal";

export function TaskBoard() {
  const {
    taskProjects,
    setTaskProjects,
    selectedProjectId,
    setSelectedProjectId,
    tasks,
    setTasks,
    upsertTaskItem,
    taskViewMode,
    setTaskViewMode,
    taskFilterQuery,
    setTaskFilterQuery,
    taskFilterPriority,
    setTaskFilterPriority,
    taskFilterLabel,
    setTaskFilterLabel,
    projectModalOpen,
    setProjectModalOpen,
    editingProject,
    setEditingProject,
    taskDetailModalOpen,
    setTaskDetailModalOpen,
    selectedTaskId,
    setSelectedTaskId,
  } = useAetherStore();

  const [loading, setLoading] = useState(true);
  const [quickAddColumn, setQuickAddColumn] = useState<TaskStatus | null>(null);
  const [quickAddTitle, setQuickAddTitle] = useState("");
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null);

  // Load projects on mount
  useEffect(() => {
    let cancelled = false;
    void listTaskProjects()
      .then((projects) => {
        if (cancelled) return;
        setTaskProjects(projects);
        if (projects.length > 0 && !selectedProjectId) {
          setSelectedProjectId(projects[0].id);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setTaskProjects, selectedProjectId, setSelectedProjectId]);

  // Load tasks whenever selectedProjectId changes
  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    void listTasks(selectedProjectId)
      .then((items) => {
        if (!cancelled) setTasks(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, setTasks]);

  const activeProject = useMemo(() => {
    return taskProjects.find((p) => p.id === selectedProjectId) ?? null;
  }, [taskProjects, selectedProjectId]);

  // Extract all unique labels in active tasks for filtering
  const allLabels = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((t) => t.labels.forEach((l) => set.add(l)));
    return Array.from(set).sort();
  }, [tasks]);

  // Filter tasks by search query, priority, label
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (taskFilterPriority && t.priority !== taskFilterPriority) return false;
      if (taskFilterLabel && !t.labels.includes(taskFilterLabel)) return false;
      if (taskFilterQuery.trim()) {
        const q = taskFilterQuery.toLowerCase();
        const matchesTitle = t.title.toLowerCase().includes(q);
        const matchesDesc = t.description.toLowerCase().includes(q);
        const matchesLabel = t.labels.some((l) => l.toLowerCase().includes(q));
        if (!matchesTitle && !matchesDesc && !matchesLabel) return false;
      }
      return true;
    });
  }, [tasks, taskFilterQuery, taskFilterPriority, taskFilterLabel]);

  // Tasks grouped by status
  const tasksByStatus = useMemo(() => {
    const map: Record<TaskStatus, TaskItem[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      done: [],
    };
    filteredTasks.forEach((t) => {
      if (map[t.status]) map[t.status].push(t);
      else map.todo.push(t);
    });
    return map;
  }, [filteredTasks]);

  const activeTask = useMemo(() => {
    return tasks.find((t) => t.id === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);

  const handleCreateQuickTask = async (status: TaskStatus) => {
    const trimmed = quickAddTitle.trim();
    if (!trimmed || !selectedProjectId) return;
    try {
      const created = await createTask({
        projectId: selectedProjectId,
        title: trimmed,
        description: "",
        status,
        priority: "none",
        dueDate: null,
        labels: [],
      });
      upsertTaskItem(created);
      setQuickAddTitle("");
      setQuickAddColumn(null);
    } catch {
      // ignore
    }
  };

  const handleOpenTask = (task: TaskItem) => {
    setSelectedTaskId(task.id);
    setTaskDetailModalOpen(true);
  };

  const handleOpenNewTask = (status: TaskStatus = "todo") => {
    setSelectedTaskId(null);
    setQuickAddColumn(null);
    setTaskDetailModalOpen(true);
  };

  // Drag and Drop handlers
  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData("text/plain", taskId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== status) setDragOverCol(status);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the column element itself
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverCol(null);
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    e.preventDefault();
    setDragOverCol(null);
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;

    const existing = tasks.find((t) => t.id === taskId);
    if (!existing || existing.status === targetStatus) return;

    // Optimistically update
    const updated = { ...existing, status: targetStatus };
    upsertTaskItem(updated);

    try {
      await updateTask(taskId, { status: targetStatus });
    } catch {
      // Revert if failed
      upsertTaskItem(existing);
    }
  };

  // If no projects exist yet
  if (!loading && taskProjects.length === 0) {
    return (
      <div className="task-board-view empty">
        <div className="task-empty-hero">
          <div className="task-empty-icon">
            <FolderKanban size={48} />
          </div>
          <h2>Projects & Issue Boards</h2>
          <p>
            Organize work with independent projects, issue tracking, and interactive Kanban boards.
            No note tags required.
          </p>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => {
              setEditingProject(null);
              setProjectModalOpen(true);
            }}
          >
            <Plus size={16} /> Create Your First Project
          </button>
        </div>
        {projectModalOpen && (
          <ProjectModal
            project={editingProject}
            onClose={() => setProjectModalOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="task-board-view">
      {/* Top Toolbar */}
      <div className="task-board-toolbar">
        <div className="task-board-toolbar-left">
          {/* Project Switcher */}
          <div className="task-project-selector-wrap">
            <span
              className="task-project-dot"
              style={{ background: activeProject?.color ?? "#3b82f6" }}
            />
            <select
              className="task-project-select"
              value={selectedProjectId ?? ""}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              {taskProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn btn-icon"
            onClick={() => {
              setEditingProject(null);
              setProjectModalOpen(true);
            }}
            title="Create New Project"
          >
            <Plus size={15} />
          </button>

          {activeProject && (
            <button
              className="btn btn-icon"
              onClick={() => {
                setEditingProject(activeProject);
                setProjectModalOpen(true);
              }}
              title="Project Settings"
            >
              <Settings2 size={15} />
            </button>
          )}

          <div className="task-toolbar-divider" />

          {/* View Toggle */}
          <div className="task-view-toggle">
            <button
              className={`task-view-toggle-btn${taskViewMode === "board" ? " selected" : ""}`}
              onClick={() => setTaskViewMode("board")}
              title="Kanban Board View"
            >
              <LayoutGrid size={14} /> Board
            </button>
            <button
              className={`task-view-toggle-btn${taskViewMode === "list" ? " selected" : ""}`}
              onClick={() => setTaskViewMode("list")}
              title="List View"
            >
              <List size={14} /> List
            </button>
          </div>
        </div>

        <div className="task-board-toolbar-right">
          {/* Search bar */}
          <div className="task-search-wrap">
            <Search size={13} className="text-tertiary" />
            <input
              type="text"
              className="task-search-input"
              placeholder="Filter tasks..."
              value={taskFilterQuery}
              onChange={(e) => setTaskFilterQuery(e.target.value)}
            />
            {taskFilterQuery && (
              <button
                className="task-filter-clear"
                onClick={() => setTaskFilterQuery("")}
              >
                ×
              </button>
            )}
          </div>

          {/* Priority filter */}
          <select
            className="task-filter-select"
            value={taskFilterPriority ?? ""}
            onChange={(e) => setTaskFilterPriority(e.target.value || null)}
          >
            <option value="">All Priorities</option>
            {TASK_PRIORITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          {/* Label filter */}
          {allLabels.length > 0 && (
            <select
              className="task-filter-select"
              value={taskFilterLabel ?? ""}
              onChange={(e) => setTaskFilterLabel(e.target.value || null)}
            >
              <option value="">All Labels</option>
              {allLabels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}

          {/* New Task Button */}
          <button
            className="btn btn-primary"
            onClick={() => handleOpenNewTask("todo")}
          >
            <Plus size={14} /> New Task
          </button>
        </div>
      </div>

      {/* Main Board / List View Area */}
      <div className="task-board-content">
        {taskViewMode === "board" ? (
          <div className="task-kanban-board">
            {TASK_STATUSES.map((col) => {
              const colTasks = tasksByStatus[col.id];
              const isDragOver = dragOverCol === col.id;

              return (
                <div
                  key={col.id}
                  className={`task-kanban-column${isDragOver ? " drag-over" : ""}`}
                  onDragOver={(e) => handleDragOver(e, col.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => void handleDrop(e, col.id)}
                >
                  {/* Column Header */}
                  <div className="task-column-header">
                    <div className="task-column-header-title">
                      <span
                        className="task-column-dot"
                        style={{ background: col.color }}
                      />
                      <span className="task-column-name">{col.label}</span>
                      <span className="task-column-count">{colTasks.length}</span>
                    </div>
                    <button
                      className="btn btn-icon btn-sm"
                      onClick={() => {
                        setQuickAddColumn(col.id);
                        setQuickAddTitle("");
                      }}
                      title={`Add task to ${col.label}`}
                    >
                      <Plus size={13} />
                    </button>
                  </div>

                  {/* Quick Add Input in column */}
                  {quickAddColumn === col.id && (
                    <div className="task-inline-add-card">
                      <input
                        autoFocus
                        className="task-inline-add-input"
                        type="text"
                        placeholder="Task title (Enter to add)..."
                        value={quickAddTitle}
                        onChange={(e) => setQuickAddTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateQuickTask(col.id);
                          } else if (e.key === "Escape") {
                            setQuickAddColumn(null);
                          }
                        }}
                      />
                      <div className="task-inline-add-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => void handleCreateQuickTask(col.id)}
                          disabled={!quickAddTitle.trim()}
                        >
                          Add
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setQuickAddColumn(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Column Cards Container */}
                  <div className="task-column-cards">
                    {colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onClick={() => handleOpenTask(task)}
                        onDragStart={(e) => handleDragStart(e, task.id)}
                      />
                    ))}

                    {colTasks.length === 0 && quickAddColumn !== col.id && (
                      <div
                        className="task-column-empty"
                        onClick={() => setQuickAddColumn(col.id)}
                      >
                        + Add task
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* List View */
          <div className="task-list-view-wrap">
            <div className="task-list-table-header">
              <div className="task-col-title">Task</div>
              <div className="task-col-status">Status</div>
              <div className="task-col-priority">Priority</div>
              <div className="task-col-labels">Labels</div>
              <div className="task-col-due">Due Date</div>
            </div>
            <div className="task-list-table-body">
              {filteredTasks.map((task) => {
                const priorityInfo = TASK_PRIORITIES.find((p) => p.id === task.priority);
                const statusInfo = TASK_STATUSES.find((s) => s.id === task.status);

                return (
                  <div
                    key={task.id}
                    className="task-list-row"
                    onClick={() => handleOpenTask(task)}
                  >
                    <div className="task-col-title">
                      <CheckSquare size={13} className="text-tertiary" />
                      <span className="task-row-title-text">{task.title}</span>
                    </div>
                    <div className="task-col-status">
                      <span
                        className="task-status-badge"
                        style={{
                          borderColor: statusInfo?.color,
                          color: statusInfo?.color,
                        }}
                      >
                        {statusInfo?.label}
                      </span>
                    </div>
                    <div className="task-col-priority">
                      <span
                        className="task-priority-badge"
                        style={{ color: priorityInfo?.color }}
                      >
                        {priorityInfo?.icon} {priorityInfo?.label}
                      </span>
                    </div>
                    <div className="task-col-labels">
                      {task.labels.slice(0, 3).map((l) => (
                        <span key={l} className="task-card-label">
                          {l}
                        </span>
                      ))}
                    </div>
                    <div className="task-col-due">
                      {task.due_date ? (
                        <span className="task-card-due">
                          <Clock size={11} /> {task.due_date}
                        </span>
                      ) : (
                        <span className="text-tertiary">—</span>
                      )}
                    </div>
                  </div>
                );
              })}

              {filteredTasks.length === 0 && (
                <div className="task-list-empty-row">
                  No tasks matching your filters.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {projectModalOpen && (
        <ProjectModal
          project={editingProject}
          onClose={() => setProjectModalOpen(false)}
        />
      )}

      {taskDetailModalOpen && (
        <TaskDetailModal
          task={activeTask}
          defaultStatus="todo"
          onClose={() => {
            setTaskDetailModalOpen(false);
            setSelectedTaskId(null);
          }}
        />
      )}
    </div>
  );
}

// Sub-component for individual Task Card in Kanban
function TaskCard({
  task,
  onClick,
  onDragStart,
}: {
  task: TaskItem;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const priorityInfo = TASK_PRIORITIES.find((p) => p.id === task.priority);

  // Subtask checklist counter
  const checklistCount = useMemo(() => {
    const matches = task.description.match(/^(\s*[-*]\s*\[([ xX])\])/gm);
    if (!matches || matches.length === 0) return null;
    const done = matches.filter((m) => m.toLowerCase().includes("[x]")).length;
    return { done, total: matches.length };
  }, [task.description]);

  const isOverdue = useMemo(() => {
    if (!task.due_date || task.status === "done") return false;
    const todayStr = new Date().toISOString().slice(0, 10);
    return task.due_date < todayStr;
  }, [task.due_date, task.status]);

  return (
    <div
      draggable
      className="task-kanban-card"
      onClick={onClick}
      onDragStart={onDragStart}
    >
      <div className="task-card-top">
        {priorityInfo && priorityInfo.id !== "none" && (
          <span
            className="task-card-priority"
            style={{ color: priorityInfo.color }}
            title={`Priority: ${priorityInfo.label}`}
          >
            {priorityInfo.icon}
          </span>
        )}
        <span className="task-card-title">{task.title}</span>
      </div>

      {(task.labels.length > 0 || task.due_date || checklistCount) && (
        <div className="task-card-meta">
          {task.labels.map((l) => (
            <span key={l} className="task-card-label">
              {l}
            </span>
          ))}

          {checklistCount && (
            <span className="task-card-checklist" title="Checklist progress">
              <CheckSquare size={10} /> {checklistCount.done}/{checklistCount.total}
            </span>
          )}

          {task.due_date && (
            <span
              className={`task-card-due${isOverdue ? " overdue" : ""}`}
              title={isOverdue ? "Overdue" : "Due date"}
            >
              <Clock size={10} /> {task.due_date}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
