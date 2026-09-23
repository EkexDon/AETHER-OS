//! macOS application discovery for the launcher.
//!
//! Scans the standard application folders for `.app` bundles (one level of
//! sub-folders deep, e.g. `/Applications/Utilities`), reads each bundle's
//! `Contents/Info.plist` (XML or binary) and names the app after
//! `CFBundleDisplayName` → `CFBundleName` → the bundle's file stem.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// An installed application.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppEntry {
    /// Display name.
    pub name: String,
    /// Absolute path of the `.app` bundle.
    pub path: String,
    /// `CFBundleIdentifier`, when the bundle declares one.
    pub bundle_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct InfoPlist {
    #[serde(rename = "CFBundleDisplayName")]
    display_name: Option<String>,
    #[serde(rename = "CFBundleName")]
    name: Option<String>,
    #[serde(rename = "CFBundleIdentifier")]
    identifier: Option<String>,
}

/// The folders applications are discovered in, in priority order:
/// `/Applications`, `~/Applications`, `/System/Applications` (+ their
/// `Utilities` sub-folders via the one-level descent in [`discover_apps`]).
pub fn default_app_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots.push(PathBuf::from("/System/Applications"));
    roots
}

/// Parse `name` and bundle id out of an `Info.plist` (XML or binary).
/// Falls back to `stem` for the name; blank values are ignored.
pub fn app_name_from_plist(bytes: &[u8], stem: &str) -> (String, Option<String>) {
    let info: InfoPlist = plist::from_bytes(bytes).unwrap_or_default();
    let clean = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let name = clean(info.display_name)
        .or_else(|| clean(info.name))
        .unwrap_or_else(|| stem.to_owned());
    (name, clean(info.identifier))
}

fn is_app_bundle(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("app"))
        && path.is_dir()
}

fn read_app(path: &Path) -> Option<AppEntry> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    if stem.is_empty() {
        return None;
    }
    let plist_path = path.join("Contents").join("Info.plist");
    let (name, bundle_id) = match std::fs::read(&plist_path) {
        Ok(bytes) => app_name_from_plist(&bytes, &stem),
        Err(_) => (stem, None),
    };
    Some(AppEntry {
        name,
        path: path.to_string_lossy().to_string(),
        bundle_id,
    })
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

/// All `.app` bundles directly inside `roots` or one folder below them,
/// de-duplicated by canonical path and sorted by name (case-insensitive).
/// Missing or unreadable roots are skipped.
pub fn discover_apps(roots: &[PathBuf]) -> Vec<AppEntry> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut apps = Vec::new();
    let mut consider = |path: &Path, apps: &mut Vec<AppEntry>| {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if !seen.insert(canonical) {
            return;
        }
        if let Some(app) = read_app(path) {
            apps.push(app);
        }
    };
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        children.sort();
        for child in children {
            if is_hidden(&child) {
                continue;
            }
            if is_app_bundle(&child) {
                consider(&child, &mut apps);
            } else if child.is_dir() {
                let Ok(nested) = std::fs::read_dir(&child) else {
                    continue;
                };
                let mut grand: Vec<PathBuf> =
                    nested.filter_map(|e| e.ok()).map(|e| e.path()).collect();
                grand.sort();
                for g in grand {
                    if !is_hidden(&g) && is_app_bundle(&g) {
                        consider(&g, &mut apps);
                    }
                }
            }
        }
    }
    apps.sort_by_cached_key(|a| a.name.to_lowercase());
    apps
}

