/**
 * Mock handlers for `commands/clipboard_commands.rs`: 40 seeded clips of
 * every kind (text, links, code, colors, images), full-text-ish search,
 * pin/copy/delete/clear, retention settings with the engine's validation
 * messages, pause, stats, "save as note" into the mock vault, and a live
 * feed that "copies" a new clip every 20 s (emitting `clipboard-changed`).
 */
import type { ClipItem, ClipKind, ClipboardChangedEvent, ClipboardSettings, ClipboardStats } from "../../types";
import { mockEvents, mockUuid, registerReset, argBool, argObject, argOptNumber, argOptString, argString, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";

const EVENT = "clipboard-changed";
const LIST_CONTENT_MAX_CHARS = 8000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Interval of the simulated "user copied something" feed. */
export const MOCK_FEED_INTERVAL_MS = 20_000;
const IMAGE_DIR = "/Users/demo/Library/Application Support/com.ekin.aetheros/clipboard/images";

interface MockClip extends ClipItem {
  /** Data URL served by `cmd_clipboard_image` for image clips. */
  image?: string;
}

interface ClipboardMockState {
  clips: MockClip[];
  settings: ClipboardSettings;
  paused: boolean;
  skippedSecrets: number;
  feedIndex: number;
  clock: number;
}

const DEFAULT_SETTINGS: ClipboardSettings = { enabled: true, max_items: 500, keep_days: 30, capture_images: true };

/** A deterministic SVG "screenshot" standing in for a PNG. */
function svgImage(width: number, height: number, hue: number, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="hsl(${hue} 22% 16%)"/>` +
    `<rect x="${width * 0.06}" y="${height * 0.1}" width="${width * 0.88}" height="${height * 0.12}" rx="${height * 0.02}" fill="hsl(${hue} 30% 26%)"/>` +
    `<rect x="${width * 0.06}" y="${height * 0.3}" width="${width * 0.55}" height="${height * 0.5}" rx="${height * 0.03}" fill="hsl(${hue} 45% 42%)"/>` +
    `<rect x="${width * 0.65}" y="${height * 0.3}" width="${width * 0.29}" height="${height * 0.22}" rx="${height * 0.03}" fill="hsl(${(hue + 40) % 360} 40% 55%)"/>` +
    `<rect x="${width * 0.65}" y="${height * 0.58}" width="${width * 0.29}" height="${height * 0.22}" rx="${height * 0.03}" fill="hsl(${(hue + 200) % 360} 35% 48%)"/>` +
    `<text x="${width * 0.08}" y="${height * 0.18}" font-family="sans-serif" font-size="${Math.round(height * 0.06)}" fill="hsl(${hue} 20% 88%)">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type Seed = { kind: ClipKind; content: string; image?: { w: number; h: number; hue: number; label: string } };

const SEEDS: Seed[] = [
  { kind: "url", content: "https://github.com/EkexDon/AETHER-OS/pull/42" },
  { kind: "code", content: "fn main() {\n    let vault = VaultReader::new(&config_dir)?;\n    println!(\"{} notes\", vault.scan_vault(&path)?.len());\n}" },
  { kind: "text", content: "Meeting with Lena moved to Thursday 14:00 — bring the Q3 roadmap draft." },
  { kind: "color", content: "#3fb0a3" },
  { kind: "image", content: "", image: { w: 1440, h: 900, hue: 172, label: "Dashboard redesign" } },
  { kind: "code", content: "const debounced = useMemo(\n  () => debounce((q: string) => search(q), 150),\n  [search]\n);" },
  { kind: "url", content: "https://docs.rs/rusqlite/latest/rusqlite/" },
  { kind: "text", content: "Einkaufsliste: Hafermilch, Sauerteigbrot, Bergkäse, Äpfel, Kaffee" },
  { kind: "code", content: "SELECT id, title, updated_at\nFROM notes\nWHERE pinned = 1\nORDER BY updated_at DESC\nLIMIT 20;" },
  { kind: "color", content: "rgb(226, 122, 78)" },
  { kind: "text", content: "ekin@example.com" },
  { kind: "url", content: "https://v2.tauri.app/develop/calling-rust/" },
  { kind: "code", content: "def chunk(text: str, size: int = 512):\n    words = text.split()\n    for i in range(0, len(words), size):\n        yield \" \".join(words[i:i + size])" },
  { kind: "image", content: "", image: { w: 820, h: 540, hue: 24, label: "Error dialog" } },
  { kind: "text", content: "Remember: the release notes need a German summary for the newsletter." },
  { kind: "code", content: "git switch -c aether/v0.2-boil-the-ocean\ngit push -u origin aether/v0.2-boil-the-ocean" },
  { kind: "color", content: "hsl(220 80% 68%)" },
  { kind: "url", content: "https://www.figma.com/design/aether-os-v02" },
  { kind: "text", content: "Hauptstraße 12, 70173 Stuttgart" },
  { kind: "code", content: "export function relativeTime(iso: string): string {\n  const diff = Date.now() - new Date(iso).getTime();\n  return diff < 60_000 ? \"now\" : `${Math.floor(diff / 60_000)}m`;\n}" },
  { kind: "text", content: "The best way to predict the future is to invent it. — Alan Kay" },
  { kind: "url", content: "https://developer.apple.com/documentation/appkit/nspasteboard" },
  { kind: "image", content: "", image: { w: 2880, h: 1800, hue: 210, label: "Retina screenshot" } },
  { kind: "code", content: "{\n  \"name\": \"aether-os\",\n  \"version\": \"0.2.0\",\n  \"private\": true\n}" },
  { kind: "text", content: "Flight LH 2037 · MUC → HAM · Seat 14A · Boarding 07:35" },
  { kind: "color", content: "#e3e0d8" },
  { kind: "url", content: "https://ollama.com/library/nomic-embed-text" },
  { kind: "text", content: "Idea: pin the three most used clips to the Home dashboard." },
  { kind: "code", content: ".clip-row {\n  height: 48px;\n  transition: background-color var(--motion-fast) var(--ease-out);\n}" },
  { kind: "image", content: "", image: { w: 640, h: 640, hue: 320, label: "Avatar" } },
  { kind: "text", content: "Paket-Sendungsnummer: 00340434161094042557" },
  { kind: "url", content: "mailto:team@aether.local" },
  { kind: "code", content: "cargo clippy -- -D warnings && cargo test" },
  { kind: "color", content: "rgba(63, 176, 163, 0.35)" },
  { kind: "text", content: "Q3 OKR: ship clipboard history, universal search and note versioning." },
  { kind: "url", content: "https://news.ycombinator.com/item?id=41234567" },
  { kind: "image", content: "", image: { w: 1200, h: 630, hue: 140, label: "Social card" } },
  { kind: "text", content: "WLAN: AETHER-Guest · Passwort liegt im Tresor" },
  { kind: "code", content: "impl Drop for Session {\n    fn drop(&mut self) {\n        self.flush();\n    }\n}" },
  { kind: "text", content: "Call back the landlord about the heating (Mon–Fri, 9–12)." },
];

/** Clips the live feed "copies", in rotation. `null` = a skipped secret. */
const FEED: (Seed | null)[] = [
  { kind: "text", content: "Standup notes: clipboard view is live in mock mode 🎉" },
  { kind: "url", content: "https://github.com/1Password/arboard" },
  null,
  { kind: "code", content: "const [items, setItems] = useState<ClipItem[]>([]);\nuseEffect(() => void refresh(), [refresh]);" },
  { kind: "color", content: "#6d9cf0" },
  { kind: "image", content: "", image: { w: 1280, h: 720, hue: 260, label: "New screenshot" } },
  { kind: "text", content: "Reminder: water the plants before leaving on Friday." },
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** First non-empty line, whitespace collapsed, ≤ 200 chars (as in Rust). */
export function mockPreview(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const collapsed = line.split(/\s+/).filter(Boolean).join(" ");
  return [...collapsed].length <= 200 ? collapsed : `${[...collapsed].slice(0, 199).join("")}…`;
}

function makeClip(seed: Seed, at: number, extra: Partial<MockClip> = {}): MockClip {
  const id = mockUuid();
  if (seed.kind === "image" && seed.image) {
    const { w, h, hue, label } = seed.image;
    return {
      id,
      kind: "image",
      content: `${IMAGE_DIR}/${id}.png`,
      preview: `${w}x${h}`,
      byte_len: Math.round(w * h * 0.42),
      pinned: false,
      source_app: null,
      copy_count: 1,
      created_at: iso(at),
      last_copied_at: iso(at),
      truncated: false,
      image: svgImage(w, h, hue, label),
      ...extra,
    };
  }
  return {
    id,
    kind: seed.kind,
    content: seed.content,
    preview: mockPreview(seed.content),
    byte_len: byteLength(seed.content),
    pinned: false,
    source_app: null,
    copy_count: 1,
    created_at: iso(at),
    last_copied_at: iso(at),
    truncated: false,
    ...extra,
  };
}

function seed(now = Date.now()): ClipboardMockState {
  const clips: MockClip[] = SEEDS.map((s, i) => {
    // Newest first: spread over ~20 days, denser in the last hours.
    const age = i < 8 ? i * 11 * 60_000 : i < 20 ? (i - 6) * 3.1 * 3_600_000 : (i - 18) * 0.95 * 86_400_000;
    const created = now - age - 60_000 * (i % 5);
    const clip = makeClip(s, created);
    const copies = [3, 1, 1, 6, 1, 2, 4, 1, 2, 1, 5][i % 11];
    clip.copy_count = copies;
    clip.pinned = [1, 3, 8, 11, 27].includes(i);
    clip.created_at = iso(created - copies * 86_400_000 * 0.3);
    return clip;
  });
  return { clips, settings: { ...DEFAULT_SETTINGS }, paused: false, skippedSecrets: 0, feedIndex: 0, clock: now };
}

let state = seed();
let feedTimer: ReturnType<typeof setInterval> | null = null;

registerReset(() => {
  state = seed();
});

function emit(event: ClipboardChangedEvent) {
  mockEvents.emit(EVENT, event);
}

/** Strictly increasing timestamps, like the engine's clock. */
function nextTimestamp(): string {
  state.clock = Math.max(Date.now(), state.clock + 1);
  return iso(state.clock);
}

function invalid(message: string): Error {
  return new Error(`invalid input: ${message}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function find(id: string): MockClip {
  if (!UUID.test(id)) throw invalid(`invalid clip id: ${id}`);
  const clip = state.clips.find((c) => c.id === id);
  if (!clip) throw invalid(`clip ${id} not found`);
  return clip;
}

/** Strip the mock-only fields. */
function publicItem(clip: MockClip, truncate = false): ClipItem {
  const { image: _image, ...item } = clip;
  if (truncate && [...item.content].length > LIST_CONTENT_MAX_CHARS) {
    return { ...item, content: [...item.content].slice(0, LIST_CONTENT_MAX_CHARS).join(""), truncated: true };
  }
  return { ...item, truncated: false };
}

function sorted(): MockClip[] {
  return [...state.clips].sort((a, b) => (a.last_copied_at < b.last_copied_at ? 1 : a.last_copied_at > b.last_copied_at ? -1 : 0));
}

/** Lowercase and strip diacritics (FTS5 `remove_diacritics`). */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Prefix-word AND search like the engine's FTS query; symbol-only words match as substrings. */
export function mockMatches(clip: Pick<ClipItem, "kind" | "content" | "preview">, query: string): boolean {
  const haystack = clip.kind === "image" ? `image ${clip.preview}` : clip.content;
  const words = fold(haystack).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const raw = fold(haystack);
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => {
      const folded = fold(term);
      if (!/[\p{L}\p{N}]/u.test(folded)) return raw.includes(folded);
      const parts = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (parts.length === 1) return words.some((w) => w.startsWith(parts[0]));
      // Phrase: consecutive words, last one prefix-matched.
      return words.some((_, i) =>
        parts.every((p, j) => (j === parts.length - 1 ? words[i + j]?.startsWith(p) : words[i + j] === p))
      );
    });
}

function prune(): void {
  const { max_items, keep_days } = state.settings;
  const cutoff = keep_days > 0 ? iso(Date.now() - keep_days * 86_400_000) : null;
  const unpinned = sorted().filter((c) => !c.pinned);
  const doomed = new Set<string>();
  unpinned.forEach((c, i) => {
    if (i >= max_items || (cutoff && c.last_copied_at < cutoff)) doomed.add(c.id);
  });
  if (doomed.size) state.clips = state.clips.filter((c) => !doomed.has(c.id));
}

function stats(): ClipboardStats {
  return {
    total: state.clips.length,
    pinned: state.clips.filter((c) => c.pinned).length,
    images: state.clips.filter((c) => c.kind === "image").length,
    bytes: state.clips.reduce((sum, c) => sum + c.byte_len, 0),
    paused: state.paused,
    enabled: state.settings.enabled,
    skipped_secrets: state.skippedSecrets,
    watcher_error: null,
  };
}

/** Simulate the user copying something anywhere on the machine. */
export function mockCapture(entry: Seed | null): ClipItem | null {
  if (!state.settings.enabled || state.paused) return null;
  if (entry === null) {
    state.skippedSecrets += 1;
    return null;
  }
  if (entry.kind === "image" && !state.settings.capture_images) return null;
  const existing = entry.kind === "image" ? undefined : state.clips.find((c) => c.content === entry.content);
  if (existing) {
    existing.copy_count += 1;
    existing.last_copied_at = nextTimestamp();
    emit({ id: existing.id, reason: "captured" });
    return publicItem(existing);
  }
  const clip = makeClip(entry, Date.now());
  clip.created_at = clip.last_copied_at = nextTimestamp();
  state.clips.push(clip);
  prune();
  emit({ id: clip.id, reason: "captured" });
  return publicItem(clip);
}

/** Start the 20 s live feed (idempotent; first clipboard call starts it). */
function ensureFeed(): void {
  if (feedTimer || typeof window === "undefined" || import.meta.env.MODE === "test") return;
  feedTimer = setInterval(() => {
    const entry = FEED[state.feedIndex % FEED.length];
    state.feedIndex += 1;
    mockCapture(entry);
  }, MOCK_FEED_INTERVAL_MS);
}

function validateSettings(next: Partial<ClipboardSettings>): ClipboardSettings {
  const merged: ClipboardSettings = { ...DEFAULT_SETTINGS, ...next };
  if (typeof merged.max_items !== "number" || merged.max_items < 10 || merged.max_items > 10_000) {
    throw invalid("max_items must be between 10 and 10000");
  }
  if (typeof merged.keep_days !== "number" || merged.keep_days < 0 || merged.keep_days > 3650) {
    throw invalid("keep_days must be between 0 and 3650");
  }
  return { enabled: !!merged.enabled, max_items: Math.round(merged.max_items), keep_days: Math.round(merged.keep_days), capture_images: !!merged.capture_images };
}

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
}

function noteBody(clip: MockClip, title: string): string {
  switch (clip.kind) {
    case "url":
      return `<${clip.content.trim()}>\n`;
    case "color":
      return `\`${clip.content.trim()}\`\n`;
    case "code": {
      const longest = Math.max(0, ...(clip.content.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(2, longest) + 1);
      return `${fence}\n${clip.content.replace(/\n+$/, "")}\n${fence}\n`;
    }
    case "image":
      return `![${title}](attachments/clipboard/clip-${clip.id.replace(/-/g, "").slice(0, 12)}.png)\n`;
    default:
      return clip.content.endsWith("\n") ? clip.content : `${clip.content}\n`;
  }
}

function copy(clip: MockClip): ClipItem {
  clip.copy_count += 1;
  clip.last_copied_at = nextTimestamp();
  emit({ id: clip.id, reason: "copied" });
  return publicItem(clip);
}

export const clipboardHandlers: MockHandlerMap = {
  cmd_clipboard_list: (args) => {
    ensureFeed();
    const query = argOptString(args, "query")?.trim() ?? "";
    const kind = argOptString(args, "kind");
    if (kind && !["all", "text", "url", "code", "image", "color"].includes(kind)) {
      throw invalid(`unknown clip kind ${kind}`);
    }
    const pinnedOnly = argBool(args, "pinnedOnly");
    const limit = Math.min(MAX_LIMIT, Math.max(1, argOptNumber(args, "limit") ?? DEFAULT_LIMIT));
    const offset = Math.max(0, argOptNumber(args, "offset") ?? 0);
    return sorted()
      .filter((c) => !kind || kind === "all" || c.kind === kind)
      .filter((c) => !pinnedOnly || c.pinned)
      .filter((c) => !query || mockMatches(c, query))
      .slice(offset, offset + limit)
      .map((c) => publicItem(c, true));
  },
  cmd_clipboard_get: (args) => publicItem(find(argString(args, "id"))),
  cmd_clipboard_copy: (args) => copy(find(argString(args, "id"))),
  cmd_clipboard_copy_latest: () => {
    const latest = sorted()[0];
    return latest ? copy(latest) : null;
  },
  cmd_clipboard_pin: (args) => {
    const clip = find(argString(args, "id"));
    clip.pinned = argBool(args, "pinned");
    emit({ id: clip.id, reason: "updated" });
    return publicItem(clip);
  },
  cmd_clipboard_delete: (args) => {
    const clip = find(argString(args, "id"));
    state.clips = state.clips.filter((c) => c.id !== clip.id);
    emit({ id: clip.id, reason: "deleted" });
  },
  cmd_clipboard_clear: (args) => {
    const keepPinned = argBool(args, "keepPinned");
    const before = state.clips.length;
    state.clips = keepPinned ? state.clips.filter((c) => c.pinned) : [];
    emit({ id: null, reason: "cleared" });
    return before - state.clips.length;
  },
  cmd_clipboard_get_settings: () => {
    ensureFeed();
    return { ...state.settings };
  },
  cmd_clipboard_set_settings: (args) => {
    state.settings = validateSettings(argObject<ClipboardSettings>(args, "settings"));
    prune();
    emit({ id: null, reason: "settings" });
    return { ...state.settings };
  },
  cmd_clipboard_set_paused: (args) => {
    state.paused = argBool(args, "paused");
    emit({ id: null, reason: "settings" });
    return state.paused;
  },
  cmd_clipboard_stats: () => {
    ensureFeed();
    return stats();
  },
  cmd_clipboard_save_as_note: (args) => {
    const clip = find(argString(args, "id"));
    const requested = sanitizeTitle(argString(args, "title"));
    const title =
      requested || (clip.kind !== "image" && sanitizeTitle(clip.preview)) || `Clip ${clip.created_at.slice(0, 10)}`;
    const markdown = `---\nsource: clipboard\nkind: ${clip.kind}\ncopied: ${clip.created_at}\n---\n\n# ${title}\n\n${noteBody(clip, title)}`;
    return mockVault.create(`clipboard/${title}.md`, markdown);
  },
  cmd_clipboard_image: (args) => {
    const clip = find(argString(args, "id"));
    argBool(args, "thumbnail");
    if (clip.kind !== "image" || !clip.image) throw invalid(`clip ${clip.id} is not an image`);
    return clip.image;
  },
};
