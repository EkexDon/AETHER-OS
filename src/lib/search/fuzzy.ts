import { scoreFields } from "../commands/fuzzy";

/** Does position `i` of `text` start a word (start, after a separator, camelCase)? */
function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (!/[\p{L}\p{N}]/u.test(prev)) return true;
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * Word-start subsequence ("acronym") score for abbreviations the palette
 * scorer rejects — `clbrd` → "Clipboard", `vsc` → "Visual Studio Code".
 * Returns 0 for no match, otherwise 1–250 (below every tier of
 * {@link scoreFields}' substring matches). The first character must start
 * a word; spread-out matches are only accepted when every character hits a
 * word start.
 */
export function acronymScore(query: string, text: string): number {
  const needle = [...query.toLowerCase().replace(/\s+/g, "")];
  if (needle.length < 2 || !text) return 0;
  const lower = text.toLowerCase();
  if (needle.length > lower.length) return 0;
  const positions = subsequencePositions(needle, text, lower);
  if (!positions || !staysCoherent(text, positions)) return 0;
  const boundaries = positions.filter((p) => isBoundary(text, p)).length;
  const span = positions[positions.length - 1] - positions[0] + 1;
  if (span > needle.length * 3 + 4 && boundaries < needle.length) return 0;
  let consecutive = 0;
  let gaps = 0;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === positions[i - 1] + 1) consecutive++;
    else gaps += positions[i] - positions[i - 1] - 1;
  }
  const score = 120 + boundaries * 20 + consecutive * 12 - gaps * 4 - Math.min(lower.length - needle.length, 60);
  return Math.max(1, Math.min(250, score));
}

/**
 * Skipping letters is fine inside the first matched word ("clbrd" →
 * "Clipboard"), but after moving on to a later word every hit must start a
 * word or directly continue the previous hit — otherwise "rust" would match
 * "run setup".
 */
function staysCoherent(text: string, positions: number[]): boolean {
  const wordOf = (pos: number) => {
    let word = 0;
    for (let i = 1; i <= pos; i++) if (isBoundary(text, i)) word++;
    return word;
  };
  const firstWord = wordOf(positions[0]);
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i];
    if (p === positions[i - 1] + 1 || isBoundary(text, p)) continue;
    if (wordOf(p) !== firstWord) return false;
  }
  return true;
}

/** Greedy in-order positions of `needle` in `text`, preferring nearby word starts. */
function subsequencePositions(needle: string[], text: string, lower: string): number[] | null {
  let start = -1;
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === needle[0] && isBoundary(text, i)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const positions = [start];
  let pos = start + 1;
  for (const ch of needle.slice(1)) {
    const next = lower.indexOf(ch, pos);
    if (next < 0) return null;
    let hit = next;
    // Keep runs together; otherwise prefer a nearby word start.
    if (next !== pos && !isBoundary(text, next)) {
      for (let j = next + 1; j < Math.min(lower.length, next + 8); j++) {
        if (lower[j] === ch && isBoundary(text, j)) {
          hit = j;
          break;
        }
      }
    }
    positions.push(hit);
    pos = hit + 1;
  }
  return positions;
}

/**
 * Launcher score of a client-side item: the palette scorer (exact > prefix
 * > word > substring > compact subsequence) with the acronym matcher as a
 * fallback. `0` means no match.
 */
export function launcherScore(query: string, title: string, secondary: string[] = []): number {
  const q = query.trim();
  if (!q) return 1;
  const base = scoreFields(q, title, secondary);
  if (base > 0) return base;
  return acronymScore(q, title);
}

/**
 * Character positions of `query` inside `text` for highlighting: a
 * contiguous case-insensitive substring when there is one, else the
 * word-start subsequence. Empty when nothing matches.
 */
export function matchPositions(query: string, text: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [];
  const lower = text.toLowerCase();
  // Only use the substring when it lines up with the original characters
  // (lower-casing can change the length of a few Unicode characters).
  if (lower.length === text.length) {
    const idx = lower.indexOf(q);
    if (idx >= 0) return Array.from({ length: q.length }, (_, i) => idx + i);
  }
  const needle = [...q.replace(/\s+/g, "")];
  if (needle.length === 0 || lower.length !== text.length) return [];
  return subsequencePositions(needle, text, lower) ?? [];
}
