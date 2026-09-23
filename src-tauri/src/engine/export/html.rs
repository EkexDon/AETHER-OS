//! Markdown → HTML for exports.
//!
//! Parsing is done by `pulldown-cmark` (CommonMark + GFM tables, task
//! lists, strikethrough, footnotes, alerts). On top of the event stream this
//! module adds the vault's Obsidian-flavoured syntax:
//!
//! - `[[Note]]`, `[[Note|Alias]]`, `[[Note#Heading]]`, `[[#Heading]]`
//!   resolve through [`VaultModel::resolve_note`]; unresolved links render
//!   as plain text with `class="missing"`.
//! - `![[image.png]]` (optionally `|300` / `|300x200`) embeds attachments,
//!   `![[Note]]` renders a link to the embedded note.
//! - `#tags` become tag chips (links to tag pages on a site).
//! - `- [ ]` tasks render as disabled checkboxes.
//! - ```` ```mermaid ```` fences become `<pre class="mermaid">`.
//! - Other fences are highlighted by `syntect` into `hl-*` classed spans;
//!   [`highlight_css`] provides light and dark colours (no JavaScript).
//! - Raw HTML passes through an allowlist sanitizer: scripts, event
//!   handlers and `javascript:` URLs never reach an exported page.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use base64::Engine as _;
use pulldown_cmark::{
    html as md_html, CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd,
    TextMergeStream,
};
use syntect::highlighting::ThemeSet;
use syntect::html::{css_for_theme_with_class_style, ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use super::{
    encode_path, escape_html, heading_anchor, inline_tags, normalize_tag, parse_frontmatter,
    percent_decode, relative_path, slugify, wikilinks_in, ExportOptions, ExportTheme, Frontmatter,
    NoteEntry, VaultModel, WikiLink,
};
use crate::engine::error::AetherError;

/// Base stylesheet of every exported document (scoped to `.aether-doc`).
pub const STYLE_CSS: &str = include_str!("templates/style.css");
/// Standalone single-note document.
const NOTE_TEMPLATE: &str = include_str!("templates/note.html");
/// Mermaid bundle referenced when "Include diagram script" is enabled.
pub const MERMAID_CDN: &str = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
/// Attachments above this size are never inlined as data URIs.
const MAX_EMBED_BYTES: u64 = 8 * 1024 * 1024;
/// Plain text kept per note for the site search index.
const MAX_INDEX_TEXT: usize = 2_000;
/// Class prefix of syntect's highlighting spans.
const HL_PREFIX: &str = "hl-";

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico",
];

/// Where rendered links point to.
#[derive(Debug, Clone, Copy)]
pub enum LinkTarget<'a> {
    /// A self-contained document: note links become plain (styled) text,
    /// images are inlined as data URIs when `embed_images` is set.
    Standalone { embed_images: bool },
    /// A page in `notes/` of a static site. `pages` maps published notes
    /// to their slugs; attachments are served from `files/` when
    /// `copy_attachments` is set.
    Site {
        pages: &'a HashMap<usize, String>,
        copy_attachments: bool,
    },
}

/// Everything the renderer needs to resolve links of one note.
pub struct RenderEnv<'a> {
    pub model: &'a VaultModel,
    /// Index of the note being rendered.
    pub note: usize,
    pub target: LinkTarget<'a>,
}

/// Output of [`render_markdown`].
#[derive(Debug, Default)]
pub struct RenderedNote {
    pub html: String,
    /// Notes this note links to (resolved, de-duplicated, in order).
    pub links: Vec<usize>,
    /// Attachments referenced by embeds, images or links.
    pub attachments: BTreeSet<usize>,
    /// Unresolved link targets as written.
    pub missing: Vec<String>,
    /// Inline tags in order (frontmatter tags are not included).
    pub tags: Vec<String>,
    /// Plain text for the search index (truncated).
    pub text: String,
    pub has_mermaid: bool,
    pub warnings: Vec<String>,
}

/// Site URL of a tag page relative to the site root.
pub fn tag_slug(tag: &str) -> String {
    slugify(&normalize_tag(tag).replace('/', "-"))
}

/// True when `name` has an image file extension.
pub fn is_image(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn mime_for(name: &str) -> &'static str {
    match name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Markdown dialect used for every export.
fn markdown_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_GFM
}

struct HeadingBuf<'a> {
    level: HeadingLevel,
    id: Option<String>,
    classes: Vec<CowStr<'a>>,
    attrs: Vec<(CowStr<'a>, Option<CowStr<'a>>)>,
    events: Vec<Event<'a>>,
    text: String,
}

struct CodeBuf {
    lang: Option<String>,
    text: String,
}

struct Renderer<'e, 'a> {
    env: &'e RenderEnv<'e>,
    out: Vec<Event<'a>>,
    heading: Option<HeadingBuf<'a>>,
    code: Option<CodeBuf>,
    /// Open links: `true` when rendered as a `<span>` instead of `<a>`.
    link_stack: Vec<bool>,
    image_depth: usize,
    anchors: HashMap<String, usize>,
    link_set: HashSet<usize>,
    tag_set: HashSet<String>,
    embed_cache: HashMap<usize, Option<String>>,
    result: RenderedNote,
}

/// Render a note body (without frontmatter) to HTML.
pub fn render_markdown(env: &RenderEnv<'_>, body: &str) -> RenderedNote {
    let mut renderer = Renderer {
        env,
        out: Vec::new(),
        heading: None,
        code: None,
        link_stack: Vec::new(),
        image_depth: 0,
        anchors: HashMap::new(),
        link_set: HashSet::new(),
        tag_set: HashSet::new(),
        embed_cache: HashMap::new(),
        result: RenderedNote::default(),
    };
    for event in TextMergeStream::new(Parser::new_ext(body, markdown_options())) {
        renderer.handle(event);
    }
    renderer.finish()
}

impl<'e, 'a> Renderer<'e, 'a> {
    fn push(&mut self, event: Event<'a>) {
        match &mut self.heading {
            Some(h) => h.events.push(event),
            None => self.out.push(event),
        }
    }

    fn html(&mut self, html: String) {
        self.push(Event::InlineHtml(CowStr::from(html)));
    }

    /// Record plain text for the search index and heading ids.
    fn plain(&mut self, text: &str) {
        if let Some(h) = &mut self.heading {
            h.text.push_str(text);
        }
        if self.result.text.len() < MAX_INDEX_TEXT {
            self.result.text.push_str(text);
        }
    }

