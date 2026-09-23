import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/core")>();
  const mock = await import("../mock/backend");
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockInvoke, resetMockState, setMockLatency } from "../mock/backend";
import type { CommandContext } from "../commands/registry";
import { resetClipboardStore, useClipboardStore } from "../clipboardStore";
import { clipboardCommands } from "./commands";

function context(view: CommandContext["view"] = "dashboard") {
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
  const ctx = { view, setView: vi.fn(), openSettings: vi.fn(), toast } as unknown as CommandContext;
  return { ctx, toast };
}

const command = (id: string) => {
  const found = clipboardCommands.find((c) => c.id === id);
  if (!found) throw new Error(`missing command ${id}`);
  return found;
};

beforeEach(async () => {
  setMockLatency(0);
  resetMockState();
  await resetClipboardStore();
});

describe("clipboard commands", () => {
  it("opens the history with mod+shift+v and focuses search", async () => {
    const open = command("clipboard.open");
    expect(open.shortcut).toBe("mod+shift+v");
    const { ctx } = context();
    await open.run(ctx);
    expect(ctx.setView).toHaveBeenCalledWith("clipboard");
    expect(useClipboardStore.getState().focusSearchToken).toBe(1);
  });

  it("pastes the last clip into a note via the clipboard", async () => {
    const { ctx, toast } = context("dashboard");
    await command("clipboard.pasteLast").run(ctx);
    expect(toast.success).toHaveBeenCalledWith("Latest clip is ready to paste", expect.objectContaining({ action: expect.any(Object) }));
    await mockInvoke("cmd_clipboard_clear", { keepPinned: false });
    await command("clipboard.pasteLast").run(ctx);
    expect(toast.info).toHaveBeenCalledWith("Clipboard history is empty", expect.any(Object));
  });

  it("toggles pause and requests the clear confirmation", async () => {
    const { ctx } = context();
    await command("clipboard.togglePause").run(ctx);
    expect(useClipboardStore.getState().stats?.paused).toBe(true);
    await command("clipboard.clear").run(ctx);
    expect(ctx.setView).toHaveBeenCalledWith("clipboard");
    expect(useClipboardStore.getState().clearRequested).toBe(true);
  });

  it("scopes the selection commands to the history view", async () => {
    const pin = command("clipboard.pinSelected");
    expect(pin.when?.(context("dashboard").ctx)).toBe(false);
    expect(pin.when?.(context("clipboard").ctx)).toBe(false);
    await useClipboardStore.getState().refresh();
    const { ctx } = context("clipboard");
    expect(pin.when?.(ctx)).toBe(true);
    const selected = useClipboardStore.getState().selectedId!;
    const before = useClipboardStore.getState().items[0].pinned;
    await pin.run(ctx);
    expect(useClipboardStore.getState().items.find((i) => i.id === selected)?.pinned).toBe(!before);
    expect(command("clipboard.search").when?.(ctx)).toBe(true);
  });
});
