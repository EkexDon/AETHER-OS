import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SyncSettings, SyncStatus } from "../../types";

const unlockSync = vi.fn();
vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    unlockSync: (...args: unknown[]) => unlockSync(...args),
    getSyncSettings: vi.fn(async () => settings),
    inspectSyncFolder: vi.fn(async (path: string) => ({ path, initialized: false, device_count: 0, created_at: null, created_by: null })),
    listSyncConflicts: vi.fn(async () => []),
    listSyncDevices: vi.fn(async () => []),
  };
});

import { resetSyncStore, useSyncStore } from "../../lib/syncStore";
import { useToastStore } from "../../ui/Toast";
import { UnlockModal } from "./UnlockModal";

const settings: SyncSettings = {
  enabled: false,
  sync_dir: null,
  device_id: "d",
  device_name: "Mac",
  include_app_data: true,
  interval_seconds: 60,
  remember_key: false,
  backup_dir: null,
  backup_every_hours: 0,
  backup_keep: 7,
  backup_include_app_data: true,
};

const status = (patch: Partial<SyncStatus>): SyncStatus => ({
  state: "idle",
  enabled: false,
  configured: false,
  unlocked: false,
  initialized: false,
  remembered: false,
  last_sync_at: null,
  pending_uploads: 0,
  pending_downloads: 0,
  conflicts: 0,
  message: null,
  device_id: "d",
  device_name: "Mac",
  last_backup_at: null,
  next_backup_at: null,
  progress: null,
  ...patch,
});

beforeEach(() => {
  resetSyncStore();
  unlockSync.mockReset();
  useToastStore.getState().clear();
});

describe("UnlockModal", () => {
  it("asks for a strong passphrase twice when no key exists yet", async () => {
    useSyncStore.setState({ status: status({}), settings, unlockOpen: true });
    unlockSync.mockResolvedValue(status({ unlocked: true, initialized: true }));
    render(<UnlockModal />);
    const dialog = await screen.findByRole("dialog", { name: "Set a sync passphrase" });
    const submit = within(dialog).getByRole("button", { name: "Set passphrase" });
    const first = within(dialog).getByLabelText("Passphrase");
    const second = within(dialog).getByLabelText("Repeat passphrase");

    fireEvent.change(first, { target: { value: "password1" } });
    expect(within(dialog).getByRole("meter", { name: "Passphrase strength" })).toHaveAttribute("aria-valuenow", "0");
    fireEvent.change(second, { target: { value: "password1" } });
    expect(submit).toBeDisabled();

    fireEvent.change(first, { target: { value: "orbit maple lantern quiet" } });
    fireEvent.change(second, { target: { value: "orbit maple lantern" } });
    expect(within(dialog).getByText("The passphrases do not match.")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.change(second, { target: { value: "orbit maple lantern quiet" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(unlockSync).toHaveBeenCalledWith("orbit maple lantern quiet", false));
    await waitFor(() => expect(useSyncStore.getState().unlockOpen).toBe(false));
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Passphrase set");
  });

  it("warns when the key is remembered and passes the choice on", async () => {
    useSyncStore.setState({ status: status({ initialized: true }), settings, unlockOpen: true });
    unlockSync.mockResolvedValue(status({ unlocked: true, initialized: true, remembered: true }));
    render(<UnlockModal />);
    const dialog = await screen.findByRole("dialog", { name: "Unlock sync" });
    expect(within(dialog).queryByLabelText("Repeat passphrase")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Remember on this device/ }));
    expect(within(dialog).getByRole("note")).toHaveTextContent(/Less secure/);
    fireEvent.change(within(dialog).getByLabelText("Passphrase"), { target: { value: "any passphrase" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(unlockSync).toHaveBeenCalledWith("any passphrase", true));
  });

  it("shows backend errors inline and keeps the dialog open", async () => {
    useSyncStore.setState({ status: status({ initialized: true }), settings, unlockOpen: true });
    unlockSync.mockRejectedValue(new Error("crypto error: wrong passphrase"));
    render(<UnlockModal />);
    const dialog = await screen.findByRole("dialog", { name: "Unlock sync" });
    fireEvent.change(within(dialog).getByLabelText("Passphrase"), { target: { value: "nope nope" } });
    fireEvent.keyDown(within(dialog).getByLabelText("Passphrase"), { key: "Enter" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Wrong passphrase");
    expect(useSyncStore.getState().unlockOpen).toBe(true);
  });

  it("clears the typed passphrase when closed", async () => {
    useSyncStore.setState({ status: status({ initialized: true }), settings, unlockOpen: true });
    const { rerender } = render(<UnlockModal />);
    const dialog = await screen.findByRole("dialog", { name: "Unlock sync" });
    fireEvent.change(within(dialog).getByLabelText("Passphrase"), { target: { value: "secret words" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    useSyncStore.setState({ unlockOpen: true });
    rerender(<UnlockModal />);
    const again = await screen.findByRole("dialog", { name: "Unlock sync" });
    expect(within(again).getByLabelText("Passphrase")).toHaveValue("");
    expect(useSyncStore.getState().prompted).toBe(true);
  });
});
