//! Tauri commands for Project and Task management (Kanban / Issue Board).

use tauri::State;

use crate::engine::task_board::{
    TaskItem, TaskItemPatch, TaskProject, TaskProjectPatch,
};
use crate::AppState;

#[tauri::command]
pub async fn cmd_list_task_projects(
    state: State<'_, AppState>,
) -> Result<Vec<TaskProject>, String> {
    state.task_board.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_task_project(
    state: State<'_, AppState>,
    id: String,
) -> Result<TaskProject, String> {
    state.task_board.get_project(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_create_task_project(
    state: State<'_, AppState>,
    name: String,
    description: String,
    color: String,
    icon: Option<String>,
) -> Result<TaskProject, String> {
    state
        .task_board
        .create_project(&name, &description, &color, icon)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_update_task_project(
    state: State<'_, AppState>,
    id: String,
    patch: TaskProjectPatch,
) -> Result<TaskProject, String> {
    state
        .task_board
        .update_project(&id, patch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_delete_task_project(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state
        .task_board
        .delete_project(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_list_tasks(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<TaskItem>, String> {
    state
        .task_board
        .list_tasks(project_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_task(
    state: State<'_, AppState>,
    id: String,
) -> Result<TaskItem, String> {
    state.task_board.get_task(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cmd_create_task(
    state: State<'_, AppState>,
    project_id: String,
    title: String,
    description: String,
    status: String,
    priority: String,
    due_date: Option<String>,
    labels: Vec<String>,
    order: Option<i64>,
) -> Result<TaskItem, String> {
    state
        .task_board
        .create_task(
            &project_id,
            &title,
            &description,
            &status,
            &priority,
            due_date,
            labels,
            order,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_update_task(
    state: State<'_, AppState>,
    id: String,
    patch: TaskItemPatch,
) -> Result<TaskItem, String> {
    state
        .task_board
        .update_task(&id, patch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_delete_task(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.task_board.delete_task(&id).map_err(|e| e.to_string())
}
