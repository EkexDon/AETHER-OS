//! Related-note and tag suggestions.
//!
//! The semantic path (Ollama embeddings + the vector index) lives in the
//! command layer; this module is the local fallback and everything that
//! does not need a model:
//!
//! - a tokenizer shared (byte-for-byte) with `src/lib/intel/keywords.ts`,
//! - per-note keyword statistics over the title (weighted ×3) and the first
//!   3 KB of the body, cached by path + mtime,
//! - "tf-idf-lite" ranking: cosine similarity of `(1 + ln tf) · ln(1 + N/df)`
//!   vectors, with a bonus for shared tags,
//! - tag ranking by keyword co-occurrence with the notes carrying each tag,
//! - frontmatter-aware tag insertion for `cmd_intel_add_tag`.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultNote;

/// Bytes of a note body that contribute keywords.
pub const DOC_PREFIX_BYTES: usize = 3 * 1024;
/// Characters of the current note used as the query.
pub const QUERY_CHARS: usize = 2_000;
/// Weight of title tokens relative to body tokens.
pub const TITLE_WEIGHT: u32 = 3;
/// Keyword scores below this are noise.
pub const MIN_KEYWORD_SCORE: f32 = 0.05;
/// Score bonus per tag shared with the current note (capped at three).
pub const SHARED_TAG_BONUS: f32 = 0.1;

const STOPWORDS: &[&str] = &[
    // English
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was",
    "one", "our", "out", "has", "have", "him", "his", "how", "its", "may", "new", "now", "old",
    "see", "two", "way", "who", "did", "get", "got", "let", "put", "say", "she", "too", "use",
    "used", "using", "with", "this", "that", "from", "they", "will", "would", "there", "their",
    "what", "about", "which", "when", "make", "like", "time", "just", "know", "take", "into",
    "your", "some", "could", "them", "than", "then", "look", "only", "come", "over", "also",
    "back", "after", "first", "well", "even", "want", "because", "these", "give", "most", "been",
    "were", "said", "each", "does", "done", "should", "very", "more", "much", "many", "such",
    "here", "where", "while", "why", "yes", "yet", "own", "same", "other", "into", "onto", "upon",
    "via", "per", "etc", "note", "notes", "todo", "tags", "tag", "title", "created", "updated",
    "date", "https", "http", "www", "com", "org", "html", "png", "jpg", // German
    "und", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
    "ist", "sind", "war", "mit", "von", "für", "auf", "aus", "bei", "nach", "über", "unter",
    "auch", "als", "wie", "was", "wer", "wir", "ihr", "sie", "ich", "mich", "mir", "dich", "dir",
    "sich", "nicht", "noch", "nur", "oder", "aber", "wenn", "dass", "sehr", "hat", "haben", "wird",
    "werden", "kann", "können", "muss", "soll", "zum", "zur", "vom", "beim", "bis", "durch",
    "gegen", "ohne", "sein", "seine", "ihre", "unser", "diese", "dieser", "dieses", "man", "mehr",
    "schon", "hier", "dort", "dann", "doch", "immer", "heute",
];

/// Lower-cased word tokens: split on anything that is not alphanumeric,
/// drop tokens shorter than three characters, pure numbers and stopwords.
pub fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter_map(|word| {
            if word.chars().count() < 3 || word.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let lower = word.to_lowercase();
            if STOPWORDS.contains(&lower.as_str()) {
                None
            } else {
                Some(lower)
            }
        })
        .collect()
}

/// Split a leading YAML frontmatter block from the body. Returns the lines
/// between the `---` fences (without them) and the remaining body.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let first_line_end = match content.find('\n') {
        Some(i) => i,
        None => return (None, content),
    };
    if content[..first_line_end].trim_end_matches('\r') != "---" {
        return (None, content);
    }
    let rest = &content[first_line_end + 1..];
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            let fm = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (Some(fm.trim_end_matches(['\n', '\r'])), body);
        }
        offset += line.len();
    }
    (None, content)
}

/// Strip `'`, `"` and a leading `#` from a tag-like token.
fn clean_tag_token(token: &str) -> String {
    token
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim_start_matches('#')
        .trim()
        .to_owned()
}

