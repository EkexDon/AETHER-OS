//! Plugin system (roadmap 5.1): installation, strict manifest validation,
//! per-plugin state, settings and storage, and capability-checked host
//! operations.
//!
//! A plugin is a folder `<data_dir>/plugins/<id>/` holding a `manifest.json`
//! and a single ES module (`main`, default `main.js`). The code runs inside a
//! Web Worker in the webview (`src/lib/plugins/`); this engine never executes
//! it. Everything a plugin can do outside its worker is proxied by the host,
//! and every privileged host operation lands here together with the plugin
//! id, so the granted permission is checked a second time in Rust.
//!
//! Layout below the engine root (`<data_dir>/plugins/`):
//!
//! | Path | Content |
//! | --- | --- |
//! | `<id>/` | Plugin package (replaced as a whole on reinstall) |
//! | `.data/<id>/settings.json` | Values for the manifest's `settings` |
//! | `.data/<id>/storage.json` | Plugin key/value storage (1 MB cap) |
//! | `.staging/` | Scratch space for installs (emptied on start) |
//! | `state.json` | Enabled flags, granted permissions, seeded examples |

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::engine::error::AetherError;
use crate::engine::updater::Version;
use crate::engine::vault_reader::VaultReader;

/// Version of the running app; a manifest's `minAppVersion` is compared
/// against it.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Largest accepted plugin entry module.
pub const MAX_MAIN_BYTES: u64 = 2 * 1024 * 1024;
/// Largest serialized `storage.json` per plugin.
pub const MAX_STORAGE_BYTES: usize = 1024 * 1024;
/// Prefix of the per-host network permission (`net:fetch:api.github.com`).
pub const NET_FETCH_PREFIX: &str = "net:fetch:";
/// Every permission string except the host-scoped `net:fetch:<host>`.
pub const PERMISSIONS: [&str; 8] = [
    "vault:read",
    "vault:write",
    "notes:create",
    "ui:commands",
    "ui:panel",
    "ui:statusbar",
    "ai:query",
    "clipboard:read",
];

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 512;
const MAX_PACKAGE_DEPTH: usize = 8;
const MAX_NOTE_BYTES: usize = 5 * 1024 * 1024;
const MAX_FETCH_BYTES: usize = 5 * 1024 * 1024;
const MAX_PERMISSIONS: usize = 32;
const MAX_SETTINGS: usize = 32;
const MAX_SELECT_OPTIONS: usize = 50;
const MAX_STRING_SETTING_CHARS: usize = 10_000;
const MAX_STORAGE_KEY_CHARS: usize = 128;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 5;

const MANIFEST_FILE: &str = "manifest.json";
const STATE_FILE: &str = "state.json";
const DATA_DIR: &str = ".data";
const STAGING_DIR: &str = ".staging";
const SETTINGS_FILE: &str = "settings.json";
const STORAGE_FILE: &str = "storage.json";
/// Names that would collide with engine files in the plugins root.
const RESERVED_IDS: [&str; 1] = [STATE_FILE];

/// One example plugin compiled into the binary (`plugins/examples/<folder>`).
struct BundledExample {
    manifest: &'static str,
    main: &'static str,
}

/// The example plugins shipped with AETHER-OS; installed once by
/// [`PluginManager::install_examples`].
const BUNDLED_EXAMPLES: [BundledExample; 3] = [
    BundledExample {
        manifest: include_str!("../../../plugins/examples/word-count/manifest.json"),
        main: include_str!("../../../plugins/examples/word-count/main.js"),
    },
    BundledExample {
        manifest: include_str!("../../../plugins/examples/daily-review/manifest.json"),
        main: include_str!("../../../plugins/examples/daily-review/main.js"),
    },
    BundledExample {
        manifest: include_str!("../../../plugins/examples/random-note/manifest.json"),
        main: include_str!("../../../plugins/examples/random-note/main.js"),
    },
];

// ── Manifest ────────────────────────────────────────────────────────────

/// `manifest.json` of a plugin. Field names are camelCase on disk and on
/// the wire; unknown fields are rejected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    /// Unique id, also the folder name (`com.example.wordcount`).
    pub id: String,
    pub name: String,
    /// Strict SemVer (`1.2.3`, `1.0.0-beta.1`).
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// Entry module, relative to the plugin folder.
    #[serde(default = "default_main")]
    pub main: String,
    /// Lowest AETHER-OS version the plugin supports.
    #[serde(default)]
    pub min_app_version: Option<String>,
    /// Requested capabilities; the user grants a subset.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// User-facing settings rendered as a form by the host.
    #[serde(default)]
    pub settings: Vec<PluginSettingSpec>,
}

fn default_main() -> String {
    "main.js".to_owned()
}

/// Value type of a plugin setting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginSettingType {
    String,
    Number,
    Boolean,
    Select,
}

/// One entry of a manifest's `settings` array.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSettingSpec {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: PluginSettingType,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub default: Option<Value>,
    /// Choices of a `select` setting.
    #[serde(default)]
    pub options: Vec<PluginSettingOption>,
    /// Bounds of a `number` setting.
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

/// One choice of a `select` setting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginSettingOption {
    pub value: String,
    pub label: String,
}

/// An installed plugin as shown by the plugin manager.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginInfo {
    /// The validated manifest. For a broken package this is a placeholder
    /// named after the folder and `error` explains what is wrong.
    pub manifest: PluginManifest,
    pub enabled: bool,
    /// Always a subset of `manifest.permissions`, in manifest order.
    pub granted_permissions: Vec<String>,
    /// Absolute path of the plugin folder.
    pub path: String,
    /// Why the plugin cannot run, if it cannot.
    pub error: Option<String>,
    /// Changes whenever the code or version changes; the host restarts a
    /// running plugin when it does.
    pub fingerprint: String,
    /// Installed from the examples bundled with AETHER-OS.
    pub bundled: bool,
}

/// A vault note as seen by plugins: paths are vault-relative.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginVaultNote {
    pub path: String,
    pub name: String,
    pub mtime: u64,
}

/// Result of [`PluginManager::fetch`].
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginFetchResponse {
    /// Final URL after redirects.
    pub url: String,
    pub status: u16,
    pub ok: bool,
    pub content_type: Option<String>,
    /// Body decoded as UTF-8 (lossy).
    pub body: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PluginsState {
    #[serde(default)]
    plugins: BTreeMap<String, PluginStateEntry>,
    /// Example ids already offered once; uninstalled examples stay gone.
    #[serde(default)]
    seeded_examples: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PluginStateEntry {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    granted: BTreeSet<String>,
    #[serde(default)]
    bundled: bool,
}

fn invalid(message: impl Into<String>) -> AetherError {
    AetherError::InvalidInput(message.into())
}

fn manifest_error(why: impl std::fmt::Display) -> AetherError {
    invalid(format!("invalid plugin manifest: {why}"))
}

/// The message of an error without its category prefix, for nesting one
/// error inside another.
fn reason(error: AetherError) -> String {
    match error {
        AetherError::InvalidInput(message) | AetherError::Vault(message) => message,
        other => other.to_string(),
    }
}

fn permission_denied(id: &str, permission: &str) -> AetherError {
    invalid(format!(
        "permission denied: plugin \"{id}\" has not been granted \"{permission}\""
    ))
}

/// Validate a plugin id: 3–64 characters of `a-z 0-9 . - _`, starting and
/// ending with a letter or digit, without repeated separators (so `..` is
/// impossible) and not a reserved engine file name.
pub fn validate_plugin_id(id: &str) -> Result<(), AetherError> {
    let bad = |why: &str| invalid(format!("invalid plugin id \"{id}\": {why}"));
    if id.len() < 3 || id.len() > 64 {
        return Err(bad("must be 3–64 characters long"));
    }
    let is_sep = |b: u8| matches!(b, b'.' | b'-' | b'_');
    let bytes = id.as_bytes();
    if !bytes
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || is_sep(b))
    {
        return Err(bad("use lowercase letters, digits, '.', '-' or '_'"));
    }
    if is_sep(bytes[0]) || is_sep(bytes[bytes.len() - 1]) {
        return Err(bad("must start and end with a letter or digit"));
    }
    if bytes.windows(2).any(|w| is_sep(w[0]) && is_sep(w[1])) {
        return Err(bad("separators must not follow each other"));
    }
    if RESERVED_IDS.contains(&id) {
        return Err(bad("reserved name"));
    }
    Ok(())
}

/// Validate the host of a `net:fetch:<host>` permission: a lowercase,
/// fully qualified DNS name. IP literals, `localhost` and local-only
/// suffixes are refused so plugins cannot reach services on this machine
/// or the LAN.
pub fn validate_fetch_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("missing host".into());
    }
    if host.len() > 253 {
        return Err("host is too long".into());
    }
    if host != host.to_ascii_lowercase() {
        return Err("host must be lowercase".into());
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return Err("host must be a fully qualified domain name".into());
    }
    for label in &labels {
        let ok_chars = label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if label.is_empty()
            || label.len() > 63
            || !ok_chars
            || label.starts_with('-')
            || label.ends_with('-')
        {
            return Err(format!("\"{host}\" is not a valid host name"));
        }
    }
    let tld = labels[labels.len() - 1];
    if !tld.bytes().any(|b| b.is_ascii_lowercase()) {
        return Err("IP addresses are not allowed".into());
    }
    if matches!(tld, "localhost" | "local" | "internal" | "lan" | "home") {
        return Err("local host names are not allowed".into());
    }
    Ok(())
}

