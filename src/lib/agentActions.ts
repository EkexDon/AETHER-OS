import type { AgentAction } from "../types";

/**
 * Parse agent actions from AI output. Actions are embedded as fenced code
 * blocks with language "action" containing JSON:
 *
 *   ```action
 *   {"action":"create_note","title":"Ideas","content":"# Hello"}
 *   ```
 *
 * Why a fenced block: it survives Markdown rendering unmodified (no HTML
 * escaping), it can't collide with natural prose, and it's trivially
 * human-readable while still being machine-parseable. Both Ollama models
 * (we use the instruction in the system prompt) and OpenRouter tool
 * post-processors can emit this format reliably.
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
      // skip malformed JSON — never crash the chat on a bad tool call
    }
  }
  return actions;
}

/**
 * Human-readable one-line description for the approval UI / chips.
 * The full set of action variants is mirrored on the Rust side in
 * `src-tauri/src/engine/agent_actions.rs`; keep them in lockstep. The
 * approval level of each variant lives in `src/lib/intel/risk.ts`.
 */
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
    case "add_memory_fact":
      return `Remember fact: ${action.fact.slice(0, 60)}`;
    case "save_aether_note":
      return `Save answer as AETHER Note`;
    case "create_calendar_event":
      return `Create event "${action.title}" on ${action.start}`;
    case "update_calendar_event":
      return `Update event ${action.id}`;
    case "delete_calendar_event":
      return `Delete event ${action.id}`;
    case "list_calendar_events":
      return `List calendar events`;
    case "import_calendar_ics":
      return `Import ICS from ${action.path}`;
    case "run_command":
      return action.cwd ? `Run \`${clip(action.command, 80)}\` in ${action.cwd}` : `Run \`${clip(action.command, 80)}\` in the vault`;
    case "delete_note":
      return `Move ${baseName(action.path)} to the trash`;
    case "move_note":
      return `Move ${baseName(action.from)} → ${action.to}`;
    case "git_commit":
      return `Commit in ${baseName(action.project_path)}: ${clip(action.message.split("\n")[0] ?? "", 60)}`;
    case "create_task":
      return `Create task "${clip(action.title, 60)}"${action.project_id ? ` in ${action.project_id}` : ""}`;
    case "toggle_vault_task":
      return `Toggle task on line ${action.line} of ${baseName(action.note_path)}`;
  }
}

/**
 * Human-readable chip label (short, no truncation, for the inline message UI).
 */
export function actionLabel(action: AgentAction): string {
  switch (action.action) {
    case "create_note":
      return `Created "${action.title}"`;
    case "append_note":
      return `Updated ${action.path.split("/").pop() ?? action.path}`;
    case "append_daily":
      return "Added to daily note";
    case "open_url":
      return `Opened ${shortenUrl(action.url)}`;
    case "clip_url":
      return `Clipped ${shortenUrl(action.url)}`;
    case "add_memory_fact":
      return "Remembered fact";
    case "save_aether_note":
      return "Saved to AETHER Notes";
    case "create_calendar_event":
      return `Created event "${action.title}"`;
    case "update_calendar_event":
      return "Updated event";
    case "delete_calendar_event":
      return "Deleted event";
    case "list_calendar_events":
      return "Listed events";
    case "import_calendar_ics":
      return "Imported calendar";
    case "run_command":
      return `Ran ${clip(action.command, 40)}`;
    case "delete_note":
      return `Trashed ${baseName(action.path)}`;
    case "move_note":
      return `Moved ${baseName(action.from)}`;
    case "git_commit":
      return `Committed in ${baseName(action.project_path)}`;
    case "create_task":
      return `Added task "${clip(action.title, 40)}"`;
    case "toggle_vault_task":
      return `Toggled task in ${baseName(action.note_path)}`;
  }
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function baseName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname === "/" ? "" : u.pathname).slice(0, 24);
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Strip ```action ... ``` blocks from AI output so they don't get
 * re-rendered as Markdown. We hide the action syntax from the user;
 * they see a normal chat message + an inline tool chip instead.
 */
export function stripActionBlocks(output: string): string {
  return output.replace(/```action\s*\n[\s\S]*?```/g, "").trim();
}

/**
 * Returns true if the AI output contained at least one parseable action.
 */
export function hasActions(output: string): boolean {
  return /```action\s*\n[\s\S]*?"action":\s*"[a-z_]+"/.test(output);
}
