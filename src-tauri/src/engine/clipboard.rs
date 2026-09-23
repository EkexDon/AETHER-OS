//! Clipboard history engine (roadmap 1.3).
//!
//! A background thread polls the system clipboard (via `arboard`, which
//! reads `NSPasteboard` on macOS) every [`POLL_INTERVAL`] and records every
//! new text, link, code snippet, color or image in a local SQLite history.
//! The UI lists, searches, pins and re-copies clips through the commands in
//! `commands/clipboard_commands.rs`.
//!
//! Storage under `<data_dir>/clipboard/`:
//!
//! - `history.db` — table `clips` plus the contentless FTS5 index
//!   `clips_fts`, kept in sync by triggers. `clips.hash` (SHA-256 of the
//!   content) makes re-copies deduplicate: the existing row moves to the top
//!   and its `copy_count` is bumped instead of inserting a duplicate.
//! - `images/<id>.png` (full image) and `images/<id>.thumb.png` (≤ 256 px
//!   thumbnail for the list). An image clip's `content` is the PNG path and
//!   its `preview` is `WxH`.
//! - `settings.json` — [`ClipboardSettings`] (enabled, retention, images).
//!
//! Privacy: nothing leaves the machine. Text that looks like a password,
//! API key, token, private key or card number is never recorded (see
//! [`looks_like_secret`]), and capture can be paused at any time. While
//! paused or disabled the clipboard is not even read; whatever was copied in
//! the meantime is adopted silently on resume instead of being recorded.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use chrono::{DateTime, SecondsFormat, Utc};
use image::ImageEncoder;
use regex::{Regex, RegexSet};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::engine::error::AetherError;
use crate::engine::sqlite::{migrate, open_db};
use crate::engine::vault_reader::VaultReader;

/// Tauri event emitted after every change to the history.
pub const CLIPBOARD_CHANGED_EVENT: &str = "clipboard-changed";
/// How often the watcher looks at the system clipboard.
pub const POLL_INTERVAL: Duration = Duration::from_millis(700);
/// Longest text (in bytes) that is recorded; larger copies are ignored.
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// Largest image (in pixels, ≈ 8K × 5K) that is recorded.
pub const MAX_IMAGE_PIXELS: usize = 40_000_000;
/// Default page size of [`ClipboardEngine::list`].
pub const DEFAULT_LIST_LIMIT: u32 = 100;
/// Largest page size of [`ClipboardEngine::list`].
pub const MAX_LIST_LIMIT: u32 = 500;
/// Bounds for [`ClipboardSettings::max_items`].
pub const MAX_ITEMS_RANGE: (u32, u32) = (10, 10_000);
/// Upper bound for [`ClipboardSettings::keep_days`] (0 = keep forever).
pub const MAX_KEEP_DAYS: u32 = 3650;

const DB_FILE: &str = "history.db";
const SETTINGS_FILE: &str = "settings.json";
const IMAGES_DIR: &str = "images";
/// Wait before retrying when the system clipboard cannot be opened.
const UNAVAILABLE_RETRY: Duration = Duration::from_secs(10);
/// A change observed this soon after we wrote an image ourselves is ours.
const SELF_WRITE_GRACE: Duration = Duration::from_millis(2500);
/// Longest pause (in polls) between two reads of an unchanged image.
const MAX_IMAGE_COOLDOWN: u32 = 7;
const THUMBNAIL_MAX_SIDE: u32 = 256;
const PREVIEW_MAX_CHARS: usize = 200;
/// List results carry at most this many characters of `content`.
const LIST_CONTENT_MAX_CHARS: i64 = 8_000;
const NOTE_TITLE_MAX_CHARS: usize = 80;
/// Vault folder for notes created with "Save as note".
const NOTE_FOLDER: &str = "clipboard";
/// Vault folder (relative to the vault root) for saved clipboard images.
const ATTACHMENT_FOLDER: &str = "attachments/clipboard";

/// Schema: `clips` + contentless FTS5 index maintained by triggers. Image
/// rows index `image <WxH>` instead of their file path.
const MIGRATIONS: &[&str] = &["
CREATE TABLE clips (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'url', 'code', 'image', 'color')),
    content TEXT NOT NULL,
    preview TEXT NOT NULL,
    byte_len INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    source_app TEXT NULL,
    copy_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_copied_at TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_clips_recent ON clips (last_copied_at DESC);
CREATE INDEX idx_clips_kind ON clips (kind);
CREATE VIRTUAL TABLE clips_fts USING fts5(
    content,
    content = '',
    contentless_delete = 1,
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER clips_fts_insert AFTER INSERT ON clips BEGIN
    INSERT INTO clips_fts (rowid, content) VALUES (
        new.rowid,
        CASE WHEN new.kind = 'image' THEN 'image ' || new.preview ELSE new.content END
    );
END;
CREATE TRIGGER clips_fts_delete AFTER DELETE ON clips BEGIN
    DELETE FROM clips_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER clips_fts_update AFTER UPDATE OF content, preview, kind ON clips BEGIN
    DELETE FROM clips_fts WHERE rowid = old.rowid;
    INSERT INTO clips_fts (rowid, content) VALUES (
        new.rowid,
        CASE WHEN new.kind = 'image' THEN 'image ' || new.preview ELSE new.content END
    );
END;
"];

const ITEM_COLUMNS: &str = "id, kind, content, preview, byte_len, pinned, source_app, \
                            copy_count, created_at, last_copied_at";

// ── Public types ────────────────────────────────────────────────────

/// What a clip contains; decides icon, preview and detail rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    Text,
    Url,
    Code,
    Image,
    Color,
}

impl ClipKind {
    /// The value stored in the `kind` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Url => "url",
            Self::Code => "code",
            Self::Image => "image",
            Self::Color => "color",
        }
    }

    /// Parse a stored / user-supplied kind (`text`, `url`, `code`, `image`, `color`).
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "text" => Some(Self::Text),
            "url" => Some(Self::Url),
            "code" => Some(Self::Code),
            "image" => Some(Self::Image),
            "color" => Some(Self::Color),
            _ => None,
        }
    }
}

/// One entry of the clipboard history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClipItem {
    /// UUID v4.
    pub id: String,
    pub kind: ClipKind,
    /// The copied text; for images the absolute path of the stored PNG.
    pub content: String,
    /// Single-line preview (≤ 200 chars); `WxH` for images.
    pub preview: String,
    /// Size of the text in bytes, or of the stored PNG for images.
    pub byte_len: i64,
    pub pinned: bool,
    /// Application the clip was copied from. Always `None` for now: the
    /// frontmost application is not available without platform bindings.
    pub source_app: Option<String>,
    /// How often the content was copied (captures + copies from the UI).
    pub copy_count: i64,
    /// First capture, RFC 3339 UTC with milliseconds.
    pub created_at: String,
    /// Most recent capture or copy; the history is ordered by it.
    pub last_copied_at: String,
    /// `true` when `content` was shortened for a list response — fetch the
    /// full clip with [`ClipboardEngine::get`].
    #[serde(default)]
    pub truncated: bool,
}

/// User settings, persisted in `settings.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ClipboardSettings {
    /// Record the clipboard at all.
    pub enabled: bool,
    /// Unpinned clips kept (oldest are pruned first); pinned clips don't count.
    pub max_items: u32,
    /// Unpinned clips not copied for this many days are pruned (0 = forever).
    pub keep_days: u32,
    /// Record copied images (screenshots, pictures).
    pub capture_images: bool,
}

impl Default for ClipboardSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_items: 500,
            keep_days: 30,
            capture_images: true,
        }
    }
}

impl ClipboardSettings {
    /// Reject values outside the supported ranges.
    pub fn validate(&self) -> Result<(), AetherError> {
        let (min, max) = MAX_ITEMS_RANGE;
        if !(min..=max).contains(&self.max_items) {
            return Err(AetherError::InvalidInput(format!(
                "max_items must be between {min} and {max}"
            )));
        }
        if self.keep_days > MAX_KEEP_DAYS {
            return Err(AetherError::InvalidInput(format!(
                "keep_days must be between 0 and {MAX_KEEP_DAYS}"
            )));
        }
        Ok(())
    }

    /// Clamp values from a hand-edited settings file into range.
    fn clamped(mut self) -> Self {
        let (min, max) = MAX_ITEMS_RANGE;
        self.max_items = self.max_items.clamp(min, max);
        self.keep_days = self.keep_days.min(MAX_KEEP_DAYS);
        self
    }
}

/// Aggregate numbers for the header, status bar and settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClipboardStats {
    pub total: u64,
    pub pinned: u64,
    pub images: u64,
    /// Sum of `byte_len` (text bytes + stored PNG sizes).
    pub bytes: u64,
    /// Capture paused for this session.
    pub paused: bool,
    /// Mirror of [`ClipboardSettings::enabled`].
    pub enabled: bool,
    /// Copies skipped this session because they looked like secrets.
    pub skipped_secrets: u64,
    /// Why the system clipboard cannot be read right now (`None` = healthy).
    pub watcher_error: Option<String>,
}

/// Why the history changed; payload of [`CLIPBOARD_CHANGED_EVENT`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeReason {
    /// A new copy was captured (or an existing clip was re-copied).
    Captured,
    /// A clip was written back to the system clipboard from the UI.
    Copied,
    /// Pin state changed.
    Updated,
    Deleted,
    Cleared,
    /// Settings or the pause state changed.
    Settings,
}

/// Payload of [`CLIPBOARD_CHANGED_EVENT`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClipboardChanged {
    /// The affected clip, when there is exactly one.
    pub id: Option<String>,
    pub reason: ChangeReason,
}

impl ClipboardChanged {
    /// Event for one clip.
    pub fn clip(id: &str, reason: ChangeReason) -> Self {
        Self {
            id: Some(id.to_owned()),
            reason,
        }
    }

    /// Event without a specific clip.
    pub fn general(reason: ChangeReason) -> Self {
        Self { id: None, reason }
    }
}

/// Filters for [`ClipboardEngine::list`].
#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    /// Full-text search; words are prefix-matched and AND-ed. Words without
    /// letters or digits (`=>`, `{}`) are matched as substrings.
    pub query: Option<String>,
    pub kind: Option<ClipKind>,
    pub pinned_only: bool,
    /// Page size (default [`DEFAULT_LIST_LIMIT`], at most [`MAX_LIST_LIMIT`]).
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Why a copy was not recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    Disabled,
    Paused,
    ImagesDisabled,
    Empty,
    TooLarge,
    Secret,
    /// Already in the history and adopted without a bump (start-up).
    AlreadyKnown,
}

/// Result of recording one copy.
#[derive(Debug, Clone, PartialEq)]
pub enum IngestOutcome {
    Inserted(ClipItem),
    /// Existing clip re-copied: moved to the top, `copy_count` bumped.
    Bumped(ClipItem),
    Skipped(SkipReason),
}

impl IngestOutcome {
    /// The recorded clip, if any.
    pub fn item(&self) -> Option<&ClipItem> {
        match self {
            Self::Inserted(item) | Self::Bumped(item) => Some(item),
            Self::Skipped(_) => None,
        }
    }
}

/// An RGBA image read from the system clipboard.
#[derive(Debug, Clone, PartialEq)]
pub struct RawImage {
    pub width: usize,
    pub height: usize,
    /// `width * height * 4` bytes, row-major RGBA.
    pub rgba: Vec<u8>,
}

