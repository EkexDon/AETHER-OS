import { beforeEach, describe, expect, it } from "vitest";
import type { VaultTaskItem, VaultTaskStats } from "../../types";
import { todayIso } from "../vaulttasks/dates";
import { mockInvoke, resetMockState, setMockLatency } from "./backend";
import { MOCK_VAULT_ROOT } from "./fixtures/vault";
import { mockVault } from "./vaultStore";

const INBOX = `${MOCK_VAULT_ROOT}/00-Inbox/Quick Capture.md`;
const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

async function inboxTask(text: string): Promise<VaultTaskItem> {
  const tasks = await invoke<VaultTaskItem[]>("cmd_vault_tasks_list", { filter: { note_path: INBOX } });
  const task = tasks.find((t) => t.text_raw.startsWith(text));
  if (!task) throw new Error(`fixture task "${text}" missing`);
  return task;
}

describe("vault tasks mock", () => {
  it("lists tasks parsed from the mock vault and filters them", async () => {
    const all = await invoke<VaultTaskItem[]>("cmd_vault_tasks_list");
    expect(all.length).toBeGreaterThan(30);
    expect(all.every((t) => t.note_path.startsWith(MOCK_VAULT_ROOT))).toBe(true);
    const open = await invoke<VaultTaskItem[]>("cmd_vault_tasks_list", { filter: { status: "open", tag: "umzug" } });
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((t) => !t.checked && t.tags.includes("umzug"))).toBe(true);
    expect(await invoke<VaultTaskItem[]>("cmd_vault_tasks_rescan")).toHaveLength(all.length);
  });

  it("toggles a task in the note (emoji style gets a done date)", async () => {
    const task = await inboxTask("Look into SQLite FTS5");
    const done = await invoke<VaultTaskItem>("cmd_vault_tasks_toggle", {
      notePath: task.note_path,
      line: task.line,
      checked: true,
      expectedText: task.text_raw,
    });
    expect(done.checked).toBe(true);
    expect(done.done_date).toBe(todayIso());
    const line = mockVault.read(INBOX).split("\n")[task.line];
    expect(line).toBe(`- [x] ${task.text_raw} ✅ ${todayIso()}`);

    // The old text is now stale.
    await expect(
      invoke("cmd_vault_tasks_toggle", { notePath: task.note_path, line: task.line, checked: false, expectedText: task.text_raw })
    ).rejects.toMatch(/note changed, rescan/);
  });

  it("sets status, due date and priority", async () => {
    const task = await inboxTask("Reply to Jonas");
    const ref = { notePath: task.note_path, line: task.line };
    const progress = await invoke<VaultTaskItem>("cmd_vault_tasks_set_status", { ...ref, status: "in_progress", expectedText: task.text_raw });
    expect(progress.status_char).toBe("/");
    const dated = await invoke<VaultTaskItem>("cmd_vault_tasks_set_due", { ...ref, due: "2026-10-01", expectedText: progress.text_raw });
    expect(dated.due).toBe("2026-10-01");
    const urgent = await invoke<VaultTaskItem>("cmd_vault_tasks_set_priority", { ...ref, priority: "urgent", expectedText: dated.text_raw });
    expect(urgent.text_raw).toBe("Reply to Jonas about the home lab rack #homelab 🔺 📅 2026-10-01");

    await expect(invoke("cmd_vault_tasks_set_due", { ...ref, due: "01.10.2026", expectedText: urgent.text_raw })).rejects.toMatch(
      /invalid date/
    );
    await expect(invoke("cmd_vault_tasks_set_status", { ...ref, status: "blocked", expectedText: urgent.text_raw })).rejects.toMatch(
      /unknown variant/
    );
  });

  it("appends to the daily note and reports stats", async () => {
    const daily = await invoke<string>("cmd_daily_note");
    const added = await invoke<VaultTaskItem>("cmd_vault_tasks_append", { notePath: daily, text: "Water the plants 📅 " + todayIso() });
    expect(added.due).toBe(todayIso());
    expect(mockVault.read(daily)).toContain("- [ ] Water the plants");
    const stats = await invoke<VaultTaskStats>("cmd_vault_tasks_stats");
    expect(stats.due_today).toBeGreaterThanOrEqual(3);
    expect(stats.overdue).toBeGreaterThan(0);
    await expect(invoke("cmd_vault_tasks_append", { notePath: daily, text: "  " })).rejects.toMatch(/task text is required/);
  });

  it("rejects notes outside the vault", async () => {
    await expect(
      invoke("cmd_vault_tasks_append", { notePath: "/etc/passwd.md", text: "x" })
    ).rejects.toMatch(/outside the vault/);
    await expect(
      invoke("cmd_vault_tasks_append", { notePath: `${MOCK_VAULT_ROOT}/../evil.md`, text: "x" })
    ).rejects.toMatch(/outside the vault/);
    await expect(
      invoke("cmd_vault_tasks_append", { notePath: `${MOCK_VAULT_ROOT}/missing.md`, text: "x" })
    ).rejects.toMatch(/note not found/);
  });
});
