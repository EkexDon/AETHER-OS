/** Mock handlers for `commands/agent_action_commands.rs`: the router
 *  commands forward to the browser, clipper, memory and AETHER Notes mocks
 *  and wrap the outcome in the tagged `AgentActionResult`. */
import { createAetherNoteRecord } from "./aetherNotes";
import { mockOpenExternal } from "./browser";
import { saveFact } from "./memory";
import { mockClip } from "./notes";
import { argString, type MockHandlerMap } from "./runtime";

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
};
