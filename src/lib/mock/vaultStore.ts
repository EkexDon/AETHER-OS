/**
 * Stateful in-memory vault shared by the vault, notes, AI, agent-action and
 * IDE mocks. It mirrors `engine/vault_reader.rs`: absolute note paths,
 * sanitised vault-relative creation without clobbering, daily notes following
 * the Settings → Vault layout (default `daily/YYYY-MM-DD.md`), backlinks from live content — and it computes the NoPes index,
 * graph and stats from the current content so every write stays consistent.
 */
import type {
  Backlink,
  GraphData,
  GraphEdge,
  VaultIndex,
  VaultNote,
  VaultStats,
  VectorMatch,
} from "../../types";
import { buildVaultFixture, MOCK_VAULT_ROOT } from "./fixtures/vault";
import { buildIndexEntry, lineLinksTo, tokenize } from "./markdown";
import {
  basename,
  dirname,
  isWithin,
  localDate,
  localTime,
  normalizePath,
  nowSeconds,
  registerReset,
} from "./runtime";

interface StoredFile {
  content: string;
  mtime: number;
}

/** The mock vault. Use the shared {@link mockVault} instance. */
/** Where daily notes go: vault-relative folder + file name pattern (`YYYY`, `MM`, `DD`, `/`). */
export interface DailyLayout {
  folder: string;
  pattern: string;
}

/** The backend's default daily-note layout. */
export const DEFAULT_DAILY_LAYOUT: DailyLayout = { folder: "daily", pattern: "YYYY-MM-DD" };

export class MockVault {
  private rootPath: string | null = MOCK_VAULT_ROOT;
  private files = new Map<string, StoredFile>();
  private dirs = new Set<string>();
  private daily: DailyLayout = { ...DEFAULT_DAILY_LAYOUT };

  constructor() {
    this.seed();
  }

  /** Restore the seed notes at the default vault path. */
  seed(now: Date = new Date()): void {
    this.rootPath = MOCK_VAULT_ROOT;
    this.daily = { ...DEFAULT_DAILY_LAYOUT };
    this.files.clear();
    this.dirs.clear();
    const nowSec = Math.floor(now.getTime() / 1000);
    for (const note of buildVaultFixture(now)) {
      const path = `${MOCK_VAULT_ROOT}/${note.rel}`;
      this.files.set(path, {
        content: note.content,
        mtime: nowSec - note.ageDays * 86_400 - (note.rel.length % 7) * 3_600,
      });
    }
  }

  /** Current vault root, `null` when disconnected. */
  get root(): string | null {
    return this.rootPath;
  }

  /** Point the vault at `path`. The demo content moves with it so the
   *  preview never goes blank after picking a folder. */
  setRoot(path: string): void {
    const next = normalizePath(path.trim());
    if (!next.startsWith("/")) throw new Error(`vault error: vault path must be absolute: ${path}`);
    const prev = this.rootPath;
    if (prev && prev !== next) {
      const moved = new Map<string, StoredFile>();
      for (const [p, f] of this.files) moved.set(next + p.slice(prev.length), f);
      this.files = moved;
      this.dirs = new Set([...this.dirs].map((d) => next + d.slice(prev.length)));
    }
    this.rootPath = next;
  }

  private requireRoot(): string {
    if (!this.rootPath) {
      throw new Error("No vault path configured. Open Settings to set a vault path.");
    }
    return this.rootPath;
  }

  private isHidden(path: string, root: string): boolean {
    return path
      .slice(root.length + 1)
      .split("/")
      .some((part) => part.startsWith("."));
  }