    fn handle(&mut self, event: Event<'a>) {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info
                        .split(|c: char| c.is_whitespace() || c == ',' || c == '{')
                        .next()
                        .filter(|l| !l.is_empty())
                        .map(|l| l.to_lowercase()),
                    CodeBlockKind::Indented => None,
                };
                self.code = Some(CodeBuf {
                    lang,
                    text: String::new(),
                });
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(code) = self.code.take() {
                    let html = self.render_code(code);
                    self.push(Event::Html(CowStr::from(html)));
                }
            }
            Event::Text(text) if self.code.is_some() => {
                if let Some(code) = &mut self.code {
                    code.text.push_str(&text);
                }
            }
            Event::Start(Tag::Heading {
                level,
                id,
                classes,
                attrs,
            }) => {
                self.heading = Some(HeadingBuf {
                    level,
                    id: id.map(|i| i.to_string()),
                    classes,
                    attrs,
                    events: Vec::new(),
                    text: String::new(),
                });
            }
            Event::End(TagEnd::Heading(_)) => self.flush_heading(),
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => match self.rewrite_link(&dest_url) {
                Some(dest) => {
                    self.link_stack.push(false);
                    self.push(Event::Start(Tag::Link {
                        link_type,
                        dest_url: CowStr::from(dest),
                        title,
                        id,
                    }));
                }
                None => {
                    self.link_stack.push(true);
                    self.html("<span class=\"wikilink\">".to_owned());
                }
            },
            Event::End(TagEnd::Link) => match self.link_stack.pop() {
                Some(true) => self.html("</span>".to_owned()),
                _ => self.push(Event::End(TagEnd::Link)),
            },
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                self.image_depth += 1;
                let src = self.rewrite_image(&dest_url);
                self.push(Event::Start(Tag::Image {
                    link_type,
                    dest_url: CowStr::from(src),
                    title,
                    id,
                }));
            }
            Event::End(TagEnd::Image) => {
                self.image_depth = self.image_depth.saturating_sub(1);
                self.push(Event::End(TagEnd::Image));
            }
            Event::Text(text) => self.text(text),
            Event::Code(code) => {
                self.plain(&code);
                self.push(Event::Code(code));
            }
            Event::Html(raw) => {
                let clean = sanitize_html(&raw);
                self.push(Event::Html(CowStr::from(clean)));
            }
            Event::InlineHtml(raw) => {
                let clean = sanitize_html(&raw);
                self.push(Event::InlineHtml(CowStr::from(clean)));
            }
            Event::End(
                end
                @ (TagEnd::Paragraph | TagEnd::Item | TagEnd::TableCell | TagEnd::BlockQuote(_)),
            ) => {
                self.plain(" ");
                self.push(Event::End(end));
            }
            Event::SoftBreak | Event::HardBreak => {
                self.plain(" ");
                self.push(event);
            }
            other => self.push(other),
        }
    }

    fn flush_heading(&mut self) {
        let Some(h) = self.heading.take() else {
            return;
        };
        let base =
            h.id.clone()
                .unwrap_or_else(|| heading_anchor(&h.text))
                .trim_matches('-')
                .to_owned();
        let base = if base.is_empty() {
            "section".to_owned()
        } else {
            base
        };
        let count = self.anchors.entry(base.clone()).or_insert(0);
        let id = if *count == 0 {
            base
        } else {
            format!("{base}-{count}")
        };
        *count += 1;
        let level = h.level;
        self.out.push(Event::Start(Tag::Heading {
            level,
            id: Some(CowStr::from(id)),
            classes: h.classes,
            attrs: h.attrs,
        }));
        self.out.extend(h.events);
        self.out.push(Event::End(TagEnd::Heading(level)));
        self.plain(" ");
    }

    /// Text outside code: wikilinks, embeds and tags become HTML.
    fn text(&mut self, text: CowStr<'a>) {
        if !self.link_stack.is_empty() || self.image_depth > 0 {
            self.plain(&text);
            self.push(Event::Text(text));
            return;
        }
        let links = wikilinks_in(&text, 0);
        let mut items: Vec<(usize, usize, Item)> = links
            .into_iter()
            .map(|l| (l.range.start, l.range.end, Item::Link(l)))
            .collect();
        for (range, tag) in inline_tags(&text) {
            if !items
                .iter()
                .any(|(s, e, _)| range.start < *e && range.end > *s)
            {
                items.push((range.start, range.end, Item::Tag(tag)));
            }
        }
        if items.is_empty() {
            self.plain(&text);
            self.push(Event::Text(text));
            return;
        }
        items.sort_by_key(|(s, _, _)| *s);
        let mut last = 0;
        for (start, end, item) in items {
            if start > last {
                let chunk = text[last..start].to_owned();
                self.plain(&chunk);
                self.push(Event::Text(CowStr::from(chunk)));
            }
            let html = match item {
                Item::Link(link) => self.render_wikilink(&link),
                Item::Tag(tag) => self.render_tag(&tag),
            };
            self.html(html);
            last = end;
        }
        if last < text.len() {
            let chunk = text[last..].to_owned();
            self.plain(&chunk);
            self.push(Event::Text(CowStr::from(chunk)));
        }
    }

    fn record_link(&mut self, idx: usize) {
        if idx != self.env.note && self.link_set.insert(idx) {
            self.result.links.push(idx);
        }
    }

    fn missing(&mut self, target: &str, display: &str, extra_class: &str) -> String {
        self.result.missing.push(target.to_owned());
        format!(
            "<span class=\"missing{extra_class}\" title=\"Not exported: {}\">{}</span>",
            escape_html(target),
            escape_html(display)
        )
    }

    /// URL of a published page (from a page in `notes/`), with an anchor.
    fn page_href(&self, idx: usize, heading: Option<&str>) -> Option<String> {
        let LinkTarget::Site { pages, .. } = self.env.target else {
            return None;
        };
        let slug = pages.get(&idx)?;
        let anchor = heading
            .map(|h| format!("#{}", encode_path(&heading_anchor(h))))
            .unwrap_or_default();
        if idx == self.env.note {
            return Some(if anchor.is_empty() {
                "#".to_owned()
            } else {
                anchor
            });
        }
        Some(format!("{}.html{anchor}", encode_path(slug)))
    }

    fn render_wikilink(&mut self, link: &WikiLink) -> String {
        let display = link.display();
        self.plain(&display);
        if link.embed {
            return self.render_embed(link, &display);
        }
        if link.target.is_empty() {
            let anchor = heading_anchor(link.heading.as_deref().unwrap_or_default());
            return format!(
                "<a class=\"internal\" href=\"#{}\">{}</a>",
                escape_html(&encode_path(&anchor)),
                escape_html(&display)
            );
        }
        let Some(idx) = self
            .env
            .model
            .resolve_note(&link.target, Some(self.env.note))
        else {
            // A link may also point at an attachment (`[[report.pdf]]`).
            if let Some(att) = self
                .env
                .model
                .resolve_attachment(&link.target, Some(self.env.note))
            {
                return self.render_attachment_link(att, &display);
            }
            return self.missing(&link.target, &display, "");
        };
        match self.env.target {
            LinkTarget::Site { .. } => match self.page_href(idx, link.heading.as_deref()) {
                Some(href) => {
                    self.record_link(idx);
                    format!(
                        "<a class=\"internal\" href=\"{}\">{}</a>",
                        escape_html(&href),
                        escape_html(&display)
                    )
                }
                None => self.missing(&link.target, &display, ""),
            },
            LinkTarget::Standalone { .. } => {
                self.record_link(idx);
                format!(
                    "<span class=\"wikilink\" title=\"{}\">{}</span>",
                    escape_html(&self.env.model.notes[idx].name),
                    escape_html(&display)
                )
            }
        }
    }

    fn render_embed(&mut self, link: &WikiLink, display: &str) -> String {
        let model = self.env.model;
        if let Some(att) = model.resolve_attachment(&link.target, Some(self.env.note)) {
            let name = model.attachments[att].file_name().to_owned();
            if !is_image(&name) {
                return self.render_attachment_link(att, &name);
            }
            let (size_attrs, alt) = image_size(link.alias.as_deref(), &name);
            return match self.attachment_src(att) {
                Some(src) => format!(
                    "<img class=\"embed\" src=\"{}\" alt=\"{}\" loading=\"lazy\"{size_attrs}>",
                    escape_html(&src),
                    escape_html(&alt)
                ),
                None => self.missing(&link.target, &name, " embed"),
            };
        }
        if let Some(idx) = model.resolve_note(&link.target, Some(self.env.note)) {
            return match self.env.target {
                LinkTarget::Site { .. } => match self.page_href(idx, link.heading.as_deref()) {
                    Some(href) => {
                        self.record_link(idx);
                        format!(
                            "<a class=\"internal embed-note\" href=\"{}\">{}</a>",
                            escape_html(&href),
                            escape_html(display)
                        )
                    }
                    None => self.missing(&link.target, display, " embed"),
                },
                LinkTarget::Standalone { .. } => {
                    self.record_link(idx);
                    format!(
                        "<span class=\"wikilink embed-note\">{}</span>",
                        escape_html(display)
                    )
                }
            };
        }
        self.missing(&link.target, display, " embed")
    }

    fn render_attachment_link(&mut self, att: usize, display: &str) -> String {
        let is_site = matches!(self.env.target, LinkTarget::Site { .. });
        match (is_site, self.attachment_src(att)) {
            (true, Some(src)) => format!(
                "<a class=\"attachment\" href=\"{}\">{}</a>",
                escape_html(&src),
                escape_html(display)
            ),
            _ => format!("<span class=\"attachment\">{}</span>", escape_html(display)),
        }
    }

    /// URL of an attachment for the current target (records it as used).
    fn attachment_src(&mut self, att: usize) -> Option<String> {
        let model = self.env.model;
        let entry = &model.attachments[att];
        match self.env.target {
            LinkTarget::Site {
                copy_attachments, ..
            } => {
                if !copy_attachments {
                    return None;
                }
                self.result.attachments.insert(att);
                Some(format!("../files/{}", encode_path(&entry.rel)))
            }
            LinkTarget::Standalone { embed_images } => {
                if embed_images && is_image(entry.file_name()) {
                    if let Some(cached) = self.embed_cache.get(&att) {
                        return cached.clone();
                    }
                    let uri = self.data_uri(att);
                    self.embed_cache.insert(att, uri.clone());
                    if uri.is_some() {
                        self.result.attachments.insert(att);
                        return uri;
                    }
                }
                let folder = model.notes[self.env.note].folder();
                Some(encode_path(&relative_path(folder, &entry.rel)))
            }
        }
    }

    fn data_uri(&mut self, att: usize) -> Option<String> {
        let entry = &self.env.model.attachments[att];
        if entry.size > MAX_EMBED_BYTES {
            self.result.warnings.push(format!(
                "{} is larger than {} MB and was linked instead of embedded",
                entry.rel,
                MAX_EMBED_BYTES / (1024 * 1024)
            ));
            return None;
        }
        match std::fs::read(&entry.abs) {
            Ok(bytes) => Some(format!(
                "data:{};base64,{}",
                mime_for(entry.file_name()),
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )),
            Err(e) => {
                self.result
                    .warnings
                    .push(format!("could not read {}: {e}", entry.rel));
                None
            }
        }
    }

    fn render_tag(&mut self, tag: &str) -> String {
        let key = normalize_tag(tag);
        if self.tag_set.insert(key) {
            self.result.tags.push(tag.to_owned());
        }
        self.plain(&format!("#{tag}"));
        match self.env.target {
            LinkTarget::Site { .. } => format!(
                "<a class=\"tag\" href=\"../tags/{}.html\">#{}</a>",
                escape_html(&encode_path(&tag_slug(tag))),
                escape_html(tag)
            ),
            LinkTarget::Standalone { .. } => {
                format!("<span class=\"tag\">#{}</span>", escape_html(tag))
            }
        }
    }

    /// Rewrite a Markdown link destination. `None` renders the link as a
    /// plain span (a note link inside a standalone document).
    fn rewrite_link(&mut self, dest: &str) -> Option<String> {
        let trimmed = dest.trim();
        if let Some(scheme) = url_scheme(trimmed) {
            return Some(if SAFE_SCHEMES.contains(&scheme.as_str()) {
                trimmed.to_owned()
            } else {
                "#".to_owned()
            });
        }
        if trimmed.starts_with('#') || trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
        let (path, fragment) = match trimmed.split_once('#') {
            Some((p, f)) => (p, Some(percent_decode(f))),
            None => (trimmed, None),
        };
        let decoded = percent_decode(path);
        let model = self.env.model;
        if decoded.to_lowercase().ends_with(".md") || !decoded.contains('.') {
            if let Some(idx) = model.resolve_note(&decoded, Some(self.env.note)) {
                return match self.env.target {
                    LinkTarget::Site { .. } => {
                        let href = self.page_href(idx, fragment.as_deref());
                        if href.is_some() {
                            self.record_link(idx);
                        } else {
                            self.result.missing.push(decoded.clone());
                        }
                        Some(href.unwrap_or_else(|| "#".to_owned()))
                    }
                    LinkTarget::Standalone { .. } => {
                        self.record_link(idx);
                        None
                    }
                };
            }
        }
        if let Some(att) = model.resolve_attachment(&decoded, Some(self.env.note)) {
            if let Some(src) = self.attachment_src(att) {
                return Some(src);
            }
        }
        Some(trimmed.to_owned())
    }

    fn rewrite_image(&mut self, src: &str) -> String {
        let trimmed = src.trim();
        if let Some(scheme) = url_scheme(trimmed) {
            return if scheme == "http" || scheme == "https" || trimmed.starts_with("data:image/") {
                trimmed.to_owned()
            } else {
                String::new()
            };
        }
        match self
            .env
            .model
            .resolve_attachment(trimmed, Some(self.env.note))
        {
            Some(att) => self.attachment_src(att).unwrap_or_default(),
            None => {
                self.result.missing.push(percent_decode(trimmed));
                trimmed.to_owned()
            }
        }
    }

    fn render_code(&mut self, code: CodeBuf) -> String {
        if code.lang.as_deref() == Some("mermaid") {
            self.result.has_mermaid = true;
            return format!("<pre class=\"mermaid\">{}</pre>\n", escape_html(&code.text));
        }
        let lang_attr = code
            .lang
            .as_deref()
            .map(|l| format!(" data-lang=\"{}\"", escape_html(l)))
            .unwrap_or_default();
        format!(
            "<pre class=\"code\"{lang_attr}><code>{}</code></pre>\n",
            highlight_code(&code.text, code.lang.as_deref())
        )
    }

    fn finish(mut self) -> RenderedNote {
        let mut html = String::new();
        md_html::push_html(&mut html, self.out.into_iter());
        self.result.html = html;
        let text = self
            .result
            .text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        self.result.text = truncate_chars(&text, MAX_INDEX_TEXT);
        self.result
    }
}

