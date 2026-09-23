use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultReader;

/// A structured action the AI agent proposes. The frontend parses these
/// from ```action fenced blocks in the AI output, classifies them with
/// [`action_risk`] and asks the user for approval before running anything
/// that is not [`ActionRisk::Safe`].
///
/// `OpenUrl` and `ClipUrl` are async-capable (they hit the network) and
/// the dedicated commands `cmd_agent_open_url` and `cmd_agent_clip_url`
/// handle them end-to-end. The approval-gated variants added by the `intel`
/// feature (`RunCommand`, `DeleteNote`, `MoveNote`, `GitCommit`,
/// `CreateTask`, `ToggleVaultTask`) are routed through the `cmd_intel_*`
/// commands, which also write the audit log. The remaining variants are
/// pure vault writes and go through `execute_action` synchronously.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AgentAction {
    /// Create a new note in the vault (title becomes the file name).
    CreateNote { title: String, content: String },
    /// Append content to an existing note (absolute path inside the vault).
    AppendNote { path: String, content: String },
    /// Append a timestamped bullet to today's daily note.
    AppendDaily { content: String },
    /// Open a URL in the embedded browser / external browser.
    OpenUrl { url: String },
    /// Clip a web page into the vault as Markdown.
    ClipUrl { url: String },
    /// Persist a fact to the agent's long-term memory store.
    AddMemoryFact { fact: String, category: String },
    /// Save the current AI answer to the AETHER Notes library.
    SaveAetherNote { title: String, content: String },
    /// Create a new calendar event. Routed through a dedicated command
    /// (`cmd_create_calendar_event`); `execute_action` rejects it.
    CreateCalendarEvent {
        title: String,
        description: String,
        all_day: bool,
        start: String,
        end: String,
        due: Option<String>,
        color: Option<String>,
        tags: Vec<String>,
        attendees: Vec<String>,
        location: Option<String>,
    },
    /// Update an existing calendar event by id. Routed through
    /// `cmd_update_calendar_event`. Not "safe" — requires approval.
    UpdateCalendarEvent {
        id: String,
        title: Option<String>,
        description: Option<String>,
        all_day: Option<bool>,
        start: Option<String>,
        end: Option<String>,
        due: Option<String>,
        color: Option<String>,
        tags: Option<Vec<String>>,
        attendees: Option<Vec<String>>,
        location: Option<String>,
    },
    /// Delete a calendar event. Routed through `cmd_delete_calendar_event`.
    /// Not "safe" — requires approval.
    DeleteCalendarEvent { id: String },
    /// List calendar events within a date range (defaults to today ± 30 days
    /// in the command layer). Routed through `cmd_list_calendar_events`.
    ListCalendarEvents {
        from: Option<String>,
        to: Option<String>,
    },
    /// Import a calendar from a user-picked .ics file. Routed through
    /// `cmd_import_calendar_ics`. Not "safe" — requires approval with
    /// a preview count.
    ImportCalendarIcs {
        path: String,
        overwrite_existing: bool,
        default_color: Option<String>,
    },
    /// Run a shell command (`sh -lc`) inside a project root or the vault.
    /// Routed through `cmd_intel_run_command`. Dangerous — always approved.
    RunCommand {
        command: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// Move a vault note to `<vault>/.trash/` (never a hard delete). Routed
    /// through `cmd_intel_delete_note`. Dangerous — always approved.
    DeleteNote { path: String },
    /// Move or rename a vault note. Routed through `cmd_intel_move_note`.
    MoveNote { from: String, to: String },
    /// Stage all changes (when nothing is staged) and commit them in a
    /// project repository. Routed through `cmd_intel_git_commit`.
    GitCommit {
        project_path: String,
        message: String,
    },
    /// Create a task on the task board (`project_id` may be an id or a
    /// project name; defaults to an "Inbox" project). Routed through
    /// `cmd_intel_create_task`.
    CreateTask {
        #[serde(default)]
        project_id: Option<String>,
        title: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        priority: Option<String>,
        #[serde(default)]
        due_date: Option<String>,
    },
    /// Toggle the Markdown checkbox on a 1-based line of a vault note.
    /// Routed through `cmd_intel_toggle_vault_task`.
    ToggleVaultTask { note_path: String, line: usize },
}

