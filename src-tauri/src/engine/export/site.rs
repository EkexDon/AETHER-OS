//! Static website export — a self-hosted "Obsidian Publish".
//!
//! Layout of the output folder (all links are relative, so the site works
//! from `file://`, a sub-path or any static host):
//!
//! ```text
//! index.html              title, description, recent notes, notes by folder
//! notes/<slug>.html       one page per note (+ "Linked from" backlinks)
//! tags/index.html         every tag
//! tags/<slug>.html        notes per tag
//! files/<vault path>      copied attachments
//! assets/style.css        theme (light, dark via prefers-color-scheme)
//! assets/search.js        client-side search (vanilla JS, no CDN)
//! search-index.js         the search index for search.js (works on file://)
//! search-index.json       the same index as JSON (for other tools)
//! sitemap.xml             when a public URL is set
//! CNAME, .nojekyll        GitHub Pages helpers
//! .aether-site.json       marker + file list (enables safe re-export)
//! ```
//!
//! Notes whose frontmatter says `publish: false` are skipped. Re-exporting
//! into the same folder replaces the previous export and removes pages
//! that no longer exist; a non-empty folder that is not an AETHER-OS
//! export is refused.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::html::{
    self, fill_template, prepare_note, render_backlinks, render_header, render_markdown, tag_slug,
    LinkTarget, RenderEnv,
};
use super::{
    encode_path, escape_html, normalize_rel, normalize_tag, slugify, unique_slug, ExportOptions,
    ExportProgress, ExportScope, Frontmatter, MissingLink, ProgressThrottle, SiteReport,
    VaultModel,
};
use crate::engine::error::AetherError;

const PAGE_TEMPLATE: &str = include_str!("templates/page.html");
const SEARCH_JS: &str = include_str!("templates/search.js");
/// Marker file identifying a folder as an AETHER-OS site export.
pub const MARKER_FILE: &str = ".aether-site.json";
/// Missing links listed in the report (the count is always exact).
const MAX_REPORTED_MISSING: usize = 200;
/// Recently updated notes shown on the index page.
const RECENT_ON_INDEX: usize = 6;

/// Contents of `.aether-site.json`.
#[derive(Debug, Serialize, Deserialize)]
struct SiteMarker {
    generator: String,
    created_at: String,
    files: Vec<String>,
}

/// One published note during generation.
struct Page {
    idx: usize,
    slug: String,
    title: String,
    folder: String,
    frontmatter: Frontmatter,
    tags: Vec<String>,
    html: String,
    links: Vec<usize>,
    text: String,
    has_mermaid: bool,
}

/// Collects written files for the marker and the byte count.
struct SiteWriter {
    out: PathBuf,
    files: Vec<String>,
    bytes: u64,
}