/// Validate one permission string.
pub fn validate_permission(permission: &str) -> Result<(), String> {
    if PERMISSIONS.contains(&permission) {
        return Ok(());
    }
    if let Some(host) = permission.strip_prefix(NET_FETCH_PREFIX) {
        return validate_fetch_host(host).map_err(|why| format!("\"{permission}\": {why}"));
    }
    Err(format!("unknown permission \"{permission}\""))
}

fn validate_main_path(main: &str) -> Result<(), String> {
    if main.is_empty() || main.len() > 128 {
        return Err("main must be 1–128 characters".into());
    }
    if main.contains('\\') || main.contains(':') || main.contains('\0') || main.starts_with('/') {
        return Err("main must be a relative path inside the plugin folder".into());
    }
    if main
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.'))
    {
        return Err("main must not contain empty, '.', '..' or hidden segments".into());
    }
    if !(main.ends_with(".js") || main.ends_with(".mjs")) {
        return Err("main must be a .js or .mjs file".into());
    }
    Ok(())
}

fn parse_strict_version(value: &str, field: &str) -> Result<Version, AetherError> {
    if value.trim() != value || value.starts_with(['v', 'V']) {
        return Err(manifest_error(format!(
            "{field} \"{value}\" must be a plain SemVer version like 1.0.0"
        )));
    }
    Version::parse(value).map_err(|e| manifest_error(format!("{field}: {}", reason(e))))
}

fn check_text(field: &str, value: &str, min: usize, max: usize) -> Result<(), AetherError> {
    let len = value.trim().chars().count();
    if len < min || value.chars().count() > max {
        return Err(manifest_error(format!(
            "{field} must be {min}–{max} characters"
        )));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(manifest_error(format!(
            "{field} must not contain control characters"
        )));
    }
    Ok(())
}

fn is_valid_setting_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && key.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Check a setting value against its spec (used for defaults and user
/// input alike).
fn validate_setting_value(spec: &PluginSettingSpec, value: &Value) -> Result<(), String> {
    match spec.kind {
        PluginSettingType::String => match value.as_str() {
            Some(s) if s.chars().count() <= MAX_STRING_SETTING_CHARS => Ok(()),
            Some(_) => Err(format!(
                "must be at most {MAX_STRING_SETTING_CHARS} characters"
            )),
            None => Err("must be a string".into()),
        },
        PluginSettingType::Number => {
            let n = value
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or("must be a finite number")?;
            if spec.min.is_some_and(|min| n < min) || spec.max.is_some_and(|max| n > max) {
                return Err(format!(
                    "must be between {} and {}",
                    spec.min.map_or("-∞".to_owned(), |v| v.to_string()),
                    spec.max.map_or("∞".to_owned(), |v| v.to_string())
                ));
            }
            Ok(())
        }
        PluginSettingType::Boolean => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err("must be true or false".into())
            }
        }
        PluginSettingType::Select => match value.as_str() {
            Some(s) if spec.options.iter().any(|o| o.value == s) => Ok(()),
            _ => Err("must be one of the listed options".into()),
        },
    }
}

fn validate_setting_spec(spec: &PluginSettingSpec) -> Result<(), AetherError> {
    let key = &spec.key;
    if !is_valid_setting_key(key) {
        return Err(manifest_error(format!(
            "setting key \"{key}\" must start with a letter and use only letters, digits or '_' (max 64)"
        )));
    }
    check_text(&format!("settings.{key}.label"), &spec.label, 1, 80)?;
    if let Some(description) = &spec.description {
        check_text(&format!("settings.{key}.description"), description, 0, 300)?;
    }
    let has_bounds = spec.min.is_some() || spec.max.is_some();
    match spec.kind {
        PluginSettingType::Number => {
            if spec.min.is_some_and(|v| !v.is_finite()) || spec.max.is_some_and(|v| !v.is_finite())
            {
                return Err(manifest_error(format!(
                    "settings.{key}: min/max must be finite"
                )));
            }
            if let (Some(min), Some(max)) = (spec.min, spec.max) {
                if min > max {
                    return Err(manifest_error(format!(
                        "settings.{key}: min is larger than max"
                    )));
                }
            }
        }
        _ if has_bounds => {
            return Err(manifest_error(format!(
                "settings.{key}: min/max are only allowed for number settings"
            )));
        }
        _ => {}
    }
    if spec.kind == PluginSettingType::Select {
        if spec.options.is_empty() || spec.options.len() > MAX_SELECT_OPTIONS {
            return Err(manifest_error(format!(
                "settings.{key}: a select needs 1–{MAX_SELECT_OPTIONS} options"
            )));
        }
        let mut seen = BTreeSet::new();
        for option in &spec.options {
            check_text(
                &format!("settings.{key}.options.value"),
                &option.value,
                1,
                100,
            )?;
            check_text(
                &format!("settings.{key}.options.label"),
                &option.label,
                1,
                80,
            )?;
            if !seen.insert(option.value.as_str()) {
                return Err(manifest_error(format!(
                    "settings.{key}: duplicate option \"{}\"",
                    option.value
                )));
            }
        }
    } else if !spec.options.is_empty() {
        return Err(manifest_error(format!(
            "settings.{key}: options are only allowed for select settings"
        )));
    }
    if let Some(default) = &spec.default {
        validate_setting_value(spec, default)
            .map_err(|why| manifest_error(format!("settings.{key}.default {why}")))?;
    }
    Ok(())
}

/// Validate every field of a parsed manifest (no filesystem access).
pub fn validate_manifest(manifest: &PluginManifest) -> Result<(), AetherError> {
    validate_plugin_id(&manifest.id).map_err(|e| manifest_error(reason(e)))?;
    check_text("name", &manifest.name, 1, 64)?;
    parse_strict_version(&manifest.version, "version")?;
    check_text("description", &manifest.description, 0, 500)?;
    check_text("author", &manifest.author, 0, 100)?;
    validate_main_path(&manifest.main).map_err(manifest_error)?;
    if let Some(min) = &manifest.min_app_version {
        let required = parse_strict_version(min, "minAppVersion")?;
        let running = Version::parse(APP_VERSION)?;
        if required > running {
            return Err(manifest_error(format!(
                "requires AETHER-OS {min} or newer (this is {APP_VERSION})"
            )));
        }
    }
    if manifest.permissions.len() > MAX_PERMISSIONS {
        return Err(manifest_error(format!(
            "at most {MAX_PERMISSIONS} permissions are allowed"
        )));
    }
    let mut seen = BTreeSet::new();
    for permission in &manifest.permissions {
        validate_permission(permission).map_err(manifest_error)?;
        if !seen.insert(permission.as_str()) {
            return Err(manifest_error(format!(
                "duplicate permission \"{permission}\""
            )));
        }
    }
    if manifest.settings.len() > MAX_SETTINGS {
        return Err(manifest_error(format!(
            "at most {MAX_SETTINGS} settings are allowed"
        )));
    }
    let mut keys = BTreeSet::new();
    for spec in &manifest.settings {
        validate_setting_spec(spec)?;
        if !keys.insert(spec.key.as_str()) {
            return Err(manifest_error(format!(
                "duplicate setting key \"{}\"",
                spec.key
            )));
        }
    }
    Ok(())
}

/// Parse and validate `manifest.json` content.
pub fn parse_manifest(raw: &str) -> Result<PluginManifest, AetherError> {
    let manifest: PluginManifest = serde_json::from_str(raw).map_err(manifest_error)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Read and validate a package folder: the manifest plus its entry module,
/// which must be a regular file inside the folder and at most 2 MB.
fn load_package(dir: &Path) -> Result<PluginManifest, AetherError> {
    let manifest_path = dir.join(MANIFEST_FILE);
    let meta =
        fs::symlink_metadata(&manifest_path).map_err(|_| invalid("manifest.json is missing"))?;
    if !meta.is_file() {
        return Err(invalid("manifest.json must be a regular file"));
    }
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(invalid("manifest.json is larger than 64 KB"));
    }
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| invalid(format!("cannot read manifest.json: {e}")))?;
    let manifest = parse_manifest(&raw)?;

    let canonical_dir = fs::canonicalize(dir)?;
    let main = fs::canonicalize(dir.join(&manifest.main))
        .map_err(|_| invalid(format!("entry module \"{}\" is missing", manifest.main)))?;
    if !main.starts_with(&canonical_dir) {
        return Err(invalid(format!(
            "entry module \"{}\" resolves outside the plugin folder",
            manifest.main
        )));
    }
    let main_meta = fs::metadata(&main)?;
    if !main_meta.is_file() {
        return Err(invalid(format!(
            "entry module \"{}\" is not a file",
            manifest.main
        )));
    }
    if main_meta.len() > MAX_MAIN_BYTES {
        return Err(invalid(format!(
            "entry module \"{}\" is larger than 2 MB",
            manifest.main
        )));
    }
    Ok(manifest)
}

fn placeholder_manifest(folder: &str) -> PluginManifest {
    PluginManifest {
        id: folder.to_owned(),
        name: folder.to_owned(),
        version: "0.0.0".to_owned(),
        description: String::new(),
        author: String::new(),
        main: default_main(),
        min_app_version: None,
        permissions: Vec::new(),
        settings: Vec::new(),
    }
}

