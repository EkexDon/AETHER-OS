/** A run of text, highlighted or not. */
export interface Segment {
  text: string;
  mark: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/** Decode the few HTML entities the backend's escaper emits (plus numeric ones). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const named = ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

/**
 * Split a backend `snippet_html` into text segments. Only `<mark>` /
 * `</mark>` are interpreted; everything else (including any other tag) is
 * treated as literal text, so the result can be rendered as React text
 * nodes without ever injecting HTML.
 */
export function parseMarkedSnippet(html: string): Segment[] {
  const segments: Segment[] = [];
  const push = (raw: string, mark: boolean) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    const last = segments[segments.length - 1];
    if (last && last.mark === mark) last.text += text;
    else segments.push({ text, mark });
  };
  let mark = false;
  let rest = html;
  while (rest.length > 0) {
    const tag = mark ? "</mark>" : "<mark>";
    const idx = rest.toLowerCase().indexOf(tag);
    if (idx < 0) {
      push(rest, mark);
      break;
    }
    push(rest.slice(0, idx), mark);
    rest = rest.slice(idx + tag.length);
    mark = !mark;
  }
  return segments;
}

/** Segments of `text` with the characters at `positions` highlighted. */
export function segmentsFromPositions(text: string, positions: number[]): Segment[] {
  if (positions.length === 0) return text ? [{ text, mark: false }] : [];
  const marked = new Set(positions);
  const segments: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const mark = marked.has(i);
    const last = segments[segments.length - 1];
    if (last && last.mark === mark) last.text += text[i];
    else segments.push({ text: text[i], mark });
  }
  return segments;
}

/** Plain text of a snippet (marks dropped, entities decoded). */
export function snippetText(html: string): string {
  return parseMarkedSnippet(html)
    .map((s) => s.text)
    .join("");
}