/// Where the watcher reads clipboard content from. Implemented for the
/// system clipboard; tests drive the watcher logic with a fake.
pub trait ClipboardSource {
    /// Current text, `Ok(None)` when the clipboard holds no text.
    fn read_text(&mut self) -> Result<Option<String>, String>;
    /// Current image, `Ok(None)` when the clipboard holds no image.
    fn read_image(&mut self) -> Result<Option<RawImage>, String>;
}

/// The real system clipboard.
struct SystemClipboard(arboard::Clipboard);

impl ClipboardSource for SystemClipboard {
    fn read_text(&mut self) -> Result<Option<String>, String> {
        match self.0.get_text() {
            Ok(text) => Ok(Some(text)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn read_image(&mut self) -> Result<Option<RawImage>, String> {
        match self.0.get_image() {
            Ok(image) => Ok(Some(RawImage {
                width: image.width,
                height: image.height,
                rgba: image.bytes.into_owned(),
            })),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ── Engine ──────────────────────────────────────────────────────────

/// How a detected copy is recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IngestMode {
    /// Insert, or bump an existing clip.
    Normal,
    /// Start-up: insert when new, but never bump a clip already known.
    AdoptExisting,
}

/// What the watcher makes of a clipboard content hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observation {
    Unchanged,
    /// First look after start-up.
    Initial,
    /// Changed, but must not be recorded (after resume, own write-back).
    Silent,
    New,
}

/// Change-detection state of the watcher.
#[derive(Debug, Default)]
struct WatchState {
    last_hash: Option<String>,
    primed: bool,
    /// Adopt the next observation silently (after pause / disable).
    resync: bool,
    /// Our own image write-back: the next change until then is ours.
    suppress_until: Option<Instant>,
    /// Polls to skip before reading an image again.
    image_cooldown: u32,
    /// Consecutive image reads that found nothing new.
    image_streak: u32,
}

impl WatchState {
    fn observe(&mut self, hash: &str) -> Observation {
        if self.last_hash.as_deref() == Some(hash) {
            return Observation::Unchanged;
        }
        self.last_hash = Some(hash.to_owned());
        if !self.primed {
            self.primed = true;
            self.resync = false;
            self.suppress_until = None;
            return Observation::Initial;
        }
        if self.resync {
            self.resync = false;
            return Observation::Silent;
        }
        if let Some(until) = self.suppress_until.take() {
            if Instant::now() < until {
                return Observation::Silent;
            }
        }
        Observation::New
    }

    /// Back off exponentially (1, 3, 7, 7… polls) while an image is unchanged:
    /// reading an image means decoding it, which is far costlier than text.
    fn image_unchanged(&mut self) {
        self.image_streak = self.image_streak.saturating_add(1);
        let cooldown = (1u32 << self.image_streak.min(4)) - 1;
        self.image_cooldown = cooldown.min(MAX_IMAGE_COOLDOWN);
    }

    fn reset_image_backoff(&mut self) {
        self.image_streak = 0;
        self.image_cooldown = 0;
    }
}

/// A clip about to be inserted.
struct NewClip {
    id: String,
    kind: ClipKind,
    content: String,
    preview: String,
    byte_len: i64,
    hash: String,
}

/// Clipboard history: SQLite store, retention, privacy filters and the
/// system clipboard watcher.
pub struct ClipboardEngine {
    images_dir: PathBuf,
    settings_path: PathBuf,
    db: Mutex<Connection>,
    settings: RwLock<ClipboardSettings>,
    paused: AtomicBool,
    watch: Mutex<WatchState>,
    watcher_error: Mutex<Option<String>>,
    skipped_secrets: AtomicU64,
    /// Last issued timestamp (ms since epoch) — keeps `last_copied_at`
    /// strictly increasing so "moved to top" is exact.
    clock: Mutex<i64>,
    started: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding one of these locks leaves the data usable
    // (SQLite rolls back unfinished transactions), so recover from poison.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ClipboardEngine {
    /// Open (or create) the history in `dir` (`<data_dir>/clipboard`).
    pub fn new(dir: &Path) -> Result<Self, AetherError> {
        let images_dir = dir.join(IMAGES_DIR);
        std::fs::create_dir_all(&images_dir)?;
        let settings_path = dir.join(SETTINGS_FILE);
        let settings = load_settings(&settings_path)?;

        let mut conn = open_db(&dir.join(DB_FILE))?;
        migrate(&mut conn, MIGRATIONS)?;
        repair_fts_if_needed(&conn)?;
        let latest: Option<String> =
            conn.query_row("SELECT MAX(last_copied_at) FROM clips", [], |r| r.get(0))?;
        let clock = latest
            .and_then(|ts| DateTime::parse_from_rfc3339(&ts).ok())
            .map(|ts| ts.timestamp_millis())
            .unwrap_or(0);

        let engine = Self {
            images_dir,
            settings_path,
            db: Mutex::new(conn),
            settings: RwLock::new(settings),
            paused: AtomicBool::new(false),
            watch: Mutex::new(WatchState::default()),
            watcher_error: Mutex::new(None),
            skipped_secrets: AtomicU64::new(0),
            clock: Mutex::new(clock),
            started: AtomicBool::new(false),
        };
        engine.prune()?;
        Ok(engine)
    }

    /// Production entry point: open `<data_dir>/clipboard` and start the
    /// system clipboard watcher, which emits [`CLIPBOARD_CHANGED_EVENT`].
    pub fn launch(data_dir: &Path, app: &AppHandle) -> Result<Arc<Self>, AetherError> {
        let engine = Arc::new(Self::new(&data_dir.join("clipboard"))?);
        let app = app.clone();
        engine.start(move |event| {
            if let Err(e) = app.emit(CLIPBOARD_CHANGED_EVENT, event) {
                eprintln!("[clipboard] failed to emit {CLIPBOARD_CHANGED_EVENT}: {e}");
            }
        })?;
        Ok(engine)
    }

    /// Start the watcher thread (idempotent). `emit` is called for every
    /// captured clip.
    pub fn start<F>(self: &Arc<Self>, emit: F) -> Result<(), AetherError>
    where
        F: Fn(ClipboardChanged) + Send + 'static,
    {
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let engine = Arc::clone(self);
        std::thread::Builder::new()
            .name("aether-clipboard".into())
            .spawn(move || engine.watch_loop(emit))?;
        Ok(())
    }

    /// The watcher: poll, record, emit — forever (the thread ends with the app).
    fn watch_loop<F: Fn(ClipboardChanged)>(&self, emit: F) {
        let mut source: Option<SystemClipboard> = None;
        let mut last_error: Option<String> = None;
        loop {
            std::thread::sleep(POLL_INTERVAL);
            if self.capture_blocked().is_some() {
                lock(&self.watch).resync = true;
                continue;
            }
            let clipboard = match source.as_mut() {
                Some(clipboard) => clipboard,
                None => match arboard::Clipboard::new() {
                    Ok(clipboard) => {
                        self.set_watcher_error(None);
                        source.insert(SystemClipboard(clipboard))
                    }
                    Err(e) => {
                        self.set_watcher_error(Some(format!("clipboard unavailable: {e}")));
                        std::thread::sleep(UNAVAILABLE_RETRY);
                        continue;
                    }
                },
            };
            match self.poll_once(clipboard) {
                Ok(Some(item)) => {
                    last_error = None;
                    self.set_watcher_error(None);
                    emit(ClipboardChanged::clip(&item.id, ChangeReason::Captured));
                }
                Ok(None) => {
                    if last_error.take().is_some() {
                        self.set_watcher_error(None);
                    }
                }
                Err(e) => {
                    let message = e.to_string();
                    if last_error.as_deref() != Some(message.as_str()) {
                        eprintln!("[clipboard] {message}");
                        self.set_watcher_error(Some(message.clone()));
                        last_error = Some(message);
                    }
                }
            }
        }
    }

    /// Look at the clipboard once and record what changed. Returns the
    /// recorded clip (new or bumped), `None` when nothing was recorded.
    pub fn poll_once<S: ClipboardSource>(
        &self,
        source: &mut S,
    ) -> Result<Option<ClipItem>, AetherError> {
        if self.capture_blocked().is_some() {
            lock(&self.watch).resync = true;
            return Ok(None);
        }
        let text = source
            .read_text()
            .map_err(|e| AetherError::InvalidInput(format!("clipboard read failed: {e}")))?;
        if let Some(text) = text {
            let observation = {
                let mut watch = lock(&self.watch);
                watch.reset_image_backoff();
                watch.observe(&text_hash(&text))
            };
            let outcome = match observation {
                Observation::Unchanged | Observation::Silent => return Ok(None),
                Observation::Initial => self.ingest_text_with(&text, IngestMode::AdoptExisting)?,
                Observation::New => self.ingest_text_with(&text, IngestMode::Normal)?,
            };
            return Ok(outcome.item().cloned());
        }

        if !self.settings().capture_images {
            return Ok(None);
        }
        {
            let mut watch = lock(&self.watch);
            if watch.image_cooldown > 0 {
                watch.image_cooldown -= 1;
                return Ok(None);
            }
        }
        let image = source
            .read_image()
            .map_err(|e| AetherError::InvalidInput(format!("clipboard read failed: {e}")))?;
        let Some(image) = image else {
            lock(&self.watch).image_unchanged();
            return Ok(None);
        };
        let hash = image_hash(image.width, image.height, &image.rgba);
        let observation = {
            let mut watch = lock(&self.watch);
            let observation = watch.observe(&hash);
            if observation == Observation::Unchanged {
                watch.image_unchanged();
            } else {
                watch.reset_image_backoff();
            }
            observation
        };
        let mode = match observation {
            Observation::Unchanged | Observation::Silent => return Ok(None),
            Observation::Initial => IngestMode::AdoptExisting,
            Observation::New => IngestMode::Normal,
        };
        let outcome = self.ingest_image_with(&image, &hash, mode)?;
        Ok(outcome.item().cloned())
    }

    fn set_watcher_error(&self, error: Option<String>) {
        *lock(&self.watcher_error) = error;
    }

    /// Why capture is currently off, if it is.
    fn capture_blocked(&self) -> Option<SkipReason> {
        if !self.settings().enabled {
            Some(SkipReason::Disabled)
        } else if self.paused.load(Ordering::SeqCst) {
            Some(SkipReason::Paused)
        } else {
            None
        }
    }

    // ── Recording ──

    /// Record copied text (dedupe, classification, privacy filters).
    pub fn ingest_text(&self, text: &str) -> Result<IngestOutcome, AetherError> {
        self.ingest_text_with(text, IngestMode::Normal)
    }

    fn ingest_text_with(&self, text: &str, mode: IngestMode) -> Result<IngestOutcome, AetherError> {
        if let Some(reason) = self.capture_blocked() {
            return Ok(IngestOutcome::Skipped(reason));
        }
        if text.trim().is_empty() {
            return Ok(IngestOutcome::Skipped(SkipReason::Empty));
        }
        if text.len() > MAX_TEXT_BYTES {
            return Ok(IngestOutcome::Skipped(SkipReason::TooLarge));
        }
        if looks_like_secret(text) {
            self.skipped_secrets.fetch_add(1, Ordering::SeqCst);
            return Ok(IngestOutcome::Skipped(SkipReason::Secret));
        }
        let hash = text_hash(text);
        if let Some(outcome) = self.touch_existing(&hash, mode)? {
            return Ok(outcome);
        }
        let clip = NewClip {
            id: uuid::Uuid::new_v4().to_string(),
            kind: classify(text),
            content: text.to_owned(),
            preview: text_preview(text),
            byte_len: text.len() as i64,
            hash,
        };
        let item = self.insert(clip)?;
        self.prune()?;
        Ok(IngestOutcome::Inserted(item))
    }

    /// Record a copied image: stored as PNG plus a thumbnail.
    pub fn ingest_image(&self, image: &RawImage) -> Result<IngestOutcome, AetherError> {
        let hash = image_hash(image.width, image.height, &image.rgba);
        self.ingest_image_with(image, &hash, IngestMode::Normal)
    }

    fn ingest_image_with(
        &self,
        image: &RawImage,
        hash: &str,
        mode: IngestMode,
    ) -> Result<IngestOutcome, AetherError> {
        if let Some(reason) = self.capture_blocked() {
            return Ok(IngestOutcome::Skipped(reason));
        }
        if !self.settings().capture_images {
            return Ok(IngestOutcome::Skipped(SkipReason::ImagesDisabled));
        }
        if image.width == 0 || image.height == 0 {
            return Ok(IngestOutcome::Skipped(SkipReason::Empty));
        }
        let pixels = image
            .width
            .checked_mul(image.height)
            .filter(|p| *p <= MAX_IMAGE_PIXELS);
        let Some(pixels) = pixels else {
            return Ok(IngestOutcome::Skipped(SkipReason::TooLarge));
        };
        if image.rgba.len() != pixels * 4 {
            return Err(AetherError::InvalidInput(format!(
                "image data has {} bytes, expected {} for {}x{} RGBA",
                image.rgba.len(),
                pixels * 4,
                image.width,
                image.height
            )));
        }
        // Dedupe before encoding: encoding a screenshot is the costly part.
        if let Some(outcome) = self.touch_existing(hash, mode)? {
            return Ok(outcome);
        }
        let (width, height) = (image.width as u32, image.height as u32);
        let id = uuid::Uuid::new_v4().to_string();
        let png = encode_png(width, height, &image.rgba)?;
        let thumbnail = encode_thumbnail(width, height, &image.rgba)?;
        let path = self.image_path(&id, false);
        write_file(&path, &png)?;
        if let Err(e) = write_file(&self.image_path(&id, true), &thumbnail) {
            self.remove_image_files(&id);
            return Err(e);
        }
        let clip = NewClip {
            id: id.clone(),
            kind: ClipKind::Image,
            content: path.to_string_lossy().into_owned(),
            preview: format!("{width}x{height}"),
            byte_len: png.len() as i64,
            hash: hash.to_owned(),
        };
        let item = match self.insert(clip) {
            Ok(item) => item,
            Err(e) => {
                self.remove_image_files(&id);
                return Err(e);
            }
        };
        self.prune()?;
        Ok(IngestOutcome::Inserted(item))
    }

    /// Dedupe: bump (or, at start-up, adopt) a clip with the same hash.
    fn touch_existing(
        &self,
        hash: &str,
        mode: IngestMode,
    ) -> Result<Option<IngestOutcome>, AetherError> {
        let conn = lock(&self.db);
        let existing: Option<String> = conn
            .query_row("SELECT id FROM clips WHERE hash = ?1", [hash], |r| r.get(0))
            .optional()?;
        let Some(id) = existing else {
            return Ok(None);
        };
        if mode == IngestMode::AdoptExisting {
            return Ok(Some(IngestOutcome::Skipped(SkipReason::AlreadyKnown)));
        }
        let now = self.next_timestamp();
        conn.execute(
            "UPDATE clips SET copy_count = copy_count + 1, last_copied_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(Some(IngestOutcome::Bumped(fetch_item(&conn, &id)?)))
    }

    fn insert(&self, clip: NewClip) -> Result<ClipItem, AetherError> {
        let conn = lock(&self.db);
        let now = self.next_timestamp();
        conn.execute(
            "INSERT INTO clips (id, kind, content, preview, byte_len, pinned, source_app,
                                copy_count, created_at, last_copied_at, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, 1, ?6, ?6, ?7)",
            params![
                clip.id,
                clip.kind.as_str(),
                clip.content,
                clip.preview,
                clip.byte_len,
                now,
                clip.hash
            ],
        )?;
        fetch_item(&conn, &clip.id)
    }

    /// Strictly increasing RFC 3339 timestamp (millisecond precision).
    fn next_timestamp(&self) -> String {
        let mut last = lock(&self.clock);
        let now = Utc::now().timestamp_millis();
        let next = now.max(*last + 1);
        *last = next;
        DateTime::<Utc>::from_timestamp_millis(next)
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    // ── Queries ──

    /// History page, newest first. `content` is shortened to 8 000
    /// characters (see [`ClipItem::truncated`]).
    pub fn list(&self, query: &ListQuery) -> Result<Vec<ClipItem>, AetherError> {
        let mut sql = String::from(
            "SELECT id, kind,
                    CASE WHEN length(content) > ?1 THEN substr(content, 1, ?1) ELSE content END,
                    preview, byte_len, pinned, source_app, copy_count, created_at,
                    last_copied_at, length(content) > ?1
             FROM clips WHERE 1 = 1",
        );
        let mut args: Vec<Value> = vec![Value::Integer(LIST_CONTENT_MAX_CHARS)];
        let mut bind = |sql: &mut String, clause: &str, value: Value| {
            args.push(value);
            sql.push_str(&clause.replace("?#", &format!("?{}", args.len())));
        };
        if let Some(kind) = query.kind {
            bind(
                &mut sql,
                " AND kind = ?#",
                Value::Text(kind.as_str().to_owned()),
            );
        }
        if query.pinned_only {
            sql.push_str(" AND pinned = 1");
        }
        if let Some(text) = query
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
        {
            let search = SearchTerms::parse(text);
            if let Some(fts) = search.fts {
                bind(
                    &mut sql,
                    " AND rowid IN (SELECT rowid FROM clips_fts WHERE clips_fts MATCH ?#)",
                    Value::Text(fts),
                );
            }
            for needle in search.substrings {
                bind(
                    &mut sql,
                    " AND (CASE WHEN kind = 'image' THEN preview ELSE content END) \
                     LIKE ?# ESCAPE '\\'",
                    Value::Text(format!("%{}%", escape_like(&needle))),
                );
            }
        }
        let limit = query
            .limit
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .clamp(1, MAX_LIST_LIMIT);
        bind(
            &mut sql,
            " ORDER BY last_copied_at DESC, rowid DESC LIMIT ?#",
            Value::Integer(i64::from(limit)),
        );
        bind(
            &mut sql,
            " OFFSET ?#",
            Value::Integer(i64::from(query.offset.unwrap_or(0))),
        );

        let conn = lock(&self.db);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), |row| {
            let mut item = item_from_row(row)?;
            item.truncated = row.get::<_, bool>(10)?;
            Ok(item)
        })?;
        let items = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    /// One clip with its full content.
    pub fn get(&self, id: &str) -> Result<ClipItem, AetherError> {
        validate_id(id)?;
        let conn = lock(&self.db);
        fetch_item(&conn, id)
    }

    /// The most recently copied clip, if any.
    pub fn latest(&self) -> Result<Option<ClipItem>, AetherError> {
        let conn = lock(&self.db);
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM clips ORDER BY last_copied_at DESC, rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        id.map(|id| fetch_item(&conn, &id)).transpose()
    }

    /// Totals for the UI.
    pub fn stats(&self) -> Result<ClipboardStats, AetherError> {
        let conn = lock(&self.db);
        let (total, pinned, images, bytes): (i64, i64, i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(pinned), 0),
                    COALESCE(SUM(kind = 'image'), 0), COALESCE(SUM(byte_len), 0)
             FROM clips",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        drop(conn);
        let to_u64 = |v: i64| u64::try_from(v).unwrap_or(0);
        Ok(ClipboardStats {
            total: to_u64(total),
            pinned: to_u64(pinned),
            images: to_u64(images),
            bytes: to_u64(bytes),
            paused: self.is_paused(),
            enabled: self.settings().enabled,
            skipped_secrets: self.skipped_secrets.load(Ordering::SeqCst),
            watcher_error: lock(&self.watcher_error).clone(),
        })
    }

    /// The stored image as a `data:image/png;base64,…` URL; `thumbnail`
    /// selects the ≤ 256 px version (falls back to the full image).
    pub fn image_data_url(&self, id: &str, thumbnail: bool) -> Result<String, AetherError> {
        let item = self.get(id)?;
        if item.kind != ClipKind::Image {
            return Err(AetherError::InvalidInput(format!(
                "clip {id} is not an image"
            )));
        }
        // The file name comes from the stored id, never from the request.
        let thumb = self.image_path(&item.id, true);
        let path = if thumbnail && thumb.exists() {
            thumb
        } else {
            self.image_path(&item.id, false)
        };
        let bytes = std::fs::read(&path).map_err(|e| {
            AetherError::InvalidInput(format!("image file for clip {id} is missing: {e}"))
        })?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    // ── Mutations ──

    /// Pin or unpin a clip. Pinned clips are never pruned.
    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<ClipItem, AetherError> {
        validate_id(id)?;
        let conn = lock(&self.db);
        let changed = conn.execute(
            "UPDATE clips SET pinned = ?2 WHERE id = ?1",
            params![id, pinned],
        )?;
        if changed == 0 {
            return Err(not_found(id));
        }
        fetch_item(&conn, id)
    }

    /// Bump the counters of a clip that was copied from the UI.
    pub fn mark_copied(&self, id: &str) -> Result<ClipItem, AetherError> {
        validate_id(id)?;
        let conn = lock(&self.db);
        let now = self.next_timestamp();
        let changed = conn.execute(
            "UPDATE clips SET copy_count = copy_count + 1, last_copied_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        if changed == 0 {
            return Err(not_found(id));
        }
        fetch_item(&conn, id)
    }

    /// Write a clip back to the system clipboard and bump its counters. The
    /// watcher recognises the write and does not record it a second time.
    pub fn copy_to_system(&self, id: &str) -> Result<ClipItem, AetherError> {
        let item = self.get(id)?;
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| AetherError::InvalidInput(format!("clipboard unavailable: {e}")))?;
        if item.kind == ClipKind::Image {
            let image = self.load_image(id)?;
            clipboard
                .set_image(arboard::ImageData {
                    width: image.width,
                    height: image.height,
                    bytes: image.rgba.into(),
                })
                .map_err(|e| AetherError::InvalidInput(format!("clipboard write failed: {e}")))?;
            self.note_self_write(None);
        } else {
            clipboard
                .set_text(item.content.clone())
                .map_err(|e| AetherError::InvalidInput(format!("clipboard write failed: {e}")))?;
            self.note_self_write(Some(text_hash(&item.content)));
        }
        self.mark_copied(id)
    }

    /// Tell the watcher that we wrote the clipboard ourselves. Text is
    /// recognised by its hash; images (whose pixels may come back altered by
    /// the OS) by a short grace period.
    fn note_self_write(&self, text_hash: Option<String>) {
        let mut watch = lock(&self.watch);
        match text_hash {
            Some(hash) => watch.last_hash = Some(hash),
            None => {
                watch.last_hash = None;
                watch.suppress_until = Some(Instant::now() + SELF_WRITE_GRACE);
                watch.reset_image_backoff();
            }
        }
    }

    /// Decode a stored image back to RGBA.
    fn load_image(&self, id: &str) -> Result<RawImage, AetherError> {
        let bytes = std::fs::read(self.image_path(id, false)).map_err(|e| {
            AetherError::InvalidInput(format!("image file for clip {id} is missing: {e}"))
        })?;
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .map_err(|e| AetherError::InvalidInput(format!("stored image is unreadable: {e}")))?
            .into_rgba8();
        Ok(RawImage {
            width: decoded.width() as usize,
            height: decoded.height() as usize,
            rgba: decoded.into_raw(),
        })
    }

    /// Delete one clip (and its image files).
    pub fn delete(&self, id: &str) -> Result<(), AetherError> {
        validate_id(id)?;
        let kind: Option<String> = {
            let conn = lock(&self.db);
            let kind = conn
                .query_row("SELECT kind FROM clips WHERE id = ?1", [id], |r| r.get(0))
                .optional()?;
            conn.execute("DELETE FROM clips WHERE id = ?1", [id])?;
            kind
        };
        match kind.as_deref() {
            None => Err(not_found(id)),
            Some("image") => {
                self.remove_image_files(id);
                Ok(())
            }
            Some(_) => Ok(()),
        }
    }

    /// Delete the whole history (optionally keeping pinned clips). Returns
    /// the number of clips removed.
    pub fn clear(&self, keep_pinned: bool) -> Result<usize, AetherError> {
        let doomed = {
            let conn = lock(&self.db);
            let mut stmt =
                conn.prepare("SELECT id, kind FROM clips WHERE (?1 = 0 OR pinned = 0)")?;
            let rows = stmt.query_map([keep_pinned], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        self.delete_many(&doomed)
    }

    /// Apply retention: drop unpinned clips older than `keep_days` (by last
    /// copy) and beyond `max_items`. Returns the number of clips removed.
    pub fn prune(&self) -> Result<usize, AetherError> {
        let settings = self.settings();
        let mut doomed: Vec<(String, String)> = Vec::new();
        {
            let conn = lock(&self.db);
            if settings.keep_days > 0 {
                let cutoff = (Utc::now() - chrono::Duration::days(i64::from(settings.keep_days)))
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
                let mut stmt = conn.prepare(
                    "SELECT id, kind FROM clips WHERE pinned = 0 AND last_copied_at < ?1",
                )?;
                let rows = stmt.query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?;
                doomed.extend(rows.collect::<Result<Vec<_>, _>>()?);
            }
            let mut stmt = conn.prepare(
                "SELECT id, kind FROM clips WHERE pinned = 0
                 ORDER BY last_copied_at DESC, rowid DESC LIMIT -1 OFFSET ?1",
            )?;
            let rows = stmt.query_map([settings.max_items], |r| Ok((r.get(0)?, r.get(1)?)))?;
            doomed.extend(rows.collect::<Result<Vec<_>, _>>()?);
        }
        let mut seen = HashSet::new();
        doomed.retain(|(id, _)| seen.insert(id.clone()));
        self.delete_many(&doomed)
    }

    fn delete_many(&self, doomed: &[(String, String)]) -> Result<usize, AetherError> {
        if doomed.is_empty() {
            return Ok(0);
        }
        {
            let mut conn = lock(&self.db);
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare("DELETE FROM clips WHERE id = ?1")?;
                for (id, _) in doomed {
                    stmt.execute([id])?;
                }
            }
            tx.commit()?;
        }
        for (id, kind) in doomed {
            if kind == ClipKind::Image.as_str() {
                self.remove_image_files(id);
            }
        }
        Ok(doomed.len())
    }

    // ── Settings & pause ──

    /// Current settings.
    pub fn settings(&self) -> ClipboardSettings {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Validate, persist and apply new settings (prunes immediately).
    pub fn set_settings(&self, next: ClipboardSettings) -> Result<ClipboardSettings, AetherError> {
        next.validate()?;
        let json = serde_json::to_string_pretty(&next)
            .map_err(|e| AetherError::InvalidInput(format!("settings serialize: {e}")))?;
        write_file(&self.settings_path, json.as_bytes())?;
        let was_enabled = {
            let mut current = self
                .settings
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let was_enabled = current.enabled;
            *current = next.clone();
            was_enabled
        };
        if !was_enabled && next.enabled {
            lock(&self.watch).resync = true;
        }
        self.prune()?;
        Ok(next)
    }

    /// Whether capture is paused for this session.
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Pause or resume capture. On resume, whatever is on the clipboard now
    /// is adopted without being recorded. Returns the new state.
    pub fn set_paused(&self, paused: bool) -> bool {
        let was = self.paused.swap(paused, Ordering::SeqCst);
        if was && !paused {
            lock(&self.watch).resync = true;
        }
        paused
    }

    // ── Vault export ──

    /// Save a clip as a Markdown note in `clipboard/<title>.md` (images are
    /// copied to `attachments/clipboard/`). Returns the note's absolute path.
    pub fn save_as_note(
        &self,
        vault: &VaultReader,
        id: &str,
        title: &str,
    ) -> Result<String, AetherError> {
        let item = self.get(id)?;
        let title = note_title(title, &item);
        let body = if item.kind == ClipKind::Image {
            let root = vault
                .detect_vault_path()
                .ok_or_else(|| AetherError::Vault("no vault path configured".into()))?;
            // A symlinked `attachments/` folder must not lead out of the vault.
            let dir = crate::engine::fs_guard::create_dir_all_within(
                &vault.vault_root()?,
                &Path::new(&root).join(ATTACHMENT_FOLDER),
            )?;
            let short: String = item.id.chars().filter(|c| *c != '-').take(12).collect();
            let target = unique_file(&dir, &format!("clip-{short}"), "png");
            std::fs::copy(self.image_path(&item.id, false), &target).map_err(|e| {
                AetherError::InvalidInput(format!("image file for clip {id} is missing: {e}"))
            })?;
            let file_name = target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("![{title}]({ATTACHMENT_FOLDER}/{file_name})\n")
        } else {
            note_body(&item)
        };
        let markdown = format!(
            "---\nsource: clipboard\nkind: {}\ncopied: {}\n---\n\n# {title}\n\n{body}",
            item.kind.as_str(),
            item.created_at
        );
        vault.create_note(&format!("{NOTE_FOLDER}/{title}.md"), &markdown)
    }

    // ── Files ──

    /// `<images>/<id>.png` or `<images>/<id>.thumb.png`. Only called with
    /// validated UUIDs, so the path never leaves the images directory.
    fn image_path(&self, id: &str, thumbnail: bool) -> PathBuf {
        let suffix = if thumbnail { ".thumb.png" } else { ".png" };
        self.images_dir.join(format!("{id}{suffix}"))
    }

    fn remove_image_files(&self, id: &str) {
        for thumbnail in [false, true] {
            let path = self.image_path(id, thumbnail);
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("[clipboard] could not remove {}: {e}", path.display());
                }
            }
        }
    }

    #[cfg(test)]
    fn conn(&self) -> MutexGuard<'_, Connection> {
        lock(&self.db)
    }
}

// ── Storage helpers ─────────────────────────────────────────────────

fn load_settings(path: &Path) -> Result<ClipboardSettings, AetherError> {
    if !path.exists() {
        let defaults = ClipboardSettings::default();
        let json = serde_json::to_string_pretty(&defaults)
            .map_err(|e| AetherError::InvalidInput(format!("settings serialize: {e}")))?;
        write_file(path, json.as_bytes())?;
        return Ok(defaults);
    }
    let raw = std::fs::read_to_string(path)?;
    match serde_json::from_str::<ClipboardSettings>(&raw) {
        Ok(settings) => Ok(settings.clamped()),
        Err(e) => {
            // Keep working with defaults; the next save rewrites the file.
            eprintln!(
                "[clipboard] ignoring unreadable {}: {e}",
                path.to_string_lossy()
            );
            Ok(ClipboardSettings::default())
        }
    }
}

/// Write via a temporary file + rename so a crash never leaves half a file.
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), AetherError> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Rebuild the FTS index when it drifted from `clips` (e.g. a crash between
/// an external tool's writes). Cheap check on every start.
fn repair_fts_if_needed(conn: &Connection) -> Result<(), AetherError> {
    let clips: i64 = conn.query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0))?;
    let indexed: i64 = conn.query_row("SELECT COUNT(*) FROM clips_fts", [], |r| r.get(0))?;
    if clips == indexed {
        return Ok(());
    }
    conn.execute_batch(
        "INSERT INTO clips_fts (clips_fts) VALUES ('delete-all');
         INSERT INTO clips_fts (rowid, content)
         SELECT rowid, CASE WHEN kind = 'image' THEN 'image ' || preview ELSE content END
         FROM clips;",
    )?;
    Ok(())
}

fn item_from_row(row: &Row<'_>) -> rusqlite::Result<ClipItem> {
    let kind: String = row.get(1)?;
    let kind = ClipKind::parse(&kind).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            format!("unknown clip kind {kind}").into(),
        )
    })?;
    Ok(ClipItem {
        id: row.get(0)?,
        kind,
        content: row.get(2)?,
        preview: row.get(3)?,
        byte_len: row.get(4)?,
        pinned: row.get(5)?,
        source_app: row.get(6)?,
        copy_count: row.get(7)?,
        created_at: row.get(8)?,
        last_copied_at: row.get(9)?,
        truncated: false,
    })
}

