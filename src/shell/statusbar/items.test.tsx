import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ indexVault: vi.fn() }));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  ...ipc,
}));

import { IndexingStatusItem, vaultName } from "./items";
import { LAST_INDEX_KEY, useHomeStore } from "../../lib/homeStore";
import { useAetherStore } from "../../lib/store";
import { useToastStore } from "../../ui/Toast";

beforeEach(() => {
  ipc.indexVault.mockReset().mockResolvedValue({ total: 5, indexed: 4, skipped: 1 });
  window.localStorage.removeItem(LAST_INDEX_KEY);
  useHomeStore.setState({ lastIndex: null });
  useAetherStore.setState({ vaultPath: "/vault", indexing: false });
  useToastStore.getState().clear();
});

describe("IndexingStatusItem", () => {
  it("indexes through Home's runIndex so both record the same last run", async () => {
    render(<IndexingStatusItem />);
    fireEvent.click(screen.getByRole("button", { name: /Index/ }));
    await waitFor(() => expect(useHomeStore.getState().lastIndex?.result).toEqual({ total: 5, indexed: 4, skipped: 1 }));
    expect(ipc.indexVault).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem(LAST_INDEX_KEY) ?? "{}")).toMatchObject({ result: { indexed: 4 } });
    expect(useToastStore.getState().toasts.some((t) => t.title === "Vault indexed")).toBe(true);
    expect(useAetherStore.getState().indexing).toBe(false);
  });

  it("ignores clicks while indexing and hides without a vault", () => {
    useAetherStore.setState({ indexing: true });
    const { rerender } = render(<IndexingStatusItem />);
    fireEvent.click(screen.getByRole("button", { name: /Indexing/ }));
    expect(ipc.indexVault).not.toHaveBeenCalled();
    useAetherStore.setState({ vaultPath: null, indexing: false });
    rerender(<IndexingStatusItem />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(vaultName("/Users/me/Vault")).toBe("Vault");
  });
});
