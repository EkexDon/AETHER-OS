/**
 * Tiny fuzzy scorer for the command palette. Higher is better; `0` means
 * no match. Ranking: exact > prefix > word-prefix > substring > in-order
 * subsequence (with a bonus for consecutive characters).
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (!t) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - Math.min(t.length - q.length, 100);
  const wordIdx = t.split(/[\s/._-]+/).findIndex((w) => w.startsWith(q));
  if (wordIdx >= 0) return 600 - wordIdx * 10;
  const idx = t.indexOf(q);
  if (idx >= 0) return 400 - Math.min(idx, 100);

  // Subsequence match — only when the matched characters stay close together,
  // otherwise short queries would match almost everything.
  const chars = q.replace(/\s+/g, "");
  let score = 0;
  let ti = 0;
  let streak = 0;
  let first = -1;
  for (const ch of chars) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    if (first < 0) first = found;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  const span = ti - first;
  if (span > chars.length + 2) return 0;
  return Math.max(1, Math.min(score, 300));
}

/** Best score of `query` against several fields (title weighted highest). */
export function scoreFields(query: string, primary: string, secondary: string[] = []): number {
  const main = fuzzyScore(query, primary);
  let best = main;
  for (const s of secondary) {
    const sc = fuzzyScore(query, s) * 0.6;
    if (sc > best) best = sc;
  }
  return best;
}
