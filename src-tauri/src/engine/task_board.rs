//! Project & Task Management Engine (Kanban / Issue Board).
//!
//! Stores projects and tasks independently of Markdown notes in
//! `<storage_dir>/projects/<id>.json` and `<storage_dir>/tasks/<id>.json`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

const PROJECTS_DIR: &str = "projects";
const TASKS_DIR: &str = "items";

/// A project containing tasks (issues).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskProject {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub icon: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Patch for updating a project.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskProjectPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<Option<String>>,
}

/// A task item (issue) inside a project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskItem {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub labels: Vec<String>,
    pub order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Patch for updating a task item.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskItemPatch {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub due_date: Option<Option<String>>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub order: Option<i64>,
}

pub struct TaskBoardEngine {
    projects_dir: PathBuf,
    tasks_dir: PathBuf,
}

impl TaskBoardEngine {
    pub fn new(storage_dir: &Path) -> Result<Self, AetherError> {
        let projects_dir = storage_dir.join(PROJECTS_DIR);
        let tasks_dir = storage_dir.join(TASKS_DIR);
        std::fs::create_dir_all(&projects_dir)?;
        std::fs::create_dir_all(&tasks_dir)?;

        Ok(Self {
            projects_dir,
            tasks_dir,
        })
    }

    // ── Project Operations ──

