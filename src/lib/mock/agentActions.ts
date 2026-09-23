/** Mock handlers for `commands/agent_action_commands.rs`: the router
 *  commands forward to the browser, clipper, memory and AETHER Notes mocks
 *  and wrap the outcome in the tagged `AgentActionResult`.
 *
 *  It also decorates the fake LLM (`cmd_agent_query_with_notes` from
 *  `./ai`) so the approval-gated actions of the `intel` feature can be
 *  exercised in the browser preview: prompts that ask to run a command,
 *  delete / move a note, commit, add a task or tick a task off get an answer
 *  with the matching ```action block; everything else is answered by the
 *  regular mock. (This map is spread after `aiHandlers` in `backend.ts`.) */
import type { AgentAction } from "../../types";
import { createAetherNoteRecord } from "./aetherNotes";
import { aiHandlers, streamText } from "./ai";
import { mockOpenExternal } from "./browser";
import { repoRoots } from "./git";
import { saveFact } from "./memory";
import { mockClip } from "./notes";
import { argOptString, argString, type MockArgs, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";

const MISSING_KEY = "OpenRouter API key is missing. Set it in Settings → AI Providers.";

function block(action: AgentAction): string {
  return `\`\`\`action\n${JSON.stringify(action)}\n\`\`\``;
}

/** The vault note whose name occurs in the prompt (longest name wins). */
function mentionedNote(prompt: string): { path: string; name: string } | null {
  const p = prompt.toLowerCase();
  const notes = mockVault
    .list()
    .filter((n) => p.includes(n.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  return notes[0] ? { path: notes[0].path, name: notes[0].name } : null;
}

function firstOpenTask(preferred: string | null): { path: string; line: number; text: string } | null {
  const notes = mockVault.list();
  const ordered = preferred ? [...notes.filter((n) => n.path === preferred), ...notes] : notes;
  for (const note of ordered) {
    const lines = mockVault.read(note.path).split(/\r?\n/);
    const index = lines.findIndex((l) => /^\s*[-*+] \[ \]/.test(l));
    if (index >= 0) return { path: note.path, line: index + 1, text: lines[index].replace(/^\s*[-*+] \[ \]\s*/, "") };
  }
  return null;
}

/**
 * The action (plus one sentence of prose) a prompt asks for, or `null`
 * when the regular mock should answer.
 */
export function intelIntent(prompt: string): { prose: string; action: AgentAction } | null {
  const p = prompt.toLowerCase();
  const repo = repoRoots()[0] ?? null;

  const quoted = /`([^`]+)`/.exec(prompt)?.[1];
  const runMatch = /\b(?:run|execute|führe)\s+(.+?)(?:\s+(?:in|im)\s+.+)?$/i.exec(prompt.trim());
  // Only explicit requests ("run …", "execute …", a `command` in backticks),
  // so questions like "how do I run tests?" stay normal answers.
  if (quoted || /^(please\s+)?(run|execute|führe)\b/i.test(prompt.trim())) {
    const command = (quoted ?? runMatch?.[1] ?? "").replace(/^(the\s+)?(command|befehl)\s+/i, "").trim();
    if (command) {
      const inRepo = /^(git|npm|pnpm|yarn|cargo)\b/.test(command) && repo;
      return {
        prose: `I'll run \`${command}\`${inRepo ? " in the demo app" : " in your vault"} once you approve it.`,
        action: { action: "run_command", command, cwd: inRepo ? repo : null },
      };
    }
  }
  if (/\b(commit)\b/.test(p) && repo) {
    const message = /["“]([^"”]+)["”]/.exec(prompt)?.[1] ?? "chore: update from AETHER";
    return {
      prose: "I'll commit the current changes of the demo app after you approve.",
      action: { action: "git_commit", project_path: repo, message },
    };
  }
  if (/\b(delete|remove|trash|lösche)\b/.test(p) && /\b(note|notiz)\b/.test(p)) {
    const note = mentionedNote(prompt) ?? mentionedNote("quick capture");
    if (note) {
      return {
        prose: `I'll move [[${note.name}]] to the trash (you can restore it from \`.trash/\`).`,
        action: { action: "delete_note", path: note.path },
      };
    }
  }
  if (/\b(move|archive|rename|verschiebe)\b/.test(p)) {
    const note = mentionedNote(prompt);
    if (note) {
      return {
        prose: `I'll move [[${note.name}]] into the archive folder.`,
        action: { action: "move_note", from: note.path, to: `04-Archive/${note.name}.md` },
      };
    }
  }
  if (/\b(tick|check off|toggle|abhaken|erledigt)\b/.test(p)) {
    const task = firstOpenTask(mentionedNote(prompt)?.path ?? null);
    if (task) {
      return {
        prose: `I'll tick off “${task.text}”.`,
        action: { action: "toggle_vault_task", note_path: task.path, line: task.line },
      };
    }
  }
  if (/\b(add|create|new|neue|erstelle)\b/.test(p) && /\b(task|aufgabe)\b/.test(p)) {
    const title =
      /["“]([^"”]+)["”]/.exec(prompt)?.[1] ??
      prompt
        .replace(/^.*?\b(task|aufgabe)\b\s*(to|:|zum|für)?\s*/i, "")
        .replace(/[.!?]+$/, "")
        .trim()
        .slice(0, 80);
    return {
      prose: "I'll add that to your task board.",
      action: { action: "create_task", title: title || "Follow up on the chat", priority: "medium" },
    };
  }
  return null;
}

async function queryWithNotes(args: MockArgs): Promise<unknown> {
  const prompt = argString(args, "prompt");
  const model = argString(args, "model");
  const provider = argOptString(args, "provider");
  const intent = intelIntent(prompt);
  if (!intent) return aiHandlers.cmd_agent_query_with_notes(args);
  const health = aiHandlers.cmd_get_health({}) as { openrouter_configured: boolean };
  if (provider === "openrouter" && !health.openrouter_configured) throw new Error(MISSING_KEY);
  await streamText(`${intent.prose}\n\n${block(intent.action)}\n\n_Answered by ${model} (mock mode)._`);
  return undefined;
}

export const agentActionsHandlers: MockHandlerMap = {
  cmd_agent_open_url: (args) => {
    const url = argString(args, "url");
    mockOpenExternal(url);
    return { kind: "opened", url };
  },
  cmd_agent_clip_url: (args) => ({ kind: "clipped_page", path: mockClip(argString(args, "url")) }),
  cmd_agent_add_memory_fact: (args) => {
    const facts = saveFact(argString(args, "fact"), argString(args, "category"));
    const saved = facts[facts.length - 1];
    if (!saved) throw new Error("memory store returned no fact");
    return { kind: "fact_saved", fact: saved };
  },
  cmd_agent_save_aether_note: (args) => ({
    kind: "aether_note_saved",
    note: createAetherNoteRecord(argString(args, "title"), argString(args, "content"), "", []),
  }),
  cmd_agent_query_with_notes: queryWithNotes,
};
