/**
 * Minimal Markdown metadata extraction for the mock vault. It mirrors what
 * the NoPes indexer writes to `.nopes/index.json` — frontmatter, `#tags`,
 * `[[wikilinks]]`, `- [ ]` tasks with due dates and `front :: back` cards —
 * so graph, stats and dashboards stay consistent while notes change.
 */
import type { VaultCard, VaultIndexEntry, VaultTask } from "../../types";

const FENCE_RE = /^\s*(```|~~~)/;

/** Split off a leading `---` YAML frontmatter block. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: null, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: content };
  const after = content.indexOf("\n", end + 4);
  return {
    frontmatter: content.slice(content.indexOf("\n") + 1, end),
    body: after === -1 ? "" : content.slice(after + 1),
  };
}

/** Flat `key: value` frontmatter map (values kept as raw strings). */
export function parseFrontmatter(content: string): Record<string, string> {
  const { frontmatter } = splitFrontmatter(content);
  const out: Record<string, string> = {};
  if (!frontmatter) return out;
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Body lines with fenced code blocks blanked out (line numbers preserved). */
function proseLines(content: string): string[] {
  let inFence = false;
  return content.split(/\r?\n/).map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line.replace(/`[^`]*`/g, "");
  });
}

const INLINE_TAG_RE = /(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;

/** Inline `#tags` of one line of prose. */
function lineTags(line: string): string[] {
  const tags: string[] = [];
  for (const m of line.matchAll(INLINE_TAG_RE)) {
    // Purely numeric "#42" is an issue reference, not a tag.
    if (/\p{L}/u.test(m[2])) tags.push(m[2]);
  }
  return tags;
}

/** Frontmatter `tags:` plus inline `#tags`, de-duplicated in order. */
export function extractTags(content: string): string[] {
  const tags: string[] = [];
  const fmTags = parseFrontmatter(content).tags;
  if (fmTags) {
    for (const t of fmTags.replace(/^\[|\]$/g, "").split(",")) {
      const tag = t.trim().replace(/^#/, "").replace(/^["']|["']$/g, "");
      if (tag) tags.push(tag);
    }
  }
  const { body } = splitFrontmatter(content);
  for (const line of proseLines(body)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) continue; // headings are not tags
    tags.push(...lineTags(line));
  }
  return [...new Set(tags)];
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Targets of `[[wikilinks]]` (alias/heading stripped), de-duplicated. */
export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  for (const line of proseLines(content)) {
    for (const m of line.matchAll(WIKILINK_RE)) {
      const target = m[1].trim();
      if (target) links.push(target);
    }
  }
  return [...new Set(links)];
}

const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const DUE_RE = /(?:📅\s*|due:\s*|@due\()(\d{4}-\d{2}-\d{2})\)?/;

/** `- [ ]` / `- [x]` tasks with 1-based line numbers, due dates and tags. */
export function extractTasks(content: string, notePath: string): VaultTask[] {
  const tasks: VaultTask[] = [];
  proseLines(content).forEach((line, idx) => {
    const m = TASK_RE.exec(line);
    if (!m) return;
    const text = m[2].trim();
    tasks.push({
      note_path: notePath,
      line: idx + 1,
      text,
      checked: m[1].toLowerCase() === "x",
      due: DUE_RE.exec(text)?.[1] ?? null,
      tags: [...new Set(lineTags(text))],
    });
  });
  return tasks;
}

/** `front :: back` flashcards. */
export function extractCards(content: string, notePath: string): VaultCard[] {
  const cards: VaultCard[] = [];
  proseLines(splitFrontmatter(content).body).forEach((line, idx) => {
    const m = /^\s*(?:[-*]\s+)?(.+?)\s+::\s+(.+)$/.exec(line);
    if (!m) return;
    cards.push({
      key: `${notePath}#${idx + 1}`,
      note_path: notePath,
      front: m[1].trim(),
      back: m[2].trim(),
      card_type: "basic",
    });
  });
  return cards;
}

/** Word count of the body (frontmatter and code fences excluded). */
export function wordCount(content: string): number {
  const text = proseLines(splitFrontmatter(content).body).join(" ");
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Full index entry for one note. */
export function buildIndexEntry(path: string, content: string, mtime: number): VaultIndexEntry {
  return {
    path,
    mtime,
    tags: extractTags(content),
    wikilinks: extractWikilinks(content),
    tasks: extractTasks(content, path),
    frontmatter: parseFrontmatter(content),
    word_count: wordCount(content),
    cards: extractCards(content, path),
  };
}

/** True when `line` links to `target` (case-insensitive, alias-aware) —
 *  the same rule as `line_matches_wikilink` in `vault_reader.rs`. */
export function lineLinksTo(line: string, target: string): boolean {
  const wanted = target.trim().toLowerCase();
  for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const name = m[1].split("|")[0].trim().toLowerCase();
    if (name === wanted) return true;
  }
  return false;
}

/** First prose sentence of a note (skips frontmatter, headings, lists, code). */
export function firstSentence(content: string): string {
  for (const raw of proseLines(splitFrontmatter(content).body)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) continue;
    if (/^[-*+]\s|^\d+\.\s|^!\[/.test(line)) continue;
    const clean = line.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b ?? a);
    const end = clean.search(/[.!?](\s|$)/);
    return end === -1 ? clean : clean.slice(0, end + 1);
  }
  return "";
}

/** Lower-case word tokens for the mock semantic search. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "how", "are", "was", "you", "your",
  "from", "about", "have", "has", "can", "does", "into", "who", "why", "when", "which",
  "der", "die", "das", "und", "ist", "ein", "eine", "mit", "wie", "was", "für", "von",
  "den", "dem", "des", "auf", "ich", "mir", "mich", "sich", "nicht", "auch", "oder",
  "bitte", "noch", "sind", "wird", "kann", "gibt", "über", "mein", "meine",
]);
