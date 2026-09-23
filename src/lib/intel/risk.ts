/**
 * Approval policy for agent actions. `actionRisk` mirrors `action_risk` in
 * `src-tauri/src/engine/agent_actions.rs` — keep both in lockstep.
 *
 * - `safe`: additive or read-only, runs automatically (as in v0.1).
 * - `confirm`: changes or reorganises existing data, needs one approval.
 * - `dangerous`: executes code or removes data, needs an explicit approval;
 *   "always allow" rules for it only last until the app restarts.
 */
import type { ActionRisk, AgentAction, AgentActionKind } from "../../types";

/**
 * Risk class of every action kind the agent may emit. A parity test
 * (`risk.test.ts`) parses `action_risk` in Rust and fails when a kind is
 * missing here or classified differently.
 */
export const ACTION_RISKS: Readonly<Record<AgentActionKind, ActionRisk>> = {
  create_note: "safe",
  append_note: "safe",
  append_daily: "safe",
  open_url: "safe",
  clip_url: "safe",
  add_memory_fact: "safe",
  save_aether_note: "safe",
  create_calendar_event: "safe",
  list_calendar_events: "safe",
  create_task: "safe",
  update_calendar_event: "confirm",
  import_calendar_ics: "confirm",
  move_note: "confirm",
  git_commit: "confirm",
  toggle_vault_task: "confirm",
  delete_calendar_event: "dangerous",
  delete_note: "dangerous",
  run_command: "dangerous",
};

/**
 * Risk of an action; unknown kinds (from a newer model prompt, a typo, or
 * `__proto__`-style keys) are treated as dangerous.
 */
export function actionRisk(action: AgentAction): ActionRisk {
  const kind = (action as { action?: unknown } | null)?.action;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(ACTION_RISKS, kind)) return "dangerous";
  return ACTION_RISKS[kind as AgentActionKind];
}

/** True when the action must not run without the user's approval. */
export function needsApproval(action: AgentAction): boolean {
  return actionRisk(action) !== "safe";
}

/** An "always allow" rule. `scope` narrows `run_command` to a directory. */
export interface AllowRule {
  id: string;
  kind: AgentActionKind;
  /** `run_command`: normalised cwd ("" = the vault default); otherwise null. */
  scope: string | null;
  risk: ActionRisk;
  /** Epoch ms. */
  createdAt: number;
}

/** Collapse duplicate/trailing slashes, `.` segments; keeps relative paths relative. */
export function normalizeScope(path: string | null | undefined): string {
  const raw = (path ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  const absolute = raw.startsWith("/");
  const parts = raw.split("/").filter((p) => p && p !== ".");
  return (absolute ? "/" : "") + parts.join("/");
}

/** The scope a new rule for `action` would get. */
export function ruleScope(action: AgentAction): string | null {
  return action.action === "run_command" ? normalizeScope(action.cwd) : null;
}

/** Does `rule` cover `action`? Command rules cover their directory and
 *  everything below it (absolute scopes) or exactly their relative scope. */
export function ruleMatches(rule: AllowRule, action: AgentAction): boolean {
  if (rule.kind !== action.action) return false;
  if (action.action !== "run_command") return true;
  const scope = rule.scope ?? "";
  const cwd = normalizeScope(action.cwd);
  if (scope === "" || !scope.startsWith("/")) return cwd === scope;
  return cwd === scope || cwd.startsWith(scope === "/" ? "/" : `${scope}/`);
}

/** Human-readable rule, e.g. `Commands in ~/Developer/app`. */
export function describeRule(rule: Pick<AllowRule, "kind" | "scope">): string {
  if (rule.kind === "run_command") {
    const scope = rule.scope ?? "";
    return scope ? `Shell commands in ${scope}` : "Shell commands in the vault";
  }
  return `All “${rule.kind.replace(/_/g, " ")}” actions`;
}

/** Label of the "always allow" switch for an action. */
export function allowToggleLabel(action: AgentAction): string {
  const rule = describeRule({ kind: action.action, scope: ruleScope(action) });
  return actionRisk(action) === "dangerous"
    ? `Always allow: ${rule} (until AETHER restarts)`
    : `Always allow: ${rule} (remembered on this device)`;
}
