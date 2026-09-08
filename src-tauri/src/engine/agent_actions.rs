use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultReader;

/// A structured action the AI agent proposes. The frontend parses these
/// from ```action fenced blocks in the AI output and asks the user for
/// approval before calling `cmd_execute_agent_action`.
///
/// `OpenUrl` and `ClipUrl` are async-capable (they hit the network) and
/// the dedicated commands `cmd_execute_open_url` and `cmd_execute_clip_url`
/// handle them end-to-end. The remaining variants are pure vault writes
/// and go through `execute_action` synchronously.
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
}

/// True if this action is "safe" — i.e. only touches the local vault and
/// requires no user approval beyond the initial one. Used by the frontend
/// to decide whether to auto-execute on Approve vs. always show a diff.
#[allow(dead_code)]
pub fn is_safe_action(action: &AgentAction) -> bool {
    matches!(
        action,
        AgentAction::CreateNote { .. }
            | AgentAction::AppendNote { .. }
            | AgentAction::AppendDaily { .. }
            | AgentAction::AddMemoryFact { .. }
            | AgentAction::SaveAetherNote { .. }
            | AgentAction::CreateCalendarEvent { .. }
            | AgentAction::ListCalendarEvents { .. }
    )
}

/// Human-readable one-line summary for the approval UI. The frontend
/// owns the runtime copy (`src/lib/agentActions.ts::describeAction`);
/// this one is kept here for future Rust-side UI and for tests.
#[allow(dead_code)]
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
    }
}

#[allow(dead_code)]
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
        assert!(is_safe_action(&AgentAction::AppendDaily { content: "x".into() }));
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
        assert!(matches!(
            action,
            AgentAction::CreateCalendarEvent { .. }
        ));
    }

    #[test]
    fn parses_update_calendar_event() {
        let json = r#"{"action":"update_calendar_event","id":"abc","title":"Renamed"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(
            action,
            AgentAction::UpdateCalendarEvent { .. }
        ));
    }

    #[test]
    fn parses_delete_calendar_event() {
        let json = r#"{"action":"delete_calendar_event","id":"abc"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(
            action,
            AgentAction::DeleteCalendarEvent { .. }
        ));
    }

    #[test]
    fn parses_list_calendar_events() {
        let json =
            r#"{"action":"list_calendar_events","from":"2026-10-01","to":"2026-10-31"}"#;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(
            action,
            AgentAction::ListCalendarEvents { .. }
        ));
    }

    #[test]
    fn parses_import_calendar_ics() {
        let json = r##"{"action":"import_calendar_ics","path":"/tmp/foo.ics","overwrite_existing":false,"default_color":"#7c3aed"}"##;
        let action: AgentAction = serde_json::from_str(json).expect("parse");
        assert!(matches!(
            action,
            AgentAction::ImportCalendarIcs { .. }
        ));
    }
}
