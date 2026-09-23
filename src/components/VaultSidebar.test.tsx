import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  agentOpenUrl: vi.fn(),
}));

import { SIDEBAR_PINS_COLLAPSED_KEY, VaultSidebar } from "./VaultSidebar";
import { usePinsStore } from "../lib/pinsStore";
import { useAetherStore } from "../lib/store";

const NOTE = { path: "/vault/Projects/Alpha.md", name: "Alpha", mtime: 1 };

beforeEach(() => {
  window.localStorage.removeItem(SIDEBAR_PINS_COLLAPSED_KEY);
  useAetherStore.setState({ vaultNotes: [NOTE], vaultPath: "/vault", selectedNotePath: null, view: "dashboard" });
  usePinsStore.setState({
    groups: [{ id: "g1", name: "Pinned", items: [{ id: "p1", kind: "note", ref: NOTE.path, label: "Alpha" }] }],
  });
});

describe("VaultSidebar pins", () => {
  it("shows pins above the note tree and opens them", () => {
    render(<VaultSidebar />);
    const section = screen.getByRole("region", { name: "Pinned" });
    const toggle = within(section).getByRole("button", { name: /Pinned/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("1");
    fireEvent.click(within(section).getByText("Alpha"));
    expect(useAetherStore.getState()).toMatchObject({ selectedNotePath: NOTE.path, view: "editor" });
    // The section comes before the vault tree.
    const tree = screen.getByRole("tree", { name: "Notes" });
    expect(section.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses and remembers the collapsed state", () => {
    const { unmount } = render(<VaultSidebar />);
    fireEvent.click(screen.getByRole("button", { name: /Pinned/ }));
    expect(screen.getByRole("button", { name: /Pinned/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Pinned" })).toBeNull();
    expect(window.localStorage.getItem(SIDEBAR_PINS_COLLAPSED_KEY)).toBe("1");
    unmount();

    render(<VaultSidebar />);
    expect(screen.getByRole("button", { name: /Pinned/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /Pinned/ }));
    expect(window.localStorage.getItem(SIDEBAR_PINS_COLLAPSED_KEY)).toBe("0");
    expect(screen.getByRole("list", { name: "Pinned" })).toBeInTheDocument();
  });

  it("is hidden when nothing is pinned", () => {
    usePinsStore.setState({ groups: [{ id: "g1", name: "Pinned", items: [] }] });
    render(<VaultSidebar />);
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.getByRole("tree", { name: "Notes" })).toBeInTheDocument();
  });
});

describe("VaultSidebar tree", () => {
  const notes = [
    NOTE,
    { path: "/vault/Projects/Beta.md", name: "Beta", mtime: 1 },
    { path: "/vault/Areas/Health.md", name: "Health", mtime: 1 },
  ];

  it("opens every folder with a match while filtering", () => {
    useAetherStore.setState({ vaultNotes: notes });
    render(<VaultSidebar />);
    const tree = screen.getByRole("tree", { name: "Notes" });
    expect(within(tree).queryByText("Beta")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search notes…"), { target: { value: "bet" } });
    expect(within(tree).getByText("Beta")).toBeInTheDocument();
    expect(within(tree).queryByText("Health")).toBeNull();
    // A folder closed during the search stays closed until the query changes.
    fireEvent.click(within(tree).getByText("Projects"));
    expect(within(tree).queryByText("Beta")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search notes…"), { target: { value: "be" } });
    expect(within(tree).getByText("Beta")).toBeInTheDocument();
  });

  it("reveals the open note's folders", () => {
    useAetherStore.setState({ vaultNotes: notes, selectedNotePath: "/vault/Areas/Health.md" });
    render(<VaultSidebar />);
    expect(within(screen.getByRole("tree", { name: "Notes" })).getByText("Health")).toBeInTheDocument();
  });
});
