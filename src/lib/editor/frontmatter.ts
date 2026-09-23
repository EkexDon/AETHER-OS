/**
 * YAML front matter for the note editor.
 *
 * The TipTap canvas only ever sees the Markdown *body*; the front matter
 * block is kept aside as the exact bytes it was read with and put back in
 * front of the body on save. Untouched notes therefore round-trip
 * byte-identically (`joinFrontmatter(splitFrontmatter(md)) === md`), and
 * edits from the Properties panel rewrite only the lines of the property
 * that changed — comments, key order, quoting and line endings of every
 * other line stay as they were.
 *
 * Only the subset of YAML that notes actually use is understood:
 * `key: value`, flow lists `key: [a, b]` and block lists
 * (`key:` followed by `- a` lines). Anything else (nested maps,
 * `|`/`>` block scalars, anchors) is reported as a read-only raw value and
 * never rewritten.
 */

/** Result of {@link splitFrontmatter}. */
export interface FrontmatterSplit {
  /**
   * The raw front matter block exactly as it appears in the file: the
   * opening `---` line, the YAML, the closing `---` (or `...`) line and any
   * blank lines up to the body. `null` when the note has none.
   */
  frontmatter: string | null;
  /** Everything after the block (the whole file when there is none). */
  body: string;
}

/** A property value: a scalar string or a list of strings. */
export type PropertyValue = string | string[];

/** How a property is written in the YAML. */
export type PropertyStyle = "scalar" | "flow-list" | "block-list" | "raw";

/** One top-level key of the front matter, with its position in the YAML. */
export interface FrontmatterProperty {
  key: string;
  /** Display value; for `raw` properties the unparsed YAML text after the key. */
  value: PropertyValue;
  style: PropertyStyle;
  /** Whether the Properties panel may rewrite this property. */
  editable: boolean;
  /** First YAML line (0-based, relative to the YAML text) of this property. */
  startLine: number;
  /** Line after the last line of this property. */
  endLine: number;
}

const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
const KEY_LINE = /^([^\s#\-?:][^:]*?|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const BOM = "\uFEFF";

interface Line {
  /** Line text without its line break. */
  text: string;
  /** The line break that ended it (`""` for the last line). */
  eol: string;
}

/** Split text into lines, keeping each line's own line break. */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  const re = /\r\n|\n|\r/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push({ text: text.slice(start, m.index), eol: m[0] });
    start = m.index + m[0].length;
  }
  if (start < text.length || lines.length === 0) lines.push({ text: text.slice(start), eol: "" });
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map((l) => l.text + l.eol).join("");
}

/**
 * Separate a note into its front matter block and its body. A block starts
 * at the very first line (`---`, optionally after a byte-order mark) and
 * ends at the next `---` or `...` line; without a closing fence the note
 * has no front matter. Blank lines between the block and the body belong to
 * the block, so the editor's serialised body can be re-attached as is.
 */
export function splitFrontmatter(md: string): FrontmatterSplit {
  const offset = md.startsWith(BOM) ? BOM.length : 0;
  const text = md.slice(offset);
  const lines = splitLines(text);
  if (lines.length < 2 || !OPEN_FENCE.test(lines[0].text) || !lines[0].eol) return { frontmatter: null, body: md };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE_FENCE.test(lines[i].text)) {
      close = i;
      break;
    }
  }
  if (close === -1) return { frontmatter: null, body: md };
  let end = close + 1;
  // Swallow blank lines after the block (only complete lines).
  while (end < lines.length && lines[end].text.trim() === "" && lines[end].eol) end++;
  const blockLength = lines.slice(0, end).reduce((n, l) => n + l.text.length + l.eol.length, 0);
  return { frontmatter: md.slice(0, offset + blockLength), body: text.slice(blockLength) };
}

/** Inverse of {@link splitFrontmatter}: put the block back in front of the body. */
export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (!frontmatter) return body;
  // A block without a trailing line break (file ended at the fence) needs one before a body.
  if (body && !/[\r\n]$/.test(frontmatter)) return `${frontmatter}${detectEol(frontmatter)}${body}`;
  return frontmatter + body;
}