    pub fn list_projects(&self) -> Result<Vec<TaskProject>, AetherError> {
        let mut projects = Vec::new();
        if !self.projects_dir.exists() {
            return Ok(projects);
        }

        for entry in std::fs::read_dir(&self.projects_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(project) = serde_json::from_str::<TaskProject>(&content) {
                        projects.push(project);
                    }
                }
            }
        }

        projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(projects)
    }

    pub fn get_project(&self, id: &str) -> Result<TaskProject, AetherError> {
        let path = self.projects_dir.join(format!("{id}.json"));
        if !path.exists() {
            return Err(AetherError::InvalidInput(format!("project {id} not found")));
        }
        let content = std::fs::read_to_string(path)?;
        serde_json::from_str(&content).map_err(|e| AetherError::Vault(format!("project parse: {e}")))
    }

    pub fn create_project(
        &self,
        name: &str,
        description: &str,
        color: &str,
        icon: Option<String>,
    ) -> Result<TaskProject, AetherError> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(AetherError::InvalidInput("project name is required".to_owned()));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let project = TaskProject {
            id: id.clone(),
            name: trimmed_name.to_owned(),
            description: description.trim().to_owned(),
            color: if color.trim().is_empty() {
                "#3b82f6".to_owned()
            } else {
                color.trim().to_owned()
            },
            icon,
            created_at: now.clone(),
            updated_at: now,
        };

        let path = self.projects_dir.join(format!("{id}.json"));
        let json = serde_json::to_string_pretty(&project)
            .map_err(|e| AetherError::Vault(format!("project serialize: {e}")))?;
        std::fs::write(path, json)?;

        Ok(project)
    }

    pub fn update_project(
        &self,
        id: &str,
        patch: TaskProjectPatch,
    ) -> Result<TaskProject, AetherError> {
        let mut project = self.get_project(id)?;

        if let Some(name) = patch.name {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(AetherError::InvalidInput("project name cannot be empty".to_owned()));
            }
            project.name = trimmed.to_owned();
        }

        if let Some(description) = patch.description {
            project.description = description.trim().to_owned();
        }

        if let Some(color) = patch.color {
            if !color.trim().is_empty() {
                project.color = color.trim().to_owned();
            }
        }

        if let Some(icon) = patch.icon {
            project.icon = icon;
        }

        project.updated_at = chrono::Utc::now().to_rfc3339();

        let path = self.projects_dir.join(format!("{id}.json"));
        let json = serde_json::to_string_pretty(&project)
            .map_err(|e| AetherError::Vault(format!("project serialize: {e}")))?;
        std::fs::write(path, json)?;

        Ok(project)
    }

    pub fn delete_project(&self, id: &str) -> Result<(), AetherError> {
        let path = self.projects_dir.join(format!("{id}.json"));
        if path.exists() {
            std::fs::remove_file(path)?;
        }

        // Cascade delete all tasks belonging to this project
        if let Ok(tasks) = self.list_tasks(Some(id)) {
            for task in tasks {
                let _ = self.delete_task(&task.id);
            }
        }

        Ok(())
    }

    // ── Task Operations ──

    pub fn list_tasks(&self, project_id: Option<&str>) -> Result<Vec<TaskItem>, AetherError> {
        let mut tasks = Vec::new();
        if !self.tasks_dir.exists() {
            return Ok(tasks);
        }

        for entry in std::fs::read_dir(&self.tasks_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(task) = serde_json::from_str::<TaskItem>(&content) {
                        if let Some(pid) = project_id {
                            if task.project_id == pid {
                                tasks.push(task);
                            }
                        } else {
                            tasks.push(task);
                        }
                    }
                }
            }
        }

        // Sort by order asc, then created_at asc
        tasks.sort_by(|a, b| {
            if a.order != b.order {
                a.order.cmp(&b.order)
            } else {
                a.created_at.cmp(&b.created_at)
            }
        });

        Ok(tasks)
    }

    pub fn get_task(&self, id: &str) -> Result<TaskItem, AetherError> {
        let path = self.tasks_dir.join(format!("{id}.json"));
        if !path.exists() {
            return Err(AetherError::InvalidInput(format!("task {id} not found")));
        }
        let content = std::fs::read_to_string(path)?;
        serde_json::from_str(&content).map_err(|e| AetherError::Vault(format!("task parse: {e}")))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &self,
        project_id: &str,
        title: &str,
        description: &str,
        status: &str,
        priority: &str,
        due_date: Option<String>,
        labels: Vec<String>,
        order: Option<i64>,
    ) -> Result<TaskItem, AetherError> {
        let trimmed_title = title.trim();
        if trimmed_title.is_empty() {
            return Err(AetherError::InvalidInput("task title is required".to_owned()));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let task_order = match order {
            Some(o) => o,
            None => {
                // Default order: max existing order in same status + 1000
                let existing = self.list_tasks(Some(project_id))?;
                let max_order = existing
                    .iter()
                    .filter(|t| t.status == status)
                    .map(|t| t.order)
                    .max()
                    .unwrap_or(0);
                max_order + 1000
            }
        };

        let task = TaskItem {
            id: id.clone(),
            project_id: project_id.to_owned(),
            title: trimmed_title.to_owned(),
            description: description.to_owned(),
            status: if status.trim().is_empty() {
                "todo".to_owned()
            } else {
                status.trim().to_owned()
            },
            priority: if priority.trim().is_empty() {
                "none".to_owned()
            } else {
                priority.trim().to_owned()
            },
            due_date,
            labels,
            order: task_order,
            created_at: now.clone(),
            updated_at: now,
        };

        let path = self.tasks_dir.join(format!("{id}.json"));
        let json = serde_json::to_string_pretty(&task)
            .map_err(|e| AetherError::Vault(format!("task serialize: {e}")))?;
        std::fs::write(path, json)?;

        Ok(task)
    }

    pub fn update_task(&self, id: &str, patch: TaskItemPatch) -> Result<TaskItem, AetherError> {
        let mut task = self.get_task(id)?;

        if let Some(project_id) = patch.project_id {
            task.project_id = project_id;
        }

        if let Some(title) = patch.title {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err(AetherError::InvalidInput("task title cannot be empty".to_owned()));
            }
            task.title = trimmed.to_owned();
        }

        if let Some(description) = patch.description {
            task.description = description;
        }

        if let Some(status) = patch.status {
            task.status = status;
        }

        if let Some(priority) = patch.priority {
            task.priority = priority;
        }

        if let Some(due_date) = patch.due_date {
            task.due_date = due_date;
        }

        if let Some(labels) = patch.labels {
            task.labels = labels;
        }

        if let Some(order) = patch.order {
            task.order = order;
        }

        task.updated_at = chrono::Utc::now().to_rfc3339();

        let path = self.tasks_dir.join(format!("{id}.json"));
        let json = serde_json::to_string_pretty(&task)
            .map_err(|e| AetherError::Vault(format!("task serialize: {e}")))?;
        std::fs::write(path, json)?;

        Ok(task)
    }

    pub fn delete_task(&self, id: &str) -> Result<(), AetherError> {
        let path = self.tasks_dir.join(format!("{id}.json"));
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_project_lifecycle() {
        let temp = tempfile::tempdir().expect("tempdir");
        let engine = TaskBoardEngine::new(temp.path()).expect("engine");

        // Create project
        let p = engine
            .create_project("Roguelike Game", "Main game project", "#10b981", None)
            .expect("create");
        assert_eq!(p.name, "Roguelike Game");
        assert_eq!(p.color, "#10b981");

        // List projects
        let list = engine.list_projects().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, p.id);

        // Update project
        let patch = TaskProjectPatch {
            name: Some("AETHER Game".to_owned()),
            ..Default::default()
        };
        let updated = engine.update_project(&p.id, patch).expect("update");
        assert_eq!(updated.name, "AETHER Game");

        // Delete project
        engine.delete_project(&p.id).expect("delete");
        let list_after = engine.list_projects().expect("list after");
        assert!(list_after.is_empty());
    }

    #[test]
    fn test_task_lifecycle_and_cascade() {
        let temp = tempfile::tempdir().expect("tempdir");
        let engine = TaskBoardEngine::new(temp.path()).expect("engine");

        let p = engine
            .create_project("Project Alpha", "", "#3b82f6", None)
            .expect("project");

        // Create task
        let task = engine
            .create_task(
                &p.id,
                "Implement inventory system",
                "Support 20 item slots",
                "todo",
                "high",
                Some("2026-10-01".to_owned()),
                vec!["gameplay".to_owned(), "core".to_owned()],
                None,
            )
            .expect("create task");

        assert_eq!(task.title, "Implement inventory system");
        assert_eq!(task.status, "todo");
        assert_eq!(task.priority, "high");
        assert_eq!(task.labels.len(), 2);

        // List tasks for project
        let tasks = engine.list_tasks(Some(&p.id)).expect("list tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, task.id);

        // Update task status (drag to in_progress)
        let patch = TaskItemPatch {
            status: Some("in_progress".to_owned()),
            order: Some(500),
            ..Default::default()
        };
        let updated = engine.update_task(&task.id, patch).expect("update");
        assert_eq!(updated.status, "in_progress");
        assert_eq!(updated.order, 500);

        // Deleting project cascades to delete task
        engine.delete_project(&p.id).expect("delete project");
        let remaining_tasks = engine.list_tasks(Some(&p.id)).expect("tasks after delete");
        assert!(remaining_tasks.is_empty());
    }
}
