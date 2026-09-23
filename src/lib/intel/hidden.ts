/**
 * Make invisible characters visible in text the user must judge before
 * approving it (shell commands, paths, commit messages). Control
 * characters, zero-width characters and bidirectional overrides can hide
 * or reorder parts of a command on screen ("Trojan Source"); the approval
 * dialog shows each one as a `U+XXXX` marker instead.
 */

/** Characters that render as nothing or change how the text around them is displayed. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/gu;

/** One run of visible text or one hidden character. */
export type RevealedPart = { kind: "text"; text: string } | { kind: "hidden"; code: string; name: string };

const NAMES: Record<number, string> = {
  0x00: "NUL",
  0x07: "BEL",
  0x08: "backspace",
  0x0d: "carriage return",
  0x1b: "escape",
  0x7f: "delete",
  0x00ad: "soft hyphen",
  0x200b: "zero-width space",
  0x200c: "zero-width non-joiner",
  0x200d: "zero-width joiner",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x2028: "line separator",
  0x2029: "paragraph separator",
  0x202a: "left-to-right embedding",
  0x202b: "right-to-left embedding",
  0x202c: "pop directional formatting",
  0x202d: "left-to-right override",
  0x202e: "right-to-left override",
  0x2066: "left-to-right isolate",
  0x2067: "right-to-left isolate",
  0x2068: "first strong isolate",
  0x2069: "pop directional isolate",
  0xfeff: "zero-width no-break space",
};

/** `U+202E` for a character. */
export function codePointLabel(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Split `text` into visible runs and hidden characters (newlines and tabs stay text). */
export function revealHidden(text: string): RevealedPart[] {
  const parts: RevealedPart[] = [];
  let last = 0;
  for (const match of text.matchAll(HIDDEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index) });
    const cp = match[0].codePointAt(0) ?? 0;
    parts.push({ kind: "hidden", code: codePointLabel(match[0]), name: NAMES[cp] ?? "invisible character" });
    last = index + match[0].length;
  }
  if (last < text.length || parts.length === 0) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** Does `text` contain characters that {@link revealHidden} would mark? */
export function hasHiddenCharacters(text: string): boolean {
  HIDDEN.lastIndex = 0;
  const found = HIDDEN.test(text);
  HIDDEN.lastIndex = 0;
  return found;
}
