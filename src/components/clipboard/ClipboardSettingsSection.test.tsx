import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../../lib/ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc/core")>();
  const mock = await import("../../lib/mock/backend");
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import type { ClipboardSettings, ClipboardStats } from "../../types";
import { resetClipboardStore } from "../../lib/clipboardStore";
import { useToastStore } from "../../ui/Toast";
import { ClipboardSettingsSection, keepDayOptions } from "./ClipboardSettingsSection";
import { ClipboardStatusItem } from "./ClipboardStatusItem";

const settings = () => mockInvoke<ClipboardSettings>("cmd_clipboard_get_settings");

beforeEach(async () => {
  setMockLatency(0);
  resetMockState();
  await resetClipboardStore();
  useToastStore.getState().clear();
});

describe("ClipboardSettingsSection", () => {
  it("saves switches and retention", async () => {
    render(<ClipboardSettingsSection />);
    const images = await screen.findByRole("switch", { name: "Capture images" });
    fireEvent.click(images);
    await waitFor(async () => expect((await settings()).capture_images).toBe(false));

    fireEvent.change(screen.getByLabelText("Keep clips for"), { target: { value: "0" } });
    await waitFor(async () => expect((await settings()).keep_days).toBe(0));

    const max = screen.getByLabelText("Maximum clips");
    fireEvent.change(max, { target: { value: "5" } });
    expect(max).toHaveAttribute("aria-invalid", "true");
    fireEvent.blur(max);
    expect((await settings()).max_items).toBe(500);
    fireEvent.change(max, { target: { value: "20" } });
    fireEvent.keyDown(max, { key: "Enter" });
    await waitFor(async () => expect((await settings()).max_items).toBe(20));

    fireEvent.click(screen.getByRole("switch", { name: "Record clipboard history" }));
    await waitFor(async () => expect((await settings()).enabled).toBe(false));
    expect(screen.getByRole("switch", { name: "Capture images" })).toBeDisabled();
  });

  it("clears the history after confirmation", async () => {
    render(<ClipboardSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear history…" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear clipboard history?" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Keep pinned clips/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));
    await waitFor(async () => expect((await mockInvoke<ClipboardStats>("cmd_clipboard_stats")).total).toBe(0));
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Removed 40 clips");
  });

  it("keeps custom retention values selectable", () => {
    const values = keepDayOptions(45).map((o) => o.value);
    expect(values).toContain("45");
    expect(values.at(-1)).toBe("0");
    expect(keepDayOptions(30).filter((o) => o.value === "30")).toHaveLength(1);
  });
});

describe("ClipboardStatusItem", () => {
  it("shows the count and the paused state", async () => {
    render(<ClipboardStatusItem />);
    expect(await screen.findByRole("button", { name: "Clipboard history: 40" })).toBeInTheDocument();
    await mockInvoke("cmd_clipboard_set_paused", { paused: true });
    expect(await screen.findByRole("button", { name: "Clipboard history: Paused" })).toBeInTheDocument();
  });
});