/// How much user involvement an action needs before it runs. Mirrors
/// `actionRisk` in `src/lib/intel/risk.ts`; keep both in lockstep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionRisk {
    /// Additive or read-only: runs automatically.
    Safe,
    /// Changes or reorganises existing data: needs one approval.
    Confirm,
    /// Executes code or removes data: needs an explicit approval, and
    /// "always allow" rules for it never survive an app restart.
    Dangerous,
}

/// Classify an action for the approval flow.
pub fn action_risk(action: &AgentAction) -> ActionRisk {
    match action {
        AgentAction::CreateNote { .. }
        | AgentAction::AppendNote { .. }
        | AgentAction::AppendDaily { .. }
        | AgentAction::OpenUrl { .. }
        | AgentAction::ClipUrl { .. }
        | AgentAction::AddMemoryFact { .. }
        | AgentAction::SaveAetherNote { .. }
        | AgentAction::CreateCalendarEvent { .. }
        | AgentAction::ListCalendarEvents { .. }
        | AgentAction::CreateTask { .. } => ActionRisk::Safe,
        AgentAction::UpdateCalendarEvent { .. }
        | AgentAction::ImportCalendarIcs { .. }
        | AgentAction::MoveNote { .. }
        | AgentAction::GitCommit { .. }
        | AgentAction::ToggleVaultTask { .. } => ActionRisk::Confirm,
        AgentAction::DeleteCalendarEvent { .. }
        | AgentAction::DeleteNote { .. }
        | AgentAction::RunCommand { .. } => ActionRisk::Dangerous,
    }
}

/// The `action` discriminator as it appears in the JSON block.
pub fn action_kind(action: &AgentAction) -> &'static str {
    match action {
        AgentAction::CreateNote { .. } => "create_note",
        AgentAction::AppendNote { .. } => "append_note",
        AgentAction::AppendDaily { .. } => "append_daily",
        AgentAction::OpenUrl { .. } => "open_url",
        AgentAction::ClipUrl { .. } => "clip_url",
        AgentAction::AddMemoryFact { .. } => "add_memory_fact",
        AgentAction::SaveAetherNote { .. } => "save_aether_note",
        AgentAction::CreateCalendarEvent { .. } => "create_calendar_event",
        AgentAction::UpdateCalendarEvent { .. } => "update_calendar_event",
        AgentAction::DeleteCalendarEvent { .. } => "delete_calendar_event",
        AgentAction::ListCalendarEvents { .. } => "list_calendar_events",
        AgentAction::ImportCalendarIcs { .. } => "import_calendar_ics",
        AgentAction::RunCommand { .. } => "run_command",
        AgentAction::DeleteNote { .. } => "delete_note",
        AgentAction::MoveNote { .. } => "move_note",
        AgentAction::GitCommit { .. } => "git_commit",
        AgentAction::CreateTask { .. } => "create_task",
        AgentAction::ToggleVaultTask { .. } => "toggle_vault_task",
    }
}

/// True if this action is "safe" *and* purely local: it is
/// [`ActionRisk::Safe`] and does not touch the network (`open_url` and
/// `clip_url` are auto-executed but reach outside the machine).
#[allow(dead_code)]
pub fn is_safe_action(action: &AgentAction) -> bool {
    action_risk(action) == ActionRisk::Safe
        && !matches!(
            action,
            AgentAction::OpenUrl { .. } | AgentAction::ClipUrl { .. }
        )
}

