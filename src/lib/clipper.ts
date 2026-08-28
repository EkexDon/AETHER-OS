import TurndownService from "turndown";
// @ts-expect-error — turndown-plugin-gfm ships no types
import { gfm } from "turndown-plugin-gfm";
import type { ClippedPage } from "../types";

let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
    turndown.use(gfm);
    turndown.remove(["script", "style", "noscript"]);
    turndown.addRule("dropEmptyLinks", {
      filter: (node) =>
        node.nodeName === "A" &&
        !(node.textContent ?? "").trim() &&
        !(node as HTMLElement).querySelector("img"),
      replacement: () => "",
    });
    turndown.addRule("preWithoutCode", {
      filter: (node) =>
        node.nodeName === "PRE" && !(node as HTMLElement).querySelector("code"),
      replacement: (_content, node) =>
        "\n\n```\n" + ((node.textContent ?? "").replace(/\n$/, "")) + "\n```\n\n",
    });
  }
  return turndown;
}

/** Convert HTML to Markdown for vault storage. */
export function htmlToMarkdown(html: string): string {
  try {
    return getTurndown().turndown(html).trim();
  } catch {
    return "";
  }
}

/** Build a complete clip note from a ClippedPage. */
export function buildClipNote(page: ClippedPage, now: Date): string {
  const title = page.title?.trim() || "Web Clip";
  const lines = [
    `# ${title}`,
    "",
    `> Clipped from ${page.url} on ${now.toLocaleString()}`,
    "",
  ];
  const body = htmlToMarkdown(page.content_html);
  if (body) {
    lines.push(body, "");
  }
  lines.push(`[Source](${page.url})`, "");
  lines.push("#clipped");
  return lines.join("\n") + "\n";
}

/** Filesystem-safe note name from a page title. */
export function clipNoteName(title: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const fallback = `Clip ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
  const cleaned = (title ?? "")
    .replace(/[/\\:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${cleaned || fallback}.md`;
}

