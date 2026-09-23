//! Conversation auto-compaction.
//!
//! The chat keeps its full transcript on disk, but only a bounded window is
//! sent to the model: a structured summary of everything older plus the most
//! recent messages. This module owns the pieces of that pipeline that do not
//! need network access, so they are unit-testable:
//!
//! - token estimation (`chars / 4`, rounded up, plus a per-message overhead —
//!   mirrored exactly in `src/lib/intel/tokens.ts`),
//! - the threshold rule and the split into "summarise" vs. "keep",
//! - the strict summarisation prompt and validation of what the model returns,
//! - an extractive fallback (first sentences of user turns) for when the
//!   model is offline or answers with garbage,
//! - the memory/conversation blocks injected into chat prompts.
//!
//! Compacted conversations are persisted through
//! [`MemoryStore::upsert_conversation`](crate::engine::memory_store::MemoryStore::upsert_conversation),
//! with the summary in the record's `summary` field.

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;
use crate::engine::memory_store::{ChatMessageRecord, Conversation, MemoryFact};

/// Default compaction threshold in estimated tokens.
pub const DEFAULT_THRESHOLD_TOKENS: usize = 6_000;
/// Default number of most recent messages kept verbatim.
pub const DEFAULT_KEEP_RECENT: usize = 4;
/// Characters per token of the estimate heuristic.
pub const CHARS_PER_TOKEN: usize = 4;
/// Fixed per-message cost (role markers, separators) of the estimate.
pub const MESSAGE_OVERHEAD_TOKENS: usize = 4;
/// Upper bound for a stored summary.
pub const MAX_SUMMARY_CHARS: usize = 1_600;
/// Section headings of the summary format, in order.
pub const SECTIONS: [&str; 4] = ["Facts", "Decisions", "Open questions", "User preferences"];

const MAX_BULLETS_PER_SECTION: usize = 8;
const MAX_BULLET_CHARS: usize = 220;
const MAX_TOPIC_CHARS: usize = 90;
/// Transcript size sent to the summariser. Local models run with a 4k
/// context, so the prompt must stay well below ~3k tokens.
const TRANSCRIPT_BUDGET_CHARS: usize = 9_000;
const MIN_MESSAGE_CHARS: usize = 240;
const TITLE_CHARS: usize = 80;

/// The system prompt of the summariser. Strict on purpose: small local
/// models follow a fixed skeleton far more reliably than open instructions.
pub const SUMMARY_SYSTEM_PROMPT: &str =
    "You compress chat transcripts into durable memory for an AI assistant. \
Reply with the summary ONLY, in exactly this format and nothing else:\n\
Topic: <what the conversation is about, at most 12 words>\n\
Facts:\n- <fact>\n\
Decisions:\n- <decision>\n\
Open questions:\n- <open question or next step>\n\
User preferences:\n- <preference>\n\n\
Rules:\n\
1. Write '- none' under a heading that has nothing.\n\
2. At most 8 bullets per heading, each under 25 words.\n\
3. Keep names, numbers, dates, note titles, file paths and commands exactly as written.\n\
4. Only include what the transcript or the previous summary states. Never invent anything.\n\
5. Merge the previous summary: keep what is still true, drop what was superseded.\n\
6. Write in the language of the conversation.";

/// Estimated tokens of a text: `ceil(chars / 4)`.
pub fn estimate_tokens(text: &str) -> usize {
    text.chars().count().div_ceil(CHARS_PER_TOKEN)
}

/// Estimated tokens of a message list, including per-message overhead.
pub fn estimate_messages_tokens(messages: &[ChatMessageRecord]) -> usize {
    messages
        .iter()
        .map(|m| estimate_tokens(&m.content) + MESSAGE_OVERHEAD_TOKENS)
        .sum()
}

/// Estimated tokens of what the model sees: the summary (if any) counted
/// like one extra message, plus the verbatim messages.
pub fn estimate_conversation_tokens(
    summary: Option<&str>,
    messages: &[ChatMessageRecord],
) -> usize {
    let summary_tokens = summary
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| estimate_tokens(s) + MESSAGE_OVERHEAD_TOKENS)
        .unwrap_or(0);
    summary_tokens + estimate_messages_tokens(messages)
}

/// Split `messages` into `(to_summarize, kept)`. The last `keep_recent`
/// messages are kept; if that window would start with an assistant reply,
/// its user turn is kept as well (as long as something is left to
/// summarise), so the model never sees an answer without its question.
pub fn split_for_compaction(
    messages: &[ChatMessageRecord],
    keep_recent: usize,
) -> (Vec<ChatMessageRecord>, Vec<ChatMessageRecord>) {
    let keep = keep_recent.max(1).min(messages.len());
    let mut split = messages.len() - keep;
    if split > 1 && messages[split].role == "assistant" && messages[split - 1].role == "user" {
        split -= 1;
    }
    (messages[..split].to_vec(), messages[split..].to_vec())
}

