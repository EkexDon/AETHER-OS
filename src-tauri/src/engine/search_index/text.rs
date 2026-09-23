//! Text helpers for the search index: FTS5 query building, safe snippet
//! rendering, Markdown → plain text, hashtag extraction and stable ids.
//!
//! Snippets are produced by SQLite's `snippet()` with two ASCII control
//! characters as match delimiters. Everything the index stores is stripped
//! of those characters first, so after HTML-escaping the whole snippet the
//! only markup that can appear in the result is the `<mark>` pair we insert
//! for the delimiters. The UI can therefore render `snippet_html` safely.

use std::sync::OnceLock;

use regex::Regex;

/// Opening match delimiter passed to `snippet()`.
pub const MARK_START: char = '\u{2}';
/// Closing match delimiter passed to `snippet()`.
pub const MARK_END: char = '\u{3}';

/// Longest single query term that is forwarded to FTS5.
const MAX_TERM_CHARS: usize = 64;
/// Query terms beyond this count are ignored (keeps MATCH expressions small).
const MAX_TERMS: usize = 12;

/// Lower-cased, de-duplicated alphanumeric terms of a user query, in order.
///
/// Anything that is not a letter or digit separates terms, mirroring the
/// `unicode61` tokenizer the FTS table uses.
pub fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric()) {
        if raw.is_empty() {
            continue;
        }
        let term: String = raw.to_lowercase().chars().take(MAX_TERM_CHARS).collect();
        if !terms.contains(&term) {
            terms.push(term);
        }
        if terms.len() == MAX_TERMS {
            break;
        }
    }
    terms
}

/// FTS5 `MATCH` expression for a free-text query: every term must match as
/// a prefix (`"rust"* "own"*`). `None` when the query has no terms.
///
/// Terms only contain letters and digits, so quoting them can never break
/// out of the string literal.
pub fn fts_match_expr(query: &str) -> Option<String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|t| format!("\"{t}\"*"))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// FTS5 `MATCH` expression restricted to the `tags` column (`#tag` queries).
pub fn fts_tag_expr(query: &str) -> Option<String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|t| format!("tags : \"{t}\"*"))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

/// Escape text for inclusion in HTML (element content and attribute values).
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Collapse every run of whitespace (including newlines) into one space.
pub fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Turn a raw `snippet()` result into safe HTML: whitespace collapsed, all
/// text escaped, match delimiters replaced by `<mark>` / `</mark>`.
/// Unbalanced delimiters (a match cut off by the snippet window) are closed.
pub fn render_snippet(raw: &str) -> String {
    let collapsed = collapse_whitespace(raw);
    let mut out = String::with_capacity(collapsed.len() + 16);
    let mut open = false;
    let mut plain = String::new();
    for c in collapsed.chars() {
        match c {
            MARK_START if !open => {
                out.push_str(&escape_html(&plain));
                plain.clear();
                out.push_str("<mark>");
                open = true;
            }
            MARK_END if open => {
                out.push_str(&escape_html(&plain));
                plain.clear();
                out.push_str("</mark>");
                open = false;
            }
            MARK_START | MARK_END => {}
            _ => plain.push(c),
        }
    }
    out.push_str(&escape_html(&plain));
    if open {
        out.push_str("</mark>");
    }
    out
}

/// Remove the snippet delimiters so indexed text can never inject markup.
pub fn strip_sentinels(text: &str) -> String {
    text.chars()
        .filter(|&c| c != MARK_START && c != MARK_END)
        .collect()
}

/// At most `max` characters of `text` (no ellipsis).
pub fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Stable 64-bit FNV-1a hash (ids must not change between builds, which
/// `std`'s `DefaultHasher` does not guarantee).
pub fn fnv1a64(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn image_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"!\[([^\]]*)\]\([^)]*\)").expect("image regex is valid"))
}

fn link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[([^\]]+)\]\([^)]*\)").expect("link regex is valid"))
}

fn wikilink_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]")
            .expect("wikilink regex is valid")
    })
}

fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:^|[\s(,])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)").expect("tag regex is valid")
    })
}

/// Split a note into its YAML frontmatter (without the fences) and body.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let rest = match content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    {
        Some(rest) => rest,
        None => return (None, content),
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            let front = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (Some(front), body);
        }
        offset += line.len();
    }
    (None, content)
}

/// Readable plain text of a Markdown note for indexing and snippets:
/// frontmatter dropped, heading/quote/list/task markers removed, links and
/// images reduced to their text, wikilinks to their alias (or target),
/// emphasis and code markers removed. Line structure is kept.
pub fn markdown_to_plain(markdown: &str) -> String {
    let (_, body) = split_frontmatter(markdown);
    let mut out = String::with_capacity(body.len());
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            continue;
        }
        let mut text = trimmed;
        while let Some(rest) = text.strip_prefix('>') {
            text = rest.trim_start();
        }
        let hashes = text.chars().take_while(|&c| c == '#').count();
        if (1..=6).contains(&hashes) && text[hashes..].starts_with(' ') {
            text = text[hashes..].trim_start();
        }
        for marker in [
            "- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "- ", "* ", "+ ",
        ] {
            if let Some(rest) = text.strip_prefix(marker) {
                text = rest;
                break;
            }
        }
        let text = image_re().replace_all(text, "$1");
        let text = wikilink_re().replace_all(&text, |caps: &regex::Captures<'_>| {
            caps.get(2)
                .or_else(|| caps.get(1))
                .map(|m| m.as_str().trim().to_owned())
                .unwrap_or_default()
        });
        let text = link_re().replace_all(&text, "$1");
        let cleaned: String = text
            .replace("**", "")
            .replace("__", "")
            .replace("~~", "")
            .replace("==", "")
            .chars()
            .filter(|&c| c != '`' && c != '*')
            .collect();
        out.push_str(cleaned.trim_end());
        out.push('\n');
    }
    strip_sentinels(out.trim())
}

