/**
 * Markdown checkbox toggling, ported from `toggle_task_line` in
 * `src-tauri/src/engine/intel/approvals.rs` (used by the mock backend).
 * Only the state character of the one line changes; line endings are kept.
 *
 * The `vaulttasks` feature has its own, richer task engine. The agent's
 * `toggle_vault_task` deliberately does not depend on it (see
 * docs/features/intel.md), hence this minimal duplicate.
 */

/** A parsed task line: offset of the state character, state and text. */
export interface TaskLine {
  offset: number;
  checked: boolean;
  text: string;
}

const TASK = /^(\s*)(?:[-*+]|\d{1,3}[.)])( +)\[([ xX])\](.*)$/;

/** Parse one line (without its line ending). */
export function parseTaskLine(line: string): TaskLine | null {
  const m = TASK.exec(line);
  if (!m) return null;
  const markerEnd = line.indexOf("[", m[1].length);
  return { offset: markerEnd + 1, checked: m[3] !== " ", text: m[4].trim() };
}

/** Flip the checkbox on `line` (1-based). Throws on invalid lines. */
export function toggleTaskLine(content: string, line: number): { content: string; checked: boolean; text: string } {
  const lines = content.split(/(?<=\n)/);
  const index = line - 1;
  if (!Number.isInteger(line) || index < 0 || index >= lines.length) {
    throw new Error(`invalid input: line ${line} does not exist (the note has ${lines.length} lines)`);
  }
  const raw = lines[index];
  const body = raw.replace(/[\r\n]+$/, "");
  const parsed = parseTaskLine(body);
  if (!parsed) throw new Error(`invalid input: line ${line} is not a Markdown task: ${body.trim().slice(0, 80)}`);
  lines[index] = raw.slice(0, parsed.offset) + (parsed.checked ? " " : "x") + raw.slice(parsed.offset + 1);
  return { content: lines.join(""), checked: !parsed.checked, text: parsed.text };
}
