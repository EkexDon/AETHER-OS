/**
 * Keyword fallback for related-note and tag suggestions, and the
 * frontmatter-aware tag insertion. A faithful port of
 * `src-tauri/src/engine/intel/suggestions.rs` (same tokenizer, stopwords,
 * weights and thresholds) so the browser preview (mock mode) ranks notes
 * exactly like the desktop app does without a vector index.
 */
import type { RelatedSuggestion } from "../../types";

/** Bytes of a note body that contribute keywords. */
export const DOC_PREFIX_BYTES = 3 * 1024;
/** Characters of the current note used as the query. */
export const QUERY_CHARS = 2_000;
/** Weight of title tokens relative to body tokens. */
export const TITLE_WEIGHT = 3;
/** Keyword scores below this are noise. */
export const MIN_KEYWORD_SCORE = 0.05;
/** Score bonus per shared tag (capped at three). */
export const SHARED_TAG_BONUS = 0.1;

const STOPWORDS = new Set([
  // English
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was",
  "one", "our", "out", "has", "have", "him", "his", "how", "its", "may", "new", "now", "old",
  "see", "two", "way", "who", "did", "get", "got", "let", "put", "say", "she", "too", "use",
  "used", "using", "with", "this", "that", "from", "they", "will", "would", "there", "their",
  "what", "about", "which", "when", "make", "like", "time", "just", "know", "take", "into",
  "your", "some", "could", "them", "than", "then", "look", "only", "come", "over", "also",
  "back", "after", "first", "well", "even", "want", "because", "these", "give", "most", "been",
  "were", "said", "each", "does", "done", "should", "very", "more", "much", "many", "such",
  "here", "where", "while", "why", "yes", "yet", "own", "same", "other", "onto",
  "upon", "via", "per", "etc", "note", "notes", "todo", "tags", "tag", "title", "created",
  "updated", "date", "https", "http", "www", "com", "org", "html", "png", "jpg",
  // German
  "und", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "ist", "sind", "war", "mit", "von", "für", "auf", "aus", "bei", "nach", "über", "unter",
  "auch", "als", "wie", "wer", "wir", "ihr", "sie", "ich", "mich", "mir", "dich", "dir",
  "sich", "nicht", "noch", "nur", "oder", "aber", "wenn", "dass", "sehr", "hat", "haben",
  "wird", "werden", "kann", "können", "muss", "soll", "zum", "zur", "vom", "beim", "bis",
  "durch", "gegen", "ohne", "sein", "seine", "ihre", "unser", "diese", "dieser", "dieses",
  "man", "mehr", "schon", "hier", "dort", "dann", "doch", "immer", "heute",
]);

const NON_WORD = /[^\p{Alphabetic}\p{N}]+/u;
const TAG_CHAR = /[\p{Alphabetic}\p{N}_\-/]/u;

const charCount = (s: string): number => Array.from(s).length;

