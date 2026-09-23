/**
 * Frecency and rank fusion — TypeScript mirror of
 * `engine/search_index/{frecency,fusion}.rs`, used to rank client-side
 * launcher items (commands, bookmarks) and by the mock backend.
 */

const DAY = 86_400;

/** How many visits are sampled per recent (matches the backend). */
export const MAX_VISITS = 10;
/** How many recents are kept (matches the backend). */
export const MAX_RECENTS = 50;
/** Reciprocal-rank-fusion damping constant. */
export const RRF_K = 60;

/** Weight of a visit that happened `ageSecs` ago (Firefox-style age buckets). */
export function visitWeight(ageSecs: number): number {
  const days = Math.floor(Math.max(0, ageSecs) / DAY);
  if (days <= 3) return 100;
  if (days <= 13) return 70;
  if (days <= 30) return 50;
  if (days <= 89) return 30;
  return 10;
}

/** Visit history of one recent result. */
export interface VisitRecord {
  count: number;
  lastUsed: number;
  /** Unix seconds of the latest visits, newest first. */
  visits: number[];
}

/** Total visits × average weight of the sampled visits. */
export function frecency(record: VisitRecord, now: number): number {
  if (record.count <= 0) return 0;
  const samples = record.visits.length > 0 ? record.visits : [record.lastUsed];
  const total = samples.reduce((sum, t) => sum + visitWeight(now - t), 0);
  return (record.count * total) / samples.length;
}

/** Multiplicative ranking boost: 1 for unused results, logarithmic, capped at 2. */
export function frecencyBoost(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(2, 1 + 0.5 * Math.log(1 + value / 100));
}

/** One ranked list for {@link reciprocalRankFusion}. */
export interface RankedList {
  ids: string[];
  weight: number;
}

/**
 * Fuse ranked lists: `score = Σ weight / (k + rank)` with 1-based ranks.
 * Duplicates inside a list count once; ties keep first appearance.
 */
export function reciprocalRankFusion(lists: RankedList[], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, { score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    if (!(Number.isFinite(list.weight) && list.weight > 0)) continue;
    const seen = new Set<string>();
    let rank = 0;
    for (const id of list.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      const entry = scores.get(id) ?? { score: 0, order: order++ };
      entry.score += list.weight / (k + rank);
      scores.set(id, entry);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order)
    .map(([id, v]) => ({ id, score: v.score }));
}