fn fetch_item(conn: &Connection, id: &str) -> Result<ClipItem, AetherError> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM clips WHERE id = ?1"),
        [id],
        item_from_row,
    )
    .optional()?
    .ok_or_else(|| not_found(id))
}

fn not_found(id: &str) -> AetherError {
    AetherError::InvalidInput(format!("clip {id} not found"))
}

/// Clip ids are hyphenated lowercase UUIDs (as generated by the engine);
/// anything else — including the braced, URN and simple UUID spellings —
/// is rejected before it reaches a query or a file path.
fn validate_id(id: &str) -> Result<(), AetherError> {
    let canonical = uuid::Uuid::parse_str(id)
        .map(|u| u.hyphenated().to_string() == id)
        .unwrap_or(false);
    if canonical {
        Ok(())
    } else {
        Err(AetherError::InvalidInput(format!("invalid clip id: {id}")))
    }
}

fn text_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"text\0");
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn image_hash(width: usize, height: usize, rgba: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("image\0{width}x{height}\0").as_bytes());
    hasher.update(rgba);
    hex::encode(hasher.finalize())
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, AetherError> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| AetherError::InvalidInput(format!("PNG encoding failed: {e}")))?;
    Ok(out)
}

/// Longest side ≤ [`THUMBNAIL_MAX_SIDE`], aspect ratio kept.
fn thumbnail_size(width: u32, height: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= THUMBNAIL_MAX_SIDE {
        return (width, height);
    }
    let scale = f64::from(THUMBNAIL_MAX_SIDE) / f64::from(longest);
    let w = ((f64::from(width) * scale).round() as u32).max(1);
    let h = ((f64::from(height) * scale).round() as u32).max(1);
    (w, h)
}