fn fingerprint(manifest: &PluginManifest, dir: &Path) -> String {
    let stamp = fs::metadata(dir.join(&manifest.main))
        .ok()
        .map(|m| {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            format!("{}-{modified}", m.len())
        })
        .unwrap_or_default();
    format!("{}:{stamp}", manifest.version)
}

// ── Settings helpers ────────────────────────────────────────────────────

fn default_setting_value(spec: &PluginSettingSpec) -> Value {
    if let Some(default) = &spec.default {
        return default.clone();
    }
    match spec.kind {
        PluginSettingType::String => Value::String(String::new()),
        PluginSettingType::Number => serde_json::Number::from_f64(spec.min.unwrap_or(0.0))
            .map_or(Value::from(0), Value::Number),
        PluginSettingType::Boolean => Value::Bool(false),
        PluginSettingType::Select => spec
            .options
            .first()
            .map_or(Value::Null, |o| Value::String(o.value.clone())),
    }
}

/// Stored values that still match the manifest, defaults for everything
/// else; keys the manifest no longer declares are dropped.
fn effective_settings(
    specs: &[PluginSettingSpec],
    stored: &Map<String, Value>,
) -> Map<String, Value> {
    specs
        .iter()
        .map(|spec| {
            let value = stored
                .get(&spec.key)
                .filter(|v| validate_setting_value(spec, v).is_ok())
                .cloned()
                .unwrap_or_else(|| default_setting_value(spec));
            (spec.key.clone(), value)
        })
        .collect()
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, AetherError> {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) | Err(_) => Err(invalid(format!("{} is corrupt", path.display()))),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(e.into()),
    }
}

/// Write via a temporary file and rename so a crash never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AetherError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

// ── Vault path helpers ──────────────────────────────────────────────────

/// Validate a vault-relative note path coming from a plugin: forward
/// slashes only, no absolute paths, drive letters, `.`/`..` or hidden
/// segments, and it must name a `.md` file.
pub fn sanitize_vault_path(path: &str) -> Result<String, AetherError> {
    let bad = || {
        invalid(format!(
            "invalid vault path \"{path}\": use a vault-relative path to a .md note"
        ))
    };
    let trimmed = path.trim();
    if trimmed.is_empty()
        || trimmed.len() > 1024
        || trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('\0')
    {
        return Err(bad());
    }
    let mut parts = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment == "." || segment == ".." || segment.starts_with('.') {
            return Err(bad());
        }
        parts.push(segment);
    }
    let joined = parts.join("/");
    if joined.is_empty() || !joined.to_ascii_lowercase().ends_with(".md") {
        return Err(bad());
    }
    Ok(joined)
}

/// Turn a note title (optionally with `folder/` prefixes) into a safe
/// vault-relative path; characters that are invalid in file names become
/// `-`, `.`/`..` and hidden segments are dropped.
fn note_path_from_title(title: &str) -> Result<String, AetherError> {
    let mut parts = Vec::new();
    for segment in title.split('/') {
        let cleaned: String = segment
            .chars()
            .map(|c| {
                if c.is_control() || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                    '-'
                } else {
                    c
                }
            })
            .collect();
        let cleaned = cleaned.trim().trim_start_matches('.').trim();
        if !cleaned.is_empty() {
            parts.push(cleaned.to_owned());
        }
    }
    if parts.is_empty() {
        return Err(invalid("note title is required"));
    }
    if parts.len() > 6 {
        return Err(invalid("note title has too many folder levels"));
    }
    let joined = parts.join("/");
    if joined.chars().count() > 200 {
        return Err(invalid("note title is longer than 200 characters"));
    }
    Ok(joined)
}

fn to_slash(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn configured_vault(vault: &VaultReader) -> Result<String, AetherError> {
    vault
        .detect_vault_path()
        .ok_or_else(|| AetherError::Vault("no vault path configured".into()))
}

fn canonical_vault_root(vault: &VaultReader) -> Result<PathBuf, AetherError> {
    let path = configured_vault(vault)?;
    fs::canonicalize(&path).map_err(|e| AetherError::Vault(format!("vault canonicalize: {e}")))
}

/// Resolve an existing note inside the canonical vault root (symlinks that
/// leave the vault are rejected).
fn resolve_existing_note(root: &Path, rel: &str) -> Result<PathBuf, AetherError> {
    let canonical = fs::canonicalize(root.join(rel))
        .map_err(|_| AetherError::Vault(format!("note not found: {rel}")))?;
    if !canonical.starts_with(root) {
        return Err(AetherError::Vault(format!(
            "refusing to access a path outside the vault: {rel}"
        )));
    }
    if !canonical.is_file() {
        return Err(AetherError::Vault(format!("note not found: {rel}")));
    }
    Ok(canonical)
}

/// Create the missing parent folders of `abs`, but only after checking
/// that the deepest existing ancestor really lies inside the vault.
fn ensure_parent_inside(root: &Path, abs: &Path) -> Result<(), AetherError> {
    let parent = abs
        .parent()
        .ok_or_else(|| AetherError::Vault("note path has no parent".into()))?;
    let mut existing = parent;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| AetherError::Vault("note path has no existing parent".into()))?;
    }
    let canonical = fs::canonicalize(existing)?;
    if !canonical.starts_with(root) {
        return Err(AetherError::Vault(format!(
            "refusing to write outside the vault: {}",
            abs.display()
        )));
    }
    fs::create_dir_all(parent)?;
    Ok(())
}

// ── Network helper ──────────────────────────────────────────────────────