/// Human-readable one-line summary, used for the audit log. The frontend
/// owns the UI copy (`src/lib/agentActions.ts::describeAction`).
pub fn describe_action(action: &AgentAction) -> String {
    match action {
        AgentAction::CreateNote { title, .. } => format!("Create note \"{title}\""),
        AgentAction::AppendNote { path, .. } => format!("Append to note {path}"),
        AgentAction::AppendDaily { content } => {
            format!("Add to daily note: {}", truncate(content, 60))
        }
        AgentAction::OpenUrl { url } => format!("Open {url}"),
        AgentAction::ClipUrl { url } => format!("Clip {url} into vault"),
        AgentAction::AddMemoryFact { fact, category } => {
            format!("Remember fact [{category}]: {}", truncate(fact, 60))
        }
        AgentAction::SaveAetherNote { title, .. } => {
            format!("Save answer as AETHER Note: \"{title}\"")
        }
        AgentAction::CreateCalendarEvent { title, start, .. } => {
            format!("Create event \"{title}\" on {start}")
        }
        AgentAction::UpdateCalendarEvent { id, .. } => {
            format!("Update calendar event {id}")
        }
        AgentAction::DeleteCalendarEvent { id } => {
            format!("Delete calendar event {id}")
        }
        AgentAction::ListCalendarEvents { from, to } => match (from, to) {
            (Some(f), Some(t)) => format!("List calendar events {f} → {t}"),
            (Some(f), None) => format!("List calendar events from {f}"),
            (None, Some(t)) => format!("List calendar events up to {t}"),
            (None, None) => "List calendar events".to_owned(),
        },
        AgentAction::ImportCalendarIcs { path, .. } => {
            format!("Import ICS file: {}", truncate(path, 60))
        }
        AgentAction::RunCommand { command, cwd } => match cwd {
            Some(dir) if !dir.trim().is_empty() => {
                format!("Run `{}` in {}", truncate(command, 80), truncate(dir, 60))
            }
            _ => format!("Run `{}` in the vault", truncate(command, 80)),
        },
        AgentAction::DeleteNote { path } => format!("Move note {} to trash", truncate(path, 80)),
        AgentAction::MoveNote { from, to } => {
            format!("Move note {} → {}", truncate(from, 60), truncate(to, 60))
        }
        AgentAction::GitCommit {
            project_path,
            message,
        } => format!(
            "Commit in {}: {}",
            truncate(project_path, 60),
            truncate(message.lines().next().unwrap_or(""), 60)
        ),
        AgentAction::CreateTask { title, .. } => format!("Create task \"{}\"", truncate(title, 60)),
        AgentAction::ToggleVaultTask { note_path, line } => {
            format!("Toggle task on line {line} of {}", truncate(note_path, 60))
        }
    }
}