/** Number of lines the block occupies (to map file lines to body lines). */
export function frontmatterLineCount(frontmatter: string | null): number {
  if (!frontmatter) return 0;
  return (frontmatter.match(/\r\n|\n|\r/g) ?? []).length;
}

function detectEol(text: string): string {
  const m = /\r\n|\n|\r/.exec(text);
  return m ? m[0] : "\n";
}

interface BlockParts {
  prefix: string;
  open: Line;
  yaml: Line[];
  close: Line;
  trailing: Line[];
}

function blockParts(frontmatter: string): BlockParts | null {
  const prefix = frontmatter.startsWith(BOM) ? BOM : "";
  const lines = splitLines(frontmatter.slice(prefix.length));
  // splitLines adds an empty last line when the text ends with a break.
  if (lines.length > 1 && lines[lines.length - 1].text === "" && lines[lines.length - 1].eol === "") lines.pop();
  if (lines.length < 2 || !OPEN_FENCE.test(lines[0].text)) return null;
  const close = lines.findIndex((l, i) => i > 0 && CLOSE_FENCE.test(l.text));
  if (close === -1) return null;
  return { prefix, open: lines[0], yaml: lines.slice(1, close), close: lines[close], trailing: lines.slice(close + 1) };
}

/** The YAML text between the fences of a front matter block. */
export function frontmatterYaml(frontmatter: string | null): string {
  if (!frontmatter) return "";
  const parts = blockParts(frontmatter);
  return parts ? joinLines(parts.yaml) : "";
}

/**
 * Replace the YAML between the fences, keeping the fence lines, the blank
 * lines after the block and the line-break style. An empty YAML removes the
 * block entirely (`null`).
 */
export function replaceFrontmatterYaml(frontmatter: string | null, yaml: string): string | null {
  const clean = yaml.replace(/(\r\n|\n|\r)+$/, "");
  if (!clean.trim()) return null;
  if (!frontmatter) return `---\n${clean}\n---\n`;
  const parts = blockParts(frontmatter);
  if (!parts) return `---\n${clean}\n---\n`;
  const eol = parts.open.eol || "\n";
  const body = clean.replace(/\r\n|\n|\r/g, eol);
  return `${parts.prefix}${parts.open.text}${eol}${body}${eol}${parts.close.text}${parts.close.eol || eol}${joinLines(parts.trailing)}`;
}

// ── Parsing ───────────────────────────────────────────────────────

function isQuoted(text: string): boolean {
  return (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  );
}

function unquote(text: string): string {
  if (!isQuoted(text)) return text;
  const inner = text.slice(1, -1);
  if (text.startsWith("'")) return inner.replace(/''/g, "'");
  return inner.replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/** Drop a trailing ` # comment` from an unquoted scalar. */
function stripComment(text: string): string {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    for (let i = 1; i < text.length; i++) {
      if (quote === '"' && text[i] === "\\") {
        i++;
        continue;
      }
      if (text[i] === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i++;
          continue;
        }
        return text.slice(0, i + 1);
      }
    }
    return text;
  }
  if (text.startsWith("#")) return "";
  const idx = text.search(/\s#/);
  return (idx === -1 ? text : text.slice(0, idx)).trimEnd();
}

function scalar(text: string): string {
  return unquote(stripComment(text.trim()));
}

/** Split the inside of a flow list on commas outside quotes. */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      current += c;
      if (quote === '"' && c === "\\" && i + 1 < inner.length) {
        current += inner[++i];
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ",") {
      items.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim() || items.length > 0) items.push(current);
  return items.map((s) => unquote(s.trim())).filter((s) => s !== "");
}

function parseFlowList(text: string): string[] | null {
  const t = stripComment(text.trim());
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1);
  if (/[[\]{}]/.test(inner.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, ""))) return null;
  return splitFlowItems(inner);
}

/**
 * Read the top-level properties of a front matter YAML text, in file order.
 * Duplicate keys keep every occurrence (the panel shows the first).
 */