/** Lower-cased word tokens without short words, numbers and stopwords. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(NON_WORD)) {
    if (charCount(word) < 3 || /^[0-9]+$/.test(word)) continue;
    const lower = word.toLowerCase();
    if (!STOPWORDS.has(lower)) out.push(lower);
  }
  return out;
}

/** Split a leading `---` frontmatter block from the body. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const firstEnd = content.indexOf("\n");
  if (firstEnd < 0 || content.slice(0, firstEnd).replace(/\r$/, "") !== "---") {
    return { frontmatter: null, body: content };
  }
  const rest = content.slice(firstEnd + 1);
  let offset = 0;
  for (const line of rest.split(/(?<=\n)/)) {
    const trimmed = line.replace(/[\r\n]+$/, "");
    if (trimmed === "---" || trimmed === "...") {
      return {
        frontmatter: rest.slice(0, offset).replace(/[\r\n]+$/, ""),
        body: rest.slice(offset + line.length),
      };
    }
    offset += line.length;
  }
  return { frontmatter: null, body: content };
}

function cleanTagToken(token: string): string {
  return token.trim().replace(/^["']+|["']+$/g, "").replace(/^#+/, "").trim();
}

/** Tags declared in frontmatter (inline list, comma list or block list). */
export function frontmatterTags(frontmatter: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    const colon = line.indexOf(":");
    if (colon < 0 || /^\s/.test(line)) return;
    const key = line.slice(0, colon).trim();
    if (key !== "tags" && key !== "tag") return;
    const value = line.slice(colon + 1).trim();
    if (!value) {
      for (const item of lines.slice(i + 1)) {
        const t = item.trimStart();
        if (!/^\s/.test(item) && !t.startsWith("-")) break;
        if (t.startsWith("-")) {
          const tag = cleanTagToken(t.slice(1));
          if (tag) out.push(tag);
        } else if (t) break;
      }
      return;
    }
    const inner = value.replace(/^\[+/, "").replace(/\]+$/, "");
    const separator = inner.includes(",") ? "," : " ";
    for (const token of inner.split(separator)) {
      const tag = cleanTagToken(token);
      if (tag) out.push(tag);
    }
  });
  return out;
}

/** Inline `#tags` outside code, preceded by whitespace or line start. */
export function inlineTags(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const chars = Array.from(line);
    let inCode = false;
    let i = 0;
    while (i < chars.length) {
      const c = chars[i];
      if (c === "`") {
        inCode = !inCode;
      } else if (c === "#" && !inCode && (i === 0 || /\s/.test(chars[i - 1]))) {
        let j = i + 1;
        while (j < chars.length && TAG_CHAR.test(chars[j])) j += 1;
        const tag = chars.slice(i + 1, j).join("").replace(/[-/]+$/, "");
        if (tag && !/^[0-9]+$/.test(tag)) out.push(tag);
        i = j;
        continue;
      }
      i += 1;
    }
  }
  return out;
}

/** Frontmatter + inline tags, de-duplicated case-insensitively. */
export function extractTags(content: string): string[] {
  const { frontmatter, body } = splitFrontmatter(content);
  const tags = [...(frontmatter ? frontmatterTags(frontmatter) : []), ...inlineTags(body)];
  const seen = new Set<string>();
  return tags.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Lower-cased `[[wikilink]]` targets (alias / heading removed). */
export function extractWikilinks(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    const target = m[1].split(/[|#]/)[0].trim().replace(/\.md$/, "").toLowerCase();
    if (target) out.add(target);
  }
  return out;
}

function clipBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/�+$/, "");
}

function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Keyword statistics of one note. */
export interface DocTerms {
  path: string;
  name: string;
  terms: Map<string, number>;
  tags: string[];
}

/** Title tokens ×3 plus tokens of the first 3 KB of the body. */
export function buildDocTerms(path: string, name: string, content: string): DocTerms {
  const { body } = splitFrontmatter(content);
  const terms = new Map<string, number>();
  for (const t of tokenize(name)) terms.set(t, (terms.get(t) ?? 0) + TITLE_WEIGHT);
  for (const t of tokenize(clipBytes(body, DOC_PREFIX_BYTES))) terms.set(t, (terms.get(t) ?? 0) + 1);
  return { path, name, terms, tags: extractTags(content) };
}

function queryTerms(text: string): Map<string, number> {
  const { body } = splitFrontmatter(text);
  const terms = new Map<string, number>();
  for (const t of tokenize(clipChars(body, QUERY_CHARS))) terms.set(t, (terms.get(t) ?? 0) + 1);
  return terms;
}

class Corpus {
  private readonly df = new Map<string, number>();
  private readonly n: number;

