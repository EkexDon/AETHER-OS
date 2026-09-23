/** Projects & Tasks (Kanban / Issue Board) types — mirror `engine/task_board.rs`. */

/** Kanban column. */
export type TaskStatus = "backlog" | "todo" | "in_progress" | "done";

/** Task priority. */
export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent";

/** A task board project. */
export interface TaskProject {
  id: string;
  name: string;
  description: string;
  color: string;
  icon?: string | null;
  created_at: string;
  updated_at: string;
}

/** Partial update for a project. */
export interface TaskProjectPatch {
  name?: string;
  description?: string;
  color?: string;
  icon?: string | null;
}

/** A task on the board. */
export interface TaskItem {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  labels: string[];
  order: number;
  created_at: string;
  updated_at: string;
}

/** Partial update for a task. */
export interface TaskItemPatch {
  project_id?: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string | null;
  labels?: string[];
  order?: number;
}
