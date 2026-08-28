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
 * `src-tauri/src/engine/agent_actions.rs`; keep them in lockstep.
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
  }
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