  constructor(docs: readonly DocTerms[]) {
    this.n = docs.length;
    for (const doc of docs) for (const term of doc.terms.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
  }

  idf(term: string): number {
    return Math.log(1 + this.n / Math.max(1, this.df.get(term) ?? 0));
  }

  weights(terms: Map<string, number>): { w: Map<string, number>; norm: number } {
    const w = new Map<string, number>();
    let norm = 0;
    for (const [term, tf] of terms) {
      const value = (1 + Math.log(tf)) * this.idf(term);
      norm += value * value;
      w.set(term, value);
    }
    return { w, norm: Math.sqrt(norm) };
  }
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** tf-idf-lite cosine ranking with a shared-tag bonus. */
export function rankByKeywords(
  text: string,
  docs: readonly DocTerms[],
  exclude: string | null,
  limit: number
): RelatedSuggestion[] {
  const query = queryTerms(text);
  if (query.size === 0 || docs.length === 0 || limit <= 0) return [];
  const corpus = new Corpus(docs);
  const q = corpus.weights(query);
  if (q.norm === 0) return [];
  const queryTags = new Set(extractTags(text).map((t) => t.toLowerCase()));
  const linked = extractWikilinks(text);

  const scored: RelatedSuggestion[] = [];
  for (const doc of docs) {
    if (exclude !== null && doc.path === exclude) continue;
    const d = corpus.weights(doc.terms);
    if (d.norm === 0) continue;
    const contributions: [string, number][] = [];
    let dot = 0;
    for (const [term, qw] of q.w) {
      const dw = d.w.get(term);
      if (dw !== undefined) {
        dot += qw * dw;
        contributions.push([term, qw * dw]);
      }
    }
    const shared = doc.tags.filter((t) => queryTags.has(t.toLowerCase()));
    const score = Math.min(1, dot / (q.norm * d.norm) + SHARED_TAG_BONUS * Math.min(3, shared.length));
    if (score < MIN_KEYWORD_SCORE) continue;
    let kind: RelatedSuggestion["kind"];
    let reason: string;
    if (shared.length > 0) {
      kind = "tags";
      reason = `shares #${shared[0]}`;
    } else {
      contributions.sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
      kind = "keywords";
      reason = `keywords: ${contributions.slice(0, 3).map(([t]) => t).join(", ")}`;
    }
    scored.push({
      path: doc.path,
      name: doc.name,
      score: round3(score),
      reason,
      kind,
      linked: linked.has(doc.name.toLowerCase()),
    });
  }
  scored.sort((a, b) => b.score - a.score || byName(a.name, b.name));
  return scored.slice(0, limit);
}

/** Existing tags ranked by the summed similarity of the notes carrying them. */
export function rankTags(text: string, docs: readonly DocTerms[], limit: number): string[] {
  const query = queryTerms(text);
  if (query.size === 0 || docs.length === 0 || limit <= 0) return [];
  const present = new Set(extractTags(text).map((t) => t.toLowerCase()));
  const corpus = new Corpus(docs);
  const q = corpus.weights(query);
  if (q.norm === 0) return [];
  const scores = new Map<string, { display: string; score: number }>();
  for (const doc of docs) {
    const d = corpus.weights(doc.terms);
    let similarity = 0;
    if (d.norm > 0) {
      let dot = 0;
      for (const [term, qw] of q.w) {
        const dw = d.w.get(term);
        if (dw !== undefined) dot += qw * dw;
      }
      similarity = dot / (q.norm * d.norm);
    }
    const seen = new Set<string>();
    for (const tag of doc.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key) || present.has(key)) continue;
      seen.add(key);
      const entry = scores.get(key) ?? { display: tag, score: 0 };
      if (similarity > 0.02) entry.score += similarity;
      scores.set(key, entry);
    }
  }
  const ranked = [...scores.values()]
    .map(({ display, score }) => {
      const words = tokenize(display.replace(/[/_-]/g, " "));
      const bonus = words.length > 0 && words.every((w) => query.has(w)) ? 0.35 : 0;
      return { display, score: score + bonus };
    })
    .filter((t) => t.score > 0.05)
    .sort((a, b) => b.score - a.score || byName(a.display, b.display));
  return ranked.slice(0, limit).map((t) => t.display);
}

