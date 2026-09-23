/** Mock handlers for `commands/task_commands.rs`: three seeded projects
 *  with a realistic backlog, CRUD with the engine's defaults (end-of-column
 *  ordering, cascade delete) and validation messages. */
import type { TaskItem, TaskItemPatch, TaskPriority, TaskProject, TaskProjectPatch, TaskStatus } from "../../types";
import {
  addDays,
  argObject,
  argOptNumber,
  argOptString,
  argString,
  argStringArray,
  localDate,
  mockUuid,
  registerReset,
  type MockHandlerMap,
} from "./runtime";

interface BoardState {
  projects: TaskProject[];
  tasks: TaskItem[];
}

function seed(): BoardState {
  const now = new Date();
  const stamp = (daysAgo: number) => addDays(now, -daysAgo).toISOString();
  const project = (name: string, description: string, color: string, icon: string, age: number): TaskProject => ({
    id: mockUuid(),
    name,
    description,
    color,
    icon,
    created_at: stamp(age),
    updated_at: stamp(Math.max(0, age - 3)),
  });
  const aether = project("AETHER-OS v0.2", "Boil-the-ocean release: design system, mock mode, features.", "#3b82f6", "rocket", 21);
  const thesis = project("Masterarbeit", "RAG für persönliche Wissensbasen.", "#8b5cf6", "graduation-cap", 60);
  const home = project("Haushalt & Umzug", "Alles rund um die neue Wohnung.", "#f97316", "home", 14);

  const orderByColumn = new Map<string, number>();
  const task = (
    p: TaskProject,
    title: string,
    status: TaskStatus,
    priority: TaskPriority,
    dueInDays: number | null,
    labels: string[],
    description = ""
  ): TaskItem => {
    const key = `${p.id}:${status}`;
    const order = (orderByColumn.get(key) ?? 0) + 1000;
    orderByColumn.set(key, order);
    const created = stamp(10 - (order / 1000) * 0.5);
    return {
      id: mockUuid(),
      project_id: p.id,
      title,
      description,
      status,
      priority,
      due_date: dueInDays === null ? null : localDate(addDays(now, dueInDays)),
      labels,
      order,
      created_at: created,
      updated_at: created,
    };
  };

  return {
    projects: [aether, thesis, home],
    tasks: [
      task(aether, "Mock backend for browser preview", "in_progress", "high", 0, ["infra"], "Every command needs a stateful mock handler."),
      task(aether, "Design tokens + primitives", "in_progress", "high", 1, ["design"]),
      task(aether, "CI for macOS and Linux", "todo", "medium", 3, ["infra"]),
      task(aether, "Crash reporting (local only)", "todo", "medium", 4, ["infra"]),
      task(aether, "Universal search launcher", "backlog", "medium", 10, ["feature", "search"]),
      task(aether, "Clipboard history", "backlog", "low", null, ["feature"]),
      task(aether, "Note version history", "backlog", "low", null, ["feature"]),
      task(aether, "Split IPC into domain modules", "done", "medium", -1, ["infra"]),
      task(aether, "Release notes v0.2", "todo", "urgent", 5, ["docs"]),
      task(thesis, "Kapitel 2 überarbeiten", "in_progress", "high", 3, ["schreiben"]),
      task(thesis, "Evaluationsdatensatz (50 Fragen)", "todo", "high", 10, ["daten"]),
      task(thesis, "Betreuertermin vereinbaren", "todo", "urgent", -2, ["orga"]),
      task(thesis, "Exposé abgeben", "done", "medium", -20, ["orga"]),
      task(home, "Umzugsfirma buchen", "todo", "urgent", 2, ["umzug"]),
      task(home, "Internetanschluss beantragen", "todo", "high", 5, ["umzug"]),
      task(home, "Ummeldung Bürgeramt", "backlog", "medium", 24, ["behörde"]),
      task(home, "Mietvertrag unterschreiben", "done", "high", -7, ["umzug"]),
    ],
  };
}

