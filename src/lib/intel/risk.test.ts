import { describe, expect, it } from "vitest";
import agentActionsRs from "../../../src-tauri/src/engine/agent_actions.rs?raw";
import type { AgentAction } from "../../types";
import { ACTION_RISKS, actionRisk, allowToggleLabel, describeRule, needsApproval, normalizeScope, ruleMatches, ruleScope, type AllowRule } from "./risk";

const run = (cwd?: string | null): AgentAction => ({ action: "run_command", command: "npm test", cwd });

function rule(kind: AllowRule["kind"], scope: string | null): AllowRule {
  return { id: "r", kind, scope, risk: kind === "run_command" ? "dangerous" : "confirm", createdAt: 0 };
}

describe("actionRisk", () => {
  it("keeps the v0.1 actions auto-executing", () => {
    const safe: AgentAction[] = [
      { action: "create_note", title: "t", content: "" },
      { action: "append_note", path: "a.md", content: "x" },
      { action: "append_daily", content: "x" },
      { action: "open_url", url: "https://x" },
      { action: "clip_url", url: "https://x" },
      { action: "add_memory_fact", fact: "f", category: "general" },
      { action: "save_aether_note", title: "t", content: "c" },
      { action: "list_calendar_events", from: null, to: null },
      { action: "create_task", title: "t" },
    ];
    for (const a of safe) {
      expect(actionRisk(a), a.action).toBe("safe");
      expect(needsApproval(a)).toBe(false);
    }
  });

  it("gates changes behind confirm and code / deletion behind dangerous", () => {
    expect(actionRisk({ action: "move_note", from: "a", to: "b" })).toBe("confirm");
    expect(actionRisk({ action: "git_commit", project_path: "/p", message: "m" })).toBe("confirm");
    expect(actionRisk({ action: "toggle_vault_task", note_path: "n.md", line: 2 })).toBe("confirm");
    expect(actionRisk({ action: "import_calendar_ics", path: "/x.ics", overwrite_existing: false, default_color: null })).toBe(
      "confirm"
    );
    expect(actionRisk(run())).toBe("dangerous");
    expect(actionRisk({ action: "delete_note", path: "x.md" })).toBe("dangerous");
    expect(actionRisk({ action: "delete_calendar_event", id: "e" })).toBe("dangerous");
    expect(needsApproval(run())).toBe(true);
  });

  it("treats unknown kinds from newer prompts as dangerous", () => {
    expect(actionRisk({ action: "format_disk" } as unknown as AgentAction)).toBe("dangerous");
    for (const sneaky of ["__proto__", "constructor", "toString", "hasOwnProperty", ""]) {
      expect(actionRisk({ action: sneaky } as unknown as AgentAction), sneaky).toBe("dangerous");
    }
    expect(actionRisk({} as unknown as AgentAction)).toBe("dangerous");
    expect(actionRisk({ action: 42 } as unknown as AgentAction)).toBe("dangerous");
  });

  it("classifies every Rust action kind exactly like action_risk in agent_actions.rs", () => {
    const source = agentActionsRs;
    const kindBody = /pub fn action_kind\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const kinds = new Map([...kindBody.matchAll(/AgentAction::(\w+)\s*\{[^}]*\}\s*=>\s*"(\w+)"/g)].map((m) => [m[1], m[2]]));
    const riskBody = /pub fn action_risk\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const rust: Record<string, string> = {};
    const arms = [...riskBody.matchAll(/((?:\|?\s*AgentAction::\w+\s*\{\s*\.\.\s*\}\s*)+)=>\s*ActionRisk::(\w+)/g)];
    for (const [, variants, risk] of arms) {
      for (const [, variant] of variants.matchAll(/AgentAction::(\w+)/g)) {
        const kind = kinds.get(variant);
        expect(kind, `action_kind has no arm for ${variant}`).toBeDefined();
        rust[kind!] = risk.toLowerCase();
      }
    }
    expect(Object.keys(rust).length, "could not parse action_risk").toBeGreaterThan(10);
    expect(Object.keys(rust).length).toBe(kinds.size);
    expect({ ...ACTION_RISKS }).toEqual(rust);
  });
});

describe("allow rules", () => {
  it("normalises scopes", () => {
    expect(normalizeScope(null)).toBe("");
    expect(normalizeScope("  ")).toBe("");
    expect(normalizeScope("/a//b/./c/")).toBe("/a/b/c");
    expect(normalizeScope("daily/")).toBe("daily");
    expect(ruleScope(run("/work/app/"))).toBe("/work/app");
    expect(ruleScope({ action: "git_commit", project_path: "/p", message: "m" })).toBeNull();
  });

  it("scopes command rules to their directory tree", () => {
    const r = rule("run_command", "/work/app");
    expect(ruleMatches(r, run("/work/app"))).toBe(true);
    expect(ruleMatches(r, run("/work/app/src"))).toBe(true);
    expect(ruleMatches(r, run("/work/application"))).toBe(false);
    expect(ruleMatches(r, run(null))).toBe(false);
    expect(ruleMatches(r, { action: "delete_note", path: "/work/app/x.md" })).toBe(false);
  });

  it("matches the vault default only for commands without a cwd", () => {
    const r = rule("run_command", "");
    expect(ruleMatches(r, run(null))).toBe(true);
    expect(ruleMatches(r, run(""))).toBe(true);
    expect(ruleMatches(r, run("/work/app"))).toBe(false);
  });

  it("covers every action of a non-command kind", () => {
    const r = rule("git_commit", null);
    expect(ruleMatches(r, { action: "git_commit", project_path: "/any", message: "m" })).toBe(true);
  });

  it("describes rules and the approval switch", () => {
    expect(describeRule(rule("run_command", "/work/app"))).toBe("Shell commands in /work/app");
    expect(describeRule(rule("run_command", ""))).toBe("Shell commands in the vault");
    expect(describeRule(rule("move_note", null))).toBe("All “move note” actions");
    expect(allowToggleLabel(run("/w"))).toContain("until AETHER restarts");
    expect(allowToggleLabel({ action: "move_note", from: "a", to: "b" })).toContain("remembered on this device");
  });
});