/// Where a summary came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SummarySource {
    /// The current chat model wrote it.
    Model,
    /// Built locally from the transcript because the model failed.
    Extractive,
}

/// Outcome of `cmd_intel_compact`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionResult {
    /// Structured summary of the dropped messages (and the previous summary).
    pub summary: String,
    /// Messages that stay verbatim in the prompt window.
    pub kept_messages: Vec<ChatMessageRecord>,
    /// How many messages the summary replaces.
    pub dropped_count: usize,
    /// Estimate before compaction (previous summary + all messages).
    pub tokens_before: usize,
    /// Estimate after compaction (new summary + kept messages).
    pub tokens_after: usize,
    pub source: SummarySource,
    /// Why the model summary was rejected, when `source` is `extractive`.
    pub model_error: Option<String>,
}

/// A compaction that has been split but not yet summarised.
#[derive(Debug, Clone)]
pub struct CompactionPlan {
    previous: Option<String>,
    to_summarize: Vec<ChatMessageRecord>,
    kept: Vec<ChatMessageRecord>,
    tokens_before: usize,
}

/// Prepare a compaction. Fails when there is nothing older than the kept
/// window, which the UI prevents by only offering compaction beyond it.
pub fn plan_compaction(
    previous_summary: Option<&str>,
    messages: &[ChatMessageRecord],
    keep_recent: usize,
) -> Result<CompactionPlan, AetherError> {
    let previous = previous_summary
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let (to_summarize, kept) = split_for_compaction(messages, keep_recent);
    if to_summarize.is_empty() {
        return Err(AetherError::InvalidInput(format!(
            "nothing to compact yet: the conversation has {} message(s) and the last {} are always kept",
            messages.len(),
            keep_recent.max(1)
        )));
    }
    let tokens_before = estimate_conversation_tokens(previous.as_deref(), messages);
    Ok(CompactionPlan {
        previous,
        to_summarize,
        kept,
        tokens_before,
    })
}

impl CompactionPlan {
    /// The user prompt for the summariser.
    pub fn prompt(&self) -> String {
        build_summary_prompt(self.previous.as_deref(), &self.to_summarize)
    }

    /// Finish with the model's raw answer (or its error). Invalid or failed
    /// model output falls back to the extractive summary; this never fails.
    pub fn finish(self, model_output: Result<String, AetherError>) -> CompactionResult {
        let validated = model_output.and_then(|raw| validate_summary(&raw, &self.to_summarize));
        let (summary, source, model_error) = match validated {
            Ok(summary) => (summary, SummarySource::Model, None),
            Err(error) => (
                extractive_summary(self.previous.as_deref(), &self.to_summarize),
                SummarySource::Extractive,
                Some(error.to_string()),
            ),
        };
        let tokens_after = estimate_conversation_tokens(Some(&summary), &self.kept);
        CompactionResult {
            dropped_count: self.to_summarize.len(),
            summary,
            kept_messages: self.kept,
            tokens_before: self.tokens_before,
            tokens_after,
            source,
            model_error,
        }
    }
}

/// Build the summariser's user prompt from an optional previous summary and
/// the messages to fold in.
pub fn build_summary_prompt(previous: Option<&str>, messages: &[ChatMessageRecord]) -> String {
    let mut out = String::new();
    if let Some(prev) = previous.map(str::trim).filter(|p| !p.is_empty()) {
        out.push_str("Previous summary:\n");
        out.push_str(prev);
        out.push_str("\n\n");
    }
    out.push_str("Transcript:\n");
    out.push_str(&render_transcript(messages, TRANSCRIPT_BUDGET_CHARS));
    out.push_str("\n\nWrite the summary now.");
    out
}

/// One line per message (`User: …` / `Assistant: …`), whitespace collapsed,
/// action blocks replaced by a marker, each message clipped to its share of
/// the budget. When even the minimum share does not fit, the first message
/// (usually the topic) and the newest ones are kept.
pub fn render_transcript(messages: &[ChatMessageRecord], budget_chars: usize) -> String {
    if messages.is_empty() {
        return "(empty)".to_owned();
    }
    let share = (budget_chars / messages.len()).max(MIN_MESSAGE_CHARS);
    let lines: Vec<String> = messages
        .iter()
        .map(|m| {
            format!(
                "{}: {}",
                role_label(&m.role),
                clip(&clean_message(&m.content), share)
            )
        })
        .collect();
    let total: usize = lines.iter().map(|l| l.chars().count() + 1).sum();
    if total <= budget_chars || lines.len() <= 2 {
        return lines.join("\n");
    }
    // Keep the first line, then as many of the newest lines as fit.
    let first = &lines[0];
    let mut used = first.chars().count() + 1;
    let mut tail: Vec<&String> = Vec::new();
    for line in lines[1..].iter().rev() {
        let len = line.chars().count() + 1;
        if used + len > budget_chars {
            break;
        }
        used += len;
        tail.push(line);
    }
    tail.reverse();
    let omitted = lines.len() - 1 - tail.len();
    let mut out = vec![first.clone()];
    if omitted > 0 {
        out.push(format!("[… {omitted} message(s) omitted …]"));
    }
    out.extend(tail.into_iter().cloned());
    out.join("\n")
}

