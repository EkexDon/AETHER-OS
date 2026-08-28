import { describe, it, expect } from "vitest";
import {
  parseAgentActions,
  describeAction,
  actionLabel,
  stripActionBlocks,
  hasActions,
} from "./agentActions";

describe("agentActions", () => {
  describe("parseAgentActions", () => {
    it("parses a single action from a fenced code block", () => {
      const output = 'Here is your note:\n\n```action\n{"action":"create_note","title":"Ideas","content":"# Hello"}\n```\nDone.';
      const actions = parseAgentActions(output);
      expect(actions).toHaveLength(1);
      expect(actions[0].action).toBe("create_note");
    });

    it("parses multiple actions in one output", () => {
      const output = [
        '```action\n{"action":"create_note","title":"A","content":"a"}\n```',
        '```action\n{"action":"append_daily","content":"reminder"}\n```',
      ].join("\n\n");
      const actions = parseAgentActions(output);
      expect(actions).toHaveLength(2);
      expect(actions[0].action).toBe("create_note");
      expect(actions[1].action).toBe("append_daily");
    });

    it("ignores malformed JSON blocks", () => {
      const output = '```action\n{invalid json}\n```';
      const actions = parseAgentActions(output);
      expect(actions).toHaveLength(0);
    });

    it("returns empty when there are no action blocks", () => {
      expect(parseAgentActions("just a regular chat reply")).toEqual([]);
    });

    it("parses the new add_memory_fact and save_aether_note variants", () => {
      const output = [
        '```action\n{"action":"add_memory_fact","fact":"User prefers dark mode","category":"preferences"}\n```',
        '```action\n{"action":"save_aether_note","title":"My answer","content":"the answer body"}\n```',
      ].join("\n");
      const actions = parseAgentActions(output);
      expect(actions).toHaveLength(2);
      expect(actions[0].action).toBe("add_memory_fact");
      expect(actions[1].action).toBe("save_aether_note");
    });
  });

  describe("describeAction", () => {
    it("describes create_note", () => {
      const desc = describeAction({ action: "create_note", title: "My Note", content: "" });
      expect(desc).toContain("Create note");
      expect(desc).toContain("My Note");
    });

    it("describes append_note", () => {
      const desc = describeAction({ action: "append_note", path: "vault/note.md", content: "" });
      expect(desc).toContain("note.md");
    });

    it("describes append_daily", () => {
      const desc = describeAction({ action: "append_daily", content: "Remember to buy milk" });
      expect(desc).toContain("Remember to buy milk");
    });

    it("describes open_url", () => {
      const desc = describeAction({ action: "open_url", url: "https://example.com" });
      expect(desc).toContain("https://example.com");
    });

    it("describes clip_url", () => {
      const desc = describeAction({ action: "clip_url", url: "https://example.com" });
      expect(desc).toContain("Clip");
      expect(desc).toContain("https://example.com");
    });

    it("describes add_memory_fact", () => {
      const desc = describeAction({
        action: "add_memory_fact",
        fact: "Project AETHER-OS is written in Rust + TypeScript",
        category: "projects",
      });
      expect(desc).toContain("Remember fact");
      expect(desc).toContain("AETHER-OS");
    });

    it("describes save_aether_note", () => {
      const desc = describeAction({
        action: "save_aether_note",
        title: "Saved answer",
        content: "...",
      });
      expect(desc).toContain("AETHER Note");
    });
  });

  describe("actionLabel", () => {
    it("produces short chip labels for each action", () => {
      expect(actionLabel({ action: "create_note", title: "T", content: "" })).toContain('Created "T"');
      expect(actionLabel({ action: "append_daily", content: "x" })).toBe("Added to daily note");
      expect(actionLabel({ action: "open_url", url: "https://example.com/long-path" })).toContain("example.com");
      expect(actionLabel({ action: "add_memory_fact", fact: "f", category: "general" })).toBe("Remembered fact");
      expect(actionLabel({ action: "save_aether_note", title: "T", content: "" })).toBe("Saved to AETHER Notes");
    });
  });

  describe("stripActionBlocks", () => {
    it("removes all action blocks from output", () => {
      const output = 'Some prose.\n\n```action\n{"action":"create_note","title":"X","content":"y"}\n```\n\nMore prose.';
      expect(stripActionBlocks(output)).toBe("Some prose.\n\n\n\nMore prose.");
    });

    it("returns the input unchanged when there are no action blocks", () => {
      const output = "Just normal text.";
      expect(stripActionBlocks(output)).toBe(output);
    });
  });

  describe("hasActions", () => {
    it("detects actions in output", () => {
      expect(hasActions('```action\n{"action":"x"}\n```')).toBe(true);
      expect(hasActions("plain text")).toBe(false);
    });

    it("does not false-positive on code blocks with different language", () => {
      expect(hasActions("```json\n{}\n```")).toBe(false);
    });
  });
});
