/** Projects & Tasks board commands (`src-tauri/src/commands/task_commands.rs`). */
import type { TaskItem, TaskItemPatch, TaskProject, TaskProjectPatch } from "../../types";
import { call } from "./core";

/** All board projects, sorted by name. */
export const listTaskProjects = () => call<TaskProject[]>("cmd_list_task_projects");
/** One project by id. */
export const getTaskProject = (id: string) => call<TaskProject>("cmd_get_task_project", { id });
/** Create a project (name required, color defaults to blue). */
export const createTaskProject = (input: {
  name: string;
  description: string;
  color: string;
  icon?: string | null;
}) =>
  call<TaskProject>("cmd_create_task_project", {
    name: input.name,
    description: input.description,
    color: input.color,
    icon: input.icon ?? null,
  });
/** Partially update a project. */
export const updateTaskProject = (id: string, patch: TaskProjectPatch) =>
  call<TaskProject>("cmd_update_task_project", { id, patch });
/** Delete a project and all of its tasks. */
export const deleteTaskProject = (id: string) =>
  call<void>("cmd_delete_task_project", { id });

/** Tasks of one project (or all), sorted by order then creation. */
export const listTasks = (projectId?: string | null) =>
  call<TaskItem[]>("cmd_list_tasks", { projectId: projectId ?? null });
/** One task by id. */
export const getTask = (id: string) => call<TaskItem>("cmd_get_task", { id });
/** Create a task; `order` defaults to the end of its column. */
export const createTask = (input: {
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate?: string | null;
  labels: string[];
  order?: number | null;
}) =>
  call<TaskItem>("cmd_create_task", {
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    dueDate: input.dueDate ?? null,
    labels: input.labels,
    order: input.order ?? null,
  });
/** Partially update a task (move columns via `status` + `order`). */
export const updateTask = (id: string, patch: TaskItemPatch) =>
  call<TaskItem>("cmd_update_task", { id, patch });
/** Delete a task. */
export const deleteTask = (id: string) => call<void>("cmd_delete_task", { id });
