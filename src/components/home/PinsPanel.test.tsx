import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ agentOpenUrl: vi.fn() }));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  ...ipc,
}));
const bus = vi.hoisted(() => ({ openConversation: vi.fn(), startNewConversation: vi.fn() }));
vi.mock("../../lib/agentChatBus", () => bus);

import { PinsPanel, PIN_DRAG_TYPE } from "./PinsPanel";
import { PinsDrawer } from "./PinsDrawer";
import { usePinsStore } from "../../lib/pinsStore";
import { useAetherStore } from "../../lib/store";
import { useHomeStore } from "../../lib/homeStore";
import { useIdeStore } from "../../lib/ideStore";
import { useToastStore } from "../../ui/Toast";
import type { PinGroup } from "../../types";

const groups = (): PinGroup[] => [
  {
    id: "g1",
    name: "Pinned",
    items: [
      { id: "a", kind: "note", ref: "/vault/Alpha.md", label: "Alpha" },
      { id: "b", kind: "project", ref: "/dev/app", label: "App" },
      { id: "c", kind: "url", ref: "https://tauri.app/", label: "Tauri docs" },
    ],
  },
  { id: "g2", name: "Work", items: [{ id: "d", kind: "conversation", ref: "c1", label: "Weekly plan" }] },
];

const labels = () => usePinsStore.getState().groups.map((g) => g.items.map((i) => i.label).join(","));

function dataTransfer() {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.agentOpenUrl.mockResolvedValue({ kind: "opened", url: "https://tauri.app/" });
  bus.openConversation.mockResolvedValue(undefined);
  usePinsStore.setState({ groups: groups() });
  useAetherStore.setState({
    view: "dashboard",
    vaultNotes: [{ path: "/vault/Alpha.md", name: "Alpha", mtime: 1 }],
    selectedNotePath: null,
    chatOpen: false,
  });
  useHomeStore.setState({ pinsDrawerOpen: false });
  useToastStore.setState({ toasts: [] });
});

describe("PinsPanel", () => {
  it("shows an empty state without pins", () => {
    usePinsStore.setState({ groups: [{ id: "g", name: "Pinned", items: [] }] });
    render(<PinsPanel />);
    expect(screen.getByText("Nothing pinned yet")).toBeInTheDocument();
  });

  it("renders groups and opens each kind of pin", async () => {
    render(<PinsPanel />);
    expect(screen.getByRole("list", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Work" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Alpha"));
    expect(useAetherStore.getState()).toMatchObject({ selectedNotePath: "/vault/Alpha.md", view: "editor" });

    fireEvent.click(screen.getByText("App"));
    expect(useIdeStore.getState().rootPath).toBe("/dev/app");
    expect(useAetherStore.getState().view).toBe("ide");

    // Conversation pins load that chat into the agent panel.
    fireEvent.click(screen.getByText("Weekly plan"));
    await vi.waitFor(() => expect(bus.openConversation).toHaveBeenCalledWith("c1"));

    fireEvent.click(screen.getByText("Tauri docs"));
    await vi.waitFor(() => expect(ipc.agentOpenUrl).toHaveBeenCalledWith("https://tauri.app/"));
  });

  it("flags and reports pins whose note is gone", async () => {
    usePinsStore.setState({ groups: [{ id: "g", name: "Pinned", items: [{ id: "x", kind: "note", ref: "/vault/Gone.md", label: "Gone" }] }] });
    render(<PinsPanel />);
    expect(screen.getByText("Missing")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Gone"));
    await vi.waitFor(() => expect(useToastStore.getState().toasts[0]?.title).toBe("Could not open pin"));
    expect(useAetherStore.getState().view).toBe("dashboard");
  });

  it("reorders with alt+arrow keys and unpins with Delete (undoable)", () => {
    render(<PinsPanel />);
    const alpha = screen.getByRole("button", { name: /^Alpha/ });
    fireEvent.keyDown(alpha, { key: "ArrowDown", altKey: true });
    expect(labels()).toEqual(["App,Alpha,Tauri docs", "Weekly plan"]);

    const tauri = screen.getByRole("button", { name: /^Tauri docs/ });
    fireEvent.keyDown(tauri, { key: "ArrowDown", altKey: true });
    expect(labels()).toEqual(["App,Alpha", "Tauri docs,Weekly plan"]);

    fireEvent.keyDown(screen.getByRole("button", { name: /^App/ }), { key: "Delete" });
    expect(labels()).toEqual(["Alpha", "Tauri docs,Weekly plan"]);
    const undo = useToastStore.getState().toasts.find((t) => t.title === "Unpinned")?.action;
    undo?.onClick();
    expect(labels()).toEqual(["App,Alpha", "Tauri docs,Weekly plan"]);
  });

  it("moves focus between pins with the arrow keys", () => {
    render(<PinsPanel />);
    const alpha = screen.getByRole("button", { name: /^Alpha/ });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /^App/ })).toHaveFocus();
  });

  it("reorders by drag and drop, also across groups", () => {
    render(<PinsPanel />);
    const dt = dataTransfer();
    const alpha = screen.getByRole("button", { name: /^Alpha/ });
    const weekly = screen.getByRole("button", { name: /^Weekly plan/ });
    fireEvent.dragStart(alpha, { dataTransfer: dt });
    expect(dt.getData(PIN_DRAG_TYPE)).toBe("a");
    // jsdom has no layout: the pointer counts as the lower half → drop after.
    fireEvent.dragOver(weekly, { dataTransfer: dt, clientY: 10 });
    fireEvent.drop(weekly, { dataTransfer: dt, clientY: 10 });
    expect(labels()).toEqual(["App,Tauri docs", "Weekly plan,Alpha"]);

    const dt2 = dataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: /^Tauri docs/ }), { dataTransfer: dt2 });
    fireEvent.dragOver(screen.getByRole("list", { name: "Work" }), { dataTransfer: dt2 });
    fireEvent.drop(screen.getByRole("list", { name: "Work" }), { dataTransfer: dt2 });
    expect(labels()).toEqual(["App", "Weekly plan,Alpha,Tauri docs"]);
  });
});