/// Tags declared in a frontmatter block (`tags: [a, b]`, `tags: a, b` or a
/// block list).
pub fn frontmatter_tags(frontmatter: &str) -> Vec<String> {
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let key = key.trim();
        if key != "tags" && key != "tag" {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            for item in lines[i + 1..].iter() {
                let t = item.trim_start();
                if !item.starts_with(char::is_whitespace) && !t.starts_with('-') {
                    break;
                }
                if let Some(rest) = t.strip_prefix('-') {
                    let tag = clean_tag_token(rest);
                    if !tag.is_empty() {
                        out.push(tag);
                    }
                } else if !t.is_empty() {
                    break;
                }
            }
        } else {
            let inner = value.trim_start_matches('[').trim_end_matches(']');
            let separator = if inner.contains(',') { ',' } else { ' ' };
            for token in inner.split(separator) {
                let tag = clean_tag_token(token);
                if !tag.is_empty() {
                    out.push(tag);
                }
            }
        }
    }
    out
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

/// Inline `#tags` of a Markdown body: preceded by start of line or
/// whitespace, made of letters, digits, `_`, `-`, `/`, containing at least
/// one non-digit. Fenced code blocks and inline code are ignored.
pub fn inline_tags(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut in_code = false;
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_code = !in_code;
            } else if c == '#' && !in_code && (i == 0 || chars[i - 1].is_whitespace()) {
                let mut j = i + 1;
                while j < chars.len() && is_tag_char(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect();
                let tag = tag.trim_end_matches(['-', '/']).to_owned();
                if !tag.is_empty() && !tag.chars().all(|ch| ch.is_ascii_digit()) {
                    out.push(tag);
                }
                i = j;
                continue;
            }
            i += 1;
        }
    }
    out
}

/// All tags of a note (frontmatter + inline), de-duplicated
/// case-insensitively, first spelling wins.
pub fn extract_tags(content: &str) -> Vec<String> {
    let (frontmatter, body) = split_frontmatter(content);
    let mut tags = frontmatter.map(frontmatter_tags).unwrap_or_default();
    tags.extend(inline_tags(body));
    let mut seen = HashSet::new();
    tags.retain(|t| seen.insert(t.to_lowercase()));
    tags
}

/// Lower-cased targets of `[[wikilinks]]` (alias and heading parts removed).
pub fn extract_wikilinks(content: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        let target = inner
            .split(['|', '#'])
            .next()
            .unwrap_or("")
            .trim()
            .trim_end_matches(".md")
            .to_lowercase();
        if !target.is_empty() {
            out.insert(target);
        }
        rest = &after[end + 2..];
    }
    out
}

