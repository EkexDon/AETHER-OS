/** Mock handlers for `commands/note_commands.rs` (write/create/append,
 *  backlinks, daily notes, clipping and vault-only agent actions). */
import type { AgentAction, ClippedPage } from "../../types";
import { argString, localDate, type MockArgs, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";

/** Fake readable content for a URL (the real clipper fetches + extracts). */
export function mockClip(url: string): ClippedPage {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid input: invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid input: only http(s) URLs can be clipped");
  }
  const slug = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
  const words = slug.replace(/\.[a-z]+$/i, "").split(/[-_]+/).filter(Boolean);
  const title = words.length
    ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")
    : parsed.hostname.replace(/^www\./, "");
  const excerpt = `A clipped article from ${parsed.hostname} about ${title.toLowerCase()}.`;
  return {
    url,
    title,
    excerpt,
    content_html:
      `<h1>${title}</h1><p>${excerpt}</p>` +
      `<h2>Key points</h2><ul><li>Local-first tools keep working offline.</li>` +
      `<li>Plain Markdown files outlive any app.</li><li>Links between notes create context.</li></ul>` +
      `<p>Source: <a href="${url}">${parsed.hostname}</a></p>`,
  };
}

function parseAction(args: MockArgs): AgentAction {
  const action = args.action as Partial<AgentAction> | undefined;
  if (!action || typeof action !== "object" || typeof action.action !== "string") {
    throw new Error("invalid args `action` for command: command missing required key action");
  }
  return action as AgentAction;
}

/** Same routing and status strings as `execute_action` in agent_actions.rs. */
export function executeVaultAction(action: AgentAction): string {
  switch (action.action) {
    case "create_note":
      return `Created note: ${mockVault.create(action.title, action.content)}`;
    case "append_note":
      mockVault.append(action.path, action.content);
      return `Appended to: ${action.path}`;
    case "append_daily":
      return `Added to daily note: ${mockVault.appendDaily(action.content)}`;
    case "add_memory_fact":
      throw new Error(
        `invalid input: add_memory_fact must go through cmd_add_memory_fact (got ${action.fact} / ${action.category})`
      );
    case "save_aether_note":
      throw new Error(`invalid input: save_aether_note must go through cmd_save_aether_note (got title="${action.title}")`);
    case "open_url":
    case "clip_url":
      throw new Error("invalid input: open_url and clip_url must be routed through their dedicated commands");
    default:
      throw new Error(`invalid input: ${action.action} must go through its dedicated calendar command`);
  }
}

export const notesHandlers: MockHandlerMap = {
  cmd_write_note: (args) => mockVault.write(argString(args, "path"), argString(args, "content")),
  cmd_create_note: (args) => mockVault.create(argString(args, "relPath"), argString(args, "content")),
  cmd_append_note: (args) => mockVault.append(argString(args, "path"), argString(args, "content")),
  cmd_get_backlinks: (args) => mockVault.backlinks(argString(args, "noteName")),
  cmd_daily_note: () => mockVault.dailyNote(localDate(new Date())),
  cmd_append_daily: (args) => mockVault.appendDaily(argString(args, "text")),
  cmd_clip_url: (args) => mockClip(argString(args, "url")),
  cmd_execute_agent_action: (args) => executeVaultAction(parseAction(args)),
};
