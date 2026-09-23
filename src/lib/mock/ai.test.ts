import { describe, expect, it } from "vitest";
import { composeAnswer, pickAction } from "./ai";
import { parseAgentActions } from "../agentActions";

describe("mock AI intents", () => {
  it("picks approval-gated actions for explicit requests", () => {
    expect(pickAction("Please run `npm test` in the demo app", 1)).toBe("run_command");
    expect(pickAction("run the tests", 1)).toBe("run_command");
    expect(pickAction("Delete the note Quick Capture", 1)).toBe("delete_note");
    expect(pickAction("Lösche die Notiz", 1)).toBe("delete_note");
    expect(pickAction("move the reading list note to resources", 1)).toBe("move_note");
    expect(pickAction("remember that I like tea", 1)).toBe("add_memory_fact");
    expect(pickAction("what is rust ownership?", 1)).toBeNull();
  });

  it("emits a parseable run_command block with the backticked command", () => {
    const answer = composeAnswer("run `npm run build`", [], 1, "gemma2:2b");
    const actions = parseAgentActions(answer);
    expect(actions).toEqual([{ action: "run_command", command: "npm run build", cwd: "/Users/demo/Developer/aether-demo-app" }]);
  });
});
