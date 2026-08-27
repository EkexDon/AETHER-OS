export interface Mention {
  index: number;
  text: string;
  snippet: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function maskNonMentionRegions(content: string): string {
  let masked = content;
  const blank = (m: string) => "^".repeat(m.length);
  masked = masked.replace(/```[\s\S]*?(```|$)/g, blank);
  masked = masked.replace(/`[^`\n]*`/g, blank);
  masked = masked.replace(/\[\[[^\]]*\]\]/g, blank);
  masked = masked.replace(/^<!--[\s\S]*?-->/g, blank);
  return masked;
}

function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !/[\p{L}\p{N}_]/u.test(ch);
}

export function findUnlinkedMentions(content: string, noteName: string): Mention[] {
  const name = noteName.replace(/\.md$/i, "").trim();
  if (name.length < 2) return [];

  const masked = maskNonMentionRegions(content);
  const re = new RegExp(escapeRegExp(name), "gi");
  const out: Mention[] = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isBoundary(masked[start - 1]) || !isBoundary(masked[end])) continue;

    const text = content.slice(start, end);
    const from = Math.max(0, start - 40);
    const to = Math.min(content.length, end + 40);
    const snippet =
      (from > 0 ? "…" : "") +
      content.slice(from, to).replace(/\n+/g, " ") +
      (to < content.length ? "…" : "");
    out.push({ index: start, text, snippet });
  }
  return out;
}

export function linkMentions(content: string, noteName: string): { content: string; linked: number } {
  const name = noteName.replace(/\.md$/i, "").trim();
  const mentions = findUnlinkedMentions(content, name);
  if (mentions.length === 0) return { content, linked: 0 };

  let result = "";
  let cursor = 0;
  for (const mention of mentions) {
    result += content.slice(cursor, mention.index);
    result += mention.text === name ? `[[${name}]]` : `[[${name}|${mention.text}]]`;
    cursor = mention.index + mention.text.length;
  }
  result += content.slice(cursor);
  return { content: result, linked: mentions.length };
}