/// Execute an approved action against the vault + memory store.
/// `OpenUrl` and `ClipUrl` are NOT handled here (they need async + network
/// and have their own dedicated commands). The frontend routes those
/// variants to the right command before calling this one.
pub fn execute_action(reader: &VaultReader, action: &AgentAction) -> Result<String, AetherError> {
    match action {
        AgentAction::CreateNote { title, content } => {
            let path = reader.create_note(title, content)?;
            Ok(format!("Created note: {path}"))
        }
        AgentAction::AppendNote { path, content } => {
            reader.append_note(path, content)?;
            Ok(format!("Appended to: {path}"))
        }
        AgentAction::AppendDaily { content } => {
            let path = reader.append_daily_note(content)?;
            Ok(format!("Added to daily note: {path}"))
        }
        AgentAction::AddMemoryFact { fact, category } => {
            // Forward to the memory store; this needs AppState so it lives
            // in the command handler, not here. The frontend should call
            // `cmd_add_memory_fact` directly for this variant instead of
            // routing through `cmd_execute_agent_action`.
            Err(AetherError::InvalidInput(format!(
                "add_memory_fact must go through cmd_add_memory_fact (got {fact} / {category})"
            )))
        }
        AgentAction::SaveAetherNote { title, .. } => {
            // Same story — AETHER Notes go through a dedicated command.
            Err(AetherError::InvalidInput(format!(
                "save_aether_note must go through cmd_save_aether_note (got title=\"{title}\")"
            )))
        }
        AgentAction::OpenUrl { .. } | AgentAction::ClipUrl { .. } => Err(AetherError::InvalidInput(
            "open_url and clip_url must be routed through their dedicated commands"
                .to_string(),
        )),
        AgentAction::CreateCalendarEvent { title, .. } => {
            Err(AetherError::InvalidInput(format!(
                "create_calendar_event must go through cmd_create_calendar_event (got title=\"{title}\")"
            )))
        }
        AgentAction::UpdateCalendarEvent { id, .. } => {
            Err(AetherError::InvalidInput(format!(
                "update_calendar_event must go through cmd_update_calendar_event (got id={id})"
            )))
        }
        AgentAction::DeleteCalendarEvent { id } => {
            Err(AetherError::InvalidInput(format!(
                "delete_calendar_event must go through cmd_delete_calendar_event (got id={id})"
            )))
        }
        AgentAction::ListCalendarEvents { .. } => {
            Err(AetherError::InvalidInput(
                "list_calendar_events must go through cmd_list_calendar_events".to_string(),
            ))
        }
        AgentAction::ImportCalendarIcs { path, .. } => {
            Err(AetherError::InvalidInput(format!(
                "import_calendar_ics must go through cmd_import_calendar_ics (got path={path})"
            )))
        }
        AgentAction::RunCommand { .. }
        | AgentAction::DeleteNote { .. }
        | AgentAction::MoveNote { .. }
        | AgentAction::GitCommit { .. }
        | AgentAction::CreateTask { .. }
        | AgentAction::ToggleVaultTask { .. } => Err(AetherError::InvalidInput(format!(
            "{} needs approval and must go through its cmd_intel_* command",
            action_kind(action)
        ))),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn reader_with_vault() -> (tempfile::TempDir, tempfile::TempDir, VaultReader) {
        let vault = tempdir().expect("vault");
        let config = tempdir().expect("config");
        let reader = VaultReader::new(config.path()).expect("reader");
        reader
            .set_vault_path(vault.path().to_str().unwrap())
            .expect("set");
        (vault, config, reader)
    }

    #[test]
    fn parses_action_json() {
        let json = r##"{"action":"create_note","title":"Ideas","content":"# Hello"}"##;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        match action {
            AgentAction::CreateNote { title, content } => {
                assert_eq!(title, "Ideas");
                assert_eq!(content, "# Hello");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn parses_append_daily() {
        let json = r#"{"action":"append_daily","content":"buy milk"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::AppendDaily { .. }));
    }

    #[test]
    fn parses_add_memory_fact() {
        let json = r#"{"action":"add_memory_fact","fact":"x","category":"general"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::AddMemoryFact { .. }));
    }

    #[test]
    fn parses_save_aether_note() {
        let json = r#"{"action":"save_aether_note","title":"X","content":"y"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::SaveAetherNote { .. }));
    }

    #[test]
    fn describe_is_human_readable() {
        let action = AgentAction::CreateNote {
            title: "Test".into(),
            content: String::new(),
        };
        assert_eq!(describe_action(&action), "Create note \"Test\"");

        let daily = AgentAction::AppendDaily {
            content: "x".repeat(100),
        };
        assert!(describe_action(&daily).len() < 100);
    }

    #[test]
    fn is_safe_classification() {
        assert!(is_safe_action(&AgentAction::AppendDaily {
            content: "x".into()
        }));
        assert!(!is_safe_action(&AgentAction::OpenUrl { url: "x".into() }));
        assert!(!is_safe_action(&AgentAction::ClipUrl { url: "x".into() }));
    }

    #[test]
    fn execute_create_note_writes_to_vault() {
        let (_vault, _config, reader) = reader_with_vault();
        let result = execute_action(
            &reader,
            &AgentAction::CreateNote {
                title: "agent/Idea".into(),
                content: "# From the agent".into(),
            },
        )
        .expect("execute");
        assert!(result.contains("agent/Idea.md"));
    }

    #[test]
    fn execute_append_daily_creates_daily_note() {
        let (_vault, _config, reader) = reader_with_vault();
        let result = execute_action(
            &reader,
            &AgentAction::AppendDaily {
                content: "remember this".into(),
            },
        )
        .expect("execute");
        assert!(result.contains("daily/"));
    }

    #[test]
    fn execute_rejects_routed_variants() {
        let (_vault, _config, reader) = reader_with_vault();
        let result = execute_action(
            &reader,
            &AgentAction::OpenUrl {
                url: "https://example.com".into(),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn parses_create_calendar_event() {
        let json = r#"{"action":"create_calendar_event","title":"Standup","description":"","all_day":false,"start":"2026-10-10T09:00:00+00:00","end":"2026-10-10T09:15:00+00:00","tags":[],"attendees":[]}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::CreateCalendarEvent { .. }));
    }

    #[test]
    fn parses_update_calendar_event() {
        let json = r#"{"action":"update_calendar_event","id":"abc","title":"Renamed"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::UpdateCalendarEvent { .. }));
    }

    #[test]
    fn parses_delete_calendar_event() {
        let json = r#"{"action":"delete_calendar_event","id":"abc"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::DeleteCalendarEvent { .. }));
    }

    #[test]
    fn parses_list_calendar_events() {
        let json = r#"{"action":"list_calendar_events","from":"2026-10-01","to":"2026-10-31"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::ListCalendarEvents { .. }));
    }

    #[test]
    fn parses_import_calendar_ics() {
        let json = r##"{"action":"import_calendar_ics","path":"/tmp/foo.ics","overwrite_existing":false,"default_color":"#7c3aed"}"##;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(action, AgentAction::ImportCalendarIcs { .. }));
    }

    #[test]
    fn parses_run_command_with_and_without_cwd() {
        let with: AgentAction =
            serde_json::from_str(r#"{"action":"run_command","command":"ls -la","cwd":"/tmp"}"#)
                .expect("parse");
        match with {
            AgentAction::RunCommand { command, cwd } => {
                assert_eq!(command, "ls -la");
                assert_eq!(cwd.as_deref(), Some("/tmp"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        let without: AgentAction =
            serde_json::from_str(r#"{"action":"run_command","command":"pwd"}"#).expect("parse");
        assert!(matches!(without, AgentAction::RunCommand { cwd: None, .. }));
    }

    #[test]
    fn parses_the_intel_note_and_task_variants() {
        let cases = [
            (r#"{"action":"delete_note","path":"Old.md"}"#, "delete_note"),
            (
                r#"{"action":"move_note","from":"a.md","to":"archive/a.md"}"#,
                "move_note",
            ),
            (
                r#"{"action":"git_commit","project_path":"/p","message":"fix"}"#,
                "git_commit",
            ),
            (
                r#"{"action":"create_task","title":"Ship it"}"#,
                "create_task",
            ),
            (
                r#"{"action":"create_task","project_id":"Inbox","title":"x","description":"d","priority":"high","due_date":"2026-10-01"}"#,
                "create_task",
            ),
            (
                r#"{"action":"toggle_vault_task","note_path":"todo.md","line":3}"#,
                "toggle_vault_task",
            ),
        ];
        for (json, kind) in cases {
            let action: AgentAction = serde_json::from_str(json).expect(json);
            assert_eq!(action_kind(&action), kind);
            // Round-trips through serde with the same discriminator.
            let value = serde_json::to_value(&action).expect("serialize");
            assert_eq!(value["action"], kind);
        }
    }

    #[test]
    fn risk_classification_matches_the_approval_policy() {
        let run = AgentAction::RunCommand {
            command: "rm -rf build".into(),
            cwd: None,
        };
        let delete = AgentAction::DeleteNote {
            path: "x.md".into(),
        };
        let delete_event = AgentAction::DeleteCalendarEvent { id: "e".into() };
        assert_eq!(action_risk(&run), ActionRisk::Dangerous);
        assert_eq!(action_risk(&delete), ActionRisk::Dangerous);
        assert_eq!(action_risk(&delete_event), ActionRisk::Dangerous);

        let confirm = [
            AgentAction::MoveNote {
                from: "a".into(),
                to: "b".into(),
            },
            AgentAction::GitCommit {
                project_path: "/p".into(),
                message: "m".into(),
            },
            AgentAction::ToggleVaultTask {
                note_path: "n.md".into(),
                line: 1,
            },
        ];
        for action in &confirm {
            assert_eq!(action_risk(action), ActionRisk::Confirm, "{action:?}");
            assert!(!is_safe_action(action));
        }

        let task = AgentAction::CreateTask {
            project_id: None,
            title: "t".into(),
            description: None,
            priority: None,
            due_date: None,
        };
        assert_eq!(action_risk(&task), ActionRisk::Safe);
        assert!(is_safe_action(&task));
        // Auto-executed but not purely local.
        assert_eq!(
            action_risk(&AgentAction::OpenUrl { url: "x".into() }),
            ActionRisk::Safe
        );
    }

    #[test]
    fn describes_the_intel_variants() {
        let run = AgentAction::RunCommand {
            command: "npm test".into(),
            cwd: Some("/work/app".into()),
        };
        assert_eq!(describe_action(&run), "Run `npm test` in /work/app");
        let run_vault = AgentAction::RunCommand {
            command: "ls".into(),
            cwd: None,
        };
        assert_eq!(describe_action(&run_vault), "Run `ls` in the vault");
        let commit = AgentAction::GitCommit {
            project_path: "/p".into(),
            message: "feat: x\n\nbody".into(),
        };
        assert_eq!(describe_action(&commit), "Commit in /p: feat: x");
    }

    #[test]
    fn execute_rejects_the_intel_variants() {
        let (_vault, _config, reader) = reader_with_vault();
        let err = execute_action(
            &reader,
            &AgentAction::DeleteNote {
                path: "x.md".into(),
            },
        )
        .expect_err("must be routed");
        assert!(err.to_string().contains("cmd_intel_"));
    }
}
