//! Fuzzy title matching — the fallback that lets abbreviations such as
//! `clbrd` find "Clipboard" when the keyword index (which only matches
//! whole tokens and token prefixes) has nothing.

/// Score `query` as a fuzzy match of `text`, in `(0, 1]` (1 = exact).
///
/// Ranking tiers: exact (1.0) > prefix (≈0.95) > word prefix (≈0.85) >
/// substring (≈0.75) > in-order subsequence (≤ 0.7). Subsequence matches
/// must start on a word boundary and stay reasonably compact, otherwise
/// short queries would match almost every title. Whitespace in the query
/// is ignored for the subsequence tier. Returns `None` for no match or a
/// query shorter than two characters.
pub fn fuzzy_score(query: &str, text: &str) -> Option<f64> {
    let q: String = query.trim().to_lowercase();
    if q.chars().count() < 2 {
        return None;
    }
    let lower = text.to_lowercase();
    if lower.is_empty() {
        return None;
    }
    let length_penalty = |extra: usize| (extra.min(100) as f64) * 0.0005;
    let text_len = lower.chars().count();
    let q_len = q.chars().count();

    if lower == q {
        return Some(1.0);
    }
    if lower.starts_with(&q) {
        return Some(0.95 - length_penalty(text_len - q_len));
    }
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    if let Some(idx) = words.iter().position(|w| w.starts_with(&q)) {
        return Some(0.85 - (idx.min(10) as f64) * 0.01 - length_penalty(text_len - q_len));
    }
    if let Some(byte_idx) = lower.find(&q) {
        let char_idx = lower[..byte_idx].chars().count();
        return Some(0.75 - (char_idx.min(50) as f64) * 0.002 - length_penalty(text_len - q_len));
    }
    subsequence_score(&q, text)
}

/// Is position `i` of `chars` the start of a word (start, after a
/// separator, or a lower→upper camelCase transition)?
fn is_boundary(chars: &[char], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    let prev = chars[i - 1];
    let cur = chars[i];
    !prev.is_alphanumeric()
        || (prev.is_lowercase() && cur.is_uppercase())
        || (prev.is_alphabetic() && cur.is_ascii_digit())
}

fn subsequence_score(q: &str, text: &str) -> Option<f64> {
    let original: Vec<char> = text.chars().collect();
    let lower: Vec<char> = original
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let needle: Vec<char> = q.chars().filter(|c| !c.is_whitespace()).collect();
    if needle.len() < 2 || needle.len() > lower.len() {
        return None;
    }

    // The first query character must hit a word start.
    let first = (0..lower.len()).find(|&i| lower[i] == needle[0] && is_boundary(&original, i))?;

    // Word number of every character: skipping letters is fine inside the
    // first matched word ("clbrd" → "Clipboard"), but after moving on to a
    // later word each hit must start a word or continue the previous hit,
    // otherwise "rust" would match "run setup".
    let mut word_of = Vec::with_capacity(lower.len());
    let mut word = 0usize;
    for i in 0..lower.len() {
        if i > 0 && is_boundary(&original, i) {
            word += 1;
        }
        word_of.push(word);
    }

    let mut pos = first + 1;
    let mut boundaries = 1usize;
    let mut consecutive = 0usize;
    let mut gaps = 0usize;
    let mut last = first;
    for &ch in &needle[1..] {
        // Keep runs together; otherwise prefer the next word-boundary
        // occurrence when it is close ("gd" → "Git Desktop" hits the D).
        let next = (pos..lower.len()).find(|&i| lower[i] == ch)?;
        let boundary_hit = (next..lower.len().min(next + 8))
            .find(|&i| lower[i] == ch && is_boundary(&original, i));
        let hit = match boundary_hit {
            Some(b) if next != pos && !is_boundary(&original, next) && b != next => b,
            _ => next,
        };
        if hit == last + 1 {
            consecutive += 1;
        } else {
            if !is_boundary(&original, hit) && word_of[hit] != word_of[first] {
                return None;
            }
            gaps += hit - last - 1;
        }
        if is_boundary(&original, hit) {
            boundaries += 1;
        }
        last = hit;
        pos = hit + 1;
    }

    // Acronyms ("vsc" → Visual Studio Code) may spread across the title as
    // long as every character hits a word start; anything else must stay
    // compact.
    let span = last - first + 1;
    if span > needle.len() * 3 + 4 && boundaries < needle.len() {
        return None;
    }
    let score = 0.35 + boundaries as f64 * 0.05 + consecutive as f64 * 0.04
        - gaps as f64 * 0.012
        - (lower.len() - needle.len()).min(60) as f64 * 0.002;
    Some(score.clamp(0.05, 0.7))
}

#[cfg(test)]
mod tests {
    use super::fuzzy_score;

    #[test]
    fn abbreviations_find_titles() {
        assert!(fuzzy_score("clbrd", "Clipboard").is_some());
        assert!(fuzzy_score("vsc", "Visual Studio Code").is_some());
        assert!(fuzzy_score("gh", "GitHub Desktop").is_some());
        assert!(fuzzy_score("sysmon", "System Monitor").is_some());
        assert!(fuzzy_score("sysset", "System Settings").is_some());
    }

    #[test]
    fn tiers_rank_exact_prefix_word_substring_subsequence() {
        let exact = fuzzy_score("notes", "Notes").unwrap();
        let prefix = fuzzy_score("not", "Notes view").unwrap();
        let word = fuzzy_score("vie", "Notes view").unwrap();
        let sub = fuzzy_score("board", "Clipboard").unwrap();
        let seq = fuzzy_score("clbrd", "Clipboard").unwrap();
        assert!(exact > prefix, "{exact} > {prefix}");
        assert!(prefix > word, "{prefix} > {word}");
        assert!(word > sub, "{word} > {sub}");
        assert!(sub > seq, "{sub} > {seq}");
    }

    #[test]
    fn rejects_scattered_or_mid_word_subsequences() {
        assert_eq!(fuzzy_score("xyz", "Clipboard"), None);
        assert_eq!(
            fuzzy_score("lpd", "Clipboard"),
            None,
            "must start on a word boundary"
        );
        assert_eq!(
            fuzzy_score("cd", "Configuration of the entire standard"),
            None
        );
        assert_eq!(
            fuzzy_score("c", "Clipboard"),
            None,
            "single characters are too noisy"
        );
        assert_eq!(
            fuzzy_score("rust", "Help: run setup again"),
            None,
            "no mid-word jumps in later words"
        );
    }

    #[test]
    fn compact_matches_beat_spread_out_ones() {
        let tight = fuzzy_score("clb", "Clipboard").unwrap();
        let loose = fuzzy_score("cbd", "Clipboard").unwrap();
        assert!(tight > loose);
    }

    #[test]
    fn handles_unicode_titles() {
        assert!(fuzzy_score("spä", "Spätzle Rezept").is_some());
        assert!(fuzzy_score("kchr", "Kochrezepte").is_some());
    }
}