/// Clip a string to at most `max` bytes on a character boundary.
pub fn clip_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Clip to at most `max` characters.
pub fn clip_chars(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

/// Keyword statistics of one note.
#[derive(Debug, Clone)]
pub struct DocTerms {
    pub path: String,
    pub name: String,
    pub mtime: u64,
    pub terms: HashMap<String, u32>,
    pub tags: Vec<String>,
}

/// Count terms of a note: title tokens ×[`TITLE_WEIGHT`], body tokens from
/// the first [`DOC_PREFIX_BYTES`] after the frontmatter.
pub fn build_doc_terms(path: &str, name: &str, mtime: u64, content: &str) -> DocTerms {
    let (_, body) = split_frontmatter(content);
    let mut terms: HashMap<String, u32> = HashMap::new();
    for token in tokenize(name) {
        *terms.entry(token).or_default() += TITLE_WEIGHT;
    }
    for token in tokenize(clip_bytes(body, DOC_PREFIX_BYTES)) {
        *terms.entry(token).or_default() += 1;
    }
    DocTerms {
        path: path.to_owned(),
        name: name.to_owned(),
        mtime,
        terms,
        tags: extract_tags(content),
    }
}

/// Term counts of the query text (first [`QUERY_CHARS`] characters, body
/// only).
pub fn query_terms(text: &str) -> HashMap<String, u32> {
    let (_, body) = split_frontmatter(text);
    let mut terms: HashMap<String, u32> = HashMap::new();
    for token in tokenize(clip_chars(body, QUERY_CHARS)) {
        *terms.entry(token).or_default() += 1;
    }
    terms
}

/// Keyword statistics of every vault note, rebuilt only for notes whose
/// mtime changed.
#[derive(Debug, Default)]
pub struct DocCache {
    entries: HashMap<String, DocTerms>,
}

impl DocCache {
    /// Sync the cache with the current note list; `read` loads a note's
    /// content (unreadable notes are skipped).
    pub fn refresh(&mut self, notes: &[VaultNote], read: impl Fn(&str) -> Option<String>) {
        let current: HashSet<&str> = notes.iter().map(|n| n.path.as_str()).collect();
        self.entries
            .retain(|path, _| current.contains(path.as_str()));
        for note in notes {
            let fresh = self
                .entries
                .get(&note.path)
                .is_some_and(|doc| doc.mtime == note.mtime && note.mtime != 0);
            if fresh {
                continue;
            }
            match read(&note.path) {
                Some(content) => {
                    let doc = build_doc_terms(&note.path, &note.name, note.mtime, &content);
                    self.entries.insert(note.path.clone(), doc);
                }
                None => {
                    self.entries.remove(&note.path);
                }
            }
        }
    }

    /// Cached documents, sorted by path for deterministic ranking.
    pub fn docs(&self) -> Vec<&DocTerms> {
        let mut docs: Vec<&DocTerms> = self.entries.values().collect();
        docs.sort_by(|a, b| a.path.cmp(&b.path));
        docs
    }

    /// Number of cached notes.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when nothing is cached.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Document frequencies of a corpus.
struct Corpus {
    n: f32,
    df: HashMap<String, u32>,
}

impl Corpus {
    fn new(docs: &[&DocTerms]) -> Self {
        let mut df: HashMap<String, u32> = HashMap::new();
        for doc in docs {
            for term in doc.terms.keys() {
                *df.entry(term.clone()).or_default() += 1;
            }
        }
        Self {
            n: docs.len() as f32,
            df,
        }
    }

    fn idf(&self, term: &str) -> f32 {
        let df = self.df.get(term).copied().unwrap_or(0).max(1) as f32;
        (1.0 + self.n / df).ln()
    }

    fn weights(&self, terms: &HashMap<String, u32>) -> (HashMap<String, f32>, f32) {
        let mut out = HashMap::with_capacity(terms.len());
        let mut norm = 0.0f32;
        for (term, &tf) in terms {
            let w = (1.0 + (tf as f32).ln()) * self.idf(term);
            norm += w * w;
            out.insert(term.clone(), w);
        }
        (out, norm.sqrt())
    }
}

fn round3(value: f32) -> f32 {
    (value * 1000.0).round() / 1000.0
}

/// Why a note was suggested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionKind {
    /// Embedding similarity from the vector index.
    Semantic,
    /// Shared distinctive keywords.
    Keywords,
    /// Shared tags (plus keywords).
    Tags,
}

/// One related-note suggestion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    pub path: String,
    pub name: String,
    /// 0–1, higher is more related.
    pub score: f32,
    /// Short label for the reason chip ("semantic 0.82", "shares #rust").
    pub reason: String,
    pub kind: SuggestionKind,
    /// The current note already links to this one.
    pub linked: bool,
}

/// Rank `docs` against the current note text with tf-idf-lite cosine
/// similarity plus a shared-tag bonus. `exclude` removes the note itself.
pub fn rank_by_keywords(
    text: &str,
    docs: &[&DocTerms],
    exclude: Option<&str>,
    limit: usize,
) -> Vec<Suggestion> {
    let query = query_terms(text);
    if query.is_empty() || docs.is_empty() || limit == 0 {
        return Vec::new();
    }
    let corpus = Corpus::new(docs);
    let (q_weights, q_norm) = corpus.weights(&query);
    if q_norm == 0.0 {
        return Vec::new();
    }
    let query_tags: HashSet<String> = extract_tags(text)
        .iter()
        .map(|t| t.to_lowercase())
        .collect();
    let linked = extract_wikilinks(text);

    let mut scored: Vec<Suggestion> = Vec::new();
    for doc in docs {
        if exclude.is_some_and(|e| e == doc.path) {
            continue;
        }
        let (d_weights, d_norm) = corpus.weights(&doc.terms);
        if d_norm == 0.0 {
            continue;
        }
        let mut contributions: Vec<(&str, f32)> = Vec::new();
        let mut dot = 0.0f32;
        for (term, qw) in &q_weights {
            if let Some(dw) = d_weights.get(term) {
                let c = qw * dw;
                dot += c;
                contributions.push((term.as_str(), c));
            }
        }
        let shared_tags: Vec<&String> = doc
            .tags
            .iter()
            .filter(|t| query_tags.contains(&t.to_lowercase()))
            .collect();
        let mut score = dot / (q_norm * d_norm);
        score += SHARED_TAG_BONUS * shared_tags.len().min(3) as f32;
        let score = score.min(1.0);
        if score < MIN_KEYWORD_SCORE {
            continue;
        }
        let (kind, reason) = if let Some(tag) = shared_tags.first() {
            (SuggestionKind::Tags, format!("shares #{tag}"))
        } else {
            contributions.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            let top: Vec<&str> = contributions.iter().take(3).map(|(t, _)| *t).collect();
            (
                SuggestionKind::Keywords,
                format!("keywords: {}", top.join(", ")),
            )
        };
        scored.push(Suggestion {
            path: doc.path.clone(),
            name: doc.name.clone(),
            score: round3(score),
            reason,
            kind,
            linked: linked.contains(&doc.name.to_lowercase()),
        });
    }
    scored.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.name.cmp(&b.name))
    });
    scored.truncate(limit);
    scored
}

