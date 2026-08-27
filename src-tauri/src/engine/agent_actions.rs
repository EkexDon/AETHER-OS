use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultReader;

/// A structured action the AI agent proposes. The frontend parses these
/// from ```action fenced blocks in the AI output and asks the user for
/// approval before calling `cmd_execute_agent_action`.
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
}

/// Human-readable one-line summary for the approval UI.
#[cfg(test)]
pub fn describe_action(action: &AgentAction) -> String {
    match action {
        AgentAction::CreateNote { title, .. } => format!("Create note \"{title}\""),
        AgentAction::AppendNote { path, .. } => format!("Append to note {path}"),
        AgentAction::AppendDaily { content } => {
            format!("Add to daily note: {}", truncate(content, 60))
        }
        AgentAction::OpenUrl { url } => format!("Open {url}"),
        AgentAction::ClipUrl { url } => format!("Clip {url} into vault"),
    }
}

/// Execute an approved action against the vault.
/// ClipUrl is handled by a dedicated command (it needs the async clipper).
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
        AgentAction::OpenUrl { url } => Ok(format!("Open URL: {url}")),
        AgentAction::ClipUrl { url } => Ok(format!("Clip URL: {url}")),
    }
}

#[cfg(test)]
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
}
