//! Markdown bundle export: a zip with the notes of a scope (vault folder
//! structure preserved), optionally the attachments they reference, and a
//! `manifest.json`. With `convert_wikilinks`, `[[wikilinks]]` and
//! `![[embeds]]` are rewritten into standard relative Markdown links so the
//! bundle reads well in any Markdown tool (GitHub, VS Code, Typora, …).

use std::collections::{BTreeSet, HashSet};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::html::is_image;
use super::{
    encode_path, extract_wikilinks, heading_anchor, note_tags, percent_decode, prose_ranges,
    relative_path, BundleReport, ExportOptions, ExportProgress, ExportScope, ProgressThrottle,
    VaultModel, WikiLink,
};
use crate::engine::error::AetherError;

/// Where a wikilink points to after conversion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkRewrite {
    /// A note, as a path relative to the linking note, plus an anchor.
    Note {
        path: String,
        anchor: Option<String>,
    },
    /// An attachment, as a path relative to the linking note.
    Attachment { path: String },
    /// The target is not part of the bundle: keep only the display text.
    Unresolved,
}

/// Result of [`convert_wikilinks`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedMarkdown {
    pub text: String,
    pub converted: usize,
    pub unresolved: usize,
}

/// Escape text for use inside `[…]` of a Markdown link.
fn escape_link_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Rewrite every wikilink outside code and frontmatter. `resolve` decides
/// where each link points; unresolved links become their display text.
pub fn convert_wikilinks(
    content: &str,
    mut resolve: impl FnMut(&WikiLink) -> LinkRewrite,
) -> ConvertedMarkdown {
    let mut out = String::with_capacity(content.len());
    let mut last = 0;
    let mut converted = 0;
    let mut unresolved = 0;
    for link in extract_wikilinks(content) {
        out.push_str(&content[last..link.range.start]);
        let display = link.display();
        let replacement = match resolve(&link) {
            LinkRewrite::Note { path, anchor } => {
                converted += 1;
                let mut dest = encode_path(&path);
                if let Some(a) = anchor.filter(|a| !a.is_empty()) {
                    dest.push('#');
                    dest.push_str(&encode_path(&a));
                }
                format!("[{}]({dest})", escape_link_text(&display))
            }
            LinkRewrite::Attachment { path } => {
                converted += 1;
                let dest = encode_path(&path);
                let name = link
                    .target
                    .rsplit('/')
                    .next()
                    .unwrap_or(&link.target)
                    .to_owned();
                if link.embed && is_image(&link.target) {
                    let alt = match link.alias.as_deref().map(str::trim) {
                        Some(a)
                            if !a.is_empty()
                                && !a.chars().all(|c| c.is_ascii_digit() || c == 'x') =>
                        {
                            a.to_owned()
                        }
                        _ => name,
                    };
                    format!("![{}]({dest})", escape_link_text(&alt))
                } else {
                    let label = if link.embed { name } else { display.clone() };
                    format!("[{}]({dest})", escape_link_text(&label))
                }
            }
            LinkRewrite::Unresolved => {
                unresolved += 1;
                display.clone()
            }
        };
        out.push_str(&replacement);
        last = link.range.end;
    }
    out.push_str(&content[last..]);
    ConvertedMarkdown {
        text: out,
        converted,
        unresolved,
    }
}