/// Validate an untrusted app path from the UI: it must canonicalize to an
/// existing `.app` bundle below one of `roots`.
pub fn resolve_app_path(path: &str, roots: &[PathBuf]) -> Result<PathBuf, AetherError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AetherError::InvalidInput("app path is required".to_owned()));
    }
    let canonical = std::fs::canonicalize(trimmed)
        .map_err(|_| AetherError::InvalidInput(format!("application not found: {trimmed}")))?;
    if !is_app_bundle(&canonical) {
        return Err(AetherError::InvalidInput(format!(
            "not an application bundle: {trimmed}"
        )));
    }
    let allowed = roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|r| canonical.starts_with(&r))
            .unwrap_or(false)
    });
    if !allowed {
        return Err(AetherError::InvalidInput(format!(
            "refusing to launch an application outside the application folders: {trimmed}"
        )));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_app(dir: &Path, bundle: &str, plist: Option<&str>) -> PathBuf {
        let app = dir.join(bundle);
        std::fs::create_dir_all(app.join("Contents")).expect("bundle dirs");
        if let Some(xml) = plist {
            std::fs::write(app.join("Contents/Info.plist"), xml).expect("plist");
        }
        app
    }

    fn plist_xml(entries: &[(&str, &str)]) -> String {
        let body: String = entries
            .iter()
            .map(|(k, v)| format!("<key>{k}</key><string>{v}</string>"))
            .collect();
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>{body}</dict></plist>"
        )
    }

    #[test]
    fn names_come_from_the_plist_with_stem_fallback() {
        let xml = plist_xml(&[
            ("CFBundleName", "Code"),
            ("CFBundleIdentifier", "com.microsoft.VSCode"),
        ]);
        assert_eq!(
            app_name_from_plist(xml.as_bytes(), "Visual Studio Code"),
            ("Code".to_owned(), Some("com.microsoft.VSCode".to_owned()))
        );
        let display = plist_xml(&[
            ("CFBundleName", "Safari"),
            ("CFBundleDisplayName", "Safari Browser"),
        ]);
        assert_eq!(
            app_name_from_plist(display.as_bytes(), "Safari").0,
            "Safari Browser"
        );
        let blank = plist_xml(&[("CFBundleName", "  ")]);
        assert_eq!(
            app_name_from_plist(blank.as_bytes(), "Stem"),
            ("Stem".to_owned(), None)
        );
        assert_eq!(
            app_name_from_plist(b"garbage", "Stem"),
            ("Stem".to_owned(), None)
        );
    }

    #[test]
    fn reads_binary_plists() {
        let mut dict = plist::Dictionary::new();
        dict.insert("CFBundleName".into(), plist::Value::String("Notes".into()));
        let mut bytes = Vec::new();
        plist::Value::Dictionary(dict)
            .to_writer_binary(&mut bytes)
            .expect("binary plist");
        assert_eq!(app_name_from_plist(&bytes, "x").0, "Notes");
    }

    #[test]
    fn discovers_bundles_one_level_deep_sorted_and_deduplicated() {
        let root = tempfile::tempdir().expect("temp dir");
        make_app(
            root.path(),
            "Zed.app",
            Some(&plist_xml(&[("CFBundleName", "Zed")])),
        );
        make_app(root.path(), "alacritty.app", None);
        make_app(
            &root.path().join("Utilities"),
            "Terminal.app",
            Some(&plist_xml(&[("CFBundleName", "Terminal")])),
        );
        make_app(&root.path().join("Deep/Deeper"), "TooDeep.app", None);
        make_app(root.path(), ".Hidden.app", None);
        std::fs::write(root.path().join("NotAnApp.app"), "file, not a bundle").ok();

        let apps = discover_apps(&[root.path().to_path_buf(), root.path().to_path_buf()]);
        let names: Vec<&str> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["alacritty", "Terminal", "Zed"]);
        assert!(apps[1].path.ends_with("Utilities/Terminal.app"));
        assert!(discover_apps(&[root.path().join("missing")]).is_empty());
    }

    #[test]
    fn launch_paths_must_be_bundles_inside_the_roots() {
        let base = tempfile::tempdir().expect("temp dir");
        let root = base.path().join("Applications");
        let app = make_app(&root, "Good.app", None);
        let evil = make_app(&base.path().join("Downloads"), "Evil.app", None);
        let roots = vec![root.clone()];

        let resolved = resolve_app_path(&app.to_string_lossy(), &roots).expect("inside root");
        assert!(resolved.ends_with("Good.app"));
        assert!(resolve_app_path(&evil.to_string_lossy(), &roots).is_err());
        let escape = format!("{}/../Downloads/Evil.app", root.display());
        assert!(
            resolve_app_path(&escape, &roots).is_err(),
            "`..` must not escape the root"
        );
        assert!(
            resolve_app_path(&root.to_string_lossy(), &roots).is_err(),
            "not a bundle"
        );
        assert!(resolve_app_path("", &roots).is_err());
    }
}
