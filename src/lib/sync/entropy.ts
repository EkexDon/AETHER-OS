/**
 * Passphrase strength estimator for the sync unlock / setup forms.
 *
 * A deliberately conservative heuristic (no dictionary download): it takes
 * the *lower* of two models and applies penalties for well-known weak
 * patterns.
 *
 * - **Character model** — `log2(pool)` bits per character, where the pool
 *   is the union of the character classes used; repeated characters and
 *   ascending/descending runs (`aaaa`, `abcd`, `4321`) only count 1 bit each.
 * - **Word model** — passphrases made of two or more words are rated like
 *   Diceware (≈ 12.9 bits per word) plus a little for extra character
 *   classes, so "correct horse battery staple" is not over-rated at 130 bits.
 *
 * Common passwords and keyboard walks (`qwerty`, `asdf`, `1qaz`) are capped.
 * The key is stretched with Argon2id (64 MiB, 3 passes) so ~50 bits already
 * resists offline guessing; the thresholds reflect that.
 */

/** 0 = very weak … 4 = very strong. */
export type StrengthScore = 0 | 1 | 2 | 3 | 4;

/** Result of {@link estimatePassphrase}. */
export interface StrengthEstimate {
  /** Estimated entropy in bits (rounded down). */
  bits: number;
  score: StrengthScore;
  label: string;
  /** Concrete suggestions, most important first. */
  hints: string[];
  /** Good enough to set as a new passphrase (≥ 8 characters and at least "Fair"). */
  acceptable: boolean;
}

/** Minimum length the backend enforces for new passphrases. */
export const MIN_PASSPHRASE_LENGTH = 8;

/** Bits per Diceware word (log2 7776). */
const BITS_PER_WORD = Math.log2(7776);

/** Minimum bits for scores 1 (weak) … 4 (very strong). */
const THRESHOLDS: readonly number[] = [28, 36, 48, 64];

const LABELS: Record<StrengthScore, string> = {
  0: "Very weak",
  1: "Weak",
  2: "Fair",
  3: "Strong",
  4: "Very strong",
};

/** A small list of the most common passwords (lowercase, without digits/symbols). */
const COMMON = new Set([
  "password",
  "passwort",
  "passphrase",
  "qwerty",
  "qwertz",
  "letmein",
  "welcome",
  "admin",
  "iloveyou",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "master",
  "sunshine",
  "princess",
  "shadow",
  "superman",
  "trustno",
  "secret",
  "hallo",
  "geheim",
  "abc",
  "test",
  "login",
  "changeme",
  "aether",
  "aetheros",
]);

const KEYBOARD_WALKS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "qwertzuiop", "yxcvbnm", "1qaz2wsx", "1234567890"];

/** Characters (by code point) in `text`. */
function chars(text: string): string[] {
  return Array.from(text);
}

/** Size of the character pool implied by the classes present. */
export function poolSize(text: string): number {
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/[0-9]/.test(text)) pool += 10;
  if (/[ ]/.test(text)) pool += 1;
  if (/[!-\/:-@[-`{-~]/.test(text)) pool += 33;
  if (/[^\x00-\x7f]/.test(text)) pool += 100;
  return pool;
}

/** Number of distinct character classes used. */
function classCount(text: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9\s]/].filter((re) => re.test(text)).length;
}

/** Character model: penalises repeats and ±1 sequences. */
function characterBits(text: string): { bits: number; patterned: boolean } {
  const list = chars(text);
  const pool = poolSize(text);
  if (list.length === 0 || pool === 0) return { bits: 0, patterned: false };
  const perChar = Math.log2(pool);
  let bits = 0;
  let patterned = 0;
  for (let i = 0; i < list.length; i++) {
    if (i === 0) {
      bits += perChar;
      continue;
    }
    const prev = list[i - 1].codePointAt(0) ?? 0;
    const cur = list[i].codePointAt(0) ?? 0;
    if (cur === prev || Math.abs(cur - prev) === 1) {
      bits += 1;
      patterned++;
    } else {
      bits += perChar;
    }
  }
  return { bits, patterned: patterned >= 3 || patterned > list.length / 3 };
}

/** Words of a passphrase (letters only, ≥ 2 characters). */
export function passphraseWords(text: string): string[] {
  return text
    .split(/[\s\-_.,;:+/]+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ""))
    .filter((w) => w.length >= 2);
}

/** Word model for multi-word passphrases (null for a single word). */
function wordBits(text: string): number | null {
  const words = passphraseWords(text);
  if (words.length < 2) return null;
  const distinct = new Set(words.map((w) => w.toLowerCase())).size;
  let bits = distinct * BITS_PER_WORD + (words.length - distinct);
  // A capital, a digit or a symbol somewhere adds a few bits.
  if (/[A-Z]/.test(text)) bits += 2;
  if (/[0-9]/.test(text)) bits += 3;
  if (/[^a-zA-Z0-9\s\-_.,;:+/]/.test(text)) bits += 3;
  return bits;
}

/** Strip digits and symbols at both ends, then undo simple leetspeak. */
function normalizeForCommonCheck(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[^a-z@$]+|[^a-z]+$/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/3/g, "e")
    .replace(/4|@/g, "a")
    .replace(/5|\$/g, "s")
    .replace(/7/g, "t");
}

function containsKeyboardWalk(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYBOARD_WALKS.some((walk) => {
    for (let i = 0; i + 4 <= walk.length; i++) {
      if (lower.includes(walk.slice(i, i + 4))) return true;
    }
    return false;
  });
}

function scoreFor(bits: number): StrengthScore {
  let score = 0;
  for (const threshold of THRESHOLDS) if (bits >= threshold) score++;
  return score as StrengthScore;
}

/** Estimate the strength of `passphrase`. */
export function estimatePassphrase(passphrase: string): StrengthEstimate {
  const length = chars(passphrase).length;
  if (length === 0) {
    return { bits: 0, score: 0, label: LABELS[0], hints: ["Enter a passphrase."], acceptable: false };
  }
  const hints: string[] = [];
  const char = characterBits(passphrase);
  const words = wordBits(passphrase);
  let bits = words === null ? char.bits : Math.min(char.bits, words);

  const common = COMMON.has(normalizeForCommonCheck(passphrase));
  if (common) {
    bits = Math.min(bits, 10);
    hints.push("This is one of the most common passwords — pick something unique.");
  }
  if (containsKeyboardWalk(passphrase)) {
    bits = Math.min(bits, Math.max(12, bits - 20));
    hints.push("Avoid keyboard patterns like qwerty or 1234.");
  }
  if (char.patterned && !common) {
    hints.push("Avoid repeated characters and runs like aaa or abc.");
  }
  if (length < MIN_PASSPHRASE_LENGTH) {
    hints.unshift(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  } else if (length < 12 && words === null) {
    hints.push("Longer is stronger — four random words work well.");
  }
  if (words === null && classCount(passphrase) === 1 && length >= MIN_PASSPHRASE_LENGTH) {
    hints.push("Add another word, a number or a symbol.");
  }

  const floored = Math.max(0, Math.floor(bits));
  const score = scoreFor(floored);
  return {
    bits: floored,
    score,
    label: LABELS[score],
    hints,
    acceptable: length >= MIN_PASSPHRASE_LENGTH && score >= 2,
  };
}
