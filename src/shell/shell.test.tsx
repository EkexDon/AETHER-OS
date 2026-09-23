import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  indexVault: vi.fn(),
  openProject: vi.fn().mockResolvedValue(undefined),
  createNote: vi.fn().mockResolvedValue("/vault/New.md"),
  getVaultNotes: vi.fn().mockResolvedValue([]),
  getMemoryFacts: vi.fn().mockResolvedValue([]),
  logFrontendError: vi.fn().mockResolvedValue(undefined),
  isDesktopRuntime: () => false,
  isTauriRuntime: () => false,
}));

import { NavRail } from "./NavRail";
import { StatusBar } from "./StatusBar";
import { ViewHost } from "./ViewHost";
import { useShellStore } from "./shellStore";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useAetherStore } from "../lib/store";
import { useThemeStore } from "../lib/theme";
import { useAppearanceStore } from "../lib/appearance";
import { isMacPlatform } from "../lib/shortcuts";
import { CommandBar } from "../components/CommandBar";
import { buildTree } from "../components/VaultSidebar";

function modKey(key: string, extra: Partial<KeyboardEventInit> = {}) {
  const mac = isMacPlatform();
  fireEvent.keyDown(window, { key, metaKey: mac, ctrlKey: !mac, ...extra });
}

function Shortcuts() {
  useGlobalShortcuts();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  useAetherStore.setState({ view: "dashboard", vaultPath: "/vault/Second-Brain", vaultNotes: [], health: null });
  useShellStore.setState({ commandBarOpen: false, settingsOpen: false, shortcutsOpen: false, newNoteOpen: false });
  useAppearanceStore.setState({ railExpanded: false });
  useThemeStore.setState({ preference: "dark", resolved: "dark" });
});

describe("NavRail", () => {
  it("lists every workspace by name and navigates on click", () => {
    render(<NavRail />);
    for (const label of ["Home", "Notes", "Search", "Graph", "AI Notes", "Memory", "IDE", "Projects", "Terminal", "Calendar", "Tasks", "Monitor", "Browser"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(useAetherStore.getState().view).toBe("tasks");
    expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
  });

  it("groups workspaces and toggles the label mode", () => {
    render(<NavRail />);
    expect(screen.getByRole("group", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "System" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show labels" }));
    expect(useAppearanceStore.getState().railExpanded).toBe(true);
    expect(screen.getByText("Knowledge")).toBeInTheDocument();
  });

  it("opens settings", () => {
    render(<NavRail />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useShellStore.getState().settingsOpen).toBe(true);
  });
});

describe("StatusBar", () => {
  it("shows the vault and provider state and toggles the theme", () => {
    useAetherStore.setState({
      vaultStats: { note_count: 12, total_tasks: 0, open_tasks: 0, total_cards: 0, total_tags: 0, total_links: 0 },
      health: { ollama_online: true, openrouter_configured: false, vault_connected: true },
    });
    render(<StatusBar />);
    expect(screen.getByText("Second-Brain")).toBeInTheDocument();
    expect(screen.getByText("12 notes")).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("not configured")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(useThemeStore.getState().resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("opens the command palette and shortcuts overlay", () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: /Commands/ }));
    expect(useShellStore.getState().commandBarOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(useShellStore.getState().shortcutsOpen).toBe(true);
  });
});

describe("global shortcuts", () => {
  it("routes mod+k, mod+/, mod+, and mod+digit to commands", async () => {
    render(<Shortcuts />);
    modKey("k");
    await act(async () => undefined);
    expect(useShellStore.getState().commandBarOpen).toBe(true);
    modKey("/");
    await act(async () => undefined);
    expect(useShellStore.getState().shortcutsOpen).toBe(true);
    modKey(",");
    await act(async () => undefined);
    expect(useShellStore.getState().settingsOpen).toBe(true);
    modKey("7");
    await act(async () => undefined);
    expect(useAetherStore.getState().view).toBe("ide");
  });

  it("leaves events alone that an editor already handled", async () => {
    render(<Shortcuts />);
    const mac = isMacPlatform();
    const ev = new KeyboardEvent("keydown", { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
    ev.preventDefault();
    window.dispatchEvent(ev);
    await act(async () => undefined);
    expect(useShellStore.getState().commandBarOpen).toBe(false);
  });

  it("ignores plain keys", async () => {
    render(<Shortcuts />);
    fireEvent.keyDown(window, { key: "k" });
    await act(async () => undefined);
    expect(useShellStore.getState().commandBarOpen).toBe(false);
  });
});

describe("ViewHost", () => {
  it("renders the active view and keeps keep-alive views mounted but hidden", async () => {
    const { rerender, container } = render(<ViewHost view="memory" />);
    expect(container.querySelector('[data-view="memory"]')).not.toBeNull();
    rerender(<ViewHost view="terminal" />);
    expect(container.querySelector('[data-view="terminal"]')).not.toBeNull();
    rerender(<ViewHost view="memory" />);
    const terminal = container.querySelector('[data-view="terminal"]');
    expect(terminal).not.toBeNull();
    expect(terminal).toHaveClass("is-hidden");
  });
});

describe("CommandBar", () => {
  it("lists navigation first, filters by query and runs the selection", async () => {
    const onClose = vi.fn();
    useAetherStore.setState({
      vaultNotes: [{ path: "/vault/Second-Brain/01-Projects/Garden.md", name: "Garden.md" } as never],
    });
    render(<CommandBar onClose={onClose} />);
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("Go to Home");
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "calendar" } });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Go to Calendar");
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalled();
    expect(useAetherStore.getState().view).toBe("calendar");
  });

  it("finds notes and opens them in the editor", async () => {
    useAetherStore.setState({
      vaultNotes: [{ path: "/vault/Second-Brain/01-Projects/Garden.md", name: "Garden.md" } as never],
    });
    render(<CommandBar onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "garden" } });
    fireEvent.click(screen.getByRole("option", { name: /Garden/ }));
    expect(useAetherStore.getState().view).toBe("editor");
    expect(useAetherStore.getState().selectedNotePath).toBe("/vault/Second-Brain/01-Projects/Garden.md");
  });

  it("shows an empty state for no matches", () => {
    render(<CommandBar onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzzzqqq" } });
    expect(screen.getByText(/No results/)).toBeInTheDocument();
  });
});

describe("vault tree", () => {
  it("is relative to the vault root, folders first, naturally sorted", () => {
    const tree = buildTree(
      [
        { path: "/v/Welcome.md", name: "Welcome" },
        { path: "/v/daily/2026-09-22.md", name: "2026-09-22" },
        { path: "/v/10-Archive/a.md", name: "a" },
        { path: "/v/2-Areas/b.md", name: "b" },
      ],
      "/v/"
    );
    expect(tree.map((n) => n.name)).toEqual(["2-Areas", "10-Archive", "daily", "Welcome"]);
    expect(tree[3].path).toBe("/v/Welcome.md");
    expect(tree[2].children[0].name).toBe("2026-09-22");
  });
});
