//! Print document behind "Print / Save as PDF…".
//!
//! Tauri 2 has no print-to-file API and a headless browser would be far too
//! heavy, so PDF export goes through the system print dialog (macOS offers
//! "Save as PDF" there). The app mounts this document in a shadow root,
//! hides its own UI for the print media and calls `window.print()`, which
//! Tauri routes to the native print operation of the webview.
//!
//! The document is always light (paper), inlines every image as a data URI
//! (the main window cannot load vault files directly) and uses print
//! typography (points, page-break rules). Mermaid diagrams print as their
//! source because no script runs inside the print document.

use serde::Serialize;

use super::html::{document_css, render_article};
use super::{ExportOptions, ExportTheme, VaultModel};
use crate::engine::error::AetherError;

/// Print-specific additions to the export stylesheet.
pub const PRINT_CSS: &str = include_str!("templates/print.css");

/// A note prepared for printing (`cmd_export_print_document`).
#[derive(Debug, Clone, Serialize)]
pub struct PrintDocument {
    /// Note title — used as the print job / PDF file name.
    pub title: String,
    /// Stylesheet for the shadow root (scoped to `.aether-doc`).
    pub css: String,
    /// `<div class="aether-doc aether-print">…</div>` markup.
    pub body: String,
    pub warnings: Vec<String>,
}

/// Build the print document for one note.
pub fn print_document(
    model: &VaultModel,
    idx: usize,
    options: &ExportOptions,
) -> Result<PrintDocument, AetherError> {
    let print_options = ExportOptions {
        theme: ExportTheme::Light,
        include_mermaid_script: false,
        ..options.clone()
    };
    // Images are always inlined: the print document lives in the app window.
    let article = render_article(model, idx, &print_options, true)?;
    let body = format!(
        "<div class=\"aether-doc aether-print\" data-theme=\"light\" lang=\"{}\"><main class=\"doc-main\">\n{}</main></div>",
        super::escape_html(&article.lang),
        article.html
    );
    Ok(PrintDocument {
        title: article.title,
        css: format!("{}\n{PRINT_CSS}", document_css()),
        body,
        warnings: article.rendered.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::export::test_support::*;
    use tempfile::tempdir;

    #[test]
    fn print_document_is_light_and_self_contained() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        let model = VaultModel::load(dir.path()).expect("model");
        let idx = model
            .notes
            .iter()
            .position(|n| n.rel == "Welcome.md")
            .expect("w");
        let options = ExportOptions {
            theme: ExportTheme::Dark,
            include_attachments: false,
            include_mermaid_script: true,
            ..Default::default()
        };
        let doc = print_document(&model, idx, &options).expect("print");
        assert_eq!(doc.title, "Welcome Home");
        assert!(doc
            .body
            .starts_with("<div class=\"aether-doc aether-print\" data-theme=\"light\""));
        assert!(
            doc.body.contains("src=\"data:image/png;base64,"),
            "images always inlined"
        );
        assert!(
            !doc.body.contains("<script"),
            "no scripts in print documents"
        );
        assert!(doc.css.contains(".aether-doc.aether-print"));
        assert!(
            doc.css.contains(".aether-doc .hl-"),
            "highlighting colours included"
        );
    }
}