fn role_label(role: &str) -> String {
    match role {
        "user" => "User".to_owned(),
        "assistant" => "Assistant".to_owned(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => "Message".to_owned(),
            }
        }
    }
}

/// Replace fenced ```action blocks with a marker and collapse whitespace.
pub fn clean_message(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("```action") {
        out.push_str(&rest[..start]);
        let after = &rest[start + "```action".len()..];
        match after.find("```") {
            Some(end) => {
                let body = &after[..end];
                let kind = serde_json::from_str::<serde_json::Value>(body.trim())
                    .ok()
                    .and_then(|v| v.get("action").and_then(|a| a.as_str()).map(str::to_owned))
                    .unwrap_or_else(|| "action".to_owned());
                out.push_str(&format!(" [action: {kind}] "));
                rest = &after[end + 3..];
            }
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Clip to at most `max` characters, ending with `…` when clipped.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out = out.trim_end().to_owned();
    out.push('…');
    out
}

/// First sentence of a text (whitespace collapsed, action blocks removed),
/// at most 160 characters.
pub fn first_sentence(text: &str) -> String {
    let cleaned = clean_message(text);
    let mut end = cleaned.len();
    let bytes: Vec<(usize, char)> = cleaned.char_indices().collect();
    for (i, (idx, ch)) in bytes.iter().enumerate() {
        if matches!(ch, '.' | '!' | '?') {
            let next = bytes.get(i + 1).map(|(_, c)| *c);
            if next.is_none() || next.is_some_and(char::is_whitespace) {
                end = idx + ch.len_utf8();
                break;
            }
        }
    }
    clip(cleaned[..end].trim(), 160)
}

/// All sentences of a text (whitespace collapsed).
fn sentences(text: &str) -> Vec<String> {
    let cleaned = clean_message(text);
    let mut out = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = cleaned.chars().collect();
    for (i, ch) in chars.iter().enumerate() {
        current.push(*ch);
        let boundary =
            matches!(ch, '.' | '!' | '?') && chars.get(i + 1).map_or(true, |c| c.is_whitespace());
        if boundary {
            let s = current.trim().to_owned();
            if !s.is_empty() {
                out.push(s);
            }
            current.clear();
        }
    }
    let s = current.trim().to_owned();
    if !s.is_empty() {
        out.push(s);
    }
    out
}

/// A summary split into its topic and the four bullet sections.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SummarySections {
    pub topic: Option<String>,
    /// Bullets per section, in [`SECTIONS`] order.
    pub sections: [Vec<String>; 4],
}

impl SummarySections {
    /// Parse a summary leniently: headings may be Markdown (`## Facts`,
    /// `**Facts:**`), bullets may use `-`, `*`, `•` or numbers, and `none`
    /// placeholders are dropped. Text without any heading becomes facts.
    pub fn parse(text: &str) -> Self {
        let mut parsed = SummarySections::default();
        let mut current: Option<usize> = None;
        let mut saw_heading = false;
        let mut loose: Vec<String> = Vec::new();
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            // Headings may carry Markdown markup; bullets keep theirs.
            let unmarked = strip_markup(line);
            if let Some(rest) = strip_prefix_ci(&unmarked, "topic:") {
                let topic = clean_bullet(rest);
                if !topic.is_empty() {
                    parsed.topic = Some(clip(&topic, MAX_TOPIC_CHARS));
                }
                continue;
            }
            if let Some((index, rest)) = match_heading(&unmarked) {
                current = Some(index);
                saw_heading = true;
                let rest = clean_bullet(rest);
                if !rest.is_empty() && !is_none_marker(&rest) {
                    parsed.sections[index].push(rest);
                }
                continue;
            }
            let bullet = clean_bullet(line);
            if bullet.is_empty() || is_none_marker(&bullet) {
                continue;
            }
            match current {
                Some(index) => parsed.sections[index].push(bullet),
                None => loose.push(bullet),
            }
        }
        if !saw_heading {
            parsed.sections[0] = loose;
        }
        for section in parsed.sections.iter_mut() {
            dedupe(section);
            section.truncate(MAX_BULLETS_PER_SECTION);
            for bullet in section.iter_mut() {
                *bullet = clip(bullet, MAX_BULLET_CHARS);
            }
        }
        parsed
    }

    /// Render in the canonical format, shrinking the longest sections until
    /// the text fits [`MAX_SUMMARY_CHARS`].
    pub fn render(&self) -> String {
        let mut sections = self.sections.clone();
        loop {
            let text = render_sections(self.topic.as_deref(), &sections);
            if text.chars().count() <= MAX_SUMMARY_CHARS {
                return text;
            }
            let longest = sections
                .iter()
                .enumerate()
                .max_by_key(|(_, s)| s.len())
                .map(|(i, _)| i)
                .unwrap_or(0);
            if sections[longest].is_empty() {
                return clip(&text, MAX_SUMMARY_CHARS);
            }
            sections[longest].pop();
        }
    }
}