/// Check `raw` against the plugin's `net:fetch:<host>` grants. Only
/// `https` URLs on the default port, without credentials, whose host
/// exactly matches a granted host pass.
pub fn check_fetch_url(granted: &[String], raw: &str) -> Result<url::Url, AetherError> {
    let url =
        url::Url::parse(raw.trim()).map_err(|e| invalid(format!("invalid URL \"{raw}\": {e}")))?;
    if url.scheme() != "https" {
        return Err(invalid("plugins may only fetch https:// URLs"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("URLs with credentials are not allowed"));
    }
    if url.port().is_some() {
        return Err(invalid("URLs with a custom port are not allowed"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| invalid("URL has no host"))?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let allowed = granted
        .iter()
        .filter_map(|p| p.strip_prefix(NET_FETCH_PREFIX))
        .any(|h| h == host);
    if !allowed {
        return Err(invalid(format!(
            "permission denied: \"{NET_FETCH_PREFIX}{host}\" has not been granted"
        )));
    }
    Ok(url)
}

// ── Package installation helpers ────────────────────────────────────────

#[derive(Default)]
struct CopyBudget {
    files: usize,
    bytes: u64,
}

impl CopyBudget {
    fn add_file(&mut self, len: u64) -> Result<(), AetherError> {
        self.files += 1;
        self.bytes = self.bytes.saturating_add(len);
        if self.files > MAX_PACKAGE_FILES {
            return Err(invalid(format!(
                "plugin package has more than {MAX_PACKAGE_FILES} files"
            )));
        }
        if self.bytes > MAX_PACKAGE_BYTES {
            return Err(invalid("plugin package is larger than 20 MB"));
        }
        Ok(())
    }
}

/// Copy a plugin folder. Hidden entries (`.git`, `.DS_Store`),
/// `node_modules` and symlinks are skipped; size and file count are capped.
fn copy_package(
    src: &Path,
    dst: &Path,
    depth: usize,
    budget: &mut CopyBudget,
) -> Result<(), AetherError> {
    if depth > MAX_PACKAGE_DEPTH {
        return Err(invalid("plugin folder is nested too deeply"));
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "node_modules" {
            continue;
        }
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(&name);
        if file_type.is_dir() {
            copy_package(&from, &to, depth + 1, budget)?;
        } else if file_type.is_file() {
            budget.add_file(entry.metadata()?.len())?;
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Map a zip entry name to a relative path. Absolute names, drive letters,
/// backslashes and any `..` segment reject the whole archive; macOS
/// resource forks and hidden files are skipped (`Ok(None)`).
fn safe_zip_entry_path(raw: &str) -> Result<Option<PathBuf>, AetherError> {
    let traversal = || invalid(format!("zip entry \"{raw}\" escapes the plugin folder"));
    if raw.starts_with('/') || raw.contains('\\') || raw.contains(':') || raw.contains('\0') {
        return Err(traversal());
    }
    let mut parts = Vec::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return Err(traversal()),
            other => parts.push(other),
        }
    }
    if parts.is_empty() || parts[0] == "__MACOSX" || parts.iter().any(|p| p.starts_with('.')) {
        return Ok(None);
    }
    if parts.len() > MAX_PACKAGE_DEPTH + 1 {
        return Err(invalid("plugin archive is nested too deeply"));
    }
    Ok(Some(parts.iter().collect()))
}

fn zip_error(e: zip::result::ZipError) -> AetherError {
    invalid(format!("cannot read zip archive: {e}"))
}

/// Extract a plugin archive into `dst`. All entry names are validated
/// before anything is written; symlink entries are refused; the real
/// number of extracted bytes is capped (declared sizes can lie).
fn extract_zip(zip_path: &Path, dst: &Path) -> Result<(), AetherError> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(zip_error)?;
    if archive.len() > MAX_PACKAGE_FILES * 2 {
        return Err(invalid(format!(
            "plugin archive has more than {MAX_PACKAGE_FILES} files"
        )));
    }

    let mut plan: Vec<(usize, PathBuf, bool)> = Vec::new();
    let mut budget = CopyBudget::default();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(zip_error)?;
        let raw = entry.name().to_owned();
        let Some(rel) = safe_zip_entry_path(&raw)? else {
            continue;
        };
        if entry.enclosed_name().is_none() {
            return Err(invalid(format!(
                "zip entry \"{raw}\" escapes the plugin folder"
            )));
        }
        if entry.is_symlink() {
            return Err(invalid(format!(
                "zip entry \"{raw}\" is a symbolic link, which plugins may not contain"
            )));
        }
        if entry.is_dir() {
            plan.push((index, rel, true));
        } else {
            budget.add_file(entry.size())?;
            plan.push((index, rel, false));
        }
    }

    let mut written: u64 = 0;
    for (index, rel, is_dir) in plan {
        let out = dst.join(&rel);
        if is_dir {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        let mut target = fs::File::create(&out)?;
        let remaining = MAX_PACKAGE_BYTES - written;
        let copied = io::copy(&mut (&mut entry).take(remaining + 1), &mut target)?;
        written += copied;
        if written > MAX_PACKAGE_BYTES {
            return Err(invalid(
                "plugin archive is larger than 20 MB when extracted",
            ));
        }
    }
    Ok(())
}

fn is_zip_file(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    let has_magic = fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_ok()
        && magic == *b"PK\x03\x04";
    has_magic
        || path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
}

/// The folder holding `manifest.json`: the extraction root itself, or its
/// single top-level folder (archives made by zipping a folder).
fn find_package_root(staging: &Path) -> Result<PathBuf, AetherError> {
    if staging.join(MANIFEST_FILE).is_file() {
        return Ok(staging.to_path_buf());
    }
    let mut children = Vec::new();
    for entry in fs::read_dir(staging)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with('.') {
            children.push(entry.path());
        }
    }
    if let [only] = children.as_slice() {
        if only.is_dir() && only.join(MANIFEST_FILE).is_file() {
            return Ok(only.clone());
        }
    }
    Err(invalid(
        "no manifest.json found at the top level of the plugin package",
    ))
}

// ── Manager ─────────────────────────────────────────────────────────────

/// Owns `<data_dir>/plugins/`. Cheap to share; state changes are
/// serialised by an internal lock.
pub struct PluginManager {
    root: PathBuf,
    lock: Mutex<()>,
}

impl PluginManager {
    /// Open (creating as needed) the plugins root and clear leftovers of
    /// interrupted installs.
    pub fn new(root: &Path) -> Result<Self, AetherError> {
        fs::create_dir_all(root.join(DATA_DIR))?;
        let staging = root.join(STAGING_DIR);
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        fs::create_dir_all(&staging)?;
        Ok(Self {
            root: root.to_path_buf(),
            lock: Mutex::new(()),
        })
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state_path(&self) -> PathBuf {
        self.root.join(STATE_FILE)
    }

    /// Current state; a missing or corrupt file means "nothing enabled,
    /// nothing granted", the safe default.
    fn load_state(&self) -> PluginsState {
        fs::read_to_string(self.state_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save_state(&self, state: &PluginsState) -> Result<(), AetherError> {
        let json = serde_json::to_vec_pretty(state)
            .map_err(|e| invalid(format!("cannot serialize plugin state: {e}")))?;
        write_atomic(&self.state_path(), &json)
    }

    fn data_dir(&self, id: &str) -> PathBuf {
        self.root.join(DATA_DIR).join(id)
    }

    fn new_staging_dir(&self) -> Result<PathBuf, AetherError> {
        let dir = self
            .root
            .join(STAGING_DIR)
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// The folder of an installed plugin. `id` must be a plain folder name
    /// (broken packages may have folder names that are not valid ids, and
    /// must still be removable).
    fn plugin_dir(&self, id: &str) -> Result<PathBuf, AetherError> {
        if id.is_empty()
            || id.len() > 255
            || id.starts_with('.')
            || id.contains(['/', '\\', ':', '\0'])
        {
            return Err(invalid(format!("invalid plugin id \"{id}\"")));
        }
        let dir = self.root.join(id);
        if !dir.is_dir() {
            return Err(invalid(format!("plugin \"{id}\" is not installed")));
        }
        Ok(dir)
    }

    /// Validated manifest of an installed plugin whose id matches its folder.
    fn valid_manifest(&self, id: &str) -> Result<(PluginManifest, PathBuf), AetherError> {
        let dir = self.plugin_dir(id)?;
        let manifest = load_package(&dir)
            .map_err(|e| invalid(format!("plugin \"{id}\" is broken: {}", reason(e))))?;
        if manifest.id != id {
            return Err(invalid(format!(
                "plugin \"{id}\" is broken: manifest id \"{}\" does not match the folder name",
                manifest.id
            )));
        }
        Ok((manifest, dir))
    }

    /// Manifest and granted permissions of an enabled, valid plugin.
    fn require_enabled(
        &self,
        id: &str,
    ) -> Result<(PluginManifest, PathBuf, Vec<String>), AetherError> {
        let (manifest, dir) = self.valid_manifest(id)?;
        let state = self.load_state();
        let entry = state.plugins.get(id).cloned().unwrap_or_default();
        if !entry.enabled {
            return Err(invalid(format!("plugin \"{id}\" is disabled")));
        }
        let granted = granted_in_manifest_order(&manifest, &entry.granted);
        Ok((manifest, dir, granted))
    }

    /// Verify that plugin `id` is installed, valid, enabled and was granted
    /// `permission`.
    pub fn require_permission(
        &self,
        id: &str,
        permission: &str,
    ) -> Result<PluginManifest, AetherError> {
        let (manifest, _, granted) = self.require_enabled(id)?;
        if !granted.iter().any(|p| p == permission) {
            return Err(permission_denied(id, permission));
        }
        Ok(manifest)
    }

    fn info_for(&self, folder: &str, dir: &Path, state: &PluginsState) -> PluginInfo {
        let entry = state.plugins.get(folder).cloned().unwrap_or_default();
        let loaded = load_package(dir).and_then(|manifest| {
            if manifest.id == folder {
                Ok(manifest)
            } else {
                Err(invalid(format!(
                    "manifest id \"{}\" does not match the folder name \"{folder}\"",
                    manifest.id
                )))
            }
        });
        let path = dir.to_string_lossy().into_owned();
        match loaded {
            Ok(manifest) => PluginInfo {
                enabled: entry.enabled,
                granted_permissions: granted_in_manifest_order(&manifest, &entry.granted),
                fingerprint: fingerprint(&manifest, dir),
                manifest,
                path,
                error: None,
                bundled: entry.bundled,
            },
            Err(e) => PluginInfo {
                manifest: placeholder_manifest(folder),
                enabled: false,
                granted_permissions: Vec::new(),
                path,
                error: Some(reason(e)),
                fingerprint: String::new(),
                bundled: entry.bundled,
            },
        }
    }

    /// Every folder in the plugins root, valid or not, sorted by name.
    pub fn list(&self) -> Result<Vec<PluginInfo>, AetherError> {
        let state = self.load_state();
        let mut plugins = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            plugins.push(self.info_for(&name, &entry.path(), &state));
        }
        plugins.sort_by(|a, b| {
            a.manifest
                .name
                .to_lowercase()
                .cmp(&b.manifest.name.to_lowercase())
                .then_with(|| a.manifest.id.cmp(&b.manifest.id))
        });
        Ok(plugins)
    }

    /// Enable or disable a plugin. Only valid packages can be enabled.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<PluginInfo, AetherError> {
        let _guard = self.guard();
        let dir = if enabled {
            self.valid_manifest(id)?.1
        } else {
            self.plugin_dir(id)?
        };
        let mut state = self.load_state();
        state.plugins.entry(id.to_owned()).or_default().enabled = enabled;
        self.save_state(&state)?;
        Ok(self.info_for(id, &dir, &state))
    }

    /// Replace the granted permissions. Every entry must be requested by the
    /// manifest.
    pub fn set_permissions(
        &self,
        id: &str,
        permissions: &[String],
    ) -> Result<PluginInfo, AetherError> {
        let _guard = self.guard();
        let (manifest, dir) = self.valid_manifest(id)?;
        for permission in permissions {
            if !manifest.permissions.contains(permission) {
                return Err(invalid(format!(
                    "plugin \"{id}\" does not request the permission \"{permission}\""
                )));
            }
        }
        let mut state = self.load_state();
        state.plugins.entry(id.to_owned()).or_default().granted =
            permissions.iter().cloned().collect();
        self.save_state(&state)?;
        Ok(self.info_for(id, &dir, &state))
    }

    /// Install (or update) a plugin from an absolute folder or `.zip` path.
    /// The package is copied/extracted into a staging folder, validated
    /// there and only then moved into place, replacing an older version.
    /// Settings and storage survive updates; grants are narrowed to the new
    /// manifest's permissions.
    pub fn install_from_path(&self, source: &str) -> Result<PluginInfo, AetherError> {
        let source = PathBuf::from(source.trim());
        if !source.is_absolute() {
            return Err(invalid("the plugin path must be absolute"));
        }
        let meta = fs::metadata(&source)
            .map_err(|_| invalid(format!("no such file or folder: {}", source.display())))?;
        let staging = self.new_staging_dir()?;
        let result = self.install_via_staging(&source, meta.is_dir(), &staging);
        let _ = fs::remove_dir_all(&staging);
        result
    }

    fn install_via_staging(
        &self,
        source: &Path,
        is_dir: bool,
        staging: &Path,
    ) -> Result<PluginInfo, AetherError> {
        let unpacked = staging.join("package");
        if is_dir {
            copy_package(source, &unpacked, 0, &mut CopyBudget::default())?;
        } else if is_zip_file(source) {
            fs::create_dir_all(&unpacked)?;
            extract_zip(source, &unpacked)?;
        } else {
            return Err(invalid("choose a plugin folder or a .zip archive"));
        }
        let package = find_package_root(&unpacked)?;
        let manifest = load_package(&package)?;
        self.commit_install(&package, &manifest, false)
    }

    fn commit_install(
        &self,
        package: &Path,
        manifest: &PluginManifest,
        bundled: bool,
    ) -> Result<PluginInfo, AetherError> {
        let _guard = self.guard();
        let target = self.root.join(&manifest.id);
        let backup = if fs::symlink_metadata(&target).is_ok() {
            let backup = self.new_staging_dir()?.join("previous");
            fs::rename(&target, &backup)?;
            Some(backup)
        } else {
            None
        };
        if let Err(e) = fs::rename(package, &target) {
            if let Some(backup) = &backup {
                let _ = fs::rename(backup, &target);
            }
            return Err(e.into());
        }
        if let Some(backup) = backup {
            if let Some(dir) = backup.parent() {
                let _ = fs::remove_dir_all(dir);
            }
        }
        let mut state = self.load_state();
        let entry = state.plugins.entry(manifest.id.clone()).or_default();
        entry.granted.retain(|p| manifest.permissions.contains(p));
        entry.bundled = bundled;
        self.save_state(&state)?;
        Ok(self.info_for(&manifest.id, &target, &state))
    }

    /// Copy the bundled example plugins into the plugins root, once. An
    /// example the user uninstalled is never reinstalled; one whose folder
    /// already exists is left alone. Returns the ids installed now.
    pub fn install_examples(&self) -> Result<Vec<String>, AetherError> {
        let mut installed = Vec::new();
        for example in &BUNDLED_EXAMPLES {
            let manifest = parse_manifest(example.manifest)?;
            let already_seeded = self.load_state().seeded_examples.contains(&manifest.id);
            if already_seeded {
                continue;
            }
            if fs::symlink_metadata(self.root.join(&manifest.id)).is_err() {
                let staging = self.new_staging_dir()?;
                let package = staging.join("package");
                fs::create_dir_all(&package)?;
                fs::write(package.join(MANIFEST_FILE), example.manifest)?;
                fs::write(package.join(&manifest.main), example.main)?;
                let result = self.commit_install(&package, &manifest, true);
                let _ = fs::remove_dir_all(&staging);
                result?;
                installed.push(manifest.id.clone());
            }
            let _guard = self.guard();
            let mut state = self.load_state();
            state.seeded_examples.insert(manifest.id.clone());
            self.save_state(&state)?;
        }
        Ok(installed)
    }

    /// Remove a plugin, its settings and its storage. A symlinked plugin
    /// folder (a development checkout) is unlinked, never deleted.
    pub fn uninstall(&self, id: &str) -> Result<(), AetherError> {
        let _guard = self.guard();
        let dir = self.plugin_dir(id)?;
        if fs::symlink_metadata(&dir)?.file_type().is_symlink() {
            fs::remove_file(&dir)?;
        } else {
            fs::remove_dir_all(&dir)?;
        }
        let data = self.data_dir(id);
        if data.exists() {
            fs::remove_dir_all(&data)?;
        }
        let mut state = self.load_state();
        state.plugins.remove(id);
        self.save_state(&state)
    }

    /// Source of an enabled plugin's entry module (loaded into its worker).
    pub fn read_source(&self, id: &str) -> Result<String, AetherError> {
        let (manifest, dir, _) = self.require_enabled(id)?;
        let path = dir.join(&manifest.main);
        if fs::metadata(&path)?.len() > MAX_MAIN_BYTES {
            return Err(invalid("entry module is larger than 2 MB"));
        }
        fs::read_to_string(&path)
            .map_err(|e| invalid(format!("cannot read {}: {e}", manifest.main)))
    }

    /// Effective settings: stored values merged over manifest defaults.
    pub fn get_settings(&self, id: &str) -> Result<Map<String, Value>, AetherError> {
        let (manifest, _) = self.valid_manifest(id)?;
        let stored = read_json_object(&self.data_dir(id).join(SETTINGS_FILE))?;
        Ok(effective_settings(&manifest.settings, &stored))
    }

    /// Update some settings (a JSON object of `key → value`). Unknown keys
    /// and values of the wrong type are rejected. Returns all settings.
    pub fn set_settings(
        &self,
        id: &str,
        values: &Value,
    ) -> Result<Map<String, Value>, AetherError> {
        let (manifest, _) = self.valid_manifest(id)?;
        let Value::Object(patch) = values else {
            return Err(invalid("plugin settings must be a JSON object"));
        };
        let _guard = self.guard();
        let path = self.data_dir(id).join(SETTINGS_FILE);
        let mut current = effective_settings(&manifest.settings, &read_json_object(&path)?);
        for (key, value) in patch {
            let spec = manifest
                .settings
                .iter()
                .find(|s| &s.key == key)
                .ok_or_else(|| invalid(format!("unknown setting \"{key}\"")))?;
            validate_setting_value(spec, value)
                .map_err(|why| invalid(format!("setting \"{}\" {why}", spec.label)))?;
            current.insert(key.clone(), value.clone());
        }
        let json = serde_json::to_vec_pretty(&Value::Object(current.clone()))
            .map_err(|e| invalid(format!("cannot serialize settings: {e}")))?;
        write_atomic(&path, &json)?;
        Ok(current)
    }

    fn validate_storage_key(key: &str) -> Result<(), AetherError> {
        let len = key.chars().count();
        if len == 0 || len > MAX_STORAGE_KEY_CHARS || key.chars().any(|c| c.is_control()) {
            return Err(invalid(format!(
                "storage keys must be 1–{MAX_STORAGE_KEY_CHARS} printable characters"
            )));
        }
        Ok(())
    }

    /// Read one value from the plugin's storage.
    pub fn storage_get(&self, id: &str, key: &str) -> Result<Option<Value>, AetherError> {
        self.require_enabled(id)?;
        Self::validate_storage_key(key)?;
        let map = read_json_object(&self.data_dir(id).join(STORAGE_FILE))?;
        Ok(map.get(key).cloned())
    }

    /// Store (`Some`) or delete (`None`) one value. The whole storage of a
    /// plugin is limited to 1 MB of JSON.
    pub fn storage_set(
        &self,
        id: &str,
        key: &str,
        value: Option<Value>,
    ) -> Result<(), AetherError> {
        self.require_enabled(id)?;
        Self::validate_storage_key(key)?;
        let _guard = self.guard();
        let path = self.data_dir(id).join(STORAGE_FILE);
        let mut map = read_json_object(&path)?;
        match value {
            Some(value) => {
                map.insert(key.to_owned(), value);
            }
            None => {
                map.remove(key);
            }
        }
        let json = serde_json::to_vec(&Value::Object(map))
            .map_err(|e| invalid(format!("cannot serialize storage: {e}")))?;
        if json.len() > MAX_STORAGE_BYTES {
            return Err(invalid("plugin storage is limited to 1 MB"));
        }
        write_atomic(&path, &json)
    }

    /// Reveal the plugins root (or one plugin's folder) in the file manager.
    pub fn open_folder(&self, id: Option<&str>) -> Result<(), AetherError> {
        let path = match id {
            Some(id) => self.plugin_dir(id)?,
            None => self.root.clone(),
        };
        crate::engine::diagnostics::open_in_file_manager(&path)
    }

    // ── Capability-checked host operations ──

    /// All vault notes with vault-relative paths (`vault:read`).
    pub fn vault_list(
        &self,
        vault: &VaultReader,
        id: &str,
    ) -> Result<Vec<PluginVaultNote>, AetherError> {
        self.require_permission(id, "vault:read")?;
        let vault_path = configured_vault(vault)?;
        let root = Path::new(&vault_path);
        Ok(vault
            .scan_vault(&vault_path)?
            .into_iter()
            .filter_map(|note| {
                let rel = Path::new(&note.path).strip_prefix(root).ok()?;
                Some(PluginVaultNote {
                    path: to_slash(rel),
                    name: note.name,
                    mtime: note.mtime,
                })
            })
            .collect())
    }

    /// Content of a vault note (`vault:read`).
    pub fn vault_read(
        &self,
        vault: &VaultReader,
        id: &str,
        path: &str,
    ) -> Result<String, AetherError> {
        self.require_permission(id, "vault:read")?;
        let rel = sanitize_vault_path(path)?;
        let root = canonical_vault_root(vault)?;
        let abs = resolve_existing_note(&root, &rel)?;
        if fs::metadata(&abs)?.len() > MAX_NOTE_BYTES as u64 {
            return Err(invalid(format!("note is larger than 5 MB: {rel}")));
        }
        vault.read_note(&abs.to_string_lossy())
    }

    /// Create or overwrite a vault note (`vault:write`). Missing folders are
    /// created inside the vault.
    pub fn vault_write(
        &self,
        vault: &VaultReader,
        id: &str,
        path: &str,
        content: &str,
    ) -> Result<(), AetherError> {
        self.require_permission(id, "vault:write")?;
        if content.len() > MAX_NOTE_BYTES {
            return Err(invalid("note content is larger than 5 MB"));
        }
        let rel = sanitize_vault_path(path)?;
        let root = canonical_vault_root(vault)?;
        let abs = root.join(&rel);
        ensure_parent_inside(&root, &abs)?;
        vault.write_note(&abs.to_string_lossy(), content)
    }

    /// Create a new note without overwriting an existing one
    /// (`notes:create`). Returns the vault-relative path it was written to.
    pub fn note_create(
        &self,
        vault: &VaultReader,
        id: &str,
        title: &str,
        content: &str,
    ) -> Result<String, AetherError> {
        self.require_permission(id, "notes:create")?;
        if content.len() > MAX_NOTE_BYTES {
            return Err(invalid("note content is larger than 5 MB"));
        }
        let rel = note_path_from_title(title)?;
        let vault_path = configured_vault(vault)?;
        let abs = vault.create_note(&rel, content)?;
        let created = Path::new(&abs)
            .strip_prefix(&vault_path)
            .map(to_slash)
            .map_err(|_| AetherError::Vault("created note is outside the vault".into()))?;
        Ok(created)
    }

    /// HTTPS GET for a plugin, allowed only for hosts granted through
    /// `net:fetch:<host>`. Redirects are followed only to granted hosts; the
    /// body is capped at 5 MB.
    pub async fn fetch(&self, id: &str, url: &str) -> Result<PluginFetchResponse, AetherError> {
        let (_, _, granted) = self.require_enabled(id)?;
        let target = check_fetch_url(&granted, url)?;
        let redirect_grants = granted.clone();
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if check_fetch_url(&redirect_grants, attempt.url().as_str()).is_ok() {
                attempt.follow()
            } else {
                let host = attempt.url().host_str().unwrap_or_default().to_owned();
                attempt.error(format!("redirect to a host that is not granted: {host}"))
            }
        });
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(policy)
            .user_agent(format!("AETHER-OS/{APP_VERSION} (plugin {id})"))
            .build()
            .map_err(|e| AetherError::Network(e.to_string()))?;
        let mut response = client
            .get(target)
            .send()
            .await
            .map_err(|e| AetherError::Network(e.to_string()))?;
        if response
            .content_length()
            .is_some_and(|len| len > MAX_FETCH_BYTES as u64)
        {
            return Err(AetherError::Network("response is larger than 5 MB".into()));
        }
        let status = response.status();
        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| AetherError::Network(e.to_string()))?
        {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_FETCH_BYTES {
                return Err(AetherError::Network("response is larger than 5 MB".into()));
            }
        }
        Ok(PluginFetchResponse {
            url: final_url,
            status: status.as_u16(),
            ok: status.is_success(),
            content_type,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }
}

fn granted_in_manifest_order(manifest: &PluginManifest, granted: &BTreeSet<String>) -> Vec<String> {
    manifest
        .permissions
        .iter()
        .filter(|p| granted.contains(*p))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{tempdir, TempDir};

    const MAIN_JS: &str = "export function activate(api) {}\n";

    fn manifest_json(id: &str, permissions: &[&str]) -> String {
        serde_json::json!({
            "id": id,
            "name": "Test Plugin",
            "version": "1.2.3",
            "description": "A plugin used in tests.",
            "author": "Tests",
            "main": "main.js",
            "minAppVersion": "0.1.0",
            "permissions": permissions,
            "settings": [
                { "key": "threshold", "type": "number", "label": "Threshold", "default": 500, "min": 0, "max": 1000 },
                { "key": "title", "type": "string", "label": "Title", "default": "Hello" },
                { "key": "enabled", "type": "boolean", "label": "On" },
                { "key": "mode", "type": "select", "label": "Mode", "default": "b",
                  "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }] }
            ]
        })
        .to_string()
    }

    /// A manifest JSON with one top-level field replaced.
    fn manifest_with(field: &str, value: serde_json::Value) -> String {
        let mut json: Value =
            serde_json::from_str(&manifest_json("com.example.test", &[])).unwrap();
        json[field] = value;
        json.to_string()
    }

    fn write_package(dir: &Path, manifest: &str, main: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), manifest).unwrap();
        fs::write(dir.join("main.js"), main).unwrap();
    }

    fn manager() -> (TempDir, PluginManager) {
        let dir = tempdir().expect("temp dir");
        let manager = PluginManager::new(&dir.path().join("plugins")).expect("manager");
        (dir, manager)
    }

    /// Install a package with `permissions` from a temporary source folder.
    fn install(manager: &PluginManager, tmp: &Path, id: &str, permissions: &[&str]) -> PluginInfo {
        let source = tmp.join(format!("src-{id}"));
        write_package(&source, &manifest_json(id, permissions), MAIN_JS);
        manager
            .install_from_path(source.to_str().unwrap())
            .expect("install")
    }

    /// Install, enable and grant every requested permission.
    fn install_enabled(manager: &PluginManager, tmp: &Path, id: &str, permissions: &[&str]) {
        install(manager, tmp, id, permissions);
        let granted: Vec<String> = permissions.iter().map(|p| p.to_string()).collect();
        manager.set_permissions(id, &granted).expect("grant");
        manager.set_enabled(id, true).expect("enable");
    }

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    fn vault_reader() -> (TempDir, TempDir, VaultReader) {
        let vault = tempdir().expect("vault dir");
        let config = tempdir().expect("config dir");
        let reader = VaultReader::new(config.path()).expect("reader");
        reader
            .set_vault_path(vault.path().to_str().unwrap())
            .expect("set vault");
        (vault, config, reader)
    }

    fn assert_err_contains<T: std::fmt::Debug>(result: Result<T, AetherError>, needle: &str) {
        let error = result.expect_err("expected an error").to_string();
        assert!(
            error.contains(needle),
            "\"{error}\" does not contain \"{needle}\""
        );
    }

    // ── Manifest validation ──

    #[test]
    fn accepts_a_complete_manifest() {
        let manifest = parse_manifest(&manifest_json(
            "com.example.wordcount",
            &["vault:read", "ui:panel", "net:fetch:api.github.com"],
        ))
        .expect("valid manifest");
        assert_eq!(manifest.id, "com.example.wordcount");
        assert_eq!(manifest.settings.len(), 4);
        assert_eq!(manifest.settings[3].kind, PluginSettingType::Select);
    }

    #[test]
    fn defaults_main_and_optional_fields() {
        let manifest = parse_manifest(r#"{ "id": "ab", "name": "Minimal", "version": "0.1.0" }"#);
        assert_err_contains(manifest, "3–64");
        let manifest =
            parse_manifest(r#"{ "id": "abc", "name": "Minimal", "version": "0.1.0" }"#).unwrap();
        assert_eq!(manifest.main, "main.js");
        assert!(manifest.permissions.is_empty());
        assert!(manifest.min_app_version.is_none());
    }

    #[test]
    fn bundled_examples_are_valid() {
        for example in &BUNDLED_EXAMPLES {
            let manifest = parse_manifest(example.manifest).expect("example manifest");
            assert!(manifest.id.starts_with("aether."));
            assert!(example.main.contains("export async function activate"));
        }
    }

    #[test]
    fn rejects_bad_plugin_ids() {
        for id in [
            "",
            "ab",
            "Com.Example",
            "com..example",
            "com/example",
            "../escape",
            ".hidden",
            "trailing-",
            "has space",
            "state.json",
            &"x".repeat(65),
        ] {
            assert!(validate_plugin_id(id).is_err(), "{id:?} must be rejected");
        }
        for id in ["com.example.wordcount", "aether.word-count", "my_plugin2"] {
            validate_plugin_id(id).unwrap_or_else(|e| panic!("{id}: {e}"));
        }
    }

    #[test]
    fn rejects_non_semver_versions() {
        for version in ["1.0", "v1.0.0", "01.0.0", "1.0.0-", " 1.0.0", "latest"] {
            assert_err_contains(
                parse_manifest(&manifest_with("version", Value::from(version))),
                "invalid plugin manifest",
            );
        }
        parse_manifest(&manifest_with(
            "version",
            Value::from("2.0.0-beta.1+build.5"),
        ))
        .expect("pre-release versions are valid");
    }

    #[test]
    fn rejects_unknown_permissions_and_bad_hosts() {
        for permission in [
            "vault:delete",
            "net:fetch:",
            "net:fetch:localhost",
            "net:fetch:127.0.0.1",
            "net:fetch:printer.local",
            "net:fetch:API.GITHUB.COM",
            "net:fetch:api.github.com/path",
            "net:fetch:api.github.com:8080",
            "net:fetch:*.github.com",
            "net:fetch:-bad.com",
        ] {
            assert!(
                validate_permission(permission).is_err(),
                "{permission} must be rejected"
            );
        }
        for permission in [
            "vault:read",
            "clipboard:read",
            "net:fetch:api.github.com",
            "net:fetch:xn--bcher-kva.de",
        ] {
            validate_permission(permission).unwrap_or_else(|e| panic!("{permission}: {e}"));
        }
        assert_err_contains(
            parse_manifest(&manifest_with(
                "permissions",
                serde_json::json!(["ui:panel", "ui:panel"]),
            )),
            "duplicate permission",
        );
    }

    #[test]
    fn rejects_main_paths_outside_the_folder() {
        for main in [
            "../main.js",
            "/abs/main.js",
            "sub/../../main.js",
            "C:\\main.js",
            ".hidden.js",
            "main.ts",
            "",
        ] {
            assert!(
                parse_manifest(&manifest_with("main", Value::from(main))).is_err(),
                "{main:?} must be rejected"
            );
        }
        parse_manifest(&manifest_with("main", Value::from("dist/plugin.mjs")))
            .expect("nested main is valid");
    }

    #[test]
    fn rejects_invalid_settings() {
        let cases = [
            serde_json::json!([{ "key": "1bad", "type": "string", "label": "L" }]),
            serde_json::json!([{ "key": "a", "type": "string", "label": "" }]),
            serde_json::json!([{ "key": "a", "type": "number", "label": "L", "default": "x" }]),
            serde_json::json!([{ "key": "a", "type": "number", "label": "L", "default": 5, "min": 10 }]),
            serde_json::json!([{ "key": "a", "type": "number", "label": "L", "min": 10, "max": 1 }]),
            serde_json::json!([{ "key": "a", "type": "string", "label": "L", "min": 1 }]),
            serde_json::json!([{ "key": "a", "type": "select", "label": "L" }]),
            serde_json::json!([{ "key": "a", "type": "select", "label": "L", "default": "z",
                                 "options": [{ "value": "x", "label": "X" }] }]),
            serde_json::json!([{ "key": "a", "type": "boolean", "label": "L", "options": [{ "value": "x", "label": "X" }] }]),
            serde_json::json!([{ "key": "a", "type": "boolean", "label": "L" }, { "key": "a", "type": "boolean", "label": "M" }]),
            serde_json::json!([{ "key": "a", "type": "color", "label": "L" }]),
            serde_json::json!([{ "key": "a", "type": "boolean", "label": "L", "extra": true }]),
        ];
        for settings in cases {
            assert!(
                parse_manifest(&manifest_with("settings", settings.clone())).is_err(),
                "{settings} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_unknown_fields_and_newer_app_versions() {
        assert_err_contains(
            parse_manifest(&manifest_with(
                "homepage",
                Value::from("https://example.com"),
            )),
            "unknown field",
        );
        assert_err_contains(
            parse_manifest(&manifest_with("minAppVersion", Value::from("99.0.0"))),
            "requires AETHER-OS 99.0.0",
        );
        assert_err_contains(parse_manifest("not json"), "invalid plugin manifest");
    }

    #[test]
    fn load_package_enforces_main_size_and_location() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("pkg");
        write_package(&dir, &manifest_json("com.example.test", &[]), MAIN_JS);
        load_package(&dir).expect("valid package");

        fs::write(
            dir.join("main.js"),
            vec![b'a'; (MAX_MAIN_BYTES + 1) as usize],
        )
        .unwrap();
        assert_err_contains(load_package(&dir), "larger than 2 MB");

        fs::remove_file(dir.join("main.js")).unwrap();
        assert_err_contains(load_package(&dir), "is missing");

        #[cfg(unix)]
        {
            let outside = tmp.path().join("outside.js");
            fs::write(&outside, MAIN_JS).unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("main.js")).unwrap();
            assert_err_contains(load_package(&dir), "outside the plugin folder");
        }
    }

    // ── Installation ──

    #[test]
    fn installs_from_folder_and_lists_the_plugin() {
        let (tmp, manager) = manager();
        let info = install(&manager, tmp.path(), "com.example.test", &["vault:read"]);
        assert_eq!(info.manifest.id, "com.example.test");
        assert!(!info.enabled, "new plugins start disabled");
        assert!(
            info.granted_permissions.is_empty(),
            "nothing is granted up front"
        );
        assert!(info.error.is_none());
        assert!(Path::new(&info.path).join("main.js").is_file());

        let listed = manager.list().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], info);
    }

    #[test]
    fn installs_from_zip_with_a_wrapper_folder() {
        let (tmp, manager) = manager();
        let zip_path = tmp.path().join("plugin.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "word-count/manifest.json",
                    &manifest_json("com.example.zipped", &[]),
                ),
                ("word-count/main.js", MAIN_JS),
                ("__MACOSX/word-count/._main.js", "resource fork"),
                ("word-count/.DS_Store", "junk"),
            ],
        );
        let info = manager
            .install_from_path(zip_path.to_str().unwrap())
            .expect("install zip");
        assert_eq!(info.manifest.id, "com.example.zipped");
        let dir = Path::new(&info.path);
        assert!(dir.join("main.js").is_file());
        assert!(!dir.join(".DS_Store").exists());
    }

    #[test]
    fn rejects_zip_entries_with_path_traversal() {
        let (tmp, manager) = manager();
        for evil in [
            "../evil.js",
            "/tmp/evil.js",
            "pkg/../../evil.js",
            "..\\evil.js",
            "C:/evil.js",
        ] {
            let zip_path = tmp.path().join("evil.zip");
            write_zip(
                &zip_path,
                &[
                    ("manifest.json", &manifest_json("com.example.evil", &[])),
                    ("main.js", MAIN_JS),
                    (evil, "pwned"),
                ],
            );
            assert_err_contains(
                manager.install_from_path(zip_path.to_str().unwrap()),
                "escapes the plugin folder",
            );
            assert!(!tmp.path().join("evil.js").exists());
            assert!(!tmp.path().join("plugins").join("evil.js").exists());
        }
        assert!(
            manager.list().unwrap().is_empty(),
            "nothing may be installed"
        );
    }

    #[test]
    fn rejects_zip_symlink_entries() {
        let (tmp, manager) = manager();
        let zip_path = tmp.path().join("link.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest_json("com.example.link", &[]).as_bytes())
            .unwrap();
        zip.add_symlink("main.js", "/etc/passwd", options).unwrap();
        zip.finish().unwrap();
        assert_err_contains(
            manager.install_from_path(zip_path.to_str().unwrap()),
            "symbolic link",
        );
    }

    #[test]
    fn rejects_invalid_install_sources() {
        let (tmp, manager) = manager();
        assert_err_contains(manager.install_from_path("relative/path"), "absolute");
        assert_err_contains(
            manager.install_from_path(tmp.path().join("missing").to_str().unwrap()),
            "no such file",
        );
        let text = tmp.path().join("notes.txt");
        fs::write(&text, "hello").unwrap();
        assert_err_contains(
            manager.install_from_path(text.to_str().unwrap()),
            "folder or a .zip",
        );
        let empty = tmp.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_err_contains(
            manager.install_from_path(empty.to_str().unwrap()),
            "no manifest.json",
        );
    }

    #[test]
    fn reinstall_keeps_settings_and_narrows_grants() {
        let (tmp, manager) = manager();
        install_enabled(
            &manager,
            tmp.path(),
            "com.example.test",
            &["vault:read", "ui:panel"],
        );
        manager
            .set_settings("com.example.test", &serde_json::json!({ "threshold": 42 }))
            .unwrap();

        let updated = install(
            &manager,
            tmp.path(),
            "com.example.test",
            &["ui:panel", "ai:query"],
        );
        assert!(updated.enabled, "an update keeps the plugin enabled");
        assert_eq!(updated.granted_permissions, vec!["ui:panel".to_owned()]);
        assert_eq!(
            manager.get_settings("com.example.test").unwrap()["threshold"],
            serde_json::json!(42)
        );
    }

    #[test]
    fn uninstall_removes_code_data_and_state() {
        let (tmp, manager) = manager();
        install_enabled(&manager, tmp.path(), "com.example.test", &[]);
        manager
            .storage_set("com.example.test", "k", Some(Value::from(1)))
            .unwrap();
        manager.uninstall("com.example.test").expect("uninstall");
        assert!(manager.list().unwrap().is_empty());
        assert!(!manager.data_dir("com.example.test").exists());
        assert!(!manager
            .load_state()
            .plugins
            .contains_key("com.example.test"));
        assert_err_contains(manager.uninstall("com.example.test"), "not installed");
        assert_err_contains(manager.uninstall("../plugins"), "invalid plugin id");
    }

    #[test]
    fn install_examples_is_idempotent_and_respects_uninstall() {
        let (_tmp, manager) = manager();
        let first = manager.install_examples().expect("examples");
        assert_eq!(first.len(), 3);
        let listed = manager.list().unwrap();
        assert_eq!(listed.len(), 3);
        assert!(listed
            .iter()
            .all(|p| p.bundled && p.error.is_none() && !p.enabled));

        assert!(
            manager.install_examples().unwrap().is_empty(),
            "second run installs nothing"
        );

        manager.uninstall("aether.random-note").unwrap();
        assert!(
            manager.install_examples().unwrap().is_empty(),
            "uninstalled examples stay gone"
        );
        assert_eq!(manager.list().unwrap().len(), 2);
    }

    #[test]
    fn broken_folders_are_listed_with_an_error() {
        let (_tmp, manager) = manager();
        let root = manager.root.clone();
        write_package(
            &root.join("com.example.other"),
            &manifest_json("com.example.mismatch", &[]),
            MAIN_JS,
        );
        fs::create_dir_all(root.join("Not A Plugin")).unwrap();

        let listed = manager.list().unwrap();
        assert_eq!(listed.len(), 2);
        let mismatch = listed
            .iter()
            .find(|p| p.manifest.id == "com.example.other")
            .unwrap();
        assert!(mismatch
            .error
            .as_deref()
            .unwrap()
            .contains("does not match the folder name"));
        let empty = listed
            .iter()
            .find(|p| p.manifest.id == "Not A Plugin")
            .unwrap();
        assert!(empty
            .error
            .as_deref()
            .unwrap()
            .contains("manifest.json is missing"));

        assert_err_contains(manager.set_enabled("com.example.other", true), "broken");
        manager
            .uninstall("Not A Plugin")
            .expect("broken folders can be removed");
    }

    // ── State and permissions ──

    #[test]
    fn grants_must_be_requested_by_the_manifest() {
        let (tmp, manager) = manager();
        install(&manager, tmp.path(), "com.example.test", &["vault:read"]);
        assert_err_contains(
            manager.set_permissions("com.example.test", &["vault:write".to_owned()]),
            "does not request",
        );
        let info = manager
            .set_permissions("com.example.test", &["vault:read".to_owned()])
            .unwrap();
        assert_eq!(info.granted_permissions, vec!["vault:read".to_owned()]);
        let info = manager.set_enabled("com.example.test", true).unwrap();
        assert!(info.enabled);
        assert!(manager
            .require_permission("com.example.test", "vault:read")
            .is_ok());
        assert_err_contains(
            manager.require_permission("com.example.test", "ui:panel"),
            "has not been granted \"ui:panel\"",
        );
    }

    #[test]
    fn read_source_requires_an_enabled_plugin() {
        let (tmp, manager) = manager();
        install(&manager, tmp.path(), "com.example.test", &[]);
        assert_err_contains(manager.read_source("com.example.test"), "disabled");
        manager.set_enabled("com.example.test", true).unwrap();
        assert_eq!(manager.read_source("com.example.test").unwrap(), MAIN_JS);
        assert_err_contains(manager.read_source("com.example.missing"), "not installed");
    }

    #[test]
    fn vault_operations_check_permissions() {
        let (tmp, manager) = manager();
        let (vault, _config, reader) = vault_reader();
        fs::write(vault.path().join("note.md"), "# Note").unwrap();
        install(
            &manager,
            tmp.path(),
            "com.example.test",
            &["vault:read", "vault:write", "notes:create"],
        );

        // Installed but disabled: nothing works.
        assert_err_contains(manager.vault_list(&reader, "com.example.test"), "disabled");

        manager.set_enabled("com.example.test", true).unwrap();
        assert_err_contains(
            manager.vault_list(&reader, "com.example.test"),
            "vault:read",
        );
        assert_err_contains(
            manager.vault_read(&reader, "com.example.test", "note.md"),
            "vault:read",
        );
        assert_err_contains(
            manager.vault_write(&reader, "com.example.test", "note.md", "x"),
            "vault:write",
        );
        assert_err_contains(
            manager.note_create(&reader, "com.example.test", "New", "x"),
            "notes:create",
        );

        manager
            .set_permissions("com.example.test", &["vault:read".to_owned()])
            .unwrap();
        let notes = manager.vault_list(&reader, "com.example.test").unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].path, "note.md");
        assert_eq!(
            manager
                .vault_read(&reader, "com.example.test", "note.md")
                .unwrap(),
            "# Note"
        );
        assert_err_contains(
            manager.vault_write(&reader, "com.example.test", "note.md", "x"),
            "vault:write",
        );
        assert_eq!(
            fs::read_to_string(vault.path().join("note.md")).unwrap(),
            "# Note"
        );
    }

    #[test]
    fn vault_paths_cannot_escape_the_vault() {
        let (tmp, manager) = manager();
        let (vault, _config, reader) = vault_reader();
        install_enabled(
            &manager,
            tmp.path(),
            "com.example.test",
            &["vault:read", "vault:write"],
        );
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "secret").unwrap();

        for path in [
            "../secret.md",
            "/etc/passwd.md",
            "a/../../secret.md",
            ".nopes/index.md",
            "C:/x.md",
            "note.txt",
            "",
        ] {
            assert!(
                manager
                    .vault_read(&reader, "com.example.test", path)
                    .is_err(),
                "read {path:?}"
            );
            assert!(
                manager
                    .vault_write(&reader, "com.example.test", path, "x")
                    .is_err(),
                "write {path:?}"
            );
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), vault.path().join("linked")).unwrap();
            assert_err_contains(
                manager.vault_read(&reader, "com.example.test", "linked/secret.md"),
                "outside the vault",
            );
            assert_err_contains(
                manager.vault_write(&reader, "com.example.test", "linked/new.md", "x"),
                "outside the vault",
            );
            assert!(!outside.path().join("new.md").exists());
        }
    }

    #[test]
    fn vault_write_creates_folders_and_note_create_never_clobbers() {
        let (tmp, manager) = manager();
        let (vault, _config, reader) = vault_reader();
        install_enabled(
            &manager,
            tmp.path(),
            "com.example.test",
            &["vault:write", "notes:create"],
        );

        manager
            .vault_write(
                &reader,
                "com.example.test",
                "daily/2026-09-22.md",
                "# Today",
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(vault.path().join("daily/2026-09-22.md")).unwrap(),
            "# Today"
        );

        let first = manager
            .note_create(&reader, "com.example.test", "Ideas: v2?", "one")
            .unwrap();
        assert_eq!(first, "Ideas- v2-.md");
        let second = manager
            .note_create(&reader, "com.example.test", "Ideas: v2?", "two")
            .unwrap();
        assert_eq!(second, "Ideas- v2- 2.md");
        let nested = manager
            .note_create(&reader, "com.example.test", "../projects/.hidden/Plan", "x")
            .unwrap();
        assert_eq!(nested, "projects/hidden/Plan.md");
        assert_err_contains(
            manager.note_create(&reader, "com.example.test", " / ", "x"),
            "title is required",
        );
    }

    #[test]
    fn fetch_urls_are_checked_against_granted_hosts() {
        let granted = vec![
            "vault:read".to_owned(),
            "net:fetch:api.github.com".to_owned(),
        ];
        assert!(check_fetch_url(&granted, "https://api.github.com/repos/x/y").is_ok());
        assert!(check_fetch_url(&granted, "https://API.GitHub.com./zen").is_ok());
        for (url, why) in [
            ("http://api.github.com/", "https://"),
            ("https://github.com/", "has not been granted"),
            ("https://evil.api.github.com/", "has not been granted"),
            ("https://api.github.com.evil.com/", "has not been granted"),
            ("https://api.github.com@evil.com/", "credentials"),
            ("https://api.github.com:8443/", "custom port"),
            ("file:///etc/passwd", "https://"),
            ("not a url", "invalid URL"),
        ] {
            assert_err_contains(check_fetch_url(&granted, url), why);
        }
    }

    #[tokio::test]
    async fn fetch_is_refused_before_any_network_access() {
        let (tmp, manager) = manager();
        install(
            &manager,
            tmp.path(),
            "com.example.test",
            &["net:fetch:api.github.com"],
        );
        assert_err_contains(
            manager
                .fetch("com.example.test", "https://api.github.com/")
                .await,
            "disabled",
        );
        manager.set_enabled("com.example.test", true).unwrap();
        assert_err_contains(
            manager
                .fetch("com.example.test", "https://api.github.com/")
                .await,
            "has not been granted",
        );
    }

    // ── Settings and storage ──

    #[test]
    fn settings_merge_defaults_and_validate_types() {
        let (tmp, manager) = manager();
        install(&manager, tmp.path(), "com.example.test", &[]);
        let defaults = manager.get_settings("com.example.test").unwrap();
        assert_eq!(defaults["threshold"], serde_json::json!(500));
        assert_eq!(defaults["title"], serde_json::json!("Hello"));
        assert_eq!(defaults["enabled"], serde_json::json!(false));
        assert_eq!(defaults["mode"], serde_json::json!("b"));

        let updated = manager
            .set_settings(
                "com.example.test",
                &serde_json::json!({ "threshold": 750, "mode": "a" }),
            )
            .unwrap();
        assert_eq!(updated["threshold"], serde_json::json!(750));
        assert_eq!(updated["title"], serde_json::json!("Hello"));

        for bad in [
            serde_json::json!({ "unknown": 1 }),
            serde_json::json!({ "threshold": "many" }),
            serde_json::json!({ "threshold": 5000 }),
            serde_json::json!({ "enabled": "yes" }),
            serde_json::json!({ "mode": "c" }),
            serde_json::json!(["not", "an", "object"]),
        ] {
            assert!(
                manager.set_settings("com.example.test", &bad).is_err(),
                "{bad} must be rejected"
            );
        }
        assert_eq!(
            manager.get_settings("com.example.test").unwrap()["mode"],
            serde_json::json!("a")
        );
    }

    #[test]
    fn storage_round_trips_and_enforces_the_cap() {
        let (tmp, manager) = manager();
        install(&manager, tmp.path(), "com.example.test", &[]);
        assert_err_contains(manager.storage_get("com.example.test", "k"), "disabled");
        manager.set_enabled("com.example.test", true).unwrap();

        assert_eq!(manager.storage_get("com.example.test", "k").unwrap(), None);
        let value = serde_json::json!({ "count": 3, "tags": ["a", "b"] });
        manager
            .storage_set("com.example.test", "k", Some(value.clone()))
            .unwrap();
        assert_eq!(
            manager.storage_get("com.example.test", "k").unwrap(),
            Some(value)
        );
        manager.storage_set("com.example.test", "k", None).unwrap();
        assert_eq!(manager.storage_get("com.example.test", "k").unwrap(), None);

        let huge = Value::from("x".repeat(MAX_STORAGE_BYTES));
        assert_err_contains(
            manager.storage_set("com.example.test", "big", Some(huge)),
            "limited to 1 MB",
        );
        assert_err_contains(
            manager.storage_set("com.example.test", "", None),
            "storage keys",
        );
    }
}