enum Item {
    Link(WikiLink),
    Tag(String),
}

/// Obsidian image size syntax: `|300` or `|300x200`; anything else is alt text.
fn image_size(alias: Option<&str>, name: &str) -> (String, String) {
    let Some(alias) = alias.map(str::trim).filter(|a| !a.is_empty()) else {
        return (String::new(), name.to_owned());
    };
    let (w, h) = match alias.split_once('x') {
        Some((w, h)) => (w.trim(), Some(h.trim())),
        None => (alias, None),
    };
    let numeric = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let height_ok = match h {
        None => true,
        Some(h) => numeric(h),
    };
    if numeric(w) && height_ok {
        let mut attrs = format!(" width=\"{w}\"");
        if let Some(h) = h {
            attrs.push_str(&format!(" height=\"{h}\""));
        }
        (attrs, name.to_owned())
    } else {
        (String::new(), alias.to_owned())
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// URL schemes a link may use in an exported page.
/// Link schemes kept in exported pages. App-specific schemes (`obsidian:`,
/// `vscode:`, …) are dropped: in a published page they would let a visitor's
/// locally installed app act on whatever the link encodes.
const SAFE_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];

/// Lower-cased scheme of an absolute URL (`https`), `None` for relative
/// references. Whitespace and control characters are ignored, so
/// `java\tscript:` is still detected.
fn url_scheme(url: &str) -> Option<String> {
    let compact: String = url
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect();
    let colon = compact.find(':')?;
    let scheme = &compact[..colon];
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    Some(scheme.to_lowercase())
}

// ─────────────────────────────────────────────────────────────────────────
// Syntax highlighting
// ─────────────────────────────────────────────────────────────────────────

fn syntax_set() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn find_syntax<'s>(set: &'s SyntaxSet, lang: &str) -> Option<&'s SyntaxReference> {
    let token = match lang {
        "ts" | "typescript" | "tsx" | "jsx" | "mjs" | "cjs" | "javascript" => "js",
        "sh" | "bash" | "zsh" | "shell" | "console" | "shellsession" => "sh",
        "py" | "python3" => "py",
        "yml" => "yaml",
        "c++" | "cpp" | "hpp" => "cpp",
        "golang" => "go",
        "jsonc" | "json5" => "json",
        "svg" => "xml",
        "rs" => "rs",
        other => other,
    };
    set.find_syntax_by_token(token)
}