/// Tags of a note: frontmatter `tags:` (inline list, comma list or YAML
/// block list) plus inline `#hashtags` outside code fences. Lower-cased,
/// de-duplicated, first-seen order; pure numbers (`#42`) are ignored.
pub fn extract_tags(markdown: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let tag = raw
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim_start_matches('#')
            .to_lowercase();
        if tag.is_empty() || tag.chars().all(|c| c.is_ascii_digit()) {
            return;
        }
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    };

    let (front, body) = split_frontmatter(markdown);
    if let Some(front) = front {
        let mut in_block = false;
        for line in front.lines() {
            let trimmed = line.trim();
            if in_block {
                if let Some(item) = trimmed.strip_prefix("- ") {
                    push(item);
                    continue;
                }
                in_block = false;
            }
            if let Some(value) = trimmed
                .strip_prefix("tags:")
                .or_else(|| trimmed.strip_prefix("tag:"))
            {
                let value = value.trim();
                if value.is_empty() {
                    in_block = true;
                } else {
                    let inner = value.trim_start_matches('[').trim_end_matches(']');
                    for item in inner.split(',') {
                        push(item);
                    }
                }
            }
        }
    }

    let mut in_code = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        for caps in tag_re().captures_iter(line) {
            if let Some(m) = caps.get(1) {
                push(m.as_str().trim_end_matches(['/', '-']));
            }
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_terms_split_like_the_tokenizer() {
        assert_eq!(
            query_terms("Rust: ownership & Borrow-checker rust"),
            vec!["rust", "ownership", "borrow", "checker"]
        );
        assert!(query_terms("  ?!  ").is_empty());
        assert_eq!(query_terms("Spätzle"), vec!["spätzle"]);
    }

    #[test]
    fn match_expressions_quote_every_term_as_prefix() {
        assert_eq!(
            fts_match_expr("vault search").as_deref(),
            Some("\"vault\"* \"search\"*")
        );
        assert_eq!(
            fts_match_expr("\" OR 1=1 --"),
            Some("\"or\"* \"1\"*".to_owned())
        );
        assert_eq!(fts_match_expr("---"), None);
        assert_eq!(
            fts_tag_expr("#Project/alpha").as_deref(),
            Some("tags : \"project\"* AND tags : \"alpha\"*")
        );
    }

    #[test]
    fn snippets_escape_everything_but_generated_marks() {
        let raw = format!("<script>alert(1)</script> {MARK_START}vault{MARK_END} & more");
        assert_eq!(
            render_snippet(&raw),
            "&lt;script&gt;alert(1)&lt;/script&gt; <mark>vault</mark> &amp; more"
        );
    }

    #[test]
    fn snippets_close_dangling_marks_and_ignore_stray_delimiters() {
        let raw = format!("a {MARK_END}b {MARK_START}c\n\nd");
        assert_eq!(render_snippet(&raw), "a b <mark>c d</mark>");
    }

    #[test]
    fn markdown_is_reduced_to_readable_text() {
        let md = "---\ntitle: X\ntags: [a]\n---\n# Heading\n> quote\n- [ ] task with [[Other Note|alias]] and [[Plain]]\n**bold** `code` [link](https://x.y) ![img](a.png)\n```rust\nfn main() {}\n```";
        assert_eq!(
            markdown_to_plain(md),
            "Heading\nquote\ntask with alias and Plain\nbold code link img\nfn main() {}"
        );
    }

    #[test]
    fn markdown_without_closing_frontmatter_keeps_everything() {
        let md = "---\nnot frontmatter";
        assert_eq!(split_frontmatter(md), (None, md));
    }

    #[test]
    fn tags_come_from_frontmatter_and_inline_hashtags() {
        let md = "---\ntags:\n  - Research\n  - \"ai\"\n---\n# Title\nSome #idea and #project/alpha, not #42.\n```\n#include <stdio.h>\n```\n(#nested) #idea";
        assert_eq!(
            extract_tags(md),
            vec!["research", "ai", "idea", "project/alpha", "nested"]
        );
        assert_eq!(extract_tags("---\ntags: a, b\n---\n"), vec!["a", "b"]);
    }

    #[test]
    fn fnv_hash_is_stable() {
        assert_eq!(fnv1a64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64("a"), 0xaf63_dc4c_8601_ec8c);
        assert_ne!(fnv1a64("fact one"), fnv1a64("fact two"));
    }

    #[test]
    fn sentinels_are_stripped_from_indexed_text() {
        let text = format!("x{MARK_START}y{MARK_END}z");
        assert_eq!(strip_sentinels(&text), "xyz");
    }
}
