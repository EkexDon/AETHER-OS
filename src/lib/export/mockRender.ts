/**
 * DEV-only Markdown → HTML renderer used by the mock backend
 * (`src/lib/mock/export.ts`) so the export preview works in the browser
 * preview (`npm run dev:mock`). It covers the syntax of the demo vault —
 * frontmatter header, headings with ids, paragraphs, lists and tasks,
 * blockquotes, tables, fenced code (mermaid as `<pre class="mermaid">`),
 * emphasis, links, images, `[[wikilinks]]`, `![[embeds]]` and `#tags` —
 * and wraps it in the real export stylesheet from the Rust templates, so
 * the preview looks like a real export. The desktop app renders with
 * pulldown-cmark + syntect in `src-tauri/src/engine/export/html.rs`.
 *
 * Only imported by the mock backend, which production builds never load.
 */
import styleCss from "../../../src-tauri/src/engine/export/templates/style.css?raw";
import printCss from "../../../src-tauri/src/engine/export/templates/print.css?raw";
import type { ExportOptions } from "../../types";

/** Link resolution for one rendered note. */
export interface MockRenderContext {
  /** Display name of the note a wikilink target resolves to, or `null`. */
  resolveNote: (target: string) => string | null;
}

/** Result of {@link renderMarkdownBody}. */
export interface MockRenderResult {
  html: string;
  missing: string[];
  tags: string[];
  hasMermaid: boolean;
}

/** The stylesheet of exported documents (base + print additions). */
export const MOCK_DOC_CSS = styleCss;
/** Print additions (`templates/print.css`). */
export const MOCK_PRINT_CSS = printCss;

/** Escape text for HTML content and attributes. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** GitHub-style heading anchor (same rule as `heading_anchor` in Rust). */
export function headingAnchor(text: string): string {
  return [...text.trim().toLowerCase()]
    .map((c) => (/[\p{L}\p{N}_-]/u.test(c) ? c : c === " " ? "-" : ""))
    .join("");
}

/** Split a leading `---` frontmatter block. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

/** The frontmatter fields the export header shows. */
export interface MockFrontmatter {
  title: string | null;
  date: string | null;
  description: string | null;
  tags: string[];
}

/** Parse `key: value`, inline `[a, b]` and block `- item` lists. */
export function parseFrontmatter(raw: string | null): MockFrontmatter {
  const fm: MockFrontmatter = { title: null, date: null, description: null, tags: [] };
  if (!raw) return fm;
  let listKey: string | null = null;
  const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "").trim();
  for (const line of raw.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey === "tags") {
      const tag = unquote(item[1]).replace(/^#/, "");
      if (tag) fm.tags.push(tag);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    listKey = value === "" ? key : null;
    if (key === "title") fm.title = unquote(value) || null;
    else if ((key === "date" || key === "created") && !fm.date) fm.date = unquote(value) || null;
    else if (key === "description" || key === "summary") fm.description = unquote(value) || null;
    else if (key === "tags" || key === "tag") {
      const list = value.startsWith("[") ? value.slice(1, -1) : value;
      for (const part of list.split(/[,\s]+/)) {
        const tag = unquote(part).replace(/^#/, "");
        if (tag) fm.tags.push(tag);
      }
    }
  }
  return fm;
}

/** Inline Markdown → HTML (placeholders keep generated HTML out of later passes). */
function renderInline(text: string, ctx: MockRenderContext, out: MockRenderResult): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/(!?)\[\[([^\]]+)\]\]/g, (_m, bang: string, inner: string) => {
    const [link, alias] = inner.replace(/\\\|/g, "|").split("|");
    const [target, heading] = link.split("#");
    const display = alias?.trim() || (heading ? (target ? `${target.trim()} > ${heading.trim()}` : heading.trim()) : target.trim());
    if (!target.trim() && heading) {
      return hold(`<a class="internal" href="#${escapeHtml(headingAnchor(heading))}">${escapeHtml(display)}</a>`);
    }
    if (bang) {
      if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(target)) return hold(placeholderImage(target.trim()));
      const note = ctx.resolveNote(target);
      if (note) return hold(`<span class="wikilink embed-note">${escapeHtml(display)}</span>`);
    }
    const note = ctx.resolveNote(target);
    if (!note) {
      out.missing.push(target.trim());
      return hold(`<span class="missing" title="Not exported: ${escapeHtml(target.trim())}">${escapeHtml(display)}</span>`);
    }
    return hold(`<span class="wikilink" title="${escapeHtml(note)}">${escapeHtml(display)}</span>`);
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) =>
    /^https?:\/\//.test(src)
      ? hold(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`)
      : hold(placeholderImage(src.split("/").pop() ?? src, alt))
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const safe = /^(https?:|mailto:|#)/i.test(href) ? href : "#";
    return hold(`<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>`);
  });
  s = s.replace(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu, (m, pre: string, tag: string) => {
    if (!/\p{L}/u.test(tag)) return m;
    if (!out.tags.includes(tag)) out.tags.push(tag);
    return `${pre}${hold(`<span class="tag">#${escapeHtml(tag)}</span>`)}`;
  });
  s = escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]);
}

/** Neutral placeholder for attachments the mock vault does not have. */
function placeholderImage(name: string, alt = name): string {
  const label = escapeHtml(name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220" viewBox="0 0 640 220"><rect width="640" height="220" rx="12" fill="#ebe8e1"/><text x="320" y="118" font-family="system-ui,sans-serif" font-size="18" fill="#6e6c65" text-anchor="middle">${label}</text></svg>`;
  return `<img class="embed" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" alt="${escapeHtml(alt)}" loading="lazy">`;
}