describe("PinsPanel (full)", () => {
  it("pins links and commands and manages groups", () => {
    render(<PinsPanel variant="full" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Web address" }), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin link" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/web address/);

    fireEvent.change(screen.getByRole("textbox", { name: "Web address" }), { target: { value: "docs.rs/serde" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin link" }));
    expect(usePinsStore.getState().groups[0].items.at(-1)).toMatchObject({ kind: "url", ref: "https://docs.rs/serde", label: "docs.rs/serde" });

    fireEvent.click(screen.getByRole("radio", { name: "Command" }));
    const select = screen.getByRole("combobox", { name: "Command" });
    const option = within(select).getAllByRole("option").find((o) => (o as HTMLOptionElement).value === "theme.toggle") as HTMLOptionElement;
    fireEvent.change(select, { target: { value: option.value } });
    fireEvent.click(screen.getByRole("button", { name: "Pin command" }));
    expect(usePinsStore.getState().groups[0].items.at(-1)).toMatchObject({ kind: "command", ref: "theme.toggle" });

    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    const name = screen.getByRole("textbox", { name: "New group name" });
    fireEvent.change(name, { target: { value: "Reading" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(usePinsStore.getState().groups.map((g) => g.name)).toEqual(["Pinned", "Work", "Reading"]);

    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    expect(usePinsStore.getState().groups.map((g) => g.name)).toEqual(["Pinned", "Reading"]);
    expect(usePinsStore.getState().groups[0].items.some((i) => i.label === "Weekly plan")).toBe(true);
  });

  it("renames a group inline", () => {
    render(<PinsPanel variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Work" }));
    const input = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(input, { target: { value: "Deep work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(usePinsStore.getState().groups[1].name).toBe("Deep work");
  });
});

describe("PinsDrawer", () => {
  it("opens from the store, pins the current note and closes on Escape", () => {
    useAetherStore.setState({ selectedNotePath: "/vault/Beta.md" });
    useHomeStore.setState({ pinsDrawerOpen: true });
    render(<PinsDrawer />);
    const drawer = screen.getByRole("dialog", { name: "Pins" });
    fireEvent.click(within(drawer).getByRole("button", { name: /Pin “Beta”/ }));
    expect(usePinsStore.getState().groups[0].items.at(-1)).toMatchObject({ kind: "note", ref: "/vault/Beta.md" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useHomeStore.getState().pinsDrawerOpen).toBe(false);
  });

  it("closes after opening a pin", async () => {
    useHomeStore.setState({ pinsDrawerOpen: true });
    render(<PinsDrawer />);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Pins" })).getByText("Alpha"));
    await vi.waitFor(() => expect(useHomeStore.getState().pinsDrawerOpen).toBe(false));
  });
});
