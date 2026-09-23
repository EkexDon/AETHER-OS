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

  describe("intel action variants", () => {
    it("parses the approval-gated actions", () => {
      const output = [
        '```action\n{"action":"run_command","command":"npm test","cwd":"/work/app"}\n```',
        '```action\n{"action":"delete_note","path":"Old.md"}\n```',
        '```action\n{"action":"move_note","from":"a.md","to":"archive/a.md"}\n```',
        '```action\n{"action":"git_commit","project_path":"/work/app","message":"fix: typo"}\n```',
        '```action\n{"action":"create_task","title":"Ship v0.2"}\n```',
        '```action\n{"action":"toggle_vault_task","note_path":"Todo.md","line":3}\n```',
      ].join("\n");
      expect(parseAgentActions(output).map((a) => a.action)).toEqual([
        "run_command",
        "delete_note",
        "move_note",
        "git_commit",
        "create_task",
        "toggle_vault_task",
      ]);
    });

    it("describes them with their targets", () => {
      expect(describeAction({ action: "run_command", command: "npm test", cwd: "/work/app" })).toBe(
        "Run `npm test` in /work/app"
      );
      expect(describeAction({ action: "run_command", command: "ls" })).toBe("Run `ls` in the vault");
      expect(describeAction({ action: "delete_note", path: "/v/inbox/Old.md" })).toBe("Move Old.md to the trash");
      expect(describeAction({ action: "move_note", from: "/v/a.md", to: "archive/a.md" })).toBe("Move a.md → archive/a.md");
      expect(describeAction({ action: "git_commit", project_path: "/work/app/", message: "feat: x\n\nbody" })).toBe(
        "Commit in app: feat: x"
      );
      expect(describeAction({ action: "create_task", title: "Ship", project_id: "AETHER" })).toBe('Create task "Ship" in AETHER');
      expect(describeAction({ action: "toggle_vault_task", note_path: "/v/Todo.md", line: 3 })).toBe(
        "Toggle task on line 3 of Todo.md"
      );
      expect(describeAction({ action: "run_command", command: "x".repeat(200) }).length).toBeLessThan(110);
    });

    it("labels them for chips without emoji", () => {
      expect(actionLabel({ action: "delete_note", path: "/v/Old.md" })).toBe("Trashed Old.md");
      expect(actionLabel({ action: "git_commit", project_path: "/w/app", message: "m" })).toBe("Committed in app");
      expect(actionLabel({ action: "delete_calendar_event", id: "e1" })).toBe("Deleted event");
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
