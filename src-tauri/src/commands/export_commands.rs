//! Tauri commands for Export & Publishing (`engine/export.rs`).
//!
//! Every command re-scans the vault into a fresh [`VaultModel`] so exports
//! always reflect the files on disk. The work runs on the blocking thread
//! pool; long exports (site, bundle) stream `export-progress` events.
//! Paths coming from the UI are untrusted: note/folder paths must resolve
//! inside the vault, output paths are validated by `check_output_path`
//! and "open" targets are limited to recorded exports.

use std::path::PathBuf;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};

use crate::engine::error::AetherError;
use crate::engine::export::{
    bundle, check_output_path, html, open_path, pdf, site, with_extension, BundleReport,
    ExportKind, ExportOptions, ExportProgress, ExportScope, NoteExportReport, RecentExport,
    ScopeNote, ScopePreview, SiteReport, TagCount, VaultModel, PROGRESS_EVENT,
};
use crate::AppState;

/// Notes listed in a scope preview.
const SCOPE_PREVIEW_LIMIT: usize = 500;

fn vault_root(state: &AppState) -> Result<PathBuf, String> {
    state
        .vault
        .detect_vault_path()
        .map(PathBuf::from)
        .ok_or_else(|| "No vault path configured. Open Settings to set a vault path.".to_owned())
}

/// Run blocking export work off the async runtime.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AetherError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("export task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Render one note as a standalone HTML document (for the preview frame).
#[tauri::command]
pub async fn cmd_export_preview_html(
    state: State<'_, AppState>,
    path: String,
    options: ExportOptions,
) -> Result<String, String> {
    let root = vault_root(&state)?;
    blocking(move || {
        let model = VaultModel::load(&root)?;
        let idx = model.note_for_path(&path)?;
        Ok(html::standalone_document(&model, idx, &options)?.html)
    })
    .await
}

/// The Markdown a note would have inside a bundle of `scope` (preview of
/// the wikilink conversion).
#[tauri::command]
pub async fn cmd_export_preview_markdown(
    state: State<'_, AppState>,
    scope: ExportScope,
    path: String,
    options: ExportOptions,
) -> Result<String, String> {
    let root = vault_root(&state)?;
    blocking(move || {
        let model = VaultModel::load(&root)?;
        let in_bundle = model.resolve_scope(&scope)?.into_iter().collect();
        let idx = model.note_for_path(&path)?;
        Ok(bundle::bundle_markdown(&model, idx, &in_bundle, &options)?.text)
    })
    .await
}