fn render_sections(topic: Option<&str>, sections: &[Vec<String>; 4]) -> String {
    let mut out = format!("Topic: {}\n", topic.unwrap_or("Conversation"));
    for (name, bullets) in SECTIONS.iter().zip(sections.iter()) {
        out.push_str(name);
        out.push_str(":\n");
        if bullets.is_empty() {
            out.push_str("- none\n");
        }
        for bullet in bullets {
            out.push_str("- ");
            out.push_str(bullet);
            out.push('\n');
        }
    }
    out.trim_end().to_owned()
}

fn strip_markup(line: &str) -> String {
    let line = line.trim_start_matches('#').trim();
    let line = line.trim_start_matches("**").trim_end_matches("**");
    // `**Facts:**` leaves `Facts:` after stripping the outer pair; `**Facts**:`
    // leaves `Facts**:` — normalise that too.
    line.replace("**:", ":").trim().to_owned()
}

fn strip_prefix_ci<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let head = line.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        Some(line[prefix.len()..].trim())
    } else {
        None
    }
}

/// Recognise a section heading (optionally followed by `: text`).
fn match_heading(line: &str) -> Option<(usize, &str)> {
    const ALIASES: [(&str, usize); 9] = [
        ("facts", 0),
        ("key facts", 0),
        ("decisions", 1),
        ("open questions", 2),
        ("questions", 2),
        ("next steps", 2),
        ("open items", 2),
        ("user preferences", 3),
        ("preferences", 3),
    ];
    for (alias, index) in ALIASES {
        // Aliases are ASCII, so a byte-prefix comparison is char-safe.
        let Some(head) = line.get(..alias.len()) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(alias) {
            continue;
        }
        let rest = line[alias.len()..].trim_start();
        if rest.is_empty() {
            return Some((index, ""));
        }
        if let Some(after_colon) = rest.strip_prefix(':') {
            return Some((index, after_colon.trim()));
        }
    }
    None
}

fn clean_bullet(text: &str) -> String {
    let mut t = text.trim();
    for marker in ["- ", "* ", "• ", "– ", "+ "] {
        if let Some(rest) = t.strip_prefix(marker) {
            t = rest.trim();
            break;
        }
    }
    if t == "-" || t == "*" || t == "•" {
        return String::new();
    }
    // Numbered bullets: "1. text" / "2) text".
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits < 4 {
        let rest = &t[digits..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            t = r.trim();
        }
    }
    t.to_owned()
}

fn is_none_marker(text: &str) -> bool {
    let t = text
        .trim()
        .trim_matches(|c: char| c == '.' || c == '(' || c == ')' || c == '_' || c == '*')
        .to_lowercase();
    matches!(
        t.as_str(),
        "none" | "n/a" | "na" | "nothing" | "keine" | "none yet" | "none recorded" | "-"
    )
}

fn dedupe(items: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert(item.to_lowercase()));
}

/// Validate and normalise the model's summary. Rejects empty output,
/// refusals and text without any usable content; adds a topic derived from
/// the first user message when the model left it out.
pub fn validate_summary(raw: &str, messages: &[ChatMessageRecord]) -> Result<String, AetherError> {
    let cleaned = strip_code_fence(raw.trim());
    if cleaned.chars().count() < 16 {
        return Err(AetherError::AiEngine(
            "the model returned an empty summary".to_owned(),
        ));
    }
    let lower = cleaned.to_lowercase();
    const REFUSALS: [&str; 5] = ["i'm sorry", "i am sorry", "i cannot", "i can't", "as an ai"];
    if REFUSALS.iter().any(|r| lower.starts_with(r)) {
        return Err(AetherError::AiEngine(
            "the model refused to summarise".to_owned(),
        ));
    }
    let mut parsed = SummarySections::parse(&cleaned);
    if parsed.sections.iter().all(Vec::is_empty) {
        return Err(AetherError::AiEngine(
            "the model summary has no content".to_owned(),
        ));
    }
    if parsed.topic.is_none() {
        parsed.topic = fallback_topic(messages);
    }
    Ok(parsed.render())
}

fn strip_code_fence(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let body = rest.split_once('\n').map(|(_, b)| b).unwrap_or("");
        return body.trim_end().trim_end_matches("```").trim().to_owned();
    }
    t.to_owned()
}