/// Highlight `code` into `hl-*` classed spans. Unknown languages (and the
/// empty language) are HTML-escaped plain text.
pub fn highlight_code(code: &str, lang: Option<&str>) -> String {
    let set = syntax_set();
    let Some(syntax) = lang.and_then(|l| find_syntax(set, l)) else {
        return escape_html(code);
    };
    let mut generator = ClassedHTMLGenerator::new_with_class_style(
        syntax,
        set,
        ClassStyle::SpacedPrefixed { prefix: HL_PREFIX },
    );
    let owned;
    let source = if code.ends_with('\n') {
        code
    } else {
        owned = format!("{code}\n");
        &owned
    };
    for line in LinesWithEndings::from(source) {
        if generator
            .parse_html_for_line_which_includes_newline(line)
            .is_err()
        {
            return escape_html(code);
        }
    }
    generator.finalize()
}

/// Scope syntect's CSS under `scope`, dropping backgrounds (the document
/// styles its own code wells).
fn scope_theme_css(css: &str, scope: &str) -> String {
    let mut without_comments = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        without_comments.push_str(&rest[..start]);
        match rest[start..].find("*/") {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                rest = "";
                break;
            }
        }
    }
    without_comments.push_str(rest);
    let mut out = String::new();
    for rule in without_comments.split('}') {
        let Some((selectors, body)) = rule.split_once('{') else {
            continue;
        };
        let selectors = selectors.trim();
        if selectors.is_empty() || selectors == format!(".{HL_PREFIX}code") {
            continue;
        }
        let declarations: Vec<&str> = body
            .split(';')
            .map(str::trim)
            .filter(|d| !d.is_empty() && !d.starts_with("background"))
            .collect();
        if declarations.is_empty() {
            continue;
        }
        let scoped: Vec<String> = selectors
            .split(',')
            .map(|s| format!("{scope} {}", s.trim()))
            .collect();
        out.push_str(&scoped.join(", "));
        out.push_str(" { ");
        out.push_str(&declarations.join("; "));
        out.push_str("; }\n");
    }
    out
}

/// Highlighting colours: a light theme by default, a warm dark theme for
/// `data-theme="dark"` and for `auto` when the reader prefers dark (screen
/// only — print always uses the light colours).
pub fn highlight_css() -> &'static str {
    static CSS: OnceLock<String> = OnceLock::new();
    CSS.get_or_init(|| {
        let themes = ThemeSet::load_defaults();
        let style = ClassStyle::SpacedPrefixed { prefix: HL_PREFIX };
        let theme_css = |name: &str| {
            themes
                .themes
                .get(name)
                .and_then(|t| css_for_theme_with_class_style(t, style).ok())
                .unwrap_or_default()
        };
        let light = theme_css("InspiredGitHub");
        let dark = theme_css("base16-eighties.dark");
        let mut css = String::from("/* Syntax highlighting (syntect) */\n");
        css.push_str(&scope_theme_css(&light, ".aether-doc"));
        css.push_str("@media screen and (prefers-color-scheme: dark) {\n");
        css.push_str(&scope_theme_css(&dark, ".aether-doc[data-theme=\"auto\"]"));
        css.push_str("}\n@media screen {\n");
        css.push_str(&scope_theme_css(&dark, ".aether-doc[data-theme=\"dark\"]"));
        css.push_str("}\n");
        css
    })
}

/// The full stylesheet of an exported document: base styles + highlighting.
pub fn document_css() -> String {
    format!("{STYLE_CSS}\n{}", highlight_css())
}

// ─────────────────────────────────────────────────────────────────────────
// Raw HTML sanitizer
// ─────────────────────────────────────────────────────────────────────────

const ALLOWED_TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "small",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
    "wbr",
];

const ALLOWED_ATTRS: &[&str] = &[
    "align", "alt", "cite", "class", "colspan", "datetime", "dir", "height", "href", "id", "lang",
    "open", "reversed", "rowspan", "src", "start", "style", "title", "type", "width",
];

struct ParsedTag {
    name: String,
    closing: bool,
    self_closing: bool,
    attrs: Vec<(String, Option<String>)>,
}

