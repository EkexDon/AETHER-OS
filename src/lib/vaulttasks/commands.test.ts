import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/registry";
import { useVaultTasksStore } from "../vaultTasksStore";
import { vaultTasksCommands } from "./commands";

const command = (id: string) => {
  const c = vaultTasksCommands.find((x) => x.id === id);
  if (!c) throw new Error(`missing command ${id}`);
  return c;
};

function ctx(view = "dashboard"): CommandContext {
  return {
    view,
    setView: vi.fn(),
    closeCommandBar: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
  } as unknown as CommandContext;
}

beforeEach(() => {
  useVaultTasksStore.setState({ quickAddOpen: false, quickAddHosts: 0, quickAddFocusToken: 0, mode: "list" });
});

describe("vaultTasksCommands", () => {
  it("uses unique ids and the assigned shortcuts", () => {
    const ids = vaultTasksCommands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(command("vaulttasks.addToDaily").shortcut).toBe("mod+shift+t");
    expect(command("vaulttasks.rescan").shortcut).toBe("mod+alt+r");
  });

  it("opens the quick-add dialog when a host is mounted", async () => {
    useVaultTasksStore.setState({ quickAddHosts: 1 });
    const c = ctx();
    await command("vaulttasks.addToDaily").run(c);
    expect(useVaultTasksStore.getState().quickAddOpen).toBe(true);
    expect(c.setView).not.toHaveBeenCalled();
  });

  it("falls back to the view's inline field without a host", async () => {
    const c = ctx();
    await command("vaulttasks.addToDaily").run(c);
    expect(c.setView).toHaveBeenCalledWith("vaulttasks");
    expect(useVaultTasksStore.getState().quickAddFocusToken).toBe(1);
  });

  it("scopes in-view shortcuts to Note Tasks", () => {
    const board = command("vaulttasks.mode.board");
    expect(board.when?.(ctx("dashboard"))).toBe(false);
    expect(board.when?.(ctx("vaulttasks"))).toBe(true);
    void board.run(ctx("vaulttasks"));
    expect(useVaultTasksStore.getState().mode).toBe("board");
  });

  it("applies due presets", async () => {
    const c = ctx();
    await command("vaulttasks.overdue").run(c);
    expect(useVaultTasksStore.getState().due).toBe("overdue");
    expect(c.setView).toHaveBeenCalledWith("vaulttasks");
  });
});