fn fallback_topic(messages: &[ChatMessageRecord]) -> Option<String> {
    messages
        .iter()
        .find(|m| m.role == "user" && !m.content.trim().is_empty())
        .map(|m| clip(&first_sentence(&m.content), MAX_TOPIC_CHARS))
        .filter(|t| !t.is_empty())
}

const PREFERENCE_MARKERS: [&str; 14] = [
    "i prefer",
    "i like",
    "i want",
    "i'd rather",
    "i would rather",
    "please always",
    "always use",
    "never use",
    "don't",
    "do not",
    "ich möchte",
    "ich bevorzuge",
    "bitte immer",
    "lieber",
];

/// Deterministic summary built from the transcript alone: each user turn's
/// first sentence as a fact, recent questions as open questions and
/// sentences with preference markers as preferences, merged into the
/// previous summary.
pub fn extractive_summary(previous: Option<&str>, messages: &[ChatMessageRecord]) -> String {
    let mut parsed = previous.map(SummarySections::parse).unwrap_or_default();
    if parsed.topic.is_none() {
        parsed.topic = fallback_topic(messages);
    }
    let user_turns: Vec<&ChatMessageRecord> = messages
        .iter()
        .filter(|m| m.role == "user" && !m.content.trim().is_empty())
        .collect();
    for turn in &user_turns {
        let sentence = first_sentence(&turn.content);
        if !sentence.is_empty() {
            parsed.sections[0].push(format!("User asked: {sentence}"));
        }
    }
    for turn in user_turns.iter().rev().take(3).rev() {
        for sentence in sentences(&turn.content) {
            if sentence.ends_with('?') {
                parsed.sections[2].push(clip(&sentence, 160));
            }
        }
    }
    for turn in &user_turns {
        for sentence in sentences(&turn.content) {
            let lower = sentence.to_lowercase();
            if PREFERENCE_MARKERS.iter().any(|m| lower.contains(m)) {
                parsed.sections[3].push(clip(&sentence, 160));
            }
        }
    }
    for section in parsed.sections.iter_mut() {
        dedupe(section);
        // Keep the newest entries when a section overflows.
        if section.len() > MAX_BULLETS_PER_SECTION {
            let overflow = section.len() - MAX_BULLETS_PER_SECTION;
            section.drain(..overflow);
        }
    }
    parsed.render()
}

/// True when `summary` is in the compaction format (starts with a topic
/// line and has at least one section heading).
pub fn is_compaction_summary(summary: &str) -> bool {
    let mut lines = summary.lines();
    let first = lines.next().unwrap_or("").trim();
    first.starts_with("Topic:")
        && summary
            .lines()
            .any(|l| SECTIONS.iter().any(|s| l.trim() == format!("{s}:")))
}

/// One-line title for a conversation: the topic of a compaction summary,
/// otherwise the summary's first line, clipped to 80 characters.
pub fn summary_title(summary: &str) -> String {
    let first = summary.lines().next().unwrap_or("").trim();
    let title = if is_compaction_summary(summary) {
        first.trim_start_matches("Topic:").trim()
    } else {
        first
    };
    clip(title, TITLE_CHARS + 1)
}

/// The chat window the frontend sends with a question: the conversation id
/// (so it is not repeated as a "recent topic"), its compaction summary and
/// the messages after the compaction point.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConversationContext {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub history: Vec<ChatMessageRecord>,
}

impl ConversationContext {
    /// True when there is neither a summary nor history to send.
    pub fn is_empty(&self) -> bool {
        self.summary
            .as_deref()
            .map_or(true, |s| s.trim().is_empty())
            && self.history.is_empty()
    }
}

/// Character budgets for one chat prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptBudget {
    pub notes_chars: usize,
    pub summary_chars: usize,
    pub history_chars: usize,
    pub message_chars: usize,
}

/// Budgets per provider. Local models run with a 4k-token context, so the
/// note context shrinks when conversation history is sent along; cloud
/// models get a generous window.
pub fn prompt_budget(provider: Option<&str>, has_conversation: bool) -> PromptBudget {
    match (provider == Some("openrouter"), has_conversation) {
        (true, _) => PromptBudget {
            notes_chars: 6_000,
            summary_chars: MAX_SUMMARY_CHARS,
            history_chars: 12_000,
            message_chars: 3_000,
        },
        (false, true) => PromptBudget {
            notes_chars: 4_800,
            summary_chars: 1_400,
            history_chars: 2_400,
            message_chars: 900,
        },
        (false, false) => PromptBudget {
            notes_chars: 6_000,
            summary_chars: 0,
            history_chars: 0,
            message_chars: 0,
        },
    }
}

