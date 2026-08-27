import TurndownService from "turndown";
// @ts-expect-error — turndown-plugin-gfm ships no types
import { gfm } from "turndown-plugin-gfm";
import type { AgentAction, ClippedPage } from "../types";

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

/**
 * Parse agent actions from AI output. Actions are embedded as fenced code
 * blocks with language "action" containing JSON:
 *
 *   ```action
 *   {"action":"create_note","title":"Ideas","content":"# Hello"}
 *   ```
 */
export function parseAgentActions(output: string): AgentAction[] {
  const actions: AgentAction[] = [];
  const re = /```action\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed.action === "string") {
        actions.push(parsed as AgentAction);
      }
    } catch {
      // skip malformed JSON
    }
  }
  return actions;
}

/** Human-readable description for the approval UI. */
export function describeAction(action: AgentAction): string {
  switch (action.action) {
    case "create_note":
      return `Create note "${action.title}"`;
    case "append_note":
      return `Append to ${action.path.split("/").pop() ?? action.path}`;
    case "append_daily":
      return `Add to daily note: ${action.content.slice(0, 60)}`;
    case "open_url":
      return `Open ${action.url}`;
    case "clip_url":
      return `Clip ${action.url} into vault`;
  }
}