/// Destinations of Markdown links and images (`[x](dest)`, `![x](dest)`)
/// in prose.
fn markdown_destinations(content: &str) -> Vec<String> {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)"#)
            .expect("valid regex")
    });
    prose_ranges(content)
        .into_iter()
        .flat_map(|r| {
            re.captures_iter(&content[r])
                .filter_map(|c| c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_owned()))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Resolve a wikilink for the bundle: notes must be part of the bundle,
/// attachments are linked at their vault location (and included when
/// `include_attachments` is set).
fn bundle_rewrite(
    model: &VaultModel,
    from: usize,
    in_bundle: &HashSet<usize>,
    link: &WikiLink,
) -> LinkRewrite {
    let folder = model.notes[from].folder();
    if link.target.is_empty() {
        return match &link.heading {
            Some(h) => LinkRewrite::Note {
                path: String::new(),
                anchor: Some(heading_anchor(h)),
            },
            None => LinkRewrite::Unresolved,
        };
    }
    if let Some(att) = model.resolve_attachment(&link.target, Some(from)) {
        if model.resolve_note(&link.target, Some(from)).is_none() {
            return LinkRewrite::Attachment {
                path: relative_path(folder, &model.attachments[att].rel),
            };
        }
    }
    match model.resolve_note(&link.target, Some(from)) {
        Some(idx) if in_bundle.contains(&idx) => LinkRewrite::Note {
            path: relative_path(folder, &model.notes[idx].rel),
            anchor: link.heading.as_deref().map(heading_anchor),
        },
        _ => LinkRewrite::Unresolved,
    }
}

/// Attachments referenced by a note (wikilinks, embeds, Markdown links).
fn referenced_attachments(model: &VaultModel, idx: usize, content: &str) -> BTreeSet<usize> {
    let mut out = BTreeSet::new();
    for link in extract_wikilinks(content) {
        if link.target.is_empty() || model.resolve_note(&link.target, Some(idx)).is_some() {
            continue;
        }
        if let Some(att) = model.resolve_attachment(&link.target, Some(idx)) {
            out.insert(att);
        }
    }
    for dest in markdown_destinations(content) {
        let path = dest.split('#').next().unwrap_or(&dest);
        if path.contains("://")
            || path.starts_with("mailto:")
            || path.to_lowercase().ends_with(".md")
        {
            continue;
        }
        if let Some(att) = model.resolve_attachment(&percent_decode(path), Some(idx)) {
            out.insert(att);
        }
    }
    out
}

/// The bundle's `manifest.json`.
#[derive(Debug, Serialize)]
struct Manifest<'a> {
    generator: &'a str,
    format: u32,
    created_at: String,
    vault: String,
    scope: String,
    options: ManifestOptions,
    notes: Vec<ManifestNote>,
    attachments: Vec<ManifestFile>,
}

#[derive(Debug, Serialize)]
struct ManifestOptions {
    convert_wikilinks: bool,
    include_attachments: bool,
}

#[derive(Debug, Serialize)]
struct ManifestNote {
    path: String,
    title: String,
    tags: Vec<String>,
    bytes: usize,
}

#[derive(Debug, Serialize)]
struct ManifestFile {
    path: String,
    bytes: u64,
}

fn zip_err(e: zip::result::ZipError) -> AetherError {
    AetherError::Io(std::io::Error::other(format!("zip: {e}")))
}

fn zip_time(secs: u64) -> Option<zip::DateTime> {
    use chrono::{Datelike, Timelike};
    let dt = chrono::DateTime::from_timestamp(secs as i64, 0)?.with_timezone(&chrono::Local);
    zip::DateTime::from_date_and_time(
        u16::try_from(dt.year()).ok()?,
        dt.month() as u8,
        dt.day() as u8,
        dt.hour() as u8,
        dt.minute() as u8,
        dt.second() as u8,
    )
    .ok()
}

/// The Markdown a note will have inside the bundle.
pub fn bundle_markdown(
    model: &VaultModel,
    idx: usize,
    in_bundle: &HashSet<usize>,
    options: &ExportOptions,
) -> Result<ConvertedMarkdown, AetherError> {
    let content = model.read(idx)?;
    if !options.convert_wikilinks {
        return Ok(ConvertedMarkdown {
            text: content,
            converted: 0,
            unresolved: 0,
        });
    }
    Ok(convert_wikilinks(&content, |link| {
        bundle_rewrite(model, idx, in_bundle, link)
    }))
}