fn encode_thumbnail(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, AetherError> {
    let (tw, th) = thumbnail_size(width, height);
    if (tw, th) == (width, height) {
        return encode_png(width, height, rgba);
    }
    let view = image::ImageBuffer::<image::Rgba<u8>, &[u8]>::from_raw(width, height, rgba)
        .ok_or_else(|| AetherError::InvalidInput("image buffer size mismatch".into()))?;
    let small = image::imageops::thumbnail(&view, tw, th);
    encode_png(tw, th, small.as_raw())
}

/// `<dir>/<stem>.<ext>`, or `<stem> 2.<ext>`, … when taken.
fn unique_file(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..10_000)
        .map(|i| dir.join(format!("{stem} {i}.{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

// ── Search ──────────────────────────────────────────────────────────

/// A user query split into an FTS5 expression and substring needles.
#[derive(Debug, PartialEq)]
struct SearchTerms {
    fts: Option<String>,
    substrings: Vec<String>,
}

impl SearchTerms {
    /// Words with letters/digits become quoted FTS5 prefix terms
    /// (`"word"*`, AND-ed) — quoting neutralises FTS5 syntax. Pure
    /// punctuation (`=>`, `#`) cannot be tokenised and is matched with LIKE.
    fn parse(query: &str) -> Self {
        let mut fts_terms = Vec::new();
        let mut substrings = Vec::new();
        for word in query.split_whitespace() {
            if word.chars().any(char::is_alphanumeric) {
                fts_terms.push(format!("\"{}\"*", word.replace('"', "\"\"")));
            } else {
                substrings.push(word.to_owned());
            }
        }
        Self {
            fts: (!fts_terms.is_empty()).then(|| fts_terms.join(" ")),
            substrings,
        }
    }
}

fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// ── Classification ──────────────────────────────────────────────────

/// Decide what kind of text was copied: color, URL, code or plain text.
pub fn classify(text: &str) -> ClipKind {
    let trimmed = text.trim();
    if is_color(trimmed) {
        ClipKind::Color
    } else if is_url(trimmed) {
        ClipKind::Url
    } else if is_code(text) {
        ClipKind::Code
    } else {
        ClipKind::Text
    }
}

fn color_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let num = r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|deg|turn|rad)?";
        let pattern = format!(
            r"(?ix)^(?:
                \#(?:[0-9a-f]{{3,4}}|[0-9a-f]{{6}}|[0-9a-f]{{8}})
              | (?:rgba?|hsla?)\(\s*{num}\s*,\s*{num}\s*,\s*{num}\s*(?:,\s*{num}\s*)?\)
              | (?:rgba?|hsla?)\(\s*{num}\s+{num}\s+{num}\s*(?:/\s*{num}\s*)?\)
            )$"
        );
        Regex::new(&pattern).expect("valid color regex")
    })
}

/// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()/hsl()/hsla()`.
/// Short all-digit forms (`#123`, `#1234`) are issue references, not colors.
pub fn is_color(text: &str) -> bool {
    if !color_regex().is_match(text) {
        return false;
    }
    if let Some(hex) = text.strip_prefix('#') {
        let short = hex.len() <= 4;
        if short && hex.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    true
}

/// A single-token web/mail/file link (`www.` links count too).
pub fn is_url(text: &str) -> bool {
    if text.is_empty() || text.contains(char::is_whitespace) {
        return false;
    }
    let candidate = if text.len() > 4 && text[..4].eq_ignore_ascii_case("www.") {
        format!("https://{text}")
    } else {
        text.to_owned()
    };
    let Ok(url) = url::Url::parse(&candidate) else {
        return false;
    };
    match url.scheme() {
        "http" | "https" | "ftp" | "ftps" | "ws" | "wss" => url
            .host_str()
            .map(|h| h.contains('.') || h == "localhost" || h.parse::<std::net::IpAddr>().is_ok())
            .unwrap_or(false),
        "mailto" => url.path().contains('@'),
        "file" => url.path().len() > 1,
        _ => false,
    }
}

const CODE_KEYWORDS: &[&str] = &[
    "fn ",
    "pub fn ",
    "pub struct ",
    "impl ",
    "use ",
    "let ",
    "let mut ",
    "const ",
    "var ",
    "def ",
    "class ",
    "import ",
    "from ",
    "export ",
    "function ",
    "func ",
    "package ",
    "return ",
    "async ",
    "await ",
    "#include",
    "#define",
    "#!/",
    "interface ",
    "struct ",
    "enum ",
    "type ",
    "if (",
    "for (",
    "while (",
    "switch (",
    "} else",
    "elif ",
    "except",
    "try {",
    "SELECT ",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
    "CREATE TABLE",
    "<?php",
    "<!DOCTYPE",
    "@media",
];

const CODE_MARKERS: &[&str] = &[
    "=>", "->", "::", "==", "!=", "&&", "||", ":=", "</", "/>", "+=", "();",
];

/// Heuristic: at least two non-empty lines, and at least a quarter of them
/// carry code signals (keywords at line start, trailing `{ } ; )` or
/// operators such as `=>`, `::`, `==`). Needs two signal lines, or one plus
/// a keyword.
pub fn is_code(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() < 2 {
        return false;
    }
    let mut signal_lines = 0usize;
    let mut keyword = false;
    for line in &lines {
        let trimmed = line.trim();
        let starts_kw = CODE_KEYWORDS.iter().any(|kw| trimmed.starts_with(kw));
        let ends_symbol = matches!(
            trimmed.chars().last(),
            Some('{') | Some('}') | Some(';') | Some(')') | Some(']')
        ) || trimmed.ends_with("):")
            || trimmed.ends_with("=>");
        let has_marker = CODE_MARKERS.iter().any(|m| trimmed.contains(m));
        if starts_kw {
            keyword = true;
        }
        if starts_kw || ends_symbol || has_marker {
            signal_lines += 1;
        }
    }
    (signal_lines >= 2 || (signal_lines >= 1 && keyword)) && signal_lines * 4 >= lines.len()
}

/// Best-effort fence language for code saved as a note.
fn guess_code_language(code: &str) -> &'static str {
    let has = |needle: &str| code.contains(needle);
    if has("fn ") && (has("let ") || has("pub ") || has("->") || has("impl ")) {
        "rust"
    } else if has("def ") || (has("import ") && has(":\n")) || has("self.") && has(":\n") {
        "python"
    } else if has("interface ") || has(": string") || has(": number") || has("import type") {
        "typescript"
    } else if has("function ") || has("const ") || has("=>") || has("console.") {
        "javascript"
    } else if has("SELECT ") || has("INSERT INTO") || has("CREATE TABLE") {
        "sql"
    } else if has("#include") {
        "c"
    } else if has("package ") && has("func ") {
        "go"
    } else if code.trim_start().starts_with('<') {
        "html"
    } else if code.trim_start().starts_with('{') && has("\":") {
        "json"
    } else if has("#!/bin/") || code.trim_start().starts_with("$ ") {
        "bash"
    } else {
        ""
    }
}

/// First non-empty line, whitespace collapsed, ≤ 200 characters.
pub fn text_preview(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PREVIEW_MAX_CHARS {
        collapsed
    } else {
        let mut cut: String = collapsed.chars().take(PREVIEW_MAX_CHARS - 1).collect();
        cut.push('…');
        cut
    }
}

// ── Secret detection ────────────────────────────────────────────────

fn secret_patterns() -> &'static RegexSet {
    static SET: OnceLock<RegexSet> = OnceLock::new();
    SET.get_or_init(|| {
        RegexSet::new([
            // OpenAI / Anthropic / OpenRouter style keys.
            r"\bsk-(?:proj-|ant-|or-|live-|test-)?[A-Za-z0-9_\-]{20,}",
            // Stripe secret / restricted keys.
            r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}",
            // GitHub tokens.
            r"\bgh[pousr]_[A-Za-z0-9]{30,}",
            r"\bgithub_pat_[A-Za-z0-9_]{40,}",
            // GitLab, Slack, npm, Hugging Face, PyPI.
            r"\bglpat-[A-Za-z0-9_\-]{20,}",
            r"\bxox[abprse]-[A-Za-z0-9\-]{10,}",
            r"\bnpm_[A-Za-z0-9]{36}\b",
            r"\bhf_[A-Za-z0-9]{30,}\b",
            r"\bpypi-[A-Za-z0-9_\-]{50,}",
            // AWS access key ids, Google API keys, SendGrid keys.
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
            r"\bAIza[0-9A-Za-z_\-]{35}\b",
            r"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}",
            // JSON Web Tokens.
            r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
            // PEM private keys.
            r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----",
        ])
        .expect("valid secret patterns")
    })
}

/// Privacy filter: `true` for text that should never be stored —
/// well-known token formats (OpenAI `sk-`, GitHub `ghp_`, AWS `AKIA`, JWT
/// `eyJ…`, Slack, Stripe, private keys, …) anywhere in the text, card
/// numbers (Luhn-valid), and single tokens of 32+ characters that look
/// random (high entropy, few vowels) or are long hex strings. Git commit
/// hashes, UUIDs, URLs, paths and e-mail addresses are exempt.
pub fn looks_like_secret(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if secret_patterns().is_match(trimmed) {
        return true;
    }
    if is_card_number(trimmed) {
        return true;
    }
    !trimmed.contains(char::is_whitespace) && is_random_token(trimmed)
}

/// 13–19 digits (spaces / dashes allowed) passing the Luhn check.
fn is_card_number(text: &str) -> bool {
    if !text
        .chars()
        .all(|c| c.is_ascii_digit() || c == ' ' || c == '-')
    {
        return false;
    }
    let digits: Vec<u32> = text.chars().filter_map(|c| c.to_digit(10)).collect();
    if !(13..=19).contains(&digits.len()) || digits.iter().all(|d| *d == digits[0]) {
        return false;
    }
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            if i % 2 == 1 {
                let doubled = d * 2;
                if doubled > 9 {
                    doubled - 9
                } else {
                    doubled
                }
            } else {
                d
            }
        })
        .sum();
    sum % 10 == 0
}

fn is_random_token(token: &str) -> bool {
    let len = token.chars().count();
    if !(32..=1024).contains(&len) {
        return false;
    }
    if !token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_+/=.~".contains(c))
    {
        return false;
    }
    if is_url(token) || looks_like_path(token) || is_uuid(token) {
        return false;
    }
    let hex = token
        .strip_prefix("0x")
        .or_else(|| token.strip_prefix("0X"))
        .unwrap_or(token);
    if hex.len() >= 32 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        // 40 hex characters is a git commit hash; other long hex strings
        // are indistinguishable from raw keys (API keys, wallet keys).
        return hex.len() != 40;
    }
    let letters: Vec<char> = token.chars().filter(char::is_ascii_alphabetic).collect();
    let digits = token.chars().filter(char::is_ascii_digit).count();
    if letters.is_empty() || digits == 0 {
        return false;
    }
    let vowels = letters
        .iter()
        .filter(|c| "aeiouAEIOU".contains(**c))
        .count();
    let vowel_ratio = vowels as f64 / letters.len() as f64;
    shannon_entropy(token) >= 3.5 && vowel_ratio < 0.3
}

fn looks_like_path(token: &str) -> bool {
    let starts = ["/", "./", "../", "~/"];
    if starts.iter().any(|s| token.starts_with(s)) {
        return true;
    }
    // `src/lib/file.ts`: separators plus a file extension.
    if token.contains('/') {
        if let Some((_, ext)) = token.rsplit_once('.') {
            return (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric());
        }
    }
    false
}

fn is_uuid(token: &str) -> bool {
    token.len() == 36 && uuid::Uuid::parse_str(token).is_ok()
}

/// Shannon entropy in bits per character.
fn shannon_entropy(text: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    let mut total = 0usize;
    for c in text.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    counts
        .values()
        .map(|&n| {
            let p = n as f64 / total as f64;
            -p * p.log2()
        })
        .sum()
}

// ── Notes ───────────────────────────────────────────────────────────