impl SiteWriter {
    fn write(&mut self, rel: &str, content: &[u8]) -> Result<(), AetherError> {
        let rel = normalize_rel(rel)
            .filter(|r| !r.is_empty())
            .ok_or_else(|| AetherError::InvalidInput(format!("invalid output path: {rel}")))?;
        let path = self.out.join(&rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
        self.bytes += content.len() as u64;
        self.files.push(rel);
        Ok(())
    }

    fn copy(&mut self, rel: &str, from: &Path) -> Result<(), AetherError> {
        let rel = normalize_rel(rel)
            .filter(|r| !r.is_empty())
            .ok_or_else(|| AetherError::InvalidInput(format!("invalid output path: {rel}")))?;
        let path = self.out.join(&rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        self.bytes += std::fs::copy(from, &path)?;
        self.files.push(rel);
        Ok(())
    }
}

/// Validate the destination folder: it must be empty, missing (its parent
/// must exist) or a previous AETHER-OS export. Returns the files of the
/// previous export (for stale cleanup).
fn prepare_out_dir(out: &Path) -> Result<Vec<String>, AetherError> {
    if !out.exists() {
        std::fs::create_dir(out)?;
        return Ok(Vec::new());
    }
    if !out.is_dir() {
        return Err(AetherError::InvalidInput(format!(
            "the destination is a file, not a folder: {}",
            out.display()
        )));
    }
    let marker = out.join(MARKER_FILE);
    if marker.is_file() {
        let previous = std::fs::read_to_string(&marker)
            .ok()
            .and_then(|s| serde_json::from_str::<SiteMarker>(&s).ok())
            .map(|m| m.files)
            .unwrap_or_default();
        return Ok(previous);
    }
    let non_empty = std::fs::read_dir(out)?
        .filter_map(|e| e.ok())
        .any(|e| e.file_name() != ".DS_Store");
    if non_empty {
        return Err(AetherError::InvalidInput(format!(
            "the destination folder is not empty: {}. Choose an empty folder or a previous AETHER-OS site export",
            out.display()
        )));
    }
    Ok(Vec::new())
}

/// Remove files of a previous export that were not written this time.
fn remove_stale(out: &Path, previous: &[String], current: &HashSet<String>) -> usize {
    let mut removed = 0;
    let mut dirs = BTreeSet::new();
    for rel in previous {
        let Some(clean) = normalize_rel(rel).filter(|r| !r.is_empty() && r == rel) else {
            continue;
        };
        if current.contains(&clean) || clean == MARKER_FILE {
            continue;
        }
        let path = out.join(&clean);
        if path.is_file() && std::fs::remove_file(&path).is_ok() {
            removed += 1;
            let mut parent = path.parent().map(Path::to_path_buf);
            while let Some(dir) = parent {
                if dir == out || !dir.starts_with(out) {
                    break;
                }
                dirs.insert(dir.clone());
                parent = dir.parent().map(Path::to_path_buf);
            }
        }
    }
    // Deepest first; `remove_dir` only succeeds on empty folders.
    for dir in dirs.iter().rev() {
        let _ = std::fs::remove_dir(dir);
    }
    removed
}

fn format_date(secs: u64) -> String {
    chrono::DateTime::from_timestamp(secs as i64, 0)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `true` for a plausible host name (`notes.example.com`).
fn valid_cname(domain: &str) -> bool {
    let d = domain.trim();
    !d.is_empty()
        && d.len() <= 253
        && d.contains('.')
        && d.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

struct PageShell<'a> {
    options: &'a ExportOptions,
    site_title: &'a str,
    footer: &'a str,
    lang: &'a str,
}

impl PageShell<'_> {
    fn render(
        &self,
        root: &str,
        page_title: &str,
        description: &str,
        content: &str,
        scripts: &str,
    ) -> String {
        fill_template(
            PAGE_TEMPLATE,
            &[
                ("lang", self.lang),
                ("page_title", &escape_html(page_title)),
                ("description", &escape_html(description)),
                ("root", root),
                ("theme", self.options.theme.as_str()),
                ("site_title", &escape_html(self.site_title)),
                ("content", content),
                ("footer", &escape_html(self.footer)),
                ("scripts", scripts),
            ],
        )
    }
}

fn note_list_item(page: &Page, prefix: &str, meta: &str) -> String {
    format!(
        "<li><a href=\"{prefix}notes/{}.html\">{}</a><span class=\"note-meta\">{}</span></li>\n",
        encode_path(&page.slug),
        escape_html(&page.title),
        escape_html(meta)
    )
}

/// Generate a static site for `scope` into `out_dir` (already validated
/// with [`super::check_output_path`]).
pub fn export_site(
    model: &VaultModel,
    scope: &ExportScope,
    out_dir: &Path,
    options: &ExportOptions,
    progress: &(dyn Fn(ExportProgress) + Sync),
) -> Result<SiteReport, AetherError> {
    let started = Instant::now();
    let scope_notes = model.resolve_scope(scope)?;
    let mut throttle = ProgressThrottle::new(progress);
    let mut warnings = Vec::new();

    // 1. Read notes, drop `publish: false`, assign slugs.
    let mut sources = Vec::new();
    let mut skipped = 0;
    for &idx in &scope_notes {
        let content = model.read(idx)?;
        let prepared = prepare_note(&model.notes[idx], &content);
        if prepared.frontmatter.publish == Some(false) {
            skipped += 1;
            continue;
        }
        let title = prepared.title.clone();
        let frontmatter = prepared.frontmatter.clone();
        let body = prepared.body.to_owned();
        sources.push((idx, title, frontmatter, body));
    }
    if sources.is_empty() {
        return Err(AetherError::InvalidInput(
            "nothing to publish: every note in the scope has `publish: false`".into(),
        ));
    }
    let previous_files = prepare_out_dir(out_dir)?;
    let mut used = HashSet::new();
    let slugs: HashMap<usize, String> = sources
        .iter()
        .map(|(idx, _, _, _)| {
            (
                *idx,
                unique_slug(&slugify(&model.notes[*idx].name), &mut used),
            )
        })
        .collect();

    // 2. Render every page. Progress runs over render + write + copy steps;
    // the attachment count is only known after rendering.
    let render_total = sources.len() * 2 + 1;
    let mut pages = Vec::with_capacity(sources.len());
    let mut attachments = BTreeSet::new();
    let mut missing = Vec::new();
    let mut missing_count = 0;
    for (n, (idx, title, frontmatter, body)) in sources.into_iter().enumerate() {
        throttle.report(n, render_total, &title, "rendering");
        let env = RenderEnv {
            model,
            note: idx,
            target: LinkTarget::Site {
                pages: &slugs,
                copy_attachments: options.include_attachments,
            },
        };
        let rendered = render_markdown(&env, &body);
        missing_count += rendered.missing.len();
        for target in &rendered.missing {
            if missing.len() < MAX_REPORTED_MISSING {
                missing.push(MissingLink {
                    note: title.clone(),
                    target: target.clone(),
                });
            }
        }
        warnings.extend(rendered.warnings.iter().cloned());
        attachments.extend(rendered.attachments.iter().copied());
        let mut tags = frontmatter.tags.clone();
        for t in &rendered.tags {
            if !tags.iter().any(|x| normalize_tag(x) == normalize_tag(t)) {
                tags.push(t.clone());
            }
        }
        pages.push(Page {
            idx,
            slug: slugs[&idx].clone(),
            title,
            folder: model.notes[idx].folder().to_owned(),
            frontmatter,
            tags,
            html: rendered.html,
            links: rendered.links,
            text: rendered.text,
            has_mermaid: rendered.has_mermaid,
        });
    }

    // 3. Backlinks and tags.
    let links: HashMap<usize, Vec<usize>> =
        pages.iter().map(|p| (p.idx, p.links.clone())).collect();
    let backlinks = compute_backlinks(&links);
    let by_idx: HashMap<usize, usize> = pages.iter().enumerate().map(|(i, p)| (p.idx, i)).collect();
    let mut tag_pages: BTreeMap<String, (String, Vec<usize>)> = BTreeMap::new();
    for (i, page) in pages.iter().enumerate() {
        for tag in &page.tags {
            let entry = tag_pages
                .entry(tag_slug(tag))
                .or_insert_with(|| (tag.trim_start_matches('#').to_owned(), Vec::new()));
            if !entry.1.contains(&i) {
                entry.1.push(i);
            }
        }
    }

    // 4. Write everything.
    let site_title = if options.site_title.trim().is_empty() {
        model.vault_name()
    } else {
        options.site_title.trim().to_owned()
    };
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let footer = format!("Published with AETHER-OS · {today}");
    let shell = PageShell {
        options,
        site_title: &site_title,
        footer: &footer,
        lang: "en",
    };
    let mut writer = SiteWriter {
        out: out_dir.to_path_buf(),
        files: Vec::new(),
        bytes: 0,
    };
    let total = pages.len() * 2 + attachments.len() + 1;
    let mermaid = if options.include_mermaid_script {
        html::mermaid_script()
    } else {
        String::new()
    };

    for (n, page) in pages.iter().enumerate() {
        throttle.report(pages.len() + n, total, &page.title, "pages");
        let tag_href = |t: &str| Some(format!("../tags/{}.html", encode_path(&tag_slug(t))));
        let crumb = breadcrumb(&page.folder);
        let mut article = String::from("<article class=\"doc\">\n");
        article.push_str(&render_header(
            &page.title,
            &page.frontmatter,
            options,
            &tag_href,
            Some(&crumb),
        ));
        article.push_str("<div class=\"doc-content\">\n");
        article.push_str(&page.html);
        article.push_str("</div>\n");
        if options.include_backlinks {
            let items: Vec<(String, Option<String>)> = backlinks
                .get(&page.idx)
                .map(|sources| {
                    let mut items: Vec<(String, Option<String>)> = sources
                        .iter()
                        .filter_map(|src| by_idx.get(src).map(|&i| &pages[i]))
                        .map(|p| {
                            (
                                p.title.clone(),
                                Some(format!("{}.html", encode_path(&p.slug))),
                            )
                        })
                        .collect();
                    items.sort_by_cached_key(|(t, _)| t.to_lowercase());
                    items
                })
                .unwrap_or_default();
            article.push_str(&render_backlinks(&items));
        }
        article.push_str("</article>\n");
        let description = page
            .frontmatter
            .description
            .clone()
            .unwrap_or_else(|| page.text.chars().take(160).collect());
        let scripts = if page.has_mermaid {
            mermaid.as_str()
        } else {
            ""
        };
        let html = shell.render(
            "../",
            &format!("{} · {site_title}", page.title),
            &description,
            &article,
            scripts,
        );
        writer.write(&format!("notes/{}.html", page.slug), html.as_bytes())?;
    }

    // Index page.
    writer.write(
        "index.html",
        shell
            .render(
                "",
                &site_title,
                &options.site_description,
                &render_index(model, &pages, &tag_pages, &site_title, options, &today),
                "",
            )
            .as_bytes(),
    )?;

    // Tag pages.
    writer.write(
        "tags/index.html",
        shell
            .render(
                "../",
                &format!("Tags · {site_title}"),
                "",
                &render_tag_index(&tag_pages),
                "",
            )
            .as_bytes(),
    )?;
    for (slug, (name, members)) in &tag_pages {
        let mut content = format!(
            "<article class=\"doc\">\n<header class=\"doc-header\">\n{}<h1 class=\"doc-title\">#{}</h1>\n<div class=\"doc-meta\">{} note{}</div>\n</header>\n<ul class=\"note-list\">\n",
            "<nav class=\"doc-breadcrumb\" aria-label=\"Breadcrumb\"><a href=\"../index.html\">Home</a><span aria-hidden=\"true\">/</span><a href=\"index.html\">Tags</a></nav>\n",
            escape_html(name),
            members.len(),
            if members.len() == 1 { "" } else { "s" }
        );
        let mut sorted: Vec<&Page> = members.iter().map(|&i| &pages[i]).collect();
        sorted.sort_by_cached_key(|p| p.title.to_lowercase());
        for page in sorted {
            content.push_str(&note_list_item(page, "../", &page.folder));
        }
        content.push_str("</ul>\n</article>\n");
        writer.write(
            &format!("tags/{slug}.html"),
            shell
                .render("../", &format!("#{name} · {site_title}"), "", &content, "")
                .as_bytes(),
        )?;
    }

    // Search index (JS for file://, JSON for everything else).
    let index: Vec<serde_json::Value> = pages
        .iter()
        .map(|p| {
            serde_json::json!({
                "t": p.title,
                "u": format!("notes/{}.html", encode_path(&p.slug)),
                "f": p.folder,
                "g": p.tags,
                "x": p.text,
            })
        })
        .collect();
    let index_json = serde_json::to_string(&index)
        .map_err(|e| AetherError::InvalidInput(format!("search index: {e}")))?;
    writer.write("search-index.json", index_json.as_bytes())?;
    writer.write(
        "search-index.js",
        format!("window.AETHER_SEARCH_INDEX = {index_json};\n").as_bytes(),
    )?;
    writer.write("assets/style.css", html::document_css().as_bytes())?;
    writer.write("assets/search.js", SEARCH_JS.as_bytes())?;
    writer.write(".nojekyll", b"")?;

    // Attachments.
    let mut copied = 0;
    for (n, att) in attachments.iter().enumerate() {
        let entry = &model.attachments[*att];
        throttle.report(pages.len() * 2 + n, total, entry.file_name(), "attachments");
        match writer.copy(&format!("files/{}", entry.rel), &entry.abs) {
            Ok(()) => copied += 1,
            Err(e) => warnings.push(format!("could not copy {}: {e}", entry.rel)),
        }
    }

    // Sitemap and CNAME.
    let base = options.base_path.trim().trim_end_matches('/');
    if base.is_empty() {
        warnings.push("No public URL set — sitemap.xml was not generated.".to_owned());
    } else {
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
        );
        let mut push = |loc: &str, lastmod: Option<String>| {
            xml.push_str("  <url><loc>");
            xml.push_str(&xml_escape(&format!("{base}/{loc}")));
            xml.push_str("</loc>");
            if let Some(date) = lastmod.filter(|d| !d.is_empty()) {
                xml.push_str(&format!("<lastmod>{date}</lastmod>"));
            }
            xml.push_str("</url>\n");
        };
        push("index.html", Some(today.clone()));
        for page in &pages {
            push(
                &format!("notes/{}.html", encode_path(&page.slug)),
                Some(format_date(model.notes[page.idx].mtime)),
            );
        }
        push("tags/index.html", None);
        for slug in tag_pages.keys() {
            push(&format!("tags/{}.html", encode_path(slug)), None);
        }
        xml.push_str("</urlset>\n");
        writer.write("sitemap.xml", xml.as_bytes())?;
    }
    let cname = options.cname.trim();
    if !cname.is_empty() {
        if valid_cname(cname) {
            writer.write("CNAME", format!("{cname}\n").as_bytes())?;
        } else {
            warnings.push(format!(
                "\"{cname}\" is not a valid domain — CNAME was not written."
            ));
        }
    }

    throttle.report(total - 1, total, "Finishing", "finishing");
    let current: HashSet<String> = writer.files.iter().cloned().collect();
    let removed_stale = remove_stale(out_dir, &previous_files, &current);
    let marker = SiteMarker {
        generator: "AETHER-OS".to_owned(),
        created_at: chrono::Local::now().to_rfc3339(),
        files: writer.files.clone(),
    };
    let marker_json = serde_json::to_string_pretty(&marker)
        .map_err(|e| AetherError::InvalidInput(format!("site marker: {e}")))?;
    std::fs::write(out_dir.join(MARKER_FILE), marker_json)?;
    throttle.report(total, total, "Done", "finishing");

    warnings.sort();
    warnings.dedup();
    Ok(SiteReport {
        out_dir: out_dir.to_string_lossy().to_string(),
        index_path: out_dir.join("index.html").to_string_lossy().to_string(),
        pages: pages.len(),
        tag_pages: tag_pages.len(),
        attachments: copied,
        skipped,
        missing_links: missing,
        missing_link_count: missing_count,
        removed_stale,
        bytes: writer.bytes,
        warnings,
        ms: started.elapsed().as_millis() as u64,
    })
}

/// Breadcrumb for a page in `notes/`.
fn breadcrumb(folder: &str) -> String {
    let mut html = String::from(
        "<nav class=\"doc-breadcrumb\" aria-label=\"Breadcrumb\"><a href=\"../index.html\">Home</a>",
    );
    for part in folder.split('/').filter(|p| !p.is_empty()) {
        html.push_str("<span aria-hidden=\"true\">/</span><span>");
        html.push_str(&escape_html(part));
        html.push_str("</span>");
    }
    html.push_str("</nav>\n");
    html
}

fn render_index(
    model: &VaultModel,
    pages: &[Page],
    tag_pages: &BTreeMap<String, (String, Vec<usize>)>,
    site_title: &str,
    options: &ExportOptions,
    today: &str,
) -> String {
    let mut html = String::from("<section class=\"site-hero\">\n");
    html.push_str(&format!(
        "<h1 class=\"site-hero-title\">{}</h1>\n",
        escape_html(site_title)
    ));
    if !options.site_description.trim().is_empty() {
        html.push_str(&format!(
            "<p class=\"site-hero-description\">{}</p>\n",
            escape_html(options.site_description.trim())
        ));
    }
    html.push_str(&format!(
        "<p class=\"site-hero-meta\">{} note{} · {} tag{} · Updated {}</p>\n</section>\n",
        pages.len(),
        if pages.len() == 1 { "" } else { "s" },
        tag_pages.len(),
        if tag_pages.len() == 1 { "" } else { "s" },
        escape_html(today)
    ));

    if pages.len() > RECENT_ON_INDEX {
        let mut recent: Vec<&Page> = pages.iter().collect();
        recent.sort_by_key(|p| std::cmp::Reverse(model.notes[p.idx].mtime));
        html.push_str("<section class=\"site-section\">\n<h2 class=\"site-section-title\">Recently updated</h2>\n<ul class=\"note-list\">\n");
        for page in recent.into_iter().take(RECENT_ON_INDEX) {
            html.push_str(&note_list_item(
                page,
                "",
                &format_date(model.notes[page.idx].mtime),
            ));
        }
        html.push_str("</ul>\n</section>\n");
    }

    let mut folders: BTreeMap<String, Vec<&Page>> = BTreeMap::new();
    for page in pages {
        folders.entry(page.folder.clone()).or_default().push(page);
    }
    html.push_str(
        "<section class=\"site-section\">\n<h2 class=\"site-section-title\">All notes</h2>\n",
    );
    for (folder, mut members) in folders {
        members.sort_by_cached_key(|p| p.title.to_lowercase());
        let label = if folder.is_empty() {
            "Top level".to_owned()
        } else {
            folder
        };
        html.push_str(&format!(
            "<details class=\"folder-group\" open>\n<summary>{} <span class=\"count\">{}</span></summary>\n<ul class=\"note-list\">\n",
            escape_html(&label),
            members.len()
        ));
        for page in members {
            let meta = page
                .frontmatter
                .date
                .clone()
                .unwrap_or_else(|| format_date(model.notes[page.idx].mtime));
            html.push_str(&note_list_item(page, "", &meta));
        }
        html.push_str("</ul>\n</details>\n");
    }
    html.push_str("</section>\n");
    if !tag_pages.is_empty() {
        html.push_str(
            "<section class=\"site-section\">\n<h2 class=\"site-section-title\">Tags</h2>\n",
        );
        html.push_str(&tag_cloud(tag_pages, "tags/"));
        html.push_str("</section>\n");
    }
    html
}

fn tag_cloud(tag_pages: &BTreeMap<String, (String, Vec<usize>)>, prefix: &str) -> String {
    let mut tags: Vec<(&String, &(String, Vec<usize>))> = tag_pages.iter().collect();
    tags.sort_by(|a, b| {
        b.1 .1
            .len()
            .cmp(&a.1 .1.len())
            .then_with(|| a.1 .0.to_lowercase().cmp(&b.1 .0.to_lowercase()))
    });
    let mut html = String::from("<ul class=\"tag-cloud\">\n");
    for (slug, (name, members)) in tags {
        html.push_str(&format!(
            "<li><a class=\"tag\" href=\"{prefix}{}.html\">#{}</a><span class=\"count\">{}</span></li>\n",
            encode_path(slug),
            escape_html(name),
            members.len()
        ));
    }
    html.push_str("</ul>\n");
    html
}

fn render_tag_index(tag_pages: &BTreeMap<String, (String, Vec<usize>)>) -> String {
    let mut html = String::from(
        "<article class=\"doc\">\n<header class=\"doc-header\">\n<nav class=\"doc-breadcrumb\" aria-label=\"Breadcrumb\"><a href=\"../index.html\">Home</a></nav>\n<h1 class=\"doc-title\">Tags</h1>\n</header>\n",
    );
    if tag_pages.is_empty() {
        html.push_str("<p>No tags yet.</p>\n");
    } else {
        html.push_str(&tag_cloud(tag_pages, ""));
    }
    html.push_str("</article>\n");
    html
}

/// Reverse a "links to" map into "linked from", without self links and
/// duplicates. Sources are sorted by index for stable output.
pub fn compute_backlinks(links: &HashMap<usize, Vec<usize>>) -> HashMap<usize, Vec<usize>> {
    let mut back: HashMap<usize, BTreeSet<usize>> = HashMap::new();
    for (&source, targets) in links {
        for &target in targets {
            if target != source && links.contains_key(&target) {
                back.entry(target).or_default().insert(source);
            }
        }
    }
    back.into_iter()
        .map(|(k, v)| (k, v.into_iter().collect()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::export::test_support::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn no_progress() -> impl Fn(ExportProgress) + Sync {
        |_| {}
    }

    #[test]
    fn backlinks_are_reversed_without_self_links() {
        let links: HashMap<usize, Vec<usize>> =
            [(0, vec![1, 2, 0]), (1, vec![0]), (2, vec![1, 1, 9])].into();
        let back = compute_backlinks(&links);
        assert_eq!(back[&0], vec![1]);
        assert_eq!(back[&1], vec![0, 2]);
        assert_eq!(back[&2], vec![0]);
        assert!(
            !back.contains_key(&9),
            "targets outside the site are ignored"
        );
    }

    #[test]
    fn generates_a_complete_relative_site() {
        let vault = tempdir().expect("vault");
        sample_vault(vault.path());
        let out_root = tempdir().expect("out");
        let out = out_root.path().join("site");
        let model = VaultModel::load(vault.path()).expect("model");
        let seen = Mutex::new(Vec::new());
        let progress = |p: ExportProgress| seen.lock().expect("lock").push(p);
        let options = ExportOptions {
            site_title: "My Garden".into(),
            base_path: "https://notes.example.com/".into(),
            cname: "notes.example.com".into(),
            ..Default::default()
        };
        let report =
            export_site(&model, &ExportScope::Vault, &out, &options, &progress).expect("site");

        assert_eq!(report.pages, 3, "publish: false note skipped");
        assert_eq!(report.skipped, 1);
        assert_eq!(report.attachments, 1);
        assert_eq!(report.missing_link_count, 1);
        assert_eq!(report.missing_links[0].target, "Ghost");
        for rel in [
            "index.html",
            "notes/welcome.html",
            "notes/alpha.html",
            "notes/beta.html",
            "tags/index.html",
            "tags/project-alpha.html",
            "tags/inbox.html",
            "tags/start.html",
            "files/assets/diagram.png",
            "assets/style.css",
            "assets/search.js",
            "search-index.js",
            "search-index.json",
            "sitemap.xml",
            "CNAME",
            ".nojekyll",
            MARKER_FILE,
        ] {
            assert!(out.join(rel).exists(), "{rel} missing");
        }
        assert!(!out.join("notes/ueber-groesse.html").exists());

        let welcome = std::fs::read_to_string(out.join("notes/welcome.html")).expect("page");
        assert!(welcome.contains("href=\"alpha.html\""));
        assert!(welcome.contains("href=\"beta.html#setup\""));
        assert!(welcome.contains("href=\"../assets/style.css\""));
        assert!(welcome.contains("<title>Welcome Home · My Garden</title>"));
        assert!(welcome.contains("Linked from"), "Alpha and Beta link back");
        let alpha = std::fs::read_to_string(out.join("notes/alpha.html")).expect("alpha");
        assert!(alpha.contains("href=\"welcome.html\""));
        assert!(alpha.contains("<span>Projects</span>"), "breadcrumb");

        // Every page is free of absolute paths and every relative link resolves.
        let vault_str = vault.path().to_string_lossy().to_string();
        let vault_canonical = model.root.to_string_lossy().to_string();
        let href_re = regex::Regex::new(r##"(?:href|src)="([^"#]+)(?:#[^"]*)?""##).expect("re");
        for entry in walkdir::WalkDir::new(&out)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("html") {
                continue;
            }
            let html = std::fs::read_to_string(entry.path()).expect("html");
            assert!(
                !html.contains(&vault_str),
                "absolute vault path leaked in {}",
                entry.path().display()
            );
            assert!(
                !html.contains(&vault_canonical),
                "absolute vault path leaked in {}",
                entry.path().display()
            );
            assert!(!html.contains("file://"));
            for cap in href_re.captures_iter(&html) {
                let link = &cap[1];
                if link.starts_with("http") || link.starts_with("mailto:") || link == "#" {
                    continue;
                }
                let target = entry
                    .path()
                    .parent()
                    .expect("dir")
                    .join(crate::engine::export::percent_decode(link));
                assert!(
                    target.exists(),
                    "broken link {link} in {}",
                    entry.path().display()
                );
            }
        }

        let index = std::fs::read_to_string(out.join("search-index.json")).expect("index");
        let parsed: serde_json::Value = serde_json::from_str(&index).expect("json");
        assert_eq!(parsed.as_array().expect("array").len(), 3);
        let sitemap = std::fs::read_to_string(out.join("sitemap.xml")).expect("sitemap");
        assert!(sitemap.contains("<loc>https://notes.example.com/notes/alpha.html</loc>"));
        assert_eq!(
            std::fs::read_to_string(out.join("CNAME")).expect("cname"),
            "notes.example.com\n"
        );

        let seen = seen.into_inner().expect("progress");
        let last = seen.last().expect("progress events");
        assert_eq!(last.done, last.total);
    }

    #[test]
    fn re_export_replaces_previous_output_and_refuses_foreign_folders() {
        let vault = tempdir().expect("vault");
        sample_vault(vault.path());
        let out_root = tempdir().expect("out");
        let out = out_root.path().join("site");
        let model = VaultModel::load(vault.path()).expect("model");
        export_site(
            &model,
            &ExportScope::Vault,
            &out,
            &ExportOptions::default(),
            &no_progress(),
        )
        .expect("first");
        assert!(out.join("notes/beta.html").exists());

        // Second export with a smaller scope removes stale pages.
        let report = export_site(
            &model,
            &ExportScope::Folder("Projects".into()),
            &out,
            &ExportOptions::default(),
            &no_progress(),
        )
        .expect("second");
        assert_eq!(report.pages, 1);
        assert!(report.removed_stale > 0);
        assert!(!out.join("notes/beta.html").exists());
        assert!(
            !out.join("files").exists(),
            "empty attachment folder removed"
        );
        assert!(out.join("notes/alpha.html").exists());

        // A foreign, non-empty folder is refused.
        let foreign = out_root.path().join("foreign");
        write(&foreign, "keep.txt", "mine");
        let err = export_site(
            &model,
            &ExportScope::Vault,
            &foreign,
            &ExportOptions::default(),
            &no_progress(),
        )
        .expect_err("foreign folder");
        assert!(err.to_string().contains("not empty"));
        assert!(foreign.join("keep.txt").exists());
    }

    #[test]
    fn slug_collisions_get_suffixes() {
        let vault = tempdir().expect("vault");
        write(vault.path(), "a/Readme.md", "# A readme\n[[b/Readme]]");
        write(vault.path(), "b/Readme.md", "# B readme");
        write(vault.path(), "Größe.md", "# Größe");
        let out_root = tempdir().expect("out");
        let out = out_root.path().join("site");
        let model = VaultModel::load(vault.path()).expect("model");
        let report = export_site(
            &model,
            &ExportScope::Vault,
            &out,
            &ExportOptions::default(),
            &no_progress(),
        )
        .expect("site");
        assert_eq!(report.pages, 3);
        assert!(out.join("notes/readme.html").exists());
        assert!(out.join("notes/readme-2.html").exists());
        assert!(out.join("notes/groesse.html").exists());
        let a = std::fs::read_to_string(out.join("notes/readme.html")).expect("a");
        assert!(
            a.contains("href=\"readme-2.html\""),
            "link to the colliding note uses its suffix"
        );
    }

    #[test]
    fn nothing_to_publish_is_an_error() {
        let vault = tempdir().expect("vault");
        write(vault.path(), "Private.md", "---\npublish: false\n---\nx");
        let out_root = tempdir().expect("out");
        let model = VaultModel::load(vault.path()).expect("model");
        let err = export_site(
            &model,
            &ExportScope::Vault,
            &out_root.path().join("s"),
            &ExportOptions::default(),
            &no_progress(),
        )
        .expect_err("nothing");
        assert!(err.to_string().contains("nothing to publish"));
    }

    #[test]
    fn cname_validation() {
        assert!(valid_cname("notes.example.com"));
        assert!(!valid_cname("localhost"));
        assert!(!valid_cname("bad domain.com"));
        assert!(!valid_cname("-x.com"));
    }
}