/// Rank existing vault tags for the current text by keyword
/// co-occurrence: a tag scores the sum of the cosine similarities between
/// the text and every note carrying it (so tags on many similar notes rank
/// high), plus a bonus when the tag itself occurs as a word in the text.
/// Tags already present in the text are excluded. `extra_tags` adds tags
/// per note path (e.g. from the NoPes index) on top of the ones found in the
/// notes themselves.
pub fn rank_tags(
    text: &str,
    docs: &[&DocTerms],
    extra_tags: &HashMap<String, Vec<String>>,
    limit: usize,
) -> Vec<String> {
    let query = query_terms(text);
    if query.is_empty() || docs.is_empty() || limit == 0 {
        return Vec::new();
    }
    let present: HashSet<String> = extract_tags(text)
        .iter()
        .map(|t| t.to_lowercase())
        .collect();
    let corpus = Corpus::new(docs);
    let (q_weights, q_norm) = corpus.weights(&query);
    if q_norm == 0.0 {
        return Vec::new();
    }

    // tag (lower) → (display spelling, accumulated evidence)
    let mut scores: HashMap<String, (String, f32)> = HashMap::new();
    for doc in docs {
        let (d_weights, d_norm) = corpus.weights(&doc.terms);
        let similarity = if d_norm == 0.0 {
            0.0
        } else {
            q_weights
                .iter()
                .filter_map(|(term, qw)| d_weights.get(term).map(|dw| qw * dw))
                .sum::<f32>()
                / (q_norm * d_norm)
        };
        let mut tags: Vec<&String> = doc.tags.iter().collect();
        if let Some(extra) = extra_tags.get(&doc.path) {
            tags.extend(extra.iter());
        }
        let mut seen = HashSet::new();
        for tag in tags {
            let key = tag.to_lowercase();
            if !seen.insert(key.clone()) || present.contains(&key) {
                continue;
            }
            let entry = scores.entry(key).or_insert_with(|| (tag.clone(), 0.0));
            if similarity > 0.02 {
                entry.1 += similarity;
            }
        }
    }

    let mut ranked: Vec<(String, f32)> = scores
        .into_values()
        .filter_map(|(display, mut score)| {
            let words = tokenize(&display.replace(['/', '-', '_'], " "));
            if !words.is_empty() && words.iter().all(|w| query.contains_key(w)) {
                score += 0.35;
            }
            (score > 0.05).then_some((display, score))
        })
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().take(limit).map(|(tag, _)| tag).collect()
}

/// Validate a tag for insertion: strip leading `#`, require letters /
/// digits / `_` / `-` / `/`, at least one non-digit, at most 64 characters.
pub fn normalize_tag(tag: &str) -> Result<String, AetherError> {
    let cleaned = tag.trim().trim_start_matches('#').trim();
    let valid = !cleaned.is_empty()
        && cleaned.chars().count() <= 64
        && cleaned.chars().all(is_tag_char)
        && !cleaned.chars().all(|c| c.is_ascii_digit());
    if valid {
        Ok(cleaned.to_owned())
    } else {
        Err(AetherError::InvalidInput(format!(
            "invalid tag: \"{tag}\" (use letters, digits, _, - or /)"
        )))
    }
}