export function listProperties(yaml: string): FrontmatterProperty[] {
  const lines = splitLines(yaml).map((l) => l.text);
  if (lines.length && lines[lines.length - 1] === "" && /(\r\n|\n|\r)$/.test(yaml)) lines.pop();
  const props: FrontmatterProperty[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) {
      i++;
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = unquote(m[1].trim());
    const rest = m[2] ?? "";
    // Continuation lines: indented lines, or `- ` items directly below the key.
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() === "") {
        // Blank lines only belong to the property when more continuation follows.
        let look = end + 1;
        while (look < lines.length && lines[look].trim() === "") look++;
        if (look < lines.length && (/^\s/.test(lines[look]) || /^-(\s|$)/.test(lines[look]))) {
          end = look;
          continue;
        }
        break;
      }
      if (/^\s/.test(next) || /^-(\s|$)/.test(next)) {
        end++;
        continue;
      }
      break;
    }
    const continuation = lines.slice(i + 1, end).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    const restClean = stripComment(rest.trim());

    let prop: FrontmatterProperty;
    if (continuation.length === 0) {
      const flow = restClean.startsWith("[") ? parseFlowList(rest) : null;
      if (flow) {
        prop = { key, value: flow, style: "flow-list", editable: true, startLine: i, endLine: end };
      } else if (/^[|>&*!{[]/.test(restClean)) {
        prop = { key, value: rest.trim(), style: "raw", editable: false, startLine: i, endLine: end };
      } else {
        prop = { key, value: scalar(rest), style: "scalar", editable: true, startLine: i, endLine: end };
      }
    } else if (!restClean && continuation.every((l) => /^\s*-(\s|$)/.test(l))) {
      const items = continuation.map((l) => l.replace(/^\s*-\s?/, ""));
      const simple = items.every((t) => !/^[[{|>&*!]/.test(t.trim()) && !/^[^"'\s][^:]*:\s/.test(t.trim()));
      prop = simple
        ? { key, value: items.map(scalar).filter((s) => s !== ""), style: "block-list", editable: true, startLine: i, endLine: end }
        : { key, value: lines.slice(i + 1, end).join("\n"), style: "raw", editable: false, startLine: i, endLine: end };
    } else {
      const raw = [rest, ...lines.slice(i + 1, end)].filter((l) => l !== "").join("\n");
      prop = { key, value: raw.trim(), style: "raw", editable: false, startLine: i, endLine: end };
    }
    props.push(prop);
    i = end;
  }
  return props;
}

/**
 * Parse the simple YAML subset into a plain object: scalars become
 * strings, both list styles become string arrays, unsupported values keep
 * their raw text. The first occurrence of a duplicate key wins.
 */
export function parseSimpleYaml(yaml: string): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const p of listProperties(yaml)) {
    if (!(p.key in out)) out[p.key] = p.value;
  }
  return out;
}

// ── Writing ───────────────────────────────────────────────────────

const PLAIN_UNSAFE_START = /^[\s\-?:,[\]{}#&*!|>'"%@`]/;
const RESERVED = /^(?:true|false|yes|no|on|off|null|~)$/i;

/** Quote a scalar only when YAML would misread it unquoted. */
export function formatScalar(value: string, { inFlow = false }: { inFlow?: boolean } = {}): string {
  if (value === "") return '""';
  const needsQuotes =
    PLAIN_UNSAFE_START.test(value) ||
    /\s$/.test(value) ||
    /:(\s|$)/.test(value) ||
    /\s#/.test(value) ||
    /[\n\r\t]/.test(value) ||
    RESERVED.test(value) ||
    (inFlow && /[,[\]{}]/.test(value));
  if (!needsQuotes) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

function formatKey(key: string): string {
  return /^[^\s#\-?:"'][^:]*$/.test(key) && !/\s$/.test(key) ? key : `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Whether `key` can be used as a new property name. */
export function isValidPropertyKey(key: string): boolean {
  const k = key.trim();
  return k.length > 0 && k.length <= 120 && !/[\r\n:]/.test(k) && !/^[-#?]/.test(k);
}

function renderProperty(key: string, value: PropertyValue, style: PropertyStyle, itemIndent: string): string[] {
  const k = formatKey(key);
  if (!Array.isArray(value)) return [value === "" ? `${k}:` : `${k}: ${formatScalar(value)}`];
  if (style === "block-list") {
    if (value.length === 0) return [`${k}: []`];
    return [`${k}:`, ...value.map((v) => `${itemIndent}- ${formatScalar(v)}`)];
  }
  return [`${k}: [${value.map((v) => formatScalar(v, { inFlow: true })).join(", ")}]`];
}

/**
 * Set `key` to `value` in a front matter YAML text. An existing editable
 * property is rewritten in its own style (a scalar becomes a flow list when
 * given an array); a new key is appended at the end. Every other line is
 * left untouched. Throws when the property is not editable.
 */
export function setProperty(yaml: string, key: string, value: PropertyValue): string {
  const eol = detectEol(yaml);
  const lines = yaml === "" ? [] : yaml.replace(/(\r\n|\n|\r)$/, "").split(/\r\n|\n|\r/);
  const existing = listProperties(yaml).find((p) => p.key === key);
  if (existing && !existing.editable) throw new Error(`The property "${key}" uses YAML the editor cannot change.`);
  if (!existing) {
    if (!isValidPropertyKey(key)) throw new Error(`"${key}" is not a valid property name.`);
    return [...lines, ...renderProperty(key.trim(), value, Array.isArray(value) ? "flow-list" : "scalar", "  ")].join(eol);
  }
  const style: PropertyStyle = Array.isArray(value)
    ? existing.style === "block-list"
      ? "block-list"
      : "flow-list"
    : "scalar";
  const indentLine = lines.slice(existing.startLine + 1, existing.endLine).find((l) => /^\s*-/.test(l));
  const itemIndent = indentLine ? (/^(\s*)-/.exec(indentLine)?.[1] ?? "  ") : "  ";
  // Keep an original key spelling (quoted keys stay quoted).
  const rendered = renderProperty(key, value, style, itemIndent);
  const originalKey = /^(\s*(?:"[^"]*"|'[^']*'|[^:]*?))[ \t]*:/.exec(lines[existing.startLine])?.[1];
  if (originalKey !== undefined) rendered[0] = rendered[0].replace(/^(?:"(?:[^"\\]|\\.)*"|[^:]*)/, originalKey);
  // Blank lines trailing a block list stay where they were.
  let end = existing.endLine;
  while (end > existing.startLine + 1 && lines[end - 1]?.trim() === "") end--;
  const next = [...lines.slice(0, existing.startLine), ...rendered, ...lines.slice(end)];
  return next.join(eol) + (/(\r\n|\n|\r)$/.test(yaml) ? eol : "");
}

/** Remove every occurrence of `key` from a front matter YAML text. */
export function removeProperty(yaml: string, key: string): string {
  const eol = detectEol(yaml);
  const lines = yaml.replace(/(\r\n|\n|\r)$/, "").split(/\r\n|\n|\r/);
  const drop = new Set<number>();
  for (const p of listProperties(yaml)) {
    if (p.key !== key) continue;
    let end = p.endLine;
    while (end > p.startLine + 1 && lines[end - 1]?.trim() === "") end--;
    for (let i = p.startLine; i < end; i++) drop.add(i);
  }
  if (drop.size === 0) return yaml;
  const next = lines.filter((_, i) => !drop.has(i));
  return next.join(eol) + (next.length && /(\r\n|\n|\r)$/.test(yaml) ? eol : "");
}

/** Convenience: apply a YAML edit to a whole front matter block. */
export function editFrontmatter(frontmatter: string | null, edit: (yaml: string) => string): string | null {
  return replaceFrontmatterYaml(frontmatter, edit(frontmatterYaml(frontmatter)));
}

/** Tags of a `tags` value (scalar `a, b` / `#a #b` or list), without `#`. */
export function normalizeTags(value: PropertyValue | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : value.split(/[,\s]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const tag = t.trim().replace(/^#+/, "");
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}