/// Parse an HTML tag at the start of `s` (which begins with `<`). Returns
/// the byte length consumed and the tag, or `None` when it is not a
/// well-formed tag.
fn parse_tag(s: &str) -> Option<(usize, ParsedTag)> {
    let b = s.as_bytes();
    let len = b.len();
    let mut i = 1;
    let closing = b.get(1) == Some(&b'/');
    if closing {
        i = 2;
    }
    let name_start = i;
    while i < len && (b[i].is_ascii_alphanumeric() || b[i] == b'-') {
        i += 1;
    }
    if i == name_start || !b[name_start].is_ascii_alphabetic() {
        return None;
    }
    let name = s[name_start..i].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut self_closing = false;
    loop {
        while i < len && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len {
            return None;
        }
        match b[i] {
            b'>' => {
                i += 1;
                break;
            }
            b'/' => {
                if b.get(i + 1) == Some(&b'>') {
                    self_closing = true;
                    i += 2;
                    break;
                }
                i += 1;
                continue;
            }
            _ => {}
        }
        let attr_start = i;
        while i < len
            && !b[i].is_ascii_whitespace()
            && !matches!(b[i], b'=' | b'>' | b'/' | b'"' | b'\'' | b'<')
        {
            i += 1;
        }
        if i == attr_start {
            return None;
        }
        let attr = s[attr_start..i].to_ascii_lowercase();
        while i < len && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = None;
        if i < len && b[i] == b'=' {
            i += 1;
            while i < len && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= len {
                return None;
            }
            if b[i] == b'"' || b[i] == b'\'' {
                let quote = b[i] as char;
                let value_start = i + 1;
                let end = s[value_start..].find(quote)?;
                value = Some(s[value_start..value_start + end].to_owned());
                i = value_start + end + 1;
            } else {
                let value_start = i;
                while i < len && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                    i += 1;
                }
                value = Some(s[value_start..i].to_owned());
            }
        }
        attrs.push((attr, value));
    }
    Some((
        i,
        ParsedTag {
            name,
            closing,
            self_closing,
            attrs,
        },
    ))
}

fn safe_attr(name: &str, value: Option<&str>) -> bool {
    if !ALLOWED_ATTRS.contains(&name) {
        return false;
    }
    let Some(value) = value else {
        return true;
    };
    let lower = value.to_lowercase();
    match name {
        "href" | "src" | "cite" => {
            // Entities could hide a scheme (`&#106;avascript:`) — refuse them.
            if lower.contains('&') {
                return false;
            }
            match url_scheme(&lower) {
                // Inline images may be data URLs; links and citations never.
                Some(scheme) => {
                    SAFE_SCHEMES.contains(&scheme.as_str())
                        || (name == "src" && lower.trim_start().starts_with("data:image/"))
                }
                None => true,
            }
        }
        "style" => {
            !(lower.contains("url(")
                || lower.contains("expression")
                || lower.contains("javascript")
                || lower.contains("@import")
                || lower.contains('&')
                || lower.contains('\\'))
        }
        _ => true,
    }
}

/// Sanitize raw HTML from a note: allowlisted tags keep allowlisted
/// attributes (URLs restricted to safe schemes), comments are kept, and
/// everything else — `<script>`, `<style>`, `<iframe>`, event handlers,
/// malformed tags — is escaped so it shows up as text instead of running.
pub fn sanitize_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while let Some(rel) = input[i..].find('<') {
        let lt = i + rel;
        out.push_str(&input[i..lt]);
        let rest = &input[lt..];
        if rest.starts_with("<!--") {
            match rest.find("-->") {
                Some(end) => {
                    out.push_str(&rest[..end + 3]);
                    i = lt + end + 3;
                }
                None => {
                    out.push_str(&escape_html(rest));
                    i = input.len();
                }
            }
            continue;
        }
        match parse_tag(rest) {
            Some((consumed, tag)) if ALLOWED_TAGS.contains(&tag.name.as_str()) => {
                if tag.closing {
                    out.push_str(&format!("</{}>", tag.name));
                } else {
                    out.push('<');
                    out.push_str(&tag.name);
                    for (name, value) in &tag.attrs {
                        if !safe_attr(name, value.as_deref()) {
                            continue;
                        }
                        match value {
                            Some(v) => out.push_str(&format!(" {name}=\"{}\"", escape_html(v))),
                            None => out.push_str(&format!(" {name}")),
                        }
                    }
                    if tag.name == "a"
                        && tag.attrs.iter().any(|(n, v)| {
                            n == "href"
                                && v.as_deref()
                                    .and_then(url_scheme)
                                    .is_some_and(|s| s == "http" || s == "https")
                        })
                    {
                        out.push_str(" rel=\"noopener noreferrer\"");
                    }
                    out.push_str(if tag.self_closing { " />" } else { ">" });
                }
                i = lt + consumed;
            }
            Some((consumed, _)) => {
                out.push_str(&escape_html(&rest[..consumed]));
                i = lt + consumed;
            }
            None => {
                out.push_str("&lt;");
                i = lt + 1;
            }
        }
    }
    out.push_str(&input[i..]);
    out
}

// ─────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────

/// A note ready to render: title and body with the title heading removed.
#[derive(Debug)]
pub struct PreparedNote<'c> {
    pub title: String,
    pub frontmatter: Frontmatter,
    pub body: &'c str,
}

/// The first line of `body` when it is a plain `# Title` heading
/// (no inline markup), plus the remaining body.
fn leading_h1(body: &str) -> Option<(String, &str)> {
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            offset += line.len();
            continue;
        }
        let text = trimmed.strip_prefix("# ")?;
        let text = text.trim().trim_end_matches('#').trim();
        if text.is_empty() || text.contains(['[', ']', '`', '*', '_', '<', '\\']) {
            return None;
        }
        return Some((text.to_owned(), &body[offset + line.len()..]));
    }
    None
}

/// Split frontmatter, choose the title (frontmatter `title`, else a leading
/// `# H1`, else the file name) and drop a leading H1 that repeats it.
pub fn prepare_note<'c>(entry: &NoteEntry, content: &'c str) -> PreparedNote<'c> {
    let (frontmatter, body) = parse_frontmatter(content);
    let (title, body) = match (frontmatter.title.clone(), leading_h1(body)) {
        (None, Some((h1, rest))) => (h1, rest),
        (Some(t), Some((h1, rest))) if t.eq_ignore_ascii_case(&h1) => (t, rest),
        (Some(t), _) => (t, body),
        (None, None) => (entry.name.clone(), body),
    };
    PreparedNote {
        title,
        frontmatter,
        body,
    }
}

/// Header with title, date, tags and description.
pub fn render_header(
    title: &str,
    fm: &Frontmatter,
    options: &ExportOptions,
    tag_href: &dyn Fn(&str) -> Option<String>,
    breadcrumb: Option<&str>,
) -> String {
    let mut html = String::from("<header class=\"doc-header\">\n");
    if let Some(crumb) = breadcrumb {
        html.push_str(crumb);
    }
    html.push_str(&format!(
        "<h1 class=\"doc-title\">{}</h1>\n",
        escape_html(title)
    ));
    if options.include_frontmatter {
        if let Some(desc) = &fm.description {
            html.push_str(&format!(
                "<p class=\"doc-description\">{}</p>\n",
                escape_html(desc)
            ));
        }
        let mut meta = Vec::new();
        if let Some(date) = &fm.date {
            meta.push(format!(
                "<time datetime=\"{0}\">{0}</time>",
                escape_html(date)
            ));
        }
        if !fm.tags.is_empty() {
            let chips: Vec<String> = fm
                .tags
                .iter()
                .map(|t| match tag_href(t) {
                    Some(href) => format!(
                        "<a class=\"tag\" href=\"{}\">#{}</a>",
                        escape_html(&href),
                        escape_html(t)
                    ),
                    None => format!("<span class=\"tag\">#{}</span>", escape_html(t)),
                })
                .collect();
            meta.push(format!(
                "<span class=\"doc-tags\">{}</span>",
                chips.join(" ")
            ));
        }
        if !meta.is_empty() {
            html.push_str(&format!(
                "<div class=\"doc-meta\">{}</div>\n",
                meta.join("<span class=\"doc-meta-sep\" aria-hidden=\"true\">·</span>")
            ));
        }
    }
    html.push_str("</header>\n");
    html
}