/// Export one note as a standalone HTML file (CSS and images inlined).
#[tauri::command]
pub async fn cmd_export_note_html(
    state: State<'_, AppState>,
    path: String,
    out_path: String,
    options: ExportOptions,
) -> Result<NoteExportReport, String> {
    let root = vault_root(&state)?;
    let engine = state.export.clone();
    blocking(move || {
        let started = Instant::now();
        let model = VaultModel::load(&root)?;
        let idx = model.note_for_path(&path)?;
        let out = with_extension(
            check_output_path(&out_path, &model.root, options.allow_inside_vault)?,
            "html",
        );
        let doc = html::standalone_document(&model, idx, &options)?;
        let tmp = out.with_extension("html.part");
        std::fs::write(&tmp, doc.html.as_bytes())?;
        std::fs::rename(&tmp, &out)?;
        let bytes = doc.html.len() as u64;
        let scope = model.describe_scope(&ExportScope::Note(path.clone()), 1);
        engine.record(ExportKind::Html, &doc.title, &scope, &out, 1, bytes)?;
        Ok(NoteExportReport {
            path: out.to_string_lossy().to_string(),
            title: doc.title,
            bytes,
            attachments: doc.attachments,
            missing_links: doc.missing.len(),
            warnings: doc.warnings,
            ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
}

/// Build the print document ("Print / Save as PDF…") for one note.
#[tauri::command]
pub async fn cmd_export_print_document(
    state: State<'_, AppState>,
    path: String,
    options: ExportOptions,
) -> Result<pdf::PrintDocument, String> {
    let root = vault_root(&state)?;
    blocking(move || {
        let model = VaultModel::load(&root)?;
        let idx = model.note_for_path(&path)?;
        pdf::print_document(&model, idx, &options)
    })
    .await
}

/// Publish `scope` as a static website into `out_dir`. Emits
/// `export-progress` events while it runs.
#[tauri::command]
pub async fn cmd_export_site(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: ExportScope,
    out_dir: String,
    options: ExportOptions,
) -> Result<SiteReport, String> {
    let root = vault_root(&state)?;
    let engine = state.export.clone();
    blocking(move || {
        let model = VaultModel::load(&root)?;
        let out = check_output_path(&out_dir, &model.root, options.allow_inside_vault)?;
        let emit = |p: ExportProgress| {
            let _ = app.emit(PROGRESS_EVENT, p);
        };
        let report = site::export_site(&model, &scope, &out, &options, &emit)?;
        let title = if options.site_title.trim().is_empty() {
            model.vault_name()
        } else {
            options.site_title.trim().to_owned()
        };
        let label = model.describe_scope(&scope, report.pages + report.skipped);
        engine.record(
            ExportKind::Site,
            &title,
            &label,
            &out,
            report.pages,
            report.bytes,
        )?;
        Ok(report)
    })
    .await
}

/// Write a Markdown bundle (zip) of `scope` to `out_path`. Emits
/// `export-progress` events while it runs.
#[tauri::command]
pub async fn cmd_export_bundle(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: ExportScope,
    out_path: String,
    options: ExportOptions,
) -> Result<BundleReport, String> {
    let root = vault_root(&state)?;
    let engine = state.export.clone();
    blocking(move || {
        let model = VaultModel::load(&root)?;
        let out = with_extension(
            check_output_path(&out_path, &model.root, options.allow_inside_vault)?,
            "zip",
        );
        let emit = |p: ExportProgress| {
            let _ = app.emit(PROGRESS_EVENT, p);
        };
        let report = bundle::export_bundle(&model, &scope, &out, &options, &emit)?;
        let title = out
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Bundle".to_owned());
        let label = model.describe_scope(&scope, report.notes);
        engine.record(
            ExportKind::Bundle,
            &title,
            &label,
            &out,
            report.notes,
            report.bytes,
        )?;
        Ok(report)
    })
    .await
}

/// Reveal an export in Finder (`reveal = true`) or open it (folders and
/// HTML files only). Only recorded export outputs are accepted.
#[tauri::command]
pub async fn cmd_export_open_path(
    state: State<'_, AppState>,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    let target = state
        .export
        .resolve_open_target(&path, reveal)
        .map_err(|e| e.to_string())?;
    open_path(&target, reveal).map_err(|e| e.to_string())
}

/// Recent exports, newest first.
#[tauri::command]
pub async fn cmd_export_list_recent(
    state: State<'_, AppState>,
) -> Result<Vec<RecentExport>, String> {
    let engine = state.export.clone();
    blocking(move || Ok(engine.list_recent())).await
}

/// Forget the recent exports list (exported files stay on disk).
#[tauri::command]
pub async fn cmd_export_clear_recent(state: State<'_, AppState>) -> Result<(), String> {
    state.export.clear_recent().map_err(|e| e.to_string())
}

/// Resolve a scope to its notes (for the wizard's summary and preview picker).
#[tauri::command]
pub async fn cmd_export_resolve_scope(
    state: State<'_, AppState>,
    scope: ExportScope,
) -> Result<ScopePreview, String> {
    let root = vault_root(&state)?;
    blocking(move || {
        let model = VaultModel::load(&root)?;
        let notes = model.resolve_scope(&scope)?;
        let total = notes.len();
        let listed = notes
            .iter()
            .take(SCOPE_PREVIEW_LIMIT)
            .map(|&i| {
                let n = &model.notes[i];
                ScopeNote {
                    path: n.abs.to_string_lossy().to_string(),
                    rel: n.rel.clone(),
                    title: n.name.clone(),
                }
            })
            .collect();
        Ok(ScopePreview {
            total,
            notes: listed,
            truncated: total > SCOPE_PREVIEW_LIMIT,
            label: model.describe_scope(&scope, total),
        })
    })
    .await
}

/// Every tag of the vault with its note count (for the tag scope picker).
#[tauri::command]
pub async fn cmd_export_list_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, String> {
    let root = vault_root(&state)?;
    blocking(move || Ok(VaultModel::load(&root)?.tag_counts())).await
}