/// The conversation block of a chat prompt: summary first, then the newest
/// messages that fit the budget (oldest first). Empty when there is nothing.
pub fn render_conversation_block(ctx: &ConversationContext, budget: &PromptBudget) -> String {
    let mut out = String::new();
    if let Some(summary) = ctx
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if budget.summary_chars > 0 {
            out.push_str("Summary of the earlier conversation:\n");
            out.push_str(&clip(summary, budget.summary_chars));
            out.push_str("\n\n");
        }
    }
    if budget.history_chars > 0 && !ctx.history.is_empty() {
        let mut used = 0usize;
        let mut lines: Vec<String> = Vec::new();
        for message in ctx.history.iter().rev() {
            let line = format!(
                "{}: {}",
                role_label(&message.role),
                clip(
                    &clean_message(&message.content),
                    budget.message_chars.max(80)
                )
            );
            let len = line.chars().count() + 1;
            if used + len > budget.history_chars && !lines.is_empty() {
                break;
            }
            used += len;
            lines.push(line);
        }
        lines.reverse();
        out.push_str("Recent messages (oldest first):\n");
        out.push_str(&lines.join("\n"));
        out.push('\n');
    }
    out.trim_end().to_owned()
}

/// Build the user prompt of a chat turn from the note context, the
/// conversation block and the question.
pub fn build_chat_user_prompt(
    context_intro: &str,
    context: &str,
    conversation: Option<&ConversationContext>,
    budget: &PromptBudget,
    question: &str,
) -> String {
    let block = conversation
        .map(|c| render_conversation_block(c, budget))
        .unwrap_or_default();
    if block.is_empty() {
        format!("{context_intro}\n\n{context}\n\n---\n\nUser question: {question}")
    } else {
        format!(
            "{context_intro}\n\n{context}\n\n---\n\n{block}\n\n---\n\nUser question: {question}"
        )
    }
}