/// "Linked from" section. `items` are `(label, optional href)`.
pub fn render_backlinks(items: &[(String, Option<String>)]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut html = String::from(
        "<section class=\"backlinks\" aria-labelledby=\"backlinks-title\">\n<h2 id=\"backlinks-title\" class=\"backlinks-title\">Linked from</h2>\n<ul>\n",
    );
    for (label, href) in items {
        match href {
            Some(h) => html.push_str(&format!(
                "<li><a class=\"internal\" href=\"{}\">{}</a></li>\n",
                escape_html(h),
                escape_html(label)
            )),
            None => html.push_str(&format!(
                "<li><span class=\"wikilink\">{}</span></li>\n",
                escape_html(label)
            )),
        }
    }
    html.push_str("</ul>\n</section>\n");
    html
}

/// Mermaid loader appended to documents with diagrams (opt-in, CDN).
pub fn mermaid_script() -> String {
    format!(
        "<script src=\"{MERMAID_CDN}\"></script>\n<script>(function(){{var t=document.body.getAttribute('data-theme');var dark=t==='dark'||(t==='auto'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(window.mermaid){{window.mermaid.initialize({{startOnLoad:true,theme:dark?'dark':'neutral'}});}}}})();</script>\n"
    )
}

/// Substitute `{{key}}` placeholders in one pass (values are inserted
/// verbatim and never re-scanned).
pub fn fill_template(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 4096);
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let key = after[..end].trim();
                match vars.iter().find(|(k, _)| *k == key) {
                    Some((_, value)) => out.push_str(value),
                    None => out.push_str(&rest[start..start + 2 + end + 2]),
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// A rendered `<article>` for a single note, used by the standalone HTML
/// export, the preview and the print document.
pub struct Article {
    pub title: String,
    pub html: String,
    pub lang: String,
    pub rendered: RenderedNote,
}

/// Render one note as a self-contained `<article>`.
pub fn render_article(
    model: &VaultModel,
    idx: usize,
    options: &ExportOptions,
    embed_images: bool,
) -> Result<Article, AetherError> {
    let content = model.read(idx)?;
    let prepared = prepare_note(&model.notes[idx], &content);
    let env = RenderEnv {
        model,
        note: idx,
        target: LinkTarget::Standalone { embed_images },
    };
    let rendered = render_markdown(&env, prepared.body);
    let mut html = String::from("<article class=\"doc\">\n");
    html.push_str(&render_header(
        &prepared.title,
        &prepared.frontmatter,
        options,
        &|_| None,
        None,
    ));
    html.push_str("<div class=\"doc-content\">\n");
    html.push_str(&rendered.html);
    html.push_str("</div>\n");
    if options.include_backlinks {
        let items: Vec<(String, Option<String>)> = model
            .backlinks_to(idx)
            .into_iter()
            .map(|i| (model.notes[i].name.clone(), None))
            .collect();
        html.push_str(&render_backlinks(&items));
    }
    html.push_str("</article>\n");
    let lang = prepared
        .frontmatter
        .fields
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("lang") || k.eq_ignore_ascii_case("language"))
        .map(|(_, v)| v.clone())
        .filter(|v| v.len() <= 12 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or_else(|| "en".to_owned());
    Ok(Article {
        title: prepared.title,
        html,
        lang,
        rendered,
    })
}

/// A complete standalone HTML document for one note.
pub struct StandaloneDocument {
    pub html: String,
    pub title: String,
    /// Attachments inlined as data URIs.
    pub attachments: usize,
    pub missing: Vec<String>,
    pub warnings: Vec<String>,
}

/// Render one note as a single HTML file with inlined CSS (and, when
/// `include_attachments` is on, images inlined as data URIs).
pub fn standalone_document(
    model: &VaultModel,
    idx: usize,
    options: &ExportOptions,
) -> Result<StandaloneDocument, AetherError> {
    let article = render_article(model, idx, options, options.include_attachments)?;
    let scripts = if article.rendered.has_mermaid && options.include_mermaid_script {
        mermaid_script()
    } else {
        String::new()
    };
    let footer = format!(
        "Exported from AETHER-OS · {}",
        chrono::Local::now().format("%Y-%m-%d")
    );
    let html = fill_template(
        NOTE_TEMPLATE,
        &[
            ("lang", &escape_html(&article.lang)),
            ("title", &escape_html(&article.title)),
            ("css", &document_css()),
            ("theme", theme_attr(options.theme)),
            ("content", &article.html),
            ("footer", &escape_html(&footer)),
            ("scripts", &scripts),
        ],
    );
    Ok(StandaloneDocument {
        html,
        title: article.title,
        attachments: article.rendered.attachments.len(),
        missing: article.rendered.missing,
        warnings: article.rendered.warnings,
    })
}

/// `data-theme` value for a theme option.
pub fn theme_attr(theme: ExportTheme) -> &'static str {
    theme.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::export::test_support::*;
    use tempfile::tempdir;

    fn model_with(files: &[(&str, &str)]) -> (tempfile::TempDir, VaultModel) {
        let dir = tempdir().expect("dir");
        for (rel, content) in files {
            write(dir.path(), rel, content);
        }
        let model = VaultModel::load(dir.path()).expect("model");
        (dir, model)
    }

    fn render(model: &VaultModel, rel: &str, target: LinkTarget<'_>) -> RenderedNote {
        let idx = model.notes.iter().position(|n| n.rel == rel).expect(rel);
        let content = model.read(idx).expect("read");
        let prepared = prepare_note(&model.notes[idx], &content);
        render_markdown(
            &RenderEnv {
                model,
                note: idx,
                target,
            },
            prepared.body,
        )
    }

    #[test]
    fn renders_wikilinks_embeds_tags_and_tasks_standalone() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        let model = VaultModel::load(dir.path()).expect("model");
        let out = render(
            &model,
            "Welcome.md",
            LinkTarget::Standalone { embed_images: true },
        );
        let html = &out.html;
        assert!(
            html.contains("<span class=\"wikilink\" title=\"Alpha\">the alpha</span>"),
            "{html}"
        );
        assert!(html.contains(">Beta &gt; Setup</span>"), "{html}");
        assert!(html.contains("<span class=\"missing\" title=\"Not exported: Ghost\">Ghost</span>"));
        assert!(html.contains("<span class=\"tag\">#inbox</span>"));
        assert!(
            html.contains("src=\"data:image/png;base64,"),
            "image embedded: {html}"
        );
        assert!(html.contains("<input disabled=\"\" type=\"checkbox\"/>"));
        assert!(html.contains("<input disabled=\"\" type=\"checkbox\" checked=\"\"/>"));
        assert!(html.contains("<pre class=\"mermaid\">graph TD; A--&gt;B;"));
        assert!(
            !html.contains("NotALink</span>"),
            "code must not be linkified"
        );
        assert_eq!(out.missing, vec!["Ghost"]);
        assert_eq!(out.tags, vec!["inbox"]);
        assert!(out.has_mermaid);
        assert_eq!(out.attachments.len(), 1);
        assert_eq!(out.links.len(), 2);
    }

    #[test]
    fn site_links_point_to_slugs_and_tag_pages() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        let model = VaultModel::load(dir.path()).expect("model");
        let alpha = model
            .notes
            .iter()
            .position(|n| n.rel == "Projects/Alpha.md")
            .expect("a");
        let beta = model
            .notes
            .iter()
            .position(|n| n.rel == "Beta.md")
            .expect("b");
        let pages: HashMap<usize, String> =
            [(alpha, "alpha".to_owned()), (beta, "beta".to_owned())].into();
        let out = render(
            &model,
            "Welcome.md",
            LinkTarget::Site {
                pages: &pages,
                copy_attachments: true,
            },
        );
        assert!(
            out.html
                .contains("<a class=\"internal\" href=\"alpha.html\">the alpha</a>"),
            "{}",
            out.html
        );
        assert!(out.html.contains("href=\"beta.html#setup\""));
        assert!(out
            .html
            .contains("<a class=\"tag\" href=\"../tags/inbox.html\">#inbox</a>"));
        assert!(out.html.contains("src=\"../files/assets/diagram.png\""));
        assert!(
            !out.html.contains(dir.path().to_string_lossy().as_ref()),
            "no absolute paths"
        );

        // Unpublished notes are missing on a site.
        let only_beta: HashMap<usize, String> = [(beta, "beta".to_owned())].into();
        let out = render(
            &model,
            "Welcome.md",
            LinkTarget::Site {
                pages: &only_beta,
                copy_attachments: false,
            },
        );
        assert!(out.html.contains(
            "<span class=\"missing\" title=\"Not exported: Projects/Alpha\">the alpha</span>"
        ));
        assert!(
            out.html.contains("class=\"missing embed\""),
            "attachments off → placeholder"
        );
    }

    #[test]
    fn headings_get_unique_ids_and_same_note_links() {
        let (_d, model) = model_with(&[(
            "Doc.md",
            "Intro [[#Part One]]\n\n## Part One\n\n## Part One\n\n### Über `code`\n",
        )]);
        let out = render(
            &model,
            "Doc.md",
            LinkTarget::Standalone {
                embed_images: false,
            },
        );
        assert!(
            out.html.contains("<h2 id=\"part-one\">Part One</h2>"),
            "{}",
            out.html
        );
        assert!(out.html.contains("<h2 id=\"part-one-1\">Part One</h2>"));
        assert!(out.html.contains("<h3 id=\"über-code\">"));
        assert!(out
            .html
            .contains("<a class=\"internal\" href=\"#part-one\">Part One</a>"));
    }

    #[test]
    fn markdown_links_and_images_are_rewritten_safely() {
        let (dir, _) = model_with(&[
            (
                "notes/A.md",
                "[b](B.md) [ext](https://example.com) [bad](javascript:alert(1)) [img](../pics/p.png)\n\n![alt](../pics/p.png) ![remote](https://x.io/i.png) ![evil](javascript:x)\n",
            ),
            ("notes/B.md", "# B"),
        ]);
        write_bytes(dir.path(), "pics/p.png", &[1, 2, 3]);
        let model = VaultModel::load(dir.path()).expect("reload");
        let b = model
            .notes
            .iter()
            .position(|n| n.rel == "notes/B.md")
            .expect("b");
        let pages: HashMap<usize, String> = [(b, "b".to_owned())].into();
        let site = render(
            &model,
            "notes/A.md",
            LinkTarget::Site {
                pages: &pages,
                copy_attachments: true,
            },
        );
        assert!(
            site.html.contains("<a href=\"b.html\">b</a>"),
            "{}",
            site.html
        );
        assert!(site.html.contains("href=\"https://example.com\""));
        assert!(site.html.contains("<a href=\"#\">bad</a>"));
        assert!(site.html.contains("src=\"../files/pics/p.png\""));
        assert!(site.html.contains("src=\"https://x.io/i.png\""));
        assert!(!site.html.contains("javascript:"));

        let standalone = render(
            &model,
            "notes/A.md",
            LinkTarget::Standalone {
                embed_images: false,
            },
        );
        assert!(
            standalone
                .html
                .contains("<span class=\"wikilink\">b</span>"),
            "{}",
            standalone.html
        );
        assert!(standalone.html.contains("src=\"../pics/p.png\""));
    }

    #[test]
    fn image_sizes_and_alt_text() {
        assert_eq!(
            image_size(Some("300"), "a.png"),
            (" width=\"300\"".into(), "a.png".into())
        );
        assert_eq!(
            image_size(Some("300x200"), "a.png"),
            (" width=\"300\" height=\"200\"".into(), "a.png".into())
        );
        assert_eq!(
            image_size(Some("A cat"), "a.png"),
            (String::new(), "A cat".into())
        );
        assert_eq!(image_size(None, "a.png"), (String::new(), "a.png".into()));
    }

    #[test]
    fn syntect_highlighting_produces_spans() {
        let html = highlight_code("fn main() {\n    let x = 1;\n}\n", Some("rust"));
        assert!(html.contains("<span class=\"hl-"), "{html}");
        assert!(
            html.contains("hl-keyword") || html.contains("hl-storage"),
            "{html}"
        );
        let ts = highlight_code("const a: number = 1", Some("ts"));
        assert!(
            ts.contains("<span class=\"hl-"),
            "typescript maps to js: {ts}"
        );
        assert_eq!(highlight_code("<b>", Some("nonexistent-lang")), "&lt;b&gt;");
        assert_eq!(highlight_code("<b>", None), "&lt;b&gt;");
        let css = highlight_css();
        assert!(css.contains(".aether-doc .hl-"));
        assert!(css.contains(".aether-doc[data-theme=\"dark\"] .hl-"));
        assert!(!css.contains("background"));
    }

    #[test]
    fn sanitizer_keeps_safe_html_and_escapes_the_rest() {
        assert_eq!(sanitize_html("<kbd>⌘K</kbd>"), "<kbd>⌘K</kbd>");
        assert_eq!(
            sanitize_html("<script>alert(1)</script>"),
            "&lt;script&gt;alert(1)&lt;/script&gt;"
        );
        assert_eq!(
            sanitize_html("<img src=\"x.png\" onerror=\"alert(1)\">"),
            "<img src=\"x.png\">"
        );
        assert_eq!(
            sanitize_html("<a href=\"javascript:alert(1)\">x</a>"),
            "<a>x</a>"
        );
        assert_eq!(
            sanitize_html("<a href=\"&#106;avascript:x\">x</a>"),
            "<a>x</a>"
        );
        assert_eq!(
            sanitize_html("<a href='https://e.com' target=_blank>x</a>"),
            "<a href=\"https://e.com\" rel=\"noopener noreferrer\">x</a>"
        );
        assert_eq!(
            sanitize_html("<span style=\"color:red\">r</span>"),
            "<span style=\"color:red\">r</span>"
        );
        assert_eq!(
            sanitize_html("<span style=\"background:url(x)\">r</span>"),
            "<span>r</span>"
        );
        assert_eq!(sanitize_html("<br/>"), "<br />");
        assert_eq!(sanitize_html("<!-- c -->"), "<!-- c -->");
        assert_eq!(sanitize_html("a < b"), "a &lt; b");
        assert_eq!(
            sanitize_html("<iframe src=x></iframe>"),
            "&lt;iframe src=x&gt;&lt;/iframe&gt;"
        );
        assert_eq!(
            sanitize_html("<details open><summary>S</summary></details>"),
            "<details open><summary>S</summary></details>"
        );
    }

    #[test]
    fn only_web_mail_and_relative_links_survive() {
        for (input, expected) in [
            (r#"<a href="obsidian://open?vault=x">o</a>"#, "<a>o</a>"),
            (r#"<a href="data:text/html,x">d</a>"#, "<a>d</a>"),
            (r#"<a href="data:image/svg+xml,x">d</a>"#, "<a>d</a>"),
            (
                r#"<a href="notes/b.html">rel</a>"#,
                r#"<a href="notes/b.html">rel</a>"#,
            ),
            (
                r#"<a href="mailto:me@example.com">m</a>"#,
                r#"<a href="mailto:me@example.com">m</a>"#,
            ),
            (
                r#"<img src="data:image/png;base64,AAAA">"#,
                r#"<img src="data:image/png;base64,AAAA">"#,
            ),
        ] {
            assert_eq!(sanitize_html(input), expected, "{input}");
        }
    }

    #[test]
    fn note_derived_text_is_escaped_in_titles_alt_text_and_tags() {
        let (_d, model) = model_with(&[(
            "X.md",
            "---\ntags: [\"a\\\"><script>\"]\n---\n# T\"><img src=x onerror=1>\n\n![al\"t<b>](pic.png) [[Y|y\"><i>]] [o](obsidian://open?x=1) #t<s>\n",
        )]);
        let idx = model.note_for_path("X.md").expect("note");
        let html = standalone_document(&model, idx, &ExportOptions::default())
            .expect("render")
            .html;
        assert!(!html.contains("<script>"), "{html}");
        assert!(!html.contains("<img src=x"), "{html}");
        assert!(!html.contains("onerror=1>"), "{html}");
        assert!(!html.contains("obsidian://"), "{html}");
        assert!(html.contains(r#"alt="al&quot;t&lt;b&gt;""#), "{html}");
        assert!(html.contains("&quot;&gt;&lt;script&gt;</span>"), "{html}");
    }

    #[test]
    fn raw_html_in_notes_is_sanitized() {
        let (_d, model) = model_with(&[("X.md", "Hi <script>steal()</script> <b onclick=\"x()\">bold</b>\n\n<div onmouseover=\"x\">block</div>\n")]);
        let out = render(
            &model,
            "X.md",
            LinkTarget::Standalone {
                embed_images: false,
            },
        );
        assert!(!out.html.contains("<script"), "{}", out.html);
        assert!(!out.html.contains("onclick"));
        assert!(!out.html.contains("onmouseover"));
        assert!(out.html.contains("<b>bold</b>"));
    }

    #[test]
    fn prepare_note_picks_title_and_strips_duplicate_h1() {
        let entry = NoteEntry {
            abs: "/v/n.md".into(),
            rel: "n.md".into(),
            name: "file-name".into(),
            mtime: 0,
        };
        let p = prepare_note(&entry, "# Heading Title\n\nBody");
        assert_eq!(p.title, "Heading Title");
        assert_eq!(p.body.trim(), "Body");
        let p = prepare_note(&entry, "---\ntitle: FM\n---\n# Other\nBody");
        assert_eq!(p.title, "FM");
        assert!(p.body.contains("# Other"));
        let p = prepare_note(&entry, "---\ntitle: Same\n---\n# same\nBody");
        assert_eq!(p.body.trim(), "Body");
        let p = prepare_note(&entry, "No heading");
        assert_eq!(p.title, "file-name");
        let p = prepare_note(&entry, "# With [[link]]\nBody");
        assert_eq!(p.title, "file-name");
        assert!(p.body.contains("[[link]]"));
    }

    #[test]
    fn header_and_template_filling() {
        let fm = Frontmatter {
            date: Some("2026-09-01".into()),
            tags: vec!["a/b".into()],
            description: Some("Desc".into()),
            ..Default::default()
        };
        let header = render_header(
            "T <x>",
            &fm,
            &ExportOptions::default(),
            &|t| Some(format!("tags/{}.html", tag_slug(t))),
            None,
        );
        assert!(header.contains("<h1 class=\"doc-title\">T &lt;x&gt;</h1>"));
        assert!(header.contains("<time datetime=\"2026-09-01\">2026-09-01</time>"));
        assert!(header.contains("href=\"tags/a-b.html\">#a/b</a>"));
        assert!(header.contains("Desc"));
        let quiet = render_header(
            "T",
            &fm,
            &ExportOptions {
                include_frontmatter: false,
                ..Default::default()
            },
            &|_| None,
            None,
        );
        assert!(!quiet.contains("doc-meta"));

        let filled = fill_template(
            "<p>{{ a }}{{b}}{{unknown}}</p>",
            &[("a", "{{b}}"), ("b", "B")],
        );
        assert_eq!(filled, "<p>{{b}}B{{unknown}}</p>");
    }

    #[test]
    fn standalone_document_is_complete() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        let model = VaultModel::load(dir.path()).expect("model");
        let idx = model
            .notes
            .iter()
            .position(|n| n.rel == "Welcome.md")
            .expect("w");
        let doc = standalone_document(&model, idx, &ExportOptions::default()).expect("doc");
        assert!(doc.html.starts_with("<!doctype html>"));
        assert!(doc.html.contains("<title>Welcome Home</title>"));
        assert!(doc.html.contains("data-theme=\"auto\""));
        assert!(doc.html.contains(".aether-doc"), "css inlined");
        assert!(doc.html.contains("Linked from"), "backlinks section");
        assert!(!doc.html.contains(MERMAID_CDN), "no CDN by default");
        assert!(!doc.html.contains("{{"), "all placeholders filled");
        let with_script = standalone_document(
            &model,
            idx,
            &ExportOptions {
                include_mermaid_script: true,
                theme: ExportTheme::Dark,
                ..Default::default()
            },
        )
        .expect("doc");
        assert!(with_script.html.contains(MERMAID_CDN));
        assert!(with_script.html.contains("data-theme=\"dark\""));
        assert_eq!(doc.attachments, 1);
        assert_eq!(doc.missing, vec!["Ghost"]);
    }

    #[test]
    fn url_schemes() {
        assert_eq!(url_scheme("https://a"), Some("https".into()));
        assert_eq!(url_scheme("java\tscript:x"), Some("javascript".into()));
        assert_eq!(url_scheme("notes/a:b.md"), None);
        assert_eq!(url_scheme("#x"), None);
        assert_eq!(url_scheme("a.md"), None);
    }
}
