/** A note split into YAML frontmatter fields and its Markdown body. */
export interface NoteParts {
  body: string;
  /** Top-level `key: value` pairs of the frontmatter (values unparsed). */
  fields: { key: string; value: string }[];
}

/**
 * Split a note's leading `---` frontmatter block from its body so the
 * preview does not render YAML as text. Notes without (or with an
 * unterminated) frontmatter are returned unchanged.
 */
export function splitNote(content: string): NoteParts {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { body: content, fields: [] };
  const fields: { key: string; value: string }[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fields.push({ key: kv[1], value: kv[2].trim() });
    else if (/^\s+-\s+/.test(line) && fields.length > 0) {
      const last = fields[fields.length - 1];
      const item = line.replace(/^\s+-\s+/, "").trim();
      last.value = last.value ? `${last.value}, ${item}` : item;
    }
  }
  return { body: content.slice(match[0].length), fields };
}