  /** All `.md` notes, sorted by name (case-insensitive) like `scan_vault`. */
  list(): VaultNote[] {
    const root = this.requireRoot();
    const notes: VaultNote[] = [];
    for (const [path, file] of this.files) {
      if (!path.toLowerCase().endsWith(".md") || this.isHidden(path, root)) continue;
      notes.push({ path, name: basename(path).replace(/\.md$/i, ""), mtime: file.mtime });
    }
    return notes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  /** True when a file exists at `path`. */
  hasFile(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** True when `path` is a directory (implicit via files, or explicit). */
  hasDir(path: string): boolean {
    const p = normalizePath(path);
    if (p === this.rootPath || this.dirs.has(p)) return true;
    const prefix = `${p}/`;
    for (const key of this.files.keys()) if (key.startsWith(prefix)) return true;
    for (const dir of this.dirs) if (dir.startsWith(prefix)) return true;
    return false;
  }

  /** Direct children of a directory inside the vault (for the IDE tree). */
  children(dir: string): { name: string; path: string; isDir: boolean; size: number }[] {
    const base = normalizePath(dir);
    const prefix = `${base}/`;
    const out = new Map<string, { name: string; path: string; isDir: boolean; size: number }>();
    const consider = (path: string, isFile: boolean) => {
      if (!path.startsWith(prefix)) return;
      const rest = path.slice(prefix.length);
      const [head, ...tail] = rest.split("/");
      if (!head) return;
      const childPath = `${prefix}${head}`;
      const childIsDir = tail.length > 0 || !isFile;
      if (!out.has(childPath)) {
        const size = childIsDir ? 0 : new TextEncoder().encode(this.files.get(path)?.content ?? "").length;
        out.set(childPath, { name: head, path: childPath, isDir: childIsDir, size });
      }
    };
    for (const key of this.files.keys()) consider(key, true);
    for (const d of this.dirs) consider(d, false);
    return [...out.values()];
  }

  /** Register an (empty) directory. */
  addDir(path: string): void {
    this.dirs.add(normalizePath(path));
  }

  /** Raw content of a note (`read_note`). */
  read(path: string): string {
    const file = this.files.get(normalizePath(path));
    if (!file) {
      throw new Error(`vault error: failed to read ${path}: No such file or directory (os error 2)`);
    }
    return file.content;
  }

  /** Overwrite (or create) a file; refuses paths outside the vault (`write_note`). */
  write(path: string, content: string): void {
    const root = this.requireRoot();
    const p = normalizePath(path);
    if (!isWithin(p, root) || p === root) {
      throw new Error(`vault error: refusing to write outside vault: ${path}`);
    }
    if (!this.hasFile(p) && !this.hasDir(dirname(p))) {
      throw new Error(`vault error: parent canonicalize: No such file or directory (os error 2)`);
    }
    this.files.set(p, { content, mtime: nowSeconds() });
  }

  /** Create a note at a sanitised vault-relative path without clobbering;
   *  returns the absolute path (`create_note`). */
  create(relPath: string, content: string): string {
    const root = this.requireRoot();
    const rel = sanitizeRelPath(relPath);
    let abs = `${root}/${rel}`;
    if (this.files.has(abs)) {
      const stem = abs.replace(/\.md$/i, "");
      for (let i = 2; i < 1000; i++) {
        const candidate = `${stem} ${i}.md`;
        if (!this.files.has(candidate)) {
          abs = candidate;
          break;
        }
      }
    }
    this.files.set(abs, { content, mtime: nowSeconds() });
    return abs;
  }

  /** Append content plus a trailing newline (`append_note`). */
  append(path: string, content: string): void {
    let next = this.read(path);
    if (next && !next.endsWith("\n")) next += "\n";
    next += content;
    if (!content.endsWith("\n")) next += "\n";
    this.write(path, next);
  }

  /** Delete a note; returns whether it existed. */
  delete(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }

  /** Every line in any note that links to `noteName` (`get_backlinks`). */
  backlinks(noteName: string): Backlink[] {
    const target = noteName.trim().toLowerCase();
    if (!target) return [];
    const out: Backlink[] = [];
    for (const note of this.list()) {
      this.read(note.path)
        .split(/\r?\n/)
        .forEach((line, idx) => {
          if (lineLinksTo(line, target)) {
            out.push({
              note_path: note.path,
              note_name: note.name,
              line: idx + 1,
              context: [...line.trim()].slice(0, 200).join(""),
            });
          }
        });
    }
    return out;
  }

  /** Use a validated daily-note layout (set by the onboarding mock's vault prefs). */
  setDailyLayout(layout: DailyLayout): void {
    this.daily = { ...layout };
  }

  /** Vault-relative path of the daily note for `date` (`YYYY-MM-DD`). */
  dailyRelPath(date: string): string {
    const [y, m, d] = date.split("-");
    const name = this.daily.pattern.replace(/YYYY/g, y).replace(/MM/g, m).replace(/DD/g, d);
    return [this.daily.folder, `${name}.md`].filter(Boolean).join("/");
  }

  /** Path of the daily note for `date`, created (with folders and a heading) if missing. */
  dailyNote(date: string): string {
    const root = this.requireRoot();
    const rel = this.dailyRelPath(date);
    const abs = `${root}/${rel}`;
    if (!this.files.has(abs)) this.create(rel, `# ${date}\n\n`);
    return abs;
  }

  /** Append `- **HH:MM** — text` to today's daily note; returns its path. */
  appendDaily(text: string, now: Date = new Date()): string {
    const path = this.dailyNote(localDate(now));
    this.append(path, `- **${localTime(now)}** — ${text.trim()}`);
    return path;
  }

  /** NoPes-style index computed from the current content. */
  index(): VaultIndex {
    return {
      version: 1,
      notes: this.list().map((n) => buildIndexEntry(n.path, this.read(n.path), n.mtime)),
    };
  }

  /** Wikilink graph; edges only for links that resolve to an existing note. */
  graph(): GraphData {
    const notes = this.list();
    const index = this.index();
    const byName = new Map(notes.map((n) => [n.name.toLowerCase(), n.path]));
    const tagsByPath = new Map(index.notes.map((e) => [e.path, e.tags]));
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const entry of index.notes) {
      for (const link of entry.wikilinks) {
        const target = byName.get(link.toLowerCase());
        if (!target) continue;
        const key = `${entry.path}\u0000${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: entry.path, target });
      }
    }
    const nodes = notes
      .map((n) => ({ id: n.path, label: n.name, tags: tagsByPath.get(n.path) ?? [] }))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return { nodes, edges };
  }

  /** Aggregate counters (`get_vault_stats`). */
  stats(): VaultStats {
    const index = this.index();
    const tasks = index.notes.flatMap((e) => e.tasks);
    return {
      note_count: index.notes.length,
      total_tasks: tasks.length,
      open_tasks: tasks.filter((t) => !t.checked).length,
      total_cards: index.notes.reduce((sum, e) => sum + e.cards.length, 0),
      total_tags: new Set(index.notes.flatMap((e) => e.tags)).size,
      total_links: index.notes.reduce((sum, e) => sum + e.wikilinks.length, 0),
    };
  }

  /**
   * Fake semantic search: TF-IDF overlap between query and note (title
   * weighted 3×), squashed into a cosine-like 0.35–0.93 range. Returns the
   * best matches; when nothing overlaps, the three most recent notes with
   * low scores (an embedding index always returns neighbours).
   */
  search(query: string, limit: number, restrictTo?: string[]): VectorMatch[] {
    const allowed = restrictTo ? new Set(restrictTo) : null;
    const notes = this.list().filter((n) => !allowed || allowed.has(n.path));
    const terms = tokenize(query);
    const docs = notes.map((n) => {
      const content = this.read(n.path);
      const counts = new Map<string, number>();
      for (const t of tokenize(content)) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of tokenize(n.name)) counts.set(t, (counts.get(t) ?? 0) + 3);
      return { note: n, content, counts };
    });
    const termFrequency = (counts: Map<string, number>, term: string): number => {
      let tf = 0;
      for (const [token, count] of counts) {
        if (token === term) tf += count;
        else if (term.length >= 4 && (token.startsWith(term) || term.startsWith(token))) tf += count * 0.5;
      }
      return tf;
    };
    const idf = new Map(
      terms.map((term) => {
        const df = docs.filter((d) => termFrequency(d.counts, term) > 0).length;
        return [term, Math.log(1 + docs.length / Math.max(1, df))] as const;
      })
    );
    const scored = docs
      .map((doc) => {
        let raw = 0;
        for (const term of terms) {
          const tf = termFrequency(doc.counts, term);
          if (tf > 0) raw += (1 + Math.log(tf)) * (idf.get(term) ?? 0);
        }
        return { doc, raw };
      })
      .filter((s) => s.raw > 0)
      .sort((a, b) => b.raw - a.raw);

    const cap = Math.max(1, Math.min(limit, 100));
    if (scored.length === 0) {
      return [...docs]
        .sort((a, b) => b.note.mtime - a.note.mtime)
        .slice(0, Math.min(3, cap))
        .map((d, i) => ({ id: d.note.path, text: d.content, score: 0.31 - i * 0.03 }));
    }
    const best = scored[0].raw;
    return scored.slice(0, cap).map((s) => ({
      id: s.doc.note.path,
      text: s.doc.content,
      score: Math.round((0.35 + 0.58 * (s.raw / best) ** 0.6) * 1000) / 1000,
    }));
  }
}

/** Same rules as `sanitize_rel_path` in `vault_reader.rs`. */
export function sanitizeRelPath(rel: string): string {
  const cleaned = rel.trim().replace(/\\/g, "/");
  if (!cleaned) throw new Error("vault error: empty note path");
  const parts = cleaned.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((p) => p === ".." || p.startsWith(".")) ||
    cleaned.startsWith("/") ||
    cleaned.includes(":")
  ) {
    throw new Error(`vault error: invalid note path: ${cleaned}`);
  }
  const joined = parts.join("/");
  return joined.toLowerCase().endsWith(".md") ? joined : `${joined}.md`;
}

/** The shared mock vault instance. */
export const mockVault = new MockVault();
registerReset(() => mockVault.seed());