interface ListFrame {
  indent: number;
  ordered: boolean;
}

/** Render a Markdown body (without frontmatter). */
export function renderMarkdownBody(markdown: string, ctx: MockRenderContext): MockRenderResult {
  const out: MockRenderResult = { html: "", missing: [], tags: [], hasMermaid: false };
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  const anchors = new Map<string, number>();
  const lists: ListFrame[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${renderInline(paragraph.join(" "), ctx, out)}</p>`);
    paragraph = [];
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > indent) {
      html.push(lists.pop()!.ordered ? "</ol>" : "</ul>");
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flushParagraph();
      closeLists();
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) code.push(lines[j++]);
      i = j;
      const lang = fence[2].toLowerCase();
      if (lang === "mermaid") {
        out.hasMermaid = true;
        html.push(`<pre class="mermaid">${escapeHtml(code.join("\n"))}</pre>`);
      } else {
        const attr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
        html.push(`<pre class="code"${attr}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = heading[1].length;
      const base = headingAnchor(heading[2].replace(/[`*_[\]]/g, "")) || "section";
      const n = anchors.get(base) ?? 0;
      anchors.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      html.push(`<h${level} id="${escapeHtml(id)}">${renderInline(heading[2], ctx, out)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      closeLists();
      html.push("<hr>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph();
      closeLists();
      const quote: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) quote.push(lines[j++].replace(/^\s*>\s?/, ""));
      i = j - 1;
      const inner = renderMarkdownBody(quote.join("\n"), ctx);
      out.missing.push(...inner.missing);
      inner.tags.forEach((t) => !out.tags.includes(t) && out.tags.push(t));
      html.push(`<blockquote>${inner.html}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      flushParagraph();
      closeLists();
      const cells = (row: string) =>
        row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && /^\s*\|/.test(lines[j])) rows.push(cells(lines[j++]));
      i = j - 1;
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${renderInline(c, ctx, out)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, ctx, out)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1].replace(/\t/g, "  ").length;
      const ordered = /\d/.test(item[2]);
      while (lists.length && lists[lists.length - 1].indent > indent) {
        html.push(lists.pop()!.ordered ? "</ol>" : "</ul>");
      }
      if (!lists.length || lists[lists.length - 1].indent < indent) {
        lists.push({ indent, ordered });
        html.push(ordered ? "<ol>" : "<ul>");
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      const body = task
        ? `<input disabled="" type="checkbox"${task[1] === " " ? "" : ' checked=""'}/>\n${renderInline(task[2], ctx, out)}`
        : renderInline(item[3], ctx, out);
      html.push(`<li>${body}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeLists();
      continue;
    }
    if (lists.length && /^\s+\S/.test(line)) {
      // Lazy continuation of a list item.
      const last = html.pop() ?? "";
      html.push(last.replace(/<\/li>$/, ` ${renderInline(line.trim(), ctx, out)}</li>`));
      continue;
    }
    closeLists();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeLists();
  out.html = html.join("\n");
  return out;
}

/** Options relevant for the mock document. */
export interface MockDocumentInput {
  /** File name of the note (fallback title). */
  name: string;
  content: string;
  options: Pick<ExportOptions, "include_frontmatter" | "include_backlinks" | "theme">;
  backlinks: string[];
  ctx: MockRenderContext;
}

/** Title + article markup for one note (shared by preview and print). */
export function renderMockArticle(input: MockDocumentInput): {
  title: string;
  article: string;
  result: MockRenderResult;
} {
  const { frontmatter, body } = splitFrontmatter(input.content);
  const fm = parseFrontmatter(frontmatter);
  let text = body;
  let title = fm.title ?? input.name;
  const h1 = /^\s*#\s+([^\n[\]`*_<\\]+?)\s*\n/.exec(body);
  if (h1 && (!fm.title || fm.title.toLowerCase() === h1[1].toLowerCase())) {
    title = fm.title ?? h1[1];
    text = body.slice(h1[0].length);
  }
  const result = renderMarkdownBody(text, input.ctx);
  const meta: string[] = [];
  if (input.options.include_frontmatter) {
    if (fm.date) meta.push(`<time datetime="${escapeHtml(fm.date)}">${escapeHtml(fm.date)}</time>`);
    if (fm.tags.length) {
      meta.push(
        `<span class="doc-tags">${fm.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join(" ")}</span>`
      );
    }
  }
  const header = [
    `<header class="doc-header">`,
    `<h1 class="doc-title">${escapeHtml(title)}</h1>`,
    input.options.include_frontmatter && fm.description
      ? `<p class="doc-description">${escapeHtml(fm.description)}</p>`
      : "",
    meta.length
      ? `<div class="doc-meta">${meta.join('<span class="doc-meta-sep" aria-hidden="true">·</span>')}</div>`
      : "",
    `</header>`,
  ].join("\n");
  const backlinks =
    input.options.include_backlinks && input.backlinks.length
      ? `<section class="backlinks" aria-labelledby="backlinks-title"><h2 id="backlinks-title" class="backlinks-title">Linked from</h2><ul>${input.backlinks
          .map((b) => `<li><span class="wikilink">${escapeHtml(b)}</span></li>`)
          .join("")}</ul></section>`
      : "";
  return {
    title,
    article: `<article class="doc">\n${header}\n<div class="doc-content">\n${result.html}\n</div>\n${backlinks}</article>`,
    result,
  };
}

/** A complete standalone document, like `templates/note.html`. */
export function renderMockDocument(input: MockDocumentInput): string {
  const { title, article } = renderMockArticle(input);
  const date = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="AETHER-OS">
<title>${escapeHtml(title)}</title>
<style>
${MOCK_DOC_CSS}
</style>
</head>
<body class="aether-doc" data-theme="${input.options.theme}">
<main class="doc-main">
${article}
</main>
<footer class="doc-footer">Exported from AETHER-OS · ${date}</footer>
</body>
</html>`;
}

/**
 * Rewrite wikilinks into relative Markdown links (mock of the bundle
 * converter): `resolve` returns the target's path relative to the note,
 * or `null` to keep only the display text.
 */
export function convertWikilinksMock(content: string, resolve: (target: string) => string | null): string {
  const { frontmatter, body } = splitFrontmatter(content);
  const head = frontmatter === null ? "" : content.slice(0, content.length - body.length);
  let inFence = false;
  const converted = body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith("`")
            ? part
            : part.replace(/(!?)\[\[([^\]]+)\]\]/g, (_m, bang: string, inner: string) => {
                const [link, alias] = inner.split("|");
                const [target, heading] = link.split("#");
                const display = alias?.trim() || (heading ? `${target} > ${heading}` : target);
                const path = resolve(target.trim());
                if (path === null) return display;
                const dest = encodeURI(path) + (heading ? `#${encodeURIComponent(headingAnchor(heading))}` : "");
                return bang && /\.(png|jpe?g|gif|webp|svg)$/i.test(target)
                  ? `![${target.split("/").pop()}](${dest})`
                  : `[${display.replace(/([[\]\\])/g, "\\$1")}](${dest})`;
              })
        )
        .join("");
    })
    .join("\n");
  return head + converted;
}