/// Add `tag` to a note. Notes with frontmatter get the tag merged into
/// their `tags:` key (inline list, comma list or block list — the existing
/// style is kept; a missing key is added as `tags: [tag]`). Notes without
/// frontmatter get `#tag` appended (to a trailing tag-only line if there is
/// one). Returns the new content and whether anything changed.
pub fn add_tag_to_content(content: &str, tag: &str) -> Result<(String, bool), AetherError> {
    let tag = normalize_tag(tag)?;
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let (frontmatter, body) = split_frontmatter(content);

    if let Some(fm) = frontmatter {
        let mut lines: Vec<String> = fm
            .lines()
            .map(|l| l.trim_end_matches('\r').to_owned())
            .collect();
        let changed = merge_frontmatter_tag(&mut lines, &tag);
        if !changed {
            return Ok((content.to_owned(), false));
        }
        let mut out = String::with_capacity(content.len() + tag.len() + 16);
        out.push_str("---");
        out.push_str(newline);
        for line in &lines {
            out.push_str(line);
            out.push_str(newline);
        }
        out.push_str("---");
        out.push_str(newline);
        out.push_str(body);
        return Ok((out, true));
    }

    let wanted = tag.to_lowercase();
    if inline_tags(content)
        .iter()
        .any(|t| t.to_lowercase() == wanted)
    {
        return Ok((content.to_owned(), false));
    }
    if content.trim().is_empty() {
        return Ok((format!("#{tag}{newline}"), true));
    }
    let trimmed = content.trim_end_matches(['\n', '\r']);
    let last_line = trimmed
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .trim_end_matches('\r');
    let tag_only = !last_line.trim().is_empty()
        && last_line
            .split_whitespace()
            .all(|token| token.len() > 1 && token.starts_with('#') && !token.starts_with("##"));
    let out = if tag_only {
        format!("{trimmed} #{tag}{newline}")
    } else {
        format!("{trimmed}{newline}{newline}#{tag}{newline}")
    };
    Ok((out, true))
}

/// Merge `tag` into frontmatter lines; returns whether they changed.
fn merge_frontmatter_tag(lines: &mut Vec<String>, tag: &str) -> bool {
    let wanted = tag.to_lowercase();
    let key_index = lines.iter().position(|line| {
        !line.starts_with(char::is_whitespace)
            && line
                .split_once(':')
                .is_some_and(|(key, _)| matches!(key.trim(), "tags" | "tag"))
    });
    let Some(index) = key_index else {
        lines.push(format!("tags: [{tag}]"));
        return true;
    };
    let (key, value) = lines[index]
        .split_once(':')
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .unwrap_or_else(|| ("tags".to_owned(), String::new()));

    if value.is_empty() {
        // Block list: `tags:` followed by indented `- item` lines.
        let mut last_item: Option<usize> = None;
        let mut indent = String::from("  ");
        for (offset, line) in lines[index + 1..].iter().enumerate() {
            let t = line.trim_start();
            if let Some(rest) = t.strip_prefix('-') {
                if clean_tag_token(rest).to_lowercase() == wanted {
                    return false;
                }
                indent = line[..line.len() - t.len()].to_owned();
                last_item = Some(index + 1 + offset);
            } else {
                break;
            }
        }
        match last_item {
            Some(at) => lines.insert(at + 1, format!("{indent}- {tag}")),
            None => lines[index] = format!("{key}: [{tag}]"),
        }
        return true;
    }

    if value.starts_with('[') && value.ends_with(']') {
        let inner = value[1..value.len() - 1].trim();
        let items: Vec<&str> = inner
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if items
            .iter()
            .any(|item| clean_tag_token(item).to_lowercase() == wanted)
        {
            return false;
        }
        lines[index] = if items.is_empty() {
            format!("{key}: [{tag}]")
        } else {
            format!("{key}: [{}, {tag}]", items.join(", "))
        };
        return true;
    }

    let separator = if value.contains(',') { ',' } else { ' ' };
    let items: Vec<&str> = value
        .split(separator)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if items
        .iter()
        .any(|item| clean_tag_token(item).to_lowercase() == wanted)
    {
        return false;
    }
    lines[index] = match (separator, items.len()) {
        (',', _) => format!("{key}: {value}, {tag}"),
        // A single scalar becomes a proper YAML list.
        (_, 1) => format!("{key}: [{value}, {tag}]"),
        // Legacy space-separated tags keep their style.
        _ => format!("{key}: {value} {tag}"),
    };
    true
}

