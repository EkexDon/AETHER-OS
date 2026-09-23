import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// Route the typed IPC wrappers to the DEV mock backend.
vi.mock("../../lib/ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc/core")>();
  const mock = await import("../../lib/mock/backend");
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../lib/sync/pickFolder", () => ({
  pickFolder: vi.fn(async (purpose: string) =>
    purpose === "backup" ? "/Users/demo/Backups/AETHER" : "/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/AETHER Sync"
  ),
  pickBackupFile: vi.fn(async () => null),
}));

import { mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import { setSyncMockDelayScale } from "../../lib/mock/sync";
import { resetSyncStore, useSyncStore } from "../../lib/syncStore";
import { useToastStore } from "../../ui/Toast";
import { SyncView } from "./SyncView";
import { SyncStatusItem } from "./SyncStatusItem";

const lastToast = () => useToastStore.getState().toasts.at(-1);

beforeEach(() => {
  setMockLatency(0);
  setSyncMockDelayScale(0);
  resetMockState();
  resetSyncStore();
  useToastStore.getState().clear();
});

async function renderView() {
  const utils = render(
    <>
      <SyncView />
      <SyncStatusItem />
    </>
  );
  await screen.findByRole("heading", { name: "1 conflict" });
  return utils;
}

describe("SyncView", () => {
  it("shows status, devices, the open conflict and the backups", async () => {
    await renderView();
    expect(screen.getByText("AETHER Sync")).toBeInTheDocument();
    const devices = await screen.findByRole("list", { name: "Devices" });
    expect(within(devices).getByText("Demo MacBook")).toBeInTheDocument();
    expect(within(devices).getByText("Studio iMac")).toBeInTheDocument();
    const conflicts = screen.getByRole("list", { name: "Open conflicts" });
    expect(within(conflicts).getByText("01-Projects/Local-first Sync.md")).toBeInTheDocument();
    const backups = await screen.findByRole("list", { name: "Backups" });
    expect(within(backups).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Sync & Backup: 1 conflict" })).toBeInTheDocument();
  });

  it("compares a conflict side by side and resolves it", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    const dialog = await screen.findByRole("dialog");
    const table = await within(dialog).findByRole("table", { name: "Side-by-side comparison" });
    expect(within(table).getByText("## Decisions")).toBeInTheDocument();
    expect(within(table).getByText("## Open questions (edited on the train)")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the note" }));
    await waitFor(() => expect(lastToast()?.title).toBe("Conflict resolved"));
    await screen.findByText("No conflicts");
    await screen.findByRole("heading", { name: "Up to date" });
    expect(screen.getByRole("button", { name: "Sync & Backup: Synced" })).toBeInTheDocument();
  });

  it("syncs now and reports the round", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(lastToast()?.title).toBe("Sync finished"));
    expect(lastToast()?.description).toBe("1 upload · 2 downloads");
    expect(await screen.findByText(/Last round: 1 upload · 2 downloads/)).toBeInTheDocument();
  });

  it("locks and unlocks through the passphrase dialog", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Lock sync" }));
    await screen.findByRole("heading", { name: "Locked" });
    expect(await screen.findByText("Unlock sync to see conflicts.")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Unlock" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Unlock sync" });
    const field = within(dialog).getByLabelText("Passphrase");
    fireEvent.change(field, { target: { value: "this is wrong" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlock" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Wrong passphrase");

    fireEvent.change(field, { target: { value: "correct horse battery" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unlock sync" })).not.toBeInTheDocument());
    await screen.findByRole("heading", { name: "1 conflict" });
    expect(lastToast()?.title).toBe("Sync unlocked");
  });

  it("creates a backup into the chosen folder", async () => {
    await renderView();
    await screen.findByRole("list", { name: "Backups" });
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(lastToast()?.title).toBe("Backup created"));
    const backups = screen.getByRole("list", { name: "Backups" });
    await waitFor(() => expect(within(backups).getAllByRole("listitem")).toHaveLength(5));
  });

  it("verifies a backup with its passphrase", async () => {
    await renderView();
    const backups = await screen.findByRole("list", { name: "Backups" });
    fireEvent.click(within(backups).getAllByRole("button", { name: "Verify backup" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Verify backup" });
    fireEvent.change(within(dialog).getByLabelText("Backup passphrase"), { target: { value: "correct horse battery" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Verify" }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(/decrypt and match their checksums/);
  });

  it("restores a backup with preview and mode", async () => {
    await renderView();
    const backups = await screen.findByRole("list", { name: "Backups" });
    fireEvent.click(within(backups).getAllByRole("button", { name: "Restore backup" })[1]);
    const dialog = await screen.findByRole("dialog", { name: "Restore backup" });
    fireEvent.change(within(dialog).getByLabelText("Backup passphrase"), { target: { value: "wrong wrong" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Show contents" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Wrong passphrase for this backup/);

    fireEvent.change(within(dialog).getByLabelText("Backup passphrase"), { target: { value: "correct horse battery" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Show contents" }));
    const files = await within(dialog).findByRole("list", { name: "Files in the backup" });
    expect(within(files).getAllByRole("listitem").length).toBeGreaterThan(5);
    fireEvent.change(within(dialog).getByLabelText("Filter files"), { target: { value: "Roadmap" } });
    expect(within(files).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose where to restore" }));
    const target = within(dialog).getByLabelText("Restore vault files to");
    fireEvent.change(target, { target: { value: "/Users/demo/Documents/Restored Vault" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Replace" }));
    expect(within(dialog).getByRole("note")).toHaveTextContent(/pre-restore/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace and restore" }));
    await waitFor(() => expect(lastToast()?.title).toBe("Backup restored"));
    expect(within(dialog).getByText("Written")).toBeInTheDocument();
  });

  it("walks through the setup wizard and joins an existing folder", async () => {
    await mockInvoke("cmd_sync_set_settings", { patch: { enabled: false, sync_dir: "" } });
    render(
      <>
        <SyncView />
        <SyncStatusItem />
      </>
    );
    await screen.findByRole("heading", { name: "Not set up" });
    fireEvent.click(screen.getAllByRole("button", { name: "Set up sync" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Set up encrypted sync" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Sync folder")).toHaveValue(
        "/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/AETHER Sync"
      )
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(await within(dialog).findByText(/already holds an encrypted AETHER store/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.change(within(dialog).getByLabelText("Passphrase"), { target: { value: "correct horse battery" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Join and sync" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Set up encrypted sync" })).not.toBeInTheDocument());
    await screen.findByRole("heading", { name: "1 conflict" });
    await waitFor(() => expect(useSyncStore.getState().settings?.enabled).toBe(true));
  });
});

describe("SyncStatusItem start-up prompt", () => {
  it("asks for the passphrase once when sync is on but locked", async () => {
    await mockInvoke("cmd_sync_lock", {});
    render(<SyncStatusItem />);
    expect(await screen.findByRole("dialog", { name: "Unlock sync" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync & Backup: Locked" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Not asked again in the same session.
    await act(async () => {
      await useSyncStore.getState().refresh();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