/** Validate a tag: letters, digits, `_`, `-`, `/`; not only digits; ≤ 64 chars. */
export function normalizeTag(tag: string): string {
  const cleaned = tag.trim().replace(/^#+/, "").trim();
  const chars = Array.from(cleaned);
  const valid =
    chars.length > 0 && chars.length <= 64 && chars.every((c) => TAG_CHAR.test(c)) && !/^[0-9]+$/.test(cleaned);
  if (!valid) throw new Error(`invalid input: invalid tag: "${tag}" (use letters, digits, _, - or /)`);
  return cleaned;
}

function mergeFrontmatterTag(lines: string[], tag: string): boolean {
  const wanted = tag.toLowerCase();
  const index = lines.findIndex((line) => {
    if (/^\s/.test(line)) return false;
    const colon = line.indexOf(":");
    return colon >= 0 && ["tags", "tag"].includes(line.slice(0, colon).trim());
  });
  if (index < 0) {
    lines.push(`tags: [${tag}]`);
    return true;
  }
  const colon = lines[index].indexOf(":");
  const key = lines[index].slice(0, colon).trim();
  const value = lines[index].slice(colon + 1).trim();

  if (!value) {
    let last: number | null = null;
    let indent = "  ";
    for (let i = index + 1; i < lines.length; i++) {
      const t = lines[i].trimStart();
      if (!t.startsWith("-")) break;
      if (cleanTagToken(t.slice(1)).toLowerCase() === wanted) return false;
      indent = lines[i].slice(0, lines[i].length - t.length);
      last = i;
    }
    if (last === null) lines[index] = `${key}: [${tag}]`;
    else lines.splice(last + 1, 0, `${indent}- ${tag}`);
    return true;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const items = value
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.some((item) => cleanTagToken(item).toLowerCase() === wanted)) return false;
    lines[index] = items.length === 0 ? `${key}: [${tag}]` : `${key}: [${items.join(", ")}, ${tag}]`;
    return true;
  }

  const separator = value.includes(",") ? "," : " ";
  const items = value
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.some((item) => cleanTagToken(item).toLowerCase() === wanted)) return false;
  if (separator === ",") lines[index] = `${key}: ${value}, ${tag}`;
  else if (items.length === 1) lines[index] = `${key}: [${value}, ${tag}]`;
  else lines[index] = `${key}: ${value} ${tag}`;
  return true;
}

/**
 * Add `tag` to a note: merged into the frontmatter `tags:` key (keeping its
 * style), or appended as `#tag` (to a trailing tag-only line if present).
 */
export function addTagToContent(content: string, rawTag: string): { content: string; changed: boolean } {
  const tag = normalizeTag(rawTag);
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  const { frontmatter, body } = splitFrontmatter(content);
  if (frontmatter !== null) {
    const lines = frontmatter.split("\n").map((l) => l.replace(/\r$/, ""));
    if (!mergeFrontmatterTag(lines, tag)) return { content, changed: false };
    return { content: `---${nl}${lines.map((l) => l + nl).join("")}---${nl}${body}`, changed: true };
  }
  const wanted = tag.toLowerCase();
  if (inlineTags(content).some((t) => t.toLowerCase() === wanted)) return { content, changed: false };
  if (!content.trim()) return { content: `#${tag}${nl}`, changed: true };
  const trimmed = content.replace(/[\r\n]+$/, "");
  const lastLine = (trimmed.split("\n").pop() ?? "").replace(/\r$/, "");
  const tokens = lastLine.trim().split(/\s+/).filter(Boolean);
  const tagOnly = tokens.length > 0 && tokens.every((t) => t.length > 1 && t.startsWith("#") && !t.startsWith("##"));
  return {
    content: tagOnly ? `${trimmed} #${tag}${nl}` : `${trimmed}${nl}${nl}#${tag}${nl}`,
    changed: true,
  };
}