/// A filesystem-safe note title (≤ 80 chars). Falls back to the clip's
/// preview, then to `Clip <date>`.
fn note_title(requested: &str, item: &ClipItem) -> String {
    let clean = |raw: &str| -> String {
        let filtered: String = raw
            .chars()
            .map(|c| {
                if c.is_control() || "/\\:*?\"<>|#^[]".contains(c) {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        let collapsed = filtered.split_whitespace().collect::<Vec<_>>().join(" ");
        let trimmed = collapsed.trim_matches(|c: char| c == '.' || c.is_whitespace());
        trimmed
            .chars()
            .take(NOTE_TITLE_MAX_CHARS)
            .collect::<String>()
    };
    let title = clean(requested);
    if !title.is_empty() {
        return title;
    }
    if item.kind != ClipKind::Image {
        let from_preview = clean(&item.preview);
        if !from_preview.is_empty() {
            return from_preview;
        }
    }
    let date = item.created_at.get(..10).unwrap_or("today");
    format!("Clip {date}")
}

/// Markdown body for a non-image clip.
fn note_body(item: &ClipItem) -> String {
    match item.kind {
        ClipKind::Url => format!("<{}>\n", item.content.trim()),
        ClipKind::Color => format!("`{}`\n", item.content.trim()),
        ClipKind::Code => {
            let longest_run = item
                .content
                .split(|c| c != '`')
                .map(str::len)
                .max()
                .unwrap_or(0);
            let fence = "`".repeat(longest_run.max(2) + 1);
            let language = guess_code_language(&item.content);
            format!(
                "{fence}{language}\n{}\n{fence}\n",
                item.content.trim_end_matches('\n')
            )
        }
        ClipKind::Text | ClipKind::Image => {
            let mut body = item.content.clone();
            if !body.ends_with('\n') {
                body.push('\n');
            }
            body
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn engine() -> (tempfile::TempDir, ClipboardEngine) {
        let dir = tempfile::tempdir().expect("temp dir");
        let engine = ClipboardEngine::new(&dir.path().join("clipboard")).expect("engine");
        (dir, engine)
    }

    fn inserted(outcome: IngestOutcome) -> ClipItem {
        match outcome {
            IngestOutcome::Inserted(item) => item,
            other => panic!("expected an insert, got {other:?}"),
        }
    }

    fn ids(items: &[ClipItem]) -> Vec<String> {
        items.iter().map(|i| i.id.clone()).collect()
    }

    fn list(engine: &ClipboardEngine, query: &str) -> Vec<ClipItem> {
        engine
            .list(&ListQuery {
                query: Some(query.to_owned()),
                ..ListQuery::default()
            })
            .expect("list")
    }

    fn backdate(engine: &ClipboardEngine, id: &str, days: i64) {
        let ts = (Utc::now() - chrono::Duration::days(days))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        engine
            .conn()
            .execute(
                "UPDATE clips SET last_copied_at = ?2 WHERE id = ?1",
                params![id, ts],
            )
            .expect("backdate");
    }

    fn checkerboard(width: usize, height: usize) -> RawImage {
        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let on = (x + y) % 2 == 0;
                rgba.extend_from_slice(if on {
                    &[240, 80, 40, 255]
                } else {
                    &[20, 30, 200, 128]
                });
            }
        }
        RawImage {
            width,
            height,
            rgba,
        }
    }

    /// Scripted clipboard for watcher tests.
    #[derive(Default)]
    struct FakeClipboard {
        text: Option<String>,
        image: Option<RawImage>,
        image_reads: usize,
        errors: VecDeque<String>,
    }

    impl ClipboardSource for FakeClipboard {
        fn read_text(&mut self) -> Result<Option<String>, String> {
            if let Some(error) = self.errors.pop_front() {
                return Err(error);
            }
            Ok(self.text.clone())
        }

        fn read_image(&mut self) -> Result<Option<RawImage>, String> {
            self.image_reads += 1;
            Ok(self.image.clone())
        }
    }

    // ── classification ──

    #[test]
    fn classifies_urls() {
        for url in [
            "https://example.com",
            "http://localhost:1420/app",
            "https://github.com/EkexDon/AETHER-OS/pull/12?tab=files#diff",
            "www.rust-lang.org/learn",
            "mailto:ekin@example.com",
            "file:///Users/ekin/notes.md",
            "  https://example.com/trailing-space  ",
        ] {
            assert_eq!(classify(url), ClipKind::Url, "{url}");
        }
        for not_url in [
            "example.com",
            "foo:bar",
            "https://",
            "see https://example.com for details",
            "C:\\Users\\ekin",
            "notes.md",
        ] {
            assert_ne!(classify(not_url), ClipKind::Url, "{not_url}");
        }
    }

    #[test]
    fn classifies_colors() {
        for color in [
            "#3fb0a3",
            "#FFF",
            "#ffffff80",
            "#abcd",
            "rgb(63, 176, 163)",
            "rgba(63,176,163,0.5)",
            "rgb(63 176 163 / 50%)",
            "hsl(173, 48%, 47%)",
            "hsla(173deg 48% 47% / .4)",
        ] {
            assert_eq!(classify(color), ClipKind::Color, "{color}");
        }
        for not_color in [
            "#123",
            "#1234",
            "#ggg",
            "rgb(1,2)",
            "#3fb0a3 is teal",
            "red",
        ] {
            assert_ne!(classify(not_color), ClipKind::Color, "{not_color}");
        }
    }

    #[test]
    fn classifies_code() {
        let rust = "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}";
        let python = "def greet(name):\n    return f\"hi {name}\"";
        let ts = "const add = (a: number, b: number) =>\n  a + b;";
        let sql = "SELECT id, title\nFROM notes\nWHERE pinned = 1;";
        for code in [rust, python, ts, sql] {
            assert_eq!(classify(code), ClipKind::Code, "{code}");
        }
        let prose = "Dear team,\nthe release ships tomorrow. Please review the notes.\nThanks!";
        let single = "let x = 1;";
        let list = "- milk\n- bread\n- eggs";
        for text in [prose, single, list] {
            assert_eq!(classify(text), ClipKind::Text, "{text}");
        }
    }

    #[test]
    fn previews_are_single_line_and_bounded() {
        assert_eq!(text_preview("\n\n  hello   world \nsecond"), "hello world");
        let long = "a".repeat(500);
        let preview = text_preview(&long);
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS);
        assert!(preview.ends_with('…'));
    }

    // ── secrets ──

    #[test]
    fn detects_secrets() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.\
                   eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkVraW4ifQ.\
                   SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        // Assembled at runtime: a literal in this exact shape trips GitHub's
        // push protection even though the value is made up.
        let slack = format!(
            "xoxb-{}-{}-{}",
            "123456789012", "1234567890123", "AbCdEfGhIjKlMnOp"
        );
        for secret in [
            "sk-proj-4f9Qm2Lp9Vt4Rk7Ws1Yb6Nc3Hd5Jf0GaXe8Tz",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
            "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
            "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF",
            "AKIAIOSFODNN7EXAMPLE",
            slack.as_str(),
            "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
            jwt,
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghijkl",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END",
            "-----BEGIN PRIVATE KEY-----",
            // Random-looking single tokens.
            "Zx8Qm2Lp9Vt4Rk7Ws1Yb6Nc3Hd5Jf0Ga",
            "k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8o9p0",
            // Long hex (API keys, wallet keys, SHA-256).
            "9f86d081884c7d659a2feaa0c55ad015",
            "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
            // Card numbers (Luhn).
            "4111 1111 1111 1111",
            "5500-0000-0000-0004",
        ] {
            assert!(looks_like_secret(secret), "should be secret: {secret}");
        }
    }

    #[test]
    fn keeps_ordinary_text() {
        for text in [
            "Hello world, this is a normal sentence that is quite long indeed.",
            "3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
            "550e8400-e29b-41d4-a716-446655440000",
            "https://example.com/a/very/long/path/that/goes/on/and/on?x=12345",
            "/Users/ekin/Documents/Projects/aether-os/src-tauri/src/engine/clipboard.rs",
            "src/components/clipboard/ClipboardView2.test.tsx",
            "aether_v0_2_boil_the_ocean_release_2026",
            "useClipboardStoreSelectorWithEquality2",
            "ekin.baca.with.a.long.address@example-company.com",
            "task-force-alpha is ready",
            "sk-learn is a library",
            "1234 5678",
            "1111111111111111",
            "#3fb0a3",
        ] {
            assert!(!looks_like_secret(text), "should not be secret: {text}");
        }
    }

    #[test]
    fn secrets_are_never_stored() {
        let (_dir, engine) = engine();
        let outcome = engine
            .ingest_text("ghp_16C7e42F292c6912E7710c838347Ae178B4a")
            .expect("ingest");
        assert_eq!(outcome, IngestOutcome::Skipped(SkipReason::Secret));
        let stats = engine.stats().expect("stats");
        assert_eq!(stats.total, 0);
        assert_eq!(stats.skipped_secrets, 1);
    }

    // ── recording ──

    #[test]
    fn ignores_empty_and_oversized_text() {
        let (_dir, engine) = engine();
        assert_eq!(
            engine.ingest_text("  \n\t ").expect("ingest"),
            IngestOutcome::Skipped(SkipReason::Empty)
        );
        let huge = "a b ".repeat(MAX_TEXT_BYTES / 4 + 1);
        assert_eq!(
            engine.ingest_text(&huge).expect("ingest"),
            IngestOutcome::Skipped(SkipReason::TooLarge)
        );
        assert_eq!(engine.stats().expect("stats").total, 0);
    }

    #[test]
    fn records_kind_preview_and_counters() {
        let (_dir, engine) = engine();
        let item = inserted(
            engine
                .ingest_text("https://example.com/docs")
                .expect("ingest"),
        );
        assert_eq!(item.kind, ClipKind::Url);
        assert_eq!(item.preview, "https://example.com/docs");
        assert_eq!(item.byte_len, 24);
        assert_eq!(item.copy_count, 1);
        assert!(!item.pinned);
        assert_eq!(item.source_app, None);
        assert_eq!(item.created_at, item.last_copied_at);
        assert_eq!(engine.get(&item.id).expect("get"), item);
    }

    #[test]
    fn recopy_moves_to_top_and_bumps_count() {
        let (_dir, engine) = engine();
        let first = inserted(engine.ingest_text("first clip").expect("ingest"));
        let second = inserted(engine.ingest_text("second clip").expect("ingest"));
        assert_eq!(
            ids(&engine.list(&ListQuery::default()).expect("list")),
            vec![second.id.clone(), first.id.clone()]
        );

        let bumped = match engine.ingest_text("first clip").expect("ingest") {
            IngestOutcome::Bumped(item) => item,
            other => panic!("expected bump, got {other:?}"),
        };
        assert_eq!(bumped.id, first.id);
        assert_eq!(bumped.copy_count, 2);
        assert!(bumped.last_copied_at > second.last_copied_at);
        assert_eq!(bumped.created_at, first.created_at);
        let listed = engine.list(&ListQuery::default()).expect("list");
        assert_eq!(ids(&listed), vec![first.id.clone(), second.id]);
        assert_eq!(engine.stats().expect("stats").total, 2);

        let copied = engine.mark_copied(&first.id).expect("mark copied");
        assert_eq!(copied.copy_count, 3);
    }

    #[test]
    fn pause_and_disable_block_capture() {
        let (_dir, engine) = engine();
        engine.set_paused(true);
        assert_eq!(
            engine.ingest_text("while paused").expect("ingest"),
            IngestOutcome::Skipped(SkipReason::Paused)
        );
        assert!(engine.stats().expect("stats").paused);
        engine.set_paused(false);
        let mut settings = engine.settings();
        settings.enabled = false;
        engine.set_settings(settings).expect("settings");
        assert_eq!(
            engine.ingest_text("while disabled").expect("ingest"),
            IngestOutcome::Skipped(SkipReason::Disabled)
        );
        assert_eq!(engine.stats().expect("stats").total, 0);
    }

    #[test]
    fn pin_delete_and_clear() {
        let (_dir, engine) = engine();
        let a = inserted(engine.ingest_text("alpha").expect("ingest"));
        let b = inserted(engine.ingest_text("beta").expect("ingest"));
        let c = inserted(engine.ingest_text("gamma").expect("ingest"));

        let pinned = engine.set_pinned(&a.id, true).expect("pin");
        assert!(pinned.pinned);
        let only_pinned = engine
            .list(&ListQuery {
                pinned_only: true,
                ..ListQuery::default()
            })
            .expect("list");
        assert_eq!(ids(&only_pinned), vec![a.id.clone()]);

        engine.delete(&b.id).expect("delete");
        assert!(engine.get(&b.id).is_err());
        assert!(
            engine.delete(&b.id).is_err(),
            "second delete reports not found"
        );

        assert_eq!(engine.clear(true).expect("clear"), 1);
        assert!(engine.get(&c.id).is_err());
        assert_eq!(
            ids(&engine.list(&ListQuery::default()).expect("list")),
            vec![a.id.clone()]
        );
        assert_eq!(engine.clear(false).expect("clear all"), 1);
        assert_eq!(engine.stats().expect("stats").total, 0);
    }

    #[test]
    fn rejects_invalid_ids() {
        let (_dir, engine) = engine();
        let upper = uuid::Uuid::new_v4().to_string().to_uppercase();
        let braced = format!("{{{}}}", uuid::Uuid::new_v4());
        let urn = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        let simple = uuid::Uuid::new_v4().simple().to_string();
        for bad in [
            "",
            "../../etc/passwd",
            "not-a-uuid",
            &upper,
            &braced,
            &urn,
            &simple,
        ] {
            assert!(engine.get(bad).is_err());
            assert!(engine.delete(bad).is_err());
            assert!(engine.image_data_url(bad, true).is_err());
        }
        let missing = uuid::Uuid::new_v4().to_string();
        let err = engine.set_pinned(&missing, true).expect_err("missing clip");
        assert!(err.to_string().contains("not found"));
    }

    // ── retention ──

    #[test]
    fn prunes_by_count_but_keeps_pinned() {
        let (_dir, engine) = engine();
        let mut settings = engine.settings();
        settings.max_items = 10;
        engine.set_settings(settings).expect("settings");

        let keeper = inserted(engine.ingest_text("pinned forever").expect("ingest"));
        engine.set_pinned(&keeper.id, true).expect("pin");
        let mut unpinned = Vec::new();
        for i in 0..15 {
            unpinned.push(inserted(
                engine
                    .ingest_text(&format!("clip number {i}"))
                    .expect("ingest"),
            ));
        }
        let stats = engine.stats().expect("stats");
        assert_eq!(stats.total, 11, "10 unpinned + 1 pinned");
        assert!(engine.get(&keeper.id).is_ok(), "pinned clip survives");
        assert!(engine.get(&unpinned[0].id).is_err(), "oldest pruned");
        assert!(engine.get(&unpinned[14].id).is_ok(), "newest kept");
    }

    #[test]
    fn prunes_by_age_but_keeps_pinned() {
        let (_dir, engine) = engine();
        let old = inserted(engine.ingest_text("old clip").expect("ingest"));
        let old_pinned = inserted(engine.ingest_text("old but pinned").expect("ingest"));
        let fresh = inserted(engine.ingest_text("fresh clip").expect("ingest"));
        engine.set_pinned(&old_pinned.id, true).expect("pin");
        backdate(&engine, &old.id, 40);
        backdate(&engine, &old_pinned.id, 400);

        assert_eq!(engine.prune().expect("prune"), 1);
        assert!(engine.get(&old.id).is_err());
        assert!(engine.get(&old_pinned.id).is_ok());
        assert!(engine.get(&fresh.id).is_ok());

        // keep_days = 0 keeps everything forever.
        let aged = inserted(engine.ingest_text("ancient").expect("ingest"));
        backdate(&engine, &aged.id, 3000);
        let mut settings = engine.settings();
        settings.keep_days = 0;
        engine.set_settings(settings).expect("settings");
        assert!(engine.get(&aged.id).is_ok());
    }

    // ── search ──

    #[test]
    fn full_text_search_with_prefixes_diacritics_and_filters() {
        let (_dir, engine) = engine();
        let recipe = inserted(
            engine
                .ingest_text("Spätzle mit Käse und Zwiebeln")
                .expect("ingest"),
        );
        let code = inserted(
            engine
                .ingest_text(
                    "const total = items.reduce((a, b) => a + b, 0);\nexport default total;",
                )
                .expect("ingest"),
        );
        let link = inserted(
            engine
                .ingest_text("https://docs.rs/rusqlite")
                .expect("ingest"),
        );

        assert_eq!(ids(&list(&engine, "kase")), vec![recipe.id.clone()]);
        assert_eq!(ids(&list(&engine, "Zwieb")), vec![recipe.id.clone()]);
        assert_eq!(ids(&list(&engine, "reduce total")), vec![code.id.clone()]);
        assert_eq!(ids(&list(&engine, "=>")), vec![code.id.clone()]);
        assert_eq!(ids(&list(&engine, "rusqlite")), vec![link.id.clone()]);
        assert!(list(&engine, "nonexistent").is_empty());
        // FTS syntax in user input is neutralised, not an error.
        assert!(list(&engine, "\"AND OR NOT ( * :").is_empty());
        assert!(list(&engine, "100%").is_empty());

        let by_kind = engine
            .list(&ListQuery {
                kind: Some(ClipKind::Code),
                ..ListQuery::default()
            })
            .expect("list");
        assert_eq!(ids(&by_kind), vec![code.id.clone()]);

        // Search keeps working after deletes and updates (FTS triggers).
        engine.delete(&recipe.id).expect("delete");
        assert!(list(&engine, "kase").is_empty());
        engine.set_pinned(&code.id, true).expect("pin");
        assert_eq!(ids(&list(&engine, "reduce")), vec![code.id]);
    }

    #[test]
    fn list_pages_and_truncates_long_content() {
        let (_dir, engine) = engine();
        for i in 0..5 {
            engine
                .ingest_text(&format!("page item {i}"))
                .expect("ingest");
        }
        let page = engine
            .list(&ListQuery {
                limit: Some(2),
                offset: Some(2),
                ..ListQuery::default()
            })
            .expect("list");
        assert_eq!(
            page.iter().map(|i| i.content.as_str()).collect::<Vec<_>>(),
            vec!["page item 2", "page item 1"]
        );

        let long = "word ".repeat(4000);
        let item = inserted(engine.ingest_text(&long).expect("ingest"));
        let listed = &engine
            .list(&ListQuery {
                limit: Some(1),
                ..ListQuery::default()
            })
            .expect("list")[0];
        assert!(listed.truncated);
        assert_eq!(
            listed.content.chars().count(),
            LIST_CONTENT_MAX_CHARS as usize
        );
        let full = engine.get(&item.id).expect("get");
        assert!(!full.truncated);
        assert_eq!(full.content, long);
    }

    #[test]
    fn search_terms_are_quoted() {
        assert_eq!(
            SearchTerms::parse("foo \"bar\" => x*"),
            SearchTerms {
                fts: Some("\"foo\"* \"\"\"bar\"\"\"* \"x*\"*".into()),
                substrings: vec!["=>".into()],
            }
        );
        assert_eq!(escape_like("100%_a\\b"), "100\\%\\_a\\\\b");
    }

    #[test]
    fn repairs_a_drifted_fts_index() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("clipboard");
        {
            let engine = ClipboardEngine::new(&root).expect("engine");
            engine.ingest_text("searchable words").expect("ingest");
            engine
                .conn()
                .execute_batch("INSERT INTO clips_fts (clips_fts) VALUES ('delete-all');")
                .expect("wipe fts");
            assert!(list(&engine, "searchable").is_empty());
        }
        let engine = ClipboardEngine::new(&root).expect("reopen");
        assert_eq!(list(&engine, "searchable").len(), 1);
    }

    // ── images ──

    #[test]
    fn image_round_trip() {
        let (_dir, engine) = engine();
        let image = checkerboard(600, 300);
        let item = inserted(engine.ingest_image(&image).expect("ingest"));
        assert_eq!(item.kind, ClipKind::Image);
        assert_eq!(item.preview, "600x300");
        let full = PathBuf::from(&item.content);
        assert!(full.exists(), "PNG written");
        assert!(
            engine.image_path(&item.id, true).exists(),
            "thumbnail written"
        );
        assert_eq!(
            item.byte_len as u64,
            std::fs::metadata(&full).expect("meta").len()
        );

        // PNG decodes back to the exact pixels.
        let decoded = engine.load_image(&item.id).expect("decode");
        assert_eq!(decoded, image);
        let thumb = image::open(engine.image_path(&item.id, true)).expect("thumb");
        assert_eq!((thumb.width(), thumb.height()), (256, 128));

        let url = engine.image_data_url(&item.id, true).expect("data url");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(engine.image_data_url(&item.id, false).expect("full").len() > 30);

        // Identical image dedupes; images are searchable by "image".
        assert!(matches!(
            engine.ingest_image(&image).expect("again"),
            IngestOutcome::Bumped(_)
        ));
        assert_eq!(ids(&list(&engine, "image")), vec![item.id.clone()]);

        engine.delete(&item.id).expect("delete");
        assert!(!full.exists(), "files removed with the clip");
        assert!(!engine.image_path(&item.id, true).exists());
    }

    #[test]
    fn image_limits_and_setting() {
        let (_dir, engine) = engine();
        let bad = RawImage {
            width: 4,
            height: 4,
            rgba: vec![0; 10],
        };
        assert!(engine.ingest_image(&bad).is_err());
        let empty = RawImage {
            width: 0,
            height: 10,
            rgba: vec![],
        };
        assert_eq!(
            engine.ingest_image(&empty).expect("ingest"),
            IngestOutcome::Skipped(SkipReason::Empty)
        );
        let huge = RawImage {
            width: 100_000,
            height: 1_000,
            rgba: vec![],
        };
        assert_eq!(
            engine.ingest_image(&huge).expect("ingest"),
            IngestOutcome::Skipped(SkipReason::TooLarge)
        );
        let mut settings = engine.settings();
        settings.capture_images = false;
        engine.set_settings(settings).expect("settings");
        assert_eq!(
            engine.ingest_image(&checkerboard(2, 2)).expect("ingest"),
            IngestOutcome::Skipped(SkipReason::ImagesDisabled)
        );
        let text = inserted(engine.ingest_text("not an image").expect("ingest"));
        assert!(engine.image_data_url(&text.id, false).is_err());
    }

    #[test]
    fn pruning_an_image_removes_its_files() {
        let (_dir, engine) = engine();
        let item = inserted(engine.ingest_image(&checkerboard(3, 3)).expect("ingest"));
        let path = PathBuf::from(&item.content);
        backdate(&engine, &item.id, 90);
        assert_eq!(engine.prune().expect("prune"), 1);
        assert!(!path.exists());
    }

    #[test]
    fn thumbnail_sizes_keep_aspect_ratio() {
        assert_eq!(thumbnail_size(100, 50), (100, 50));
        assert_eq!(thumbnail_size(2880, 1800), (256, 160));
        assert_eq!(thumbnail_size(10, 5000), (1, 256));
    }

    // ── settings ──

    #[test]
    fn settings_persist_and_validate() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("clipboard");
        {
            let engine = ClipboardEngine::new(&root).expect("engine");
            assert_eq!(engine.settings(), ClipboardSettings::default());
            let next = ClipboardSettings {
                enabled: false,
                max_items: 42,
                keep_days: 0,
                capture_images: false,
            };
            assert_eq!(engine.set_settings(next.clone()).expect("save"), next);
            for invalid in [
                ClipboardSettings {
                    max_items: 5,
                    ..next.clone()
                },
                ClipboardSettings {
                    keep_days: MAX_KEEP_DAYS + 1,
                    ..next.clone()
                },
            ] {
                assert!(engine.set_settings(invalid).is_err());
            }
            assert_eq!(engine.settings(), next, "invalid saves change nothing");
        }
        let reopened = ClipboardEngine::new(&root).expect("reopen");
        assert_eq!(reopened.settings().max_items, 42);
        assert!(!reopened.settings().enabled);

        std::fs::write(root.join(SETTINGS_FILE), "{ not json").expect("corrupt");
        let recovered = ClipboardEngine::new(&root).expect("recover");
        assert_eq!(recovered.settings(), ClipboardSettings::default());

        std::fs::write(root.join(SETTINGS_FILE), r#"{"max_items": 1}"#).expect("partial");
        let clamped = ClipboardEngine::new(&root).expect("clamp");
        assert_eq!(clamped.settings().max_items, MAX_ITEMS_RANGE.0);
        assert!(clamped.settings().enabled, "missing fields use defaults");
    }

    #[test]
    fn history_survives_restart_with_monotonic_timestamps() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("clipboard");
        let first = {
            let engine = ClipboardEngine::new(&root).expect("engine");
            inserted(engine.ingest_text("persisted").expect("ingest"))
        };
        let engine = ClipboardEngine::new(&root).expect("reopen");
        assert_eq!(engine.get(&first.id).expect("get").content, "persisted");
        let next = inserted(engine.ingest_text("after restart").expect("ingest"));
        assert!(next.last_copied_at > first.last_copied_at);
    }

    // ── watcher ──

    #[test]
    fn watcher_records_changes_once() {
        let (_dir, engine) = engine();
        let known = inserted(engine.ingest_text("already known").expect("ingest"));
        let mut clipboard = FakeClipboard {
            text: Some("already known".into()),
            ..FakeClipboard::default()
        };

        // Start-up: existing content is adopted without a bump.
        assert_eq!(engine.poll_once(&mut clipboard).expect("poll"), None);
        assert_eq!(engine.get(&known.id).expect("get").copy_count, 1);

        clipboard.text = Some("fresh copy".into());
        let captured = engine
            .poll_once(&mut clipboard)
            .expect("poll")
            .expect("captured");
        assert_eq!(captured.content, "fresh copy");
        assert_eq!(
            engine.poll_once(&mut clipboard).expect("poll"),
            None,
            "unchanged"
        );

        // Re-copying an older clip bumps it.
        clipboard.text = Some("already known".into());
        let bumped = engine
            .poll_once(&mut clipboard)
            .expect("poll")
            .expect("bumped");
        assert_eq!(
            (bumped.id.as_str(), bumped.copy_count),
            (known.id.as_str(), 2)
        );

        // Read errors surface as errors, the next poll works again.
        clipboard.errors.push_back("occupied".into());
        assert!(engine.poll_once(&mut clipboard).is_err());
        assert_eq!(engine.poll_once(&mut clipboard).expect("poll"), None);
    }

    #[test]
    fn watcher_inserts_new_content_found_at_startup() {
        let (_dir, engine) = engine();
        let mut clipboard = FakeClipboard {
            text: Some("copied before launch".into()),
            ..FakeClipboard::default()
        };
        let item = engine
            .poll_once(&mut clipboard)
            .expect("poll")
            .expect("inserted");
        assert_eq!(item.copy_count, 1);
    }

    #[test]
    fn watcher_ignores_copies_made_while_paused() {
        let (_dir, engine) = engine();
        let mut clipboard = FakeClipboard {
            text: Some("before pause".into()),
            ..FakeClipboard::default()
        };
        engine.poll_once(&mut clipboard).expect("prime");
        engine.set_paused(true);
        clipboard.text = Some("hunter2-password-copied-while-paused".into());
        assert_eq!(engine.poll_once(&mut clipboard).expect("poll"), None);
        engine.set_paused(false);
        assert_eq!(
            engine.poll_once(&mut clipboard).expect("poll"),
            None,
            "content copied during the pause is adopted, not recorded"
        );
        assert!(list(&engine, "hunter2").is_empty());
        clipboard.text = Some("after resume".into());
        assert!(engine.poll_once(&mut clipboard).expect("poll").is_some());
    }

    #[test]
    fn watcher_skips_its_own_writes() {
        let (_dir, engine) = engine();
        let mut clipboard = FakeClipboard {
            text: Some("start".into()),
            ..FakeClipboard::default()
        };
        engine.poll_once(&mut clipboard).expect("prime");
        let item = inserted(engine.ingest_text("copied from the UI").expect("ingest"));
        // What `copy_to_system` does after writing the text.
        engine.note_self_write(Some(text_hash(&item.content)));
        engine.mark_copied(&item.id).expect("mark");
        clipboard.text = Some(item.content.clone());
        assert_eq!(engine.poll_once(&mut clipboard).expect("poll"), None);
        assert_eq!(engine.get(&item.id).expect("get").copy_count, 2);

        // Images: the next change inside the grace period is ours.
        engine.note_self_write(None);
        clipboard.text = None;
        clipboard.image = Some(checkerboard(2, 2));
        assert_eq!(engine.poll_once(&mut clipboard).expect("poll"), None);
        assert_eq!(engine.stats().expect("stats").images, 0);
    }

    #[test]
    fn watcher_backs_off_on_unchanged_images() {
        let (_dir, engine) = engine();
        let mut clipboard = FakeClipboard {
            image: Some(checkerboard(4, 4)),
            ..FakeClipboard::default()
        };
        assert!(engine.poll_once(&mut clipboard).expect("poll").is_some());
        for _ in 0..40 {
            assert_eq!(engine.poll_once(&mut clipboard).expect("poll"), None);
        }
        assert!(
            clipboard.image_reads < 12,
            "unchanged images are re-read with backoff, got {} reads",
            clipboard.image_reads
        );
        // Text resets the backoff and wins over images.
        clipboard.text = Some("text now".into());
        assert!(engine.poll_once(&mut clipboard).expect("poll").is_some());
    }

    // ── notes ──

    #[test]
    fn note_titles_are_sanitised() {
        let (_dir, engine) = engine();
        let item = inserted(
            engine
                .ingest_text("Meeting notes: Q3/Q4 plan")
                .expect("ingest"),
        );
        assert_eq!(note_title("  ../My: Title?  ", &item), "My Title");
        assert_eq!(note_title("", &item), "Meeting notes Q3 Q4 plan");
        assert_eq!(
            note_title(&"x".repeat(200), &item).len(),
            NOTE_TITLE_MAX_CHARS
        );
    }

    #[test]
    fn note_bodies_by_kind() {
        let (_dir, engine) = engine();
        let code = inserted(
            engine
                .ingest_text("fn main() {\n    let s = \"```\";\n}\n")
                .expect("ingest"),
        );
        let body = note_body(&code);
        assert!(body.starts_with("````rust\n"), "{body}");
        assert!(body.trim_end().ends_with("````"));
        let url = inserted(engine.ingest_text("https://example.com").expect("ingest"));
        assert_eq!(note_body(&url), "<https://example.com>\n");
        let color = inserted(engine.ingest_text("#3fb0a3").expect("ingest"));
        assert_eq!(note_body(&color), "`#3fb0a3`\n");
    }

    #[test]
    fn saves_clips_as_vault_notes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let vault_dir = dir.path().join("vault");
        std::fs::create_dir_all(&vault_dir).expect("vault");
        let vault = VaultReader::new(&dir.path().join("config")).expect("reader");
        vault
            .set_vault_path(&vault_dir.to_string_lossy())
            .expect("vault path");
        let engine = ClipboardEngine::new(&dir.path().join("clipboard")).expect("engine");

        let text = inserted(engine.ingest_text("Remember the milk").expect("ingest"));
        let path = engine
            .save_as_note(&vault, &text.id, "Groceries")
            .expect("save");
        assert!(path.ends_with("clipboard/Groceries.md"), "{path}");
        let note = std::fs::read_to_string(&path).expect("read note");
        assert!(note.starts_with("---\nsource: clipboard\nkind: text\n"));
        assert!(note.contains("# Groceries\n\nRemember the milk\n"));
        let again = engine
            .save_as_note(&vault, &text.id, "Groceries")
            .expect("again");
        assert!(again.ends_with("Groceries 2.md"), "never clobbers: {again}");

        let image = inserted(engine.ingest_image(&checkerboard(2, 2)).expect("ingest"));
        let image_note = engine
            .save_as_note(&vault, &image.id, "")
            .expect("image note");
        let content = std::fs::read_to_string(&image_note).expect("read");
        let short: String = image.id.chars().filter(|c| *c != '-').take(12).collect();
        assert!(content.contains(&format!("](attachments/clipboard/clip-{short}.png)")));
        assert!(vault_dir
            .join(format!("attachments/clipboard/clip-{short}.png"))
            .exists());
    }

    #[test]
    fn note_titles_from_the_ui_are_sanitized() {
        let dir = tempfile::tempdir().expect("temp dir");
        let vault_dir = dir.path().join("vault");
        std::fs::create_dir_all(&vault_dir).expect("vault");
        let vault = VaultReader::new(&dir.path().join("config")).expect("reader");
        vault
            .set_vault_path(&vault_dir.to_string_lossy())
            .expect("vault path");
        let engine = ClipboardEngine::new(&dir.path().join("clipboard")).expect("engine");
        let text = inserted(engine.ingest_text("payload").expect("ingest"));
        for title in [
            "../../escape",
            "/etc/passwd",
            "a\\b:c*?",
            ".hidden",
            "..",
            "x\ny",
        ] {
            let path = engine.save_as_note(&vault, &text.id, title).expect("save");
            let canonical = std::fs::canonicalize(&path).expect("canonical");
            let clipboard = std::fs::canonicalize(vault_dir.join("clipboard")).expect("dir");
            assert_eq!(
                canonical.parent(),
                Some(clipboard.as_path()),
                "{title:?} → {path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn image_attachments_never_leave_the_vault() {
        let dir = tempfile::tempdir().expect("temp dir");
        let outside = tempfile::tempdir().expect("outside");
        let vault_dir = dir.path().join("vault");
        std::fs::create_dir_all(&vault_dir).expect("vault");
        std::os::unix::fs::symlink(outside.path(), vault_dir.join("attachments")).expect("link");
        let vault = VaultReader::new(&dir.path().join("config")).expect("reader");
        vault
            .set_vault_path(&vault_dir.to_string_lossy())
            .expect("vault path");
        let engine = ClipboardEngine::new(&dir.path().join("clipboard")).expect("engine");
        let image = inserted(engine.ingest_image(&checkerboard(2, 2)).expect("ingest"));
        assert!(engine.save_as_note(&vault, &image.id, "Shot").is_err());
        assert_eq!(std::fs::read_dir(outside.path()).expect("read").count(), 0);
    }
}