/// Pick tags from a model reply: a JSON array anywhere in the text, or a
/// comma / newline separated list. Only tags from `candidates` survive
/// (compared case-insensitively, returned in the candidates' spelling), so
/// the model can re-rank but never invent tags.
pub fn parse_llm_tags(response: &str, candidates: &[String]) -> Vec<String> {
    let by_lower: HashMap<String, &String> =
        candidates.iter().map(|c| (c.to_lowercase(), c)).collect();
    let raw_items: Vec<String> = match (response.find('['), response.rfind(']')) {
        (Some(start), Some(end)) if end > start => {
            serde_json::from_str::<Vec<String>>(&response[start..=end]).unwrap_or_else(|_| {
                response[start + 1..end]
                    .split(',')
                    .map(str::to_owned)
                    .collect()
            })
        }
        _ => response.split([',', '\n']).map(str::to_owned).collect(),
    };
    let mut seen = HashSet::new();
    raw_items
        .iter()
        .map(|item| clean_tag_token(item.trim().trim_start_matches(['-', '*', ' '])).to_lowercase())
        .filter_map(|lower| by_lower.get(&lower).map(|c| (*c).clone()))
        .filter(|tag| seen.insert(tag.to_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(path: &str, name: &str, content: &str) -> DocTerms {
        build_doc_terms(path, name, 1, content)
    }

    #[test]
    fn tokenizer_drops_short_words_numbers_and_stopwords() {
        assert_eq!(
            tokenize("The Rust borrow-checker: 2024 & lifetimes, über Äpfel!"),
            vec!["rust", "borrow", "checker", "lifetimes", "äpfel"]
        );
        assert!(tokenize("and the for mit und").is_empty());
    }

    #[test]
    fn splits_frontmatter_from_the_body() {
        let (fm, body) = split_frontmatter("---\ntags: [a]\ntitle: X\n---\n# Body\n");
        assert_eq!(fm, Some("tags: [a]\ntitle: X"));
        assert_eq!(body, "# Body\n");
        let (fm, body) = split_frontmatter("# No frontmatter\n---\n");
        assert!(fm.is_none());
        assert_eq!(body, "# No frontmatter\n---\n");
        let (fm, _) = split_frontmatter("---\nunterminated: yes\n");
        assert!(fm.is_none());
    }

    #[test]
    fn extracts_frontmatter_and_inline_tags() {
        let content = "---\ntags:\n  - rust\n  - \"learning\"\n---\n# Title\nSome #inline and #nested/tag.\n`#code` and #123 ignored\n```\n#fenced\n```\nurl.com/#anchor #Rust";
        assert_eq!(
            extract_tags(content),
            vec!["rust", "learning", "inline", "nested/tag"]
        );
        assert_eq!(frontmatter_tags("tags: [a, 'b', #c]"), vec!["a", "b", "c"]);
        assert_eq!(frontmatter_tags("tags: a, b"), vec!["a", "b"]);
        assert_eq!(frontmatter_tags("tag: solo"), vec!["solo"]);
    }

    #[test]
    fn extracts_wikilink_targets() {
        let links =
            extract_wikilinks("See [[Rust Ownership]], [[Berlin|the move]] and [[Thesis#Plan]].");
        assert!(links.contains("rust ownership"));
        assert!(links.contains("berlin"));
        assert!(links.contains("thesis"));
        assert_eq!(links.len(), 3);
    }

    #[test]
    fn clips_on_character_boundaries() {
        assert_eq!(clip_bytes("äää", 3), "ä");
        assert_eq!(clip_chars("äää", 2), "ää");
        assert_eq!(clip_chars("ab", 5), "ab");
    }

    #[test]
    fn keyword_ranking_prefers_notes_sharing_distinctive_terms() {
        let rust = doc(
            "/v/Rust Ownership.md",
            "Rust Ownership",
            "Borrowing, lifetimes and the borrow checker in Rust.",
        );
        let move_note = doc(
            "/v/Berlin Move.md",
            "Berlin Move",
            "Book a moving van, register at the Bürgeramt in Berlin.",
        );
        let cooking = doc(
            "/v/Pasta.md",
            "Pasta",
            "Boil water, add salt, cook pasta for ten minutes.",
        );
        let current = doc("/v/Lifetimes.md", "Lifetimes", "x");
        let docs = vec![&rust, &move_note, &cooking, &current];
        let text =
            "Understanding lifetimes: the borrow checker rejects dangling references in Rust.";
        let ranked = rank_by_keywords(text, &docs, Some("/v/Lifetimes.md"), 5);
        assert!(!ranked.is_empty());
        assert_eq!(ranked[0].name, "Rust Ownership");
        assert_eq!(ranked[0].kind, SuggestionKind::Keywords);
        assert!(ranked[0].reason.starts_with("keywords: "));
        assert!(ranked[0].reason.contains("borrow") || ranked[0].reason.contains("lifetimes"));
        assert!(ranked.iter().all(|s| s.path != "/v/Lifetimes.md"));
        assert!(ranked.iter().all(|s| s.name != "Pasta"));
        assert!(ranked[0].score > 0.0 && ranked[0].score <= 1.0);
    }

    #[test]
    fn shared_tags_boost_and_explain_suggestions() {
        let a = doc(
            "/v/a.md",
            "Alpha",
            "Planning notes #thesis about evaluation metrics.",
        );
        let b = doc(
            "/v/b.md",
            "Beta",
            "Evaluation metrics for retrieval systems.",
        );
        let docs = vec![&a, &b];
        let ranked = rank_by_keywords("Draft on evaluation metrics #thesis", &docs, None, 5);
        assert_eq!(ranked[0].name, "Alpha");
        assert_eq!(ranked[0].kind, SuggestionKind::Tags);
        assert_eq!(ranked[0].reason, "shares #thesis");
    }

    #[test]
    fn marks_already_linked_notes() {
        let a = doc("/v/a.md", "Alpha", "Evaluation metrics for retrieval.");
        let docs = vec![&a];
        let ranked = rank_by_keywords("Evaluation metrics, see [[Alpha]]", &docs, None, 5);
        assert!(ranked[0].linked);
    }

    #[test]
    fn empty_inputs_yield_no_suggestions() {
        let a = doc("/v/a.md", "Alpha", "Evaluation metrics.");
        assert!(rank_by_keywords("", &[&a], None, 5).is_empty());
        assert!(rank_by_keywords("and the", &[&a], None, 5).is_empty());
        assert!(rank_by_keywords("metrics", &[], None, 5).is_empty());
        assert!(rank_by_keywords("metrics", &[&a], None, 0).is_empty());
    }

    #[test]
    fn doc_cache_rebuilds_only_changed_notes_and_prunes_removed_ones() {
        use std::cell::Cell;
        let notes = vec![
            VaultNote {
                path: "/v/a.md".into(),
                name: "a".into(),
                mtime: 1,
            },
            VaultNote {
                path: "/v/b.md".into(),
                name: "b".into(),
                mtime: 1,
            },
        ];
        let reads = Cell::new(0);
        let mut cache = DocCache::default();
        cache.refresh(&notes, |_| {
            reads.set(reads.get() + 1);
            Some("alpha beta".into())
        });
        assert_eq!(cache.len(), 2);
        assert_eq!(reads.get(), 2);
        cache.refresh(&notes, |_| {
            reads.set(reads.get() + 1);
            Some("alpha beta".into())
        });
        assert_eq!(reads.get(), 2, "unchanged notes are not re-read");
        let changed = vec![VaultNote {
            path: "/v/a.md".into(),
            name: "a".into(),
            mtime: 2,
        }];
        cache.refresh(&changed, |_| {
            reads.set(reads.get() + 1);
            Some("gamma".into())
        });
        assert_eq!(reads.get(), 3);
        assert_eq!(cache.len(), 1);
        assert!(cache.docs()[0].terms.contains_key("gamma"));
    }

    #[test]
    fn ranks_tags_by_keyword_co_occurrence() {
        let a = doc(
            "/v/a.md",
            "Rust Ownership",
            "#rust borrow checker lifetimes",
        );
        let b = doc("/v/b.md", "Move", "#berlin moving van apartment");
        let c = doc("/v/c.md", "Traits", "#rust traits generics");
        let docs = vec![&a, &b, &c];
        let mut extra = HashMap::new();
        extra.insert("/v/a.md".to_owned(), vec!["learning".to_owned()]);
        let tags = rank_tags(
            "Notes on lifetimes and the borrow checker",
            &docs,
            &extra,
            5,
        );
        assert_eq!(tags.len(), 2, "{tags:?}");
        assert!(tags.contains(&"rust".to_owned()));
        assert!(tags.contains(&"learning".to_owned()));
        assert!(!tags.contains(&"berlin".to_owned()));
        // More matching notes → more evidence.
        let d = doc("/v/d.md", "Borrowing", "#rust borrow checker errors");
        let docs = vec![&a, &b, &c, &d];
        let tags = rank_tags(
            "Notes on lifetimes and the borrow checker",
            &docs,
            &extra,
            5,
        );
        assert_eq!(tags.first().map(String::as_str), Some("rust"));
        // Tags already in the text are not suggested again.
        let tags = rank_tags("lifetimes and the borrow checker #rust", &docs, &extra, 5);
        assert!(!tags.iter().any(|t| t == "rust"));
    }

    #[test]
    fn direct_tag_mentions_get_a_bonus() {
        let a = doc("/v/a.md", "A", "#berlin apartment");
        let b = doc("/v/b.md", "B", "#thesis evaluation");
        let tags = rank_tags(
            "Looking for an apartment in berlin",
            &[&a, &b],
            &HashMap::new(),
            3,
        );
        assert_eq!(tags, vec!["berlin"]);
    }

    #[test]
    fn normalizes_tags() {
        assert_eq!(normalize_tag("#rust").expect("valid"), "rust");
        assert_eq!(
            normalize_tag(" project/aether ").expect("valid"),
            "project/aether"
        );
        assert!(normalize_tag("").is_err());
        assert!(normalize_tag("#").is_err());
        assert!(normalize_tag("two words").is_err());
        assert!(normalize_tag("2024").is_err());
        assert!(normalize_tag(&"x".repeat(65)).is_err());
    }

    #[test]
    fn adds_tags_to_inline_frontmatter_lists() {
        let (out, changed) = add_tag_to_content("---\ntags: [a, b]\n---\n# X\n", "c").expect("add");
        assert!(changed);
        assert_eq!(out, "---\ntags: [a, b, c]\n---\n# X\n");
        let (same, changed) = add_tag_to_content(&out, "#C").expect("add");
        assert!(!changed);
        assert_eq!(same, out);
        let (empty, _) = add_tag_to_content("---\ntags: []\n---\nbody", "x").expect("add");
        assert_eq!(empty, "---\ntags: [x]\n---\nbody");
    }

    #[test]
    fn adds_tags_to_block_and_comma_lists() {
        let (block, changed) = add_tag_to_content(
            "---\ntitle: T\ntags:\n    - a\n    - b\nstatus: draft\n---\nbody\n",
            "c",
        )
        .expect("add");
        assert!(changed);
        assert_eq!(
            block,
            "---\ntitle: T\ntags:\n    - a\n    - b\n    - c\nstatus: draft\n---\nbody\n"
        );
        let (_, changed) = add_tag_to_content(&block, "b").expect("add");
        assert!(!changed);

        let (comma, _) = add_tag_to_content("---\ntags: a, b\n---\n", "c").expect("add");
        assert_eq!(comma, "---\ntags: a, b, c\n---\n");
        let (scalar, _) = add_tag_to_content("---\ntags: a\n---\n", "c").expect("add");
        assert_eq!(scalar, "---\ntags: [a, c]\n---\n");
        let (spaced, _) = add_tag_to_content("---\ntags: a b\n---\n", "c").expect("add");
        assert_eq!(spaced, "---\ntags: a b c\n---\n");
        let (bare, _) = add_tag_to_content("---\ntags:\n---\nx", "c").expect("add");
        assert_eq!(bare, "---\ntags: [c]\n---\nx");
    }

    #[test]
    fn adds_a_tags_key_when_frontmatter_has_none() {
        let (out, changed) = add_tag_to_content("---\ntitle: T\n---\nbody", "new").expect("add");
        assert!(changed);
        assert_eq!(out, "---\ntitle: T\ntags: [new]\n---\nbody");
    }

    #[test]
    fn appends_inline_tags_without_frontmatter() {
        let (out, changed) = add_tag_to_content("# Note\n\nSome text.\n", "rust").expect("add");
        assert!(changed);
        assert_eq!(out, "# Note\n\nSome text.\n\n#rust\n");
        let (again, changed) = add_tag_to_content(&out, "learning").expect("add");
        assert!(changed);
        assert_eq!(again, "# Note\n\nSome text.\n\n#rust #learning\n");
        let (_, changed) = add_tag_to_content(&again, "Rust").expect("add");
        assert!(!changed);
        let (fresh, _) = add_tag_to_content("", "x").expect("add");
        assert_eq!(fresh, "#x\n");
        let (crlf, _) = add_tag_to_content("line\r\n", "x").expect("add");
        assert_eq!(crlf, "line\r\n\r\n#x\r\n");
    }

    #[test]
    fn rejects_invalid_tags() {
        assert!(add_tag_to_content("body", "no spaces").is_err());
    }

    #[test]
    fn parses_llm_tag_replies_against_candidates() {
        let candidates = vec![
            "Rust".to_owned(),
            "learning".to_owned(),
            "berlin".to_owned(),
        ];
        assert_eq!(
            parse_llm_tags("Sure: [\"#rust\", \"invented\", \"Learning\"]", &candidates),
            vec!["Rust", "learning"]
        );
        assert_eq!(
            parse_llm_tags("- berlin\n- rust\n- rust", &candidates),
            vec!["berlin", "Rust"]
        );
        assert!(parse_llm_tags("nothing useful", &candidates).is_empty());
    }
}