/// Write a zip bundle of `scope` to `out_path` (validated by
/// [`super::check_output_path`]). The file is written next to the target
/// and renamed into place, so a failed export never leaves a broken zip.
pub fn export_bundle(
    model: &VaultModel,
    scope: &ExportScope,
    out_path: &Path,
    options: &ExportOptions,
    progress: &(dyn Fn(ExportProgress) + Sync),
) -> Result<BundleReport, AetherError> {
    let started = Instant::now();
    let notes = model.resolve_scope(scope)?;
    let in_bundle: HashSet<usize> = notes.iter().copied().collect();
    let mut throttle = ProgressThrottle::new(progress);
    let mut warnings = Vec::new();

    let file_name = out_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "bundle.zip".to_owned());
    let tmp = out_path.with_file_name(format!(".{file_name}.part"));
    let result = (|| -> Result<(BundleReport, u64), AetherError> {
        let file = std::fs::File::create(&tmp)?;
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let base = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);

        let mut manifest_notes = Vec::with_capacity(notes.len());
        let mut attachments = BTreeSet::new();
        let mut converted = 0;
        let mut unresolved = 0;
        let mut total = notes.len() + 1;
        for (n, &idx) in notes.iter().enumerate() {
            let entry = &model.notes[idx];
            throttle.report(n, total, &entry.name, "notes");
            let converted_md = bundle_markdown(model, idx, &in_bundle, options)?;
            converted += converted_md.converted;
            unresolved += converted_md.unresolved;
            if options.include_attachments {
                let original = model.read(idx)?;
                attachments.extend(referenced_attachments(model, idx, &original));
            }
            let opts = match zip_time(entry.mtime) {
                Some(t) => base.last_modified_time(t),
                None => base,
            };
            zip.start_file(entry.rel.as_str(), opts).map_err(zip_err)?;
            zip.write_all(converted_md.text.as_bytes())?;
            manifest_notes.push(ManifestNote {
                path: entry.rel.clone(),
                title: entry.name.clone(),
                tags: note_tags(&converted_md.text),
                bytes: converted_md.text.len(),
            });
        }

        total += attachments.len();
        let mut manifest_files = Vec::with_capacity(attachments.len());
        for (n, &att) in attachments.iter().enumerate() {
            let entry = &model.attachments[att];
            throttle.report(notes.len() + n, total, entry.file_name(), "attachments");
            let mut source = match std::fs::File::open(&entry.abs) {
                Ok(f) => f,
                Err(e) => {
                    warnings.push(format!("could not read {}: {e}", entry.rel));
                    continue;
                }
            };
            // Already-compressed media gains nothing from deflate.
            let opts = if is_image(entry.file_name()) || entry.rel.to_lowercase().ends_with(".pdf")
            {
                base.compression_method(CompressionMethod::Stored)
            } else {
                base
            };
            zip.start_file(entry.rel.as_str(), opts).map_err(zip_err)?;
            let bytes = std::io::copy(&mut source, &mut zip)?;
            manifest_files.push(ManifestFile {
                path: entry.rel.clone(),
                bytes,
            });
        }

        throttle.report(total - 1, total, "manifest.json", "finishing");
        let manifest = Manifest {
            generator: "AETHER-OS",
            format: 1,
            created_at: chrono::Local::now().to_rfc3339(),
            vault: model.vault_name(),
            scope: model.describe_scope(scope, notes.len()),
            options: ManifestOptions {
                convert_wikilinks: options.convert_wikilinks,
                include_attachments: options.include_attachments,
            },
            notes: manifest_notes,
            attachments: manifest_files,
        };
        let json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| AetherError::InvalidInput(format!("manifest: {e}")))?;
        zip.start_file("manifest.json", base).map_err(zip_err)?;
        zip.write_all(json.as_bytes())?;
        let mut writer = zip.finish().map_err(zip_err)?;
        writer.flush()?;
        drop(writer);
        let bytes = std::fs::metadata(&tmp)?.len();
        throttle.report(total, total, "Done", "finishing");
        Ok((
            BundleReport {
                path: out_path.to_string_lossy().to_string(),
                notes: notes.len(),
                attachments: manifest.attachments.len(),
                converted_links: converted,
                unresolved_links: unresolved,
                bytes,
                warnings: Vec::new(),
                ms: 0,
            },
            bytes,
        ))
    })();

    match result {
        Ok((mut report, _)) => {
            std::fs::rename(&tmp, out_path)?;
            report.warnings = warnings;
            report.ms = started.elapsed().as_millis() as u64;
            Ok(report)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::export::test_support::*;
    use std::io::Read;
    use tempfile::tempdir;

    #[test]
    fn converts_wikilinks_to_relative_markdown_links() {
        let content = "---\nrelated: \"[[Keep]]\"\n---\nSee [[Alpha|the alpha]], [[Beta#Set up]] and [[#Local]].\n![[img one.png|300]] ![[photo.jpg|A cat]] ![[doc.pdf]] [[Gone]]\n`[[code]]`\n```\n[[fenced]]\n```\n";
        let result = convert_wikilinks(content, |link| match link.target.as_str() {
            "Alpha" => LinkRewrite::Note {
                path: "Projects/Alpha.md".into(),
                anchor: None,
            },
            "Beta" => LinkRewrite::Note {
                path: "../Beta.md".into(),
                anchor: link.heading.as_deref().map(heading_anchor),
            },
            "" => LinkRewrite::Note {
                path: String::new(),
                anchor: Some("local".into()),
            },
            "img one.png" => LinkRewrite::Attachment {
                path: "assets/img one.png".into(),
            },
            "photo.jpg" => LinkRewrite::Attachment {
                path: "photo.jpg".into(),
            },
            "doc.pdf" => LinkRewrite::Attachment {
                path: "files/doc.pdf".into(),
            },
            _ => LinkRewrite::Unresolved,
        });
        assert!(
            result.text.contains("[the alpha](Projects/Alpha.md)"),
            "{}",
            result.text
        );
        assert!(result.text.contains("[Beta > Set up](../Beta.md#set-up)"));
        assert!(result.text.contains("[Local](#local)"));
        assert!(result.text.contains("![img one.png](assets/img%20one.png)"));
        assert!(result.text.contains("![A cat](photo.jpg)"));
        assert!(result.text.contains("[doc.pdf](files/doc.pdf)"));
        assert!(result.text.contains(" Gone\n"), "unresolved → plain text");
        assert!(
            result.text.contains("related: \"[[Keep]]\""),
            "frontmatter untouched"
        );
        assert!(result.text.contains("`[[code]]`"));
        assert!(result.text.contains("[[fenced]]"));
        assert_eq!(result.converted, 6);
        assert_eq!(result.unresolved, 1);
        assert_eq!(escape_link_text("a [b] \\c"), "a \\[b\\] \\\\c");
    }

    #[test]
    fn finds_markdown_destinations_outside_code() {
        let dests = markdown_destinations(
            "![a](x.png) [b](<y z.pdf> \"t\") `[c](no.png)`\n```\n![d](no2.png)\n```\n",
        );
        assert_eq!(dests, vec!["x.png", "y z.pdf"]);
    }

    fn read_zip(path: &Path) -> std::collections::BTreeMap<String, String> {
        let file = std::fs::File::open(path).expect("zip");
        let mut archive = zip::ZipArchive::new(file).expect("archive");
        let mut out = std::collections::BTreeMap::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).expect("read");
            out.insert(
                entry.name().to_owned(),
                String::from_utf8_lossy(&bytes).to_string(),
            );
        }
        out
    }

    #[test]
    fn bundles_notes_attachments_and_manifest() {
        let vault = tempdir().expect("vault");
        sample_vault(vault.path());
        write_bytes(vault.path(), "assets/unused.png", &[1, 2]);
        let out_dir = tempdir().expect("out");
        let out = out_dir.path().join("bundle.zip");
        let model = VaultModel::load(vault.path()).expect("model");
        let scope = ExportScope::Selection(vec!["Welcome.md".into(), "Beta.md".into()]);
        let report = export_bundle(&model, &scope, &out, &ExportOptions::default(), &|_| {})
            .expect("bundle");
        assert_eq!(report.notes, 2);
        assert_eq!(report.attachments, 1);
        assert!(report.bytes > 0);
        assert!(
            !out_dir.path().join(".bundle.zip.part").exists(),
            "temp file renamed"
        );

        let files = read_zip(&out);
        let names: Vec<&str> = files.keys().map(String::as_str).collect();
        assert_eq!(
            names,
            vec![
                "Beta.md",
                "Welcome.md",
                "assets/diagram.png",
                "manifest.json"
            ]
        );
        let welcome = &files["Welcome.md"];
        assert!(
            welcome.contains("[Beta > Setup](Beta.md#setup)"),
            "{welcome}"
        );
        assert!(welcome.contains("![diagram.png](assets/diagram.png)"));
        assert!(
            welcome.contains("See the alpha and"),
            "Alpha is not in the bundle → text"
        );
        assert!(welcome.contains("\"[[NotALink]]\""), "code untouched");
        let beta = &files["Beta.md"];
        assert!(beta.contains("[welcome](Welcome.md)"), "{beta}");

        let manifest: serde_json::Value =
            serde_json::from_str(&files["manifest.json"]).expect("manifest");
        assert_eq!(manifest["generator"], "AETHER-OS");
        assert_eq!(manifest["notes"].as_array().expect("notes").len(), 2);
        assert_eq!(manifest["attachments"][0]["path"], "assets/diagram.png");
        assert_eq!(manifest["options"]["convert_wikilinks"], true);

        // Without conversion and attachments the notes are byte-identical.
        let raw = out_dir.path().join("raw.zip");
        let options = ExportOptions {
            convert_wikilinks: false,
            include_attachments: false,
            ..Default::default()
        };
        let report =
            export_bundle(&model, &ExportScope::Vault, &raw, &options, &|_| {}).expect("raw");
        assert_eq!(report.attachments, 0);
        assert_eq!(report.converted_links, 0);
        let files = read_zip(&raw);
        assert_eq!(files.len(), 5, "4 notes + manifest");
        assert_eq!(
            files["Welcome.md"],
            std::fs::read_to_string(vault.path().join("Welcome.md")).expect("orig")
        );
    }

    #[test]
    fn nested_links_are_relative_to_the_note() {
        let vault = tempdir().expect("vault");
        write(
            vault.path(),
            "a/b/Deep.md",
            "[[Top]] [[a/Mid]] ![[pic.png]]",
        );
        write(vault.path(), "Top.md", "[[Deep]]");
        write(vault.path(), "a/Mid.md", "x");
        write_bytes(vault.path(), "media/pic.png", &[0]);
        let model = VaultModel::load(vault.path()).expect("model");
        let all: HashSet<usize> = (0..model.notes.len()).collect();
        let deep = model
            .notes
            .iter()
            .position(|n| n.rel == "a/b/Deep.md")
            .expect("deep");
        let md = bundle_markdown(&model, deep, &all, &ExportOptions::default()).expect("md");
        assert_eq!(
            md.text,
            "[Top](../../Top.md) [a/Mid](../Mid.md) ![pic.png](../../media/pic.png)"
        );
        let top = model
            .notes
            .iter()
            .position(|n| n.rel == "Top.md")
            .expect("top");
        let md = bundle_markdown(&model, top, &all, &ExportOptions::default()).expect("md");
        assert_eq!(md.text, "[Deep](a/b/Deep.md)");
    }
}