let state = seed();
registerReset(() => {
  state = seed();
});

function findProject(id: string): TaskProject {
  const project = state.projects.find((p) => p.id === id);
  if (!project) throw new Error(`invalid input: project ${id} not found`);
  return project;
}

function findTask(id: string): TaskItem {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`invalid input: task ${id} not found`);
  return task;
}

function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));
}

export const tasksHandlers: MockHandlerMap = {
  cmd_list_task_projects: () =>
    [...state.projects].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
  cmd_get_task_project: (args) => findProject(argString(args, "id")),
  cmd_create_task_project: (args) => {
    const name = argString(args, "name").trim();
    if (!name) throw new Error("invalid input: project name is required");
    const color = argString(args, "color").trim();
    const now = new Date().toISOString();
    const project: TaskProject = {
      id: mockUuid(),
      name,
      description: argString(args, "description").trim(),
      color: color || "#3b82f6",
      icon: argOptString(args, "icon"),
      created_at: now,
      updated_at: now,
    };
    state.projects.push(project);
    return project;
  },
  cmd_update_task_project: (args) => {
    const project = { ...findProject(argString(args, "id")) };
    const patch = argObject<TaskProjectPatch>(args, "patch");
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error("invalid input: project name cannot be empty");
      project.name = patch.name.trim();
    }
    if (patch.description !== undefined) project.description = patch.description.trim();
    if (patch.color !== undefined && patch.color.trim()) project.color = patch.color.trim();
    if (patch.icon !== undefined) project.icon = patch.icon;
    project.updated_at = new Date().toISOString();
    state.projects = state.projects.map((p) => (p.id === project.id ? project : p));
    return project;
  },
  cmd_delete_task_project: (args) => {
    const id = argString(args, "id");
    state.projects = state.projects.filter((p) => p.id !== id);
    state.tasks = state.tasks.filter((t) => t.project_id !== id);
  },
  cmd_list_tasks: (args) => {
    const projectId = argOptString(args, "projectId");
    return sortTasks(projectId ? state.tasks.filter((t) => t.project_id === projectId) : state.tasks);
  },
  cmd_get_task: (args) => findTask(argString(args, "id")),
  cmd_create_task: (args) => {
    const projectId = argString(args, "projectId");
    const title = argString(args, "title").trim();
    if (!title) throw new Error("invalid input: task title is required");
    const status = (argString(args, "status").trim() || "backlog") as TaskStatus;
    const priority = (argString(args, "priority").trim() || "none") as TaskPriority;
    const explicitOrder = argOptNumber(args, "order");
    const order =
      explicitOrder ??
      Math.max(0, ...state.tasks.filter((t) => t.project_id === projectId && t.status === status).map((t) => t.order)) + 1000;
    const now = new Date().toISOString();
    const task: TaskItem = {
      id: mockUuid(),
      project_id: projectId,
      title,
      description: argString(args, "description").trim(),
      status,
      priority,
      due_date: argOptString(args, "dueDate"),
      labels: argStringArray(args, "labels"),
      order,
      created_at: now,
      updated_at: now,
    };
    state.tasks.push(task);
    return task;
  },
  cmd_update_task: (args) => {
    const task = { ...findTask(argString(args, "id")) };
    const patch = argObject<TaskItemPatch>(args, "patch");
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error("invalid input: task title cannot be empty");
      task.title = patch.title.trim();
    }
    if (patch.project_id !== undefined) task.project_id = patch.project_id;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.priority !== undefined) task.priority = patch.priority;
    if (patch.due_date !== undefined) task.due_date = patch.due_date;
    if (patch.labels !== undefined) task.labels = patch.labels;
    if (patch.order !== undefined) task.order = patch.order;
    task.updated_at = new Date().toISOString();
    state.tasks = state.tasks.map((t) => (t.id === task.id ? task : t));
    return task;
  },
  cmd_delete_task: (args) => {
    const id = argString(args, "id");
    state.tasks = state.tasks.filter((t) => t.id !== id);
  },
};
