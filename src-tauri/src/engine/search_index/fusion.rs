//! Reciprocal-rank fusion (RRF) of several ranked result lists.
//!
//! Keyword (BM25), fuzzy-title and semantic (vector) rankings produce scores
//! on incomparable scales, so they are merged by rank instead:
//! `score(d) = Σ_lists weight / (k + rank_list(d))` with 1-based ranks
//! (Cormack et al., 2009). Documents found by several retrievers rise to the
//! top; a document missing from a list simply gets no contribution from it.

use std::collections::HashMap;

/// The conventional RRF damping constant. Larger values flatten the
/// advantage of the very first ranks.
pub const RRF_K: f64 = 60.0;

/// One ranked list: document ids best-first and the list's weight.
#[derive(Debug, Clone, Copy)]
pub struct RankedList<'a> {
    pub ids: &'a [String],
    pub weight: f64,
}

/// Fuse ranked lists with RRF. Returns `(id, score)` best-first.
///
/// Duplicate ids inside one list only count at their best rank. Ties are
/// broken by first appearance (list order, then rank) so the result is
/// deterministic. Lists with a non-positive or non-finite weight are ignored.
pub fn reciprocal_rank_fusion(lists: &[RankedList<'_>], k: f64) -> Vec<(String, f64)> {
    let k = if k.is_finite() && k >= 0.0 { k } else { RRF_K };
    let mut scores: HashMap<&str, (f64, usize)> = HashMap::new();
    let mut order = 0usize;
    for list in lists {
        if !(list.weight.is_finite() && list.weight > 0.0) {
            continue;
        }
        let mut seen = std::collections::HashSet::new();
        let mut rank = 0usize;
        for id in list.ids {
            if !seen.insert(id.as_str()) {
                continue;
            }
            rank += 1;
            let contribution = list.weight / (k + rank as f64);
            let entry = scores.entry(id.as_str()).or_insert_with(|| {
                order += 1;
                (0.0, order)
            });
            entry.0 += contribution;
        }
    }
    let mut fused: Vec<(String, f64, usize)> = scores
        .into_iter()
        .map(|(id, (score, first))| (id.to_owned(), score, first))
        .collect();
    fused.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)));
    fused
        .into_iter()
        .map(|(id, score, _)| (id, score))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    fn order(fused: &[(String, f64)]) -> Vec<&str> {
        fused.iter().map(|(id, _)| id.as_str()).collect()
    }

    #[test]
    fn documents_found_by_several_retrievers_win() {
        let keyword = ids(&["a", "b", "c"]);
        let semantic = ids(&["c", "d", "a"]);
        let fused = reciprocal_rank_fusion(
            &[
                RankedList {
                    ids: &keyword,
                    weight: 1.0,
                },
                RankedList {
                    ids: &semantic,
                    weight: 1.0,
                },
            ],
            RRF_K,
        );
        // a: 1/61 + 1/63, c: 1/63 + 1/61 → tie broken by first appearance.
        assert_eq!(order(&fused), vec!["a", "c", "b", "d"]);
        let a = fused[0].1;
        assert!((a - (1.0 / 61.0 + 1.0 / 63.0)).abs() < 1e-12);
    }

    #[test]
    fn single_list_order_is_preserved() {
        let list = ids(&["x", "y", "z"]);
        let fused = reciprocal_rank_fusion(
            &[RankedList {
                ids: &list,
                weight: 1.0,
            }],
            RRF_K,
        );
        assert_eq!(order(&fused), vec!["x", "y", "z"]);
        assert!(fused[0].1 > fused[1].1 && fused[1].1 > fused[2].1);
    }

    #[test]
    fn weights_shift_the_balance() {
        let keyword = ids(&["k"]);
        let semantic = ids(&["s"]);
        let fused = reciprocal_rank_fusion(
            &[
                RankedList {
                    ids: &keyword,
                    weight: 0.5,
                },
                RankedList {
                    ids: &semantic,
                    weight: 2.0,
                },
            ],
            RRF_K,
        );
        assert_eq!(order(&fused), vec!["s", "k"]);
    }

    #[test]
    fn duplicates_count_once_at_their_best_rank() {
        let dup = ids(&["a", "a", "b"]);
        let fused = reciprocal_rank_fusion(
            &[RankedList {
                ids: &dup,
                weight: 1.0,
            }],
            0.0,
        );
        assert_eq!(order(&fused), vec!["a", "b"]);
        assert!((fused[0].1 - 1.0).abs() < 1e-12);
        assert!(
            (fused[1].1 - 0.5).abs() < 1e-12,
            "b is rank 2 after de-duplication"
        );
    }

    #[test]
    fn empty_and_invalid_lists_are_ignored() {
        let list = ids(&["a"]);
        let empty: Vec<String> = Vec::new();
        let fused = reciprocal_rank_fusion(
            &[
                RankedList {
                    ids: &empty,
                    weight: 1.0,
                },
                RankedList {
                    ids: &list,
                    weight: f64::NAN,
                },
                RankedList {
                    ids: &list,
                    weight: -1.0,
                },
            ],
            RRF_K,
        );
        assert!(fused.is_empty());
        assert!(reciprocal_rank_fusion(&[], RRF_K).is_empty());
    }

    #[test]
    fn invalid_k_falls_back_to_default() {
        let list = ids(&["a"]);
        let fused = reciprocal_rank_fusion(
            &[RankedList {
                ids: &list,
                weight: 1.0,
            }],
            f64::NAN,
        );
        assert!((fused[0].1 - 1.0 / (RRF_K + 1.0)).abs() < 1e-12);
    }
}