/// Memory block appended to the system prompt: the ten newest facts and up
/// to five recent conversation titles (never the current conversation, whose
/// summary travels in the user prompt instead).
pub fn build_memory_section(
    facts: &[MemoryFact],
    recent: &[Conversation],
    exclude_id: Option<&str>,
) -> String {
    let mut out = String::new();
    if !facts.is_empty() {
        out.push_str("## What I know about the user\n");
        for fact in facts.iter().rev().take(10) {
            out.push_str(&format!("- {}\n", fact.fact));
        }
    }
    let topics: Vec<String> = recent
        .iter()
        .filter(|c| Some(c.id.as_str()) != exclude_id)
        .map(|c| summary_title(&c.summary))
        .filter(|t| !t.is_empty())
        .take(5)
        .collect();
    if !topics.is_empty() {
        out.push_str("\n## Recent conversation topics\n");
        for topic in topics {
            out.push_str(&format!("- {topic}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessageRecord {
        ChatMessageRecord {
            role: role.to_owned(),
            content: content.to_owned(),
        }
    }

    /// Turns with realistic lengths (≈300 characters per message).
    fn long_turns(n: usize) -> Vec<ChatMessageRecord> {
        (0..n)
            .flat_map(|i| {
                [
                    msg("user", &format!("Question {i}? {}", "detail ".repeat(42))),
                    msg("assistant", &format!("Answer {i}. {}", "word ".repeat(60))),
                ]
            })
            .collect()
    }

    fn turns(n: usize) -> Vec<ChatMessageRecord> {
        (0..n)
            .flat_map(|i| {
                [
                    msg("user", &format!("Question {i}? I prefer short answers.")),
                    msg("assistant", &format!("Answer {i}.")),
                ]
            })
            .collect()
    }

    #[test]
    fn estimates_tokens_as_chars_over_four_rounded_up() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        // Counts characters, not bytes.
        assert_eq!(estimate_tokens("äöüß"), 1);
        assert_eq!(
            estimate_messages_tokens(&[msg("user", "abcd")]),
            1 + MESSAGE_OVERHEAD_TOKENS
        );
        assert_eq!(
            estimate_conversation_tokens(Some("abcdefgh"), &[msg("user", "abcd")]),
            2 + MESSAGE_OVERHEAD_TOKENS + 1 + MESSAGE_OVERHEAD_TOKENS
        );
        assert_eq!(estimate_conversation_tokens(Some("   "), &[]), 0);
    }

    #[test]
    fn split_keeps_the_recent_window_and_whole_turns() {
        let messages = turns(4); // 8 messages, alternating user/assistant
        let (drop, keep) = split_for_compaction(&messages, 4);
        assert_eq!(drop.len(), 4);
        assert_eq!(keep.len(), 4);
        assert_eq!(keep[0].role, "user");

        // An odd window would start with an assistant reply: keep its question.
        let (drop, keep) = split_for_compaction(&messages, 3);
        assert_eq!(keep.len(), 4);
        assert_eq!(drop.len(), 4);
        assert_eq!(keep[0].role, "user");

        let (drop, keep) = split_for_compaction(&messages[..2], 4);
        assert!(drop.is_empty());
        assert_eq!(keep.len(), 2);
    }

    #[test]
    fn plan_rejects_short_conversations() {
        assert!(plan_compaction(None, &turns(1), 4).is_err());
        let plan = plan_compaction(Some("Topic: x\nFacts:\n- a"), &turns(4), 4).expect("plan");
        let prompt = plan.prompt();
        assert!(prompt.starts_with("Previous summary:\nTopic: x"));
        assert!(prompt.contains("Transcript:\nUser: Question 0?"));
        assert!(prompt.ends_with("Write the summary now."));
        // Only the dropped messages are in the transcript.
        assert!(!prompt.contains("Question 3"));
    }

    #[test]
    fn transcript_strips_actions_and_respects_the_budget() {
        let messages = vec![
            msg("user", "Please   remember\n\nthis"),
            msg(
                "assistant",
                "Sure.\n\n```action\n{\"action\":\"add_memory_fact\",\"fact\":\"x\",\"category\":\"general\"}\n```",
            ),
        ];
        let text = render_transcript(&messages, 9_000);
        assert_eq!(
            text,
            "User: Please remember this\nAssistant: Sure. [action: add_memory_fact]"
        );

        let long: Vec<ChatMessageRecord> = (0..40)
            .map(|i| {
                msg(
                    if i % 2 == 0 { "user" } else { "assistant" },
                    &format!("{i} {}", "x".repeat(400)),
                )
            })
            .collect();
        let clipped = render_transcript(&long, 3_000);
        assert!(clipped.chars().count() <= 3_000 + 40);
        assert!(clipped.starts_with("User: 0 "));
        assert!(clipped.contains("omitted"));
        assert!(clipped.contains("Assistant: 39 "));
    }

    #[test]
    fn validates_and_normalises_model_summaries() {
        let raw = "Here you go:\n## Topic: Moving to Berlin\n**Facts:**\n* Moving in October\n* Needs a van\nDecisions:\n1. Book the van on Friday\nOpen questions:\n- none\nUser preferences:\n- Short answers";
        let summary = validate_summary(raw, &[]).expect("valid");
        assert_eq!(
            summary,
            "Topic: Moving to Berlin\nFacts:\n- Moving in October\n- Needs a van\nDecisions:\n- Book the van on Friday\nOpen questions:\n- none\nUser preferences:\n- Short answers"
        );
        assert!(is_compaction_summary(&summary));
        assert_eq!(summary_title(&summary), "Moving to Berlin");
    }

    #[test]
    fn validation_adds_a_topic_and_accepts_unstructured_prose() {
        let messages = vec![msg("user", "How do lifetimes work? Explain.")];
        let summary = validate_summary(
            "The user learns Rust lifetimes from the Rust Ownership note.",
            &messages,
        )
        .expect("valid");
        assert!(summary.starts_with("Topic: How do lifetimes work?\nFacts:\n- The user learns"));
    }

    #[test]
    fn validation_rejects_empty_refusals_and_contentless_output() {
        assert!(validate_summary("   ", &[]).is_err());
        assert!(validate_summary("```\n\n```", &[]).is_err());
        assert!(validate_summary("I'm sorry, but I can't help with that request.", &[]).is_err());
        assert!(validate_summary("Topic: x\nFacts:\n- none\nDecisions:\n- none", &[]).is_err());
    }

    #[test]
    fn rendered_summaries_are_capped() {
        let bullets: String = (0..8)
            .map(|i| format!("- {i} {}\n", "y".repeat(200)))
            .collect();
        let raw =
            format!("Topic: big\nFacts:\n{bullets}Decisions:\n{bullets}Open questions:\n{bullets}");
        let summary = validate_summary(&raw, &[]).expect("valid");
        assert!(summary.chars().count() <= MAX_SUMMARY_CHARS);
        assert!(summary.starts_with("Topic: big"));
    }

    #[test]
    fn extractive_fallback_uses_first_sentences_of_user_turns() {
        let messages = vec![
            msg(
                "user",
                "Plan my move to Berlin. I prefer trains over flights.",
            ),
            msg("assistant", "Sure, here is a plan."),
            msg("user", "What about the internet contract? Can you check?"),
            msg("assistant", "Yes."),
        ];
        let summary = extractive_summary(None, &messages);
        assert!(summary.starts_with("Topic: Plan my move to Berlin.\n"));
        assert!(summary.contains("- User asked: Plan my move to Berlin."));
        assert!(summary.contains("- User asked: What about the internet contract?"));
        assert!(summary
            .contains("Open questions:\n- What about the internet contract?\n- Can you check?"));
        assert!(summary.contains("User preferences:\n- I prefer trains over flights."));
        assert!(summary.contains("Decisions:\n- none"));
    }

    #[test]
    fn extractive_fallback_merges_the_previous_summary() {
        let previous = "Topic: Thesis\nFacts:\n- Deadline is March\nDecisions:\n- Use RAG\nOpen questions:\n- none\nUser preferences:\n- none";
        let summary = extractive_summary(Some(previous), &[msg("user", "Add a chapter on evals.")]);
        assert!(summary.starts_with("Topic: Thesis\n"));
        assert!(summary.contains("- Deadline is March\n- User asked: Add a chapter on evals."));
        assert!(summary.contains("Decisions:\n- Use RAG"));
    }

    #[test]
    fn finish_falls_back_when_the_model_fails() {
        let plan = plan_compaction(None, &long_turns(5), 4).expect("plan");
        let result = plan.finish(Err(AetherError::AiEngine("offline".into())));
        assert_eq!(result.source, SummarySource::Extractive);
        assert_eq!(result.dropped_count, 6);
        assert_eq!(result.kept_messages.len(), 4);
        assert!(result
            .model_error
            .as_deref()
            .unwrap_or("")
            .contains("offline"));
        assert!(result.tokens_after < result.tokens_before);
        assert!(is_compaction_summary(&result.summary));

        let plan = plan_compaction(None, &long_turns(5), 4).expect("plan");
        let ok = plan.finish(Ok("Topic: Q&A\nFacts:\n- Asked five questions".into()));
        assert_eq!(ok.source, SummarySource::Model);
        assert!(ok.model_error.is_none());
        assert!(ok.summary.contains("- Asked five questions"));
    }

    #[test]
    fn first_sentence_handles_abbreviations_and_missing_punctuation() {
        assert_eq!(
            first_sentence("Version 1.5 is out. Next one soon."),
            "Version 1.5 is out."
        );
        assert_eq!(first_sentence("no punctuation here"), "no punctuation here");
        assert_eq!(first_sentence(""), "");
    }

    #[test]
    fn conversation_block_prefers_the_newest_messages() {
        let ctx = ConversationContext {
            id: None,
            summary: Some("Topic: T\nFacts:\n- f".into()),
            history: long_turns(20),
        };
        let budget = prompt_budget(Some("ollama"), true);
        let block = render_conversation_block(&ctx, &budget);
        assert!(block.starts_with("Summary of the earlier conversation:\nTopic: T"));
        assert!(block.contains("Recent messages (oldest first):"));
        let last = block.lines().last().unwrap_or("");
        assert!(last.starts_with("Assistant: Answer 19."), "{last}");
        assert!(!block.contains("Question 0?"));
        assert!(block.chars().count() <= budget.summary_chars + budget.history_chars + 100);

        let empty = ConversationContext::default();
        assert!(empty.is_empty());
        assert_eq!(render_conversation_block(&empty, &budget), "");
    }

    #[test]
    fn chat_prompt_includes_the_conversation_only_when_present() {
        let budget = prompt_budget(None, false);
        let plain = build_chat_user_prompt("Notes:", "ctx", None, &budget, "Why?");
        assert_eq!(plain, "Notes:\n\nctx\n\n---\n\nUser question: Why?");

        let ctx = ConversationContext {
            id: Some("c1".into()),
            summary: None,
            history: vec![msg("user", "Hi"), msg("assistant", "Hello")],
        };
        let budget = prompt_budget(Some("openrouter"), true);
        let with = build_chat_user_prompt("Notes:", "ctx", Some(&ctx), &budget, "Why?");
        assert!(with.contains("Recent messages (oldest first):\nUser: Hi\nAssistant: Hello"));
        assert!(with.ends_with("User question: Why?"));
    }

    #[test]
    fn budgets_shrink_notes_for_local_models_with_history() {
        assert_eq!(prompt_budget(None, false).notes_chars, 6_000);
        assert!(prompt_budget(Some("ollama"), true).notes_chars < 6_000);
        assert_eq!(prompt_budget(Some("openrouter"), true).notes_chars, 6_000);
    }

    #[test]
    fn memory_section_lists_titles_and_skips_the_current_conversation() {
        let facts = vec![MemoryFact {
            fact: "Uses an M2".into(),
            category: "general".into(),
            created_at: 0,
        }];
        let conv = |id: &str, summary: &str| Conversation {
            id: id.into(),
            timestamp: 0,
            messages: vec![],
            context_notes: vec![],
            summary: summary.into(),
        };
        let recent = vec![
            conv("now", "Topic: Current chat\nFacts:\n- x"),
            conv("old", "Topic: Berlin move\nFacts:\n- y"),
            conv("plain", "What should I focus on today?"),
        ];
        let section = build_memory_section(&facts, &recent, Some("now"));
        assert!(section.contains("## What I know about the user\n- Uses an M2\n"));
        assert!(section.contains("- Berlin move\n"));
        assert!(section.contains("- What should I focus on today?\n"));
        assert!(!section.contains("Current chat"));
        assert!(!section.contains("Facts:"));
        assert_eq!(build_memory_section(&[], &[], None), "");
    }
}
