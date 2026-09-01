import { describe, expect, it, vi, beforeEach } from "vitest";

const mockTermInstance = {
  open: vi.fn(),
  dispose: vi.fn(),
  write: vi.fn(),
  writeln: vi.fn(),
  onData: vi.fn(),
  loadAddon: vi.fn(),
  reset: vi.fn(),
  focus: vi.fn(),
  cols: 80,
  rows: 24,
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => mockTermInstance),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../lib/ipc", () => ({
  isDesktopRuntime: () => false,
  terminalSpawn: vi.fn(),
  terminalWrite: vi.fn(),
  terminalResize: vi.fn(),
  terminalKill: vi.fn(),
  onTerminalOutput: vi.fn(() => Promise.resolve(() => undefined)),
}));

import { render, screen, fireEvent } from "@testing-library/react";
import { Terminal } from "./Terminal";

describe("Terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders tab bar and creates a local tab when IPC is unavailable", async () => {
    render(<Terminal />);
    await vi.waitFor(() => {
      expect(screen.getByText(/Terminal/i)).toBeTruthy();
    });
  });

  it("shows new tab button", () => {
    render(<Terminal />);
    const newTabButton = screen.getByTitle("New tab");
    expect(newTabButton).toBeTruthy();
  });

  it("creates additional tab when new tab button is clicked", async () => {
    render(<Terminal />);
    await vi.waitFor(() => {
      expect(screen.getByText(/Terminal/i)).toBeTruthy();
    });
    const newTabButton = screen.getByTitle("New tab");
    fireEvent.click(newTabButton);
    await vi.waitFor(() => {
      const tabElements = screen.getAllByText(/Terminal/i);
      expect(tabElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("switches tabs without disposing background terminal panes", async () => {
    render(<Terminal />);
    await vi.waitFor(() => {
      expect(screen.getByText(/Terminal/i)).toBeTruthy();
    });

    const newTabButton = screen.getByTitle("New tab");
    fireEvent.click(newTabButton);

    await vi.waitFor(() => {
      const tabs = screen.getAllByText(/Terminal/i);
      expect(tabs.length).toBe(2);
    });

    const tabs = screen.getAllByText(/Terminal/i);
    // Click first tab
    fireEvent.click(tabs[0]);

    // Check that panes are present
    const panes = document.querySelectorAll(".terminal-tab-pane");
    expect(panes.length).toBe(2);
    expect((panes[0] as HTMLElement).style.display).toBe("block");
    expect((panes[1] as HTMLElement).style.display).toBe("none");

    // Switch to second tab
    fireEvent.click(tabs[1]);
    expect((panes[0] as HTMLElement).style.display).toBe("none");
    expect((panes[1] as HTMLElement).style.display).toBe("block");
  });

  it("shows an enabled reset button once a tab is active and does not throw when clicked", async () => {
    render(<Terminal />);
    await vi.waitFor(() => {
      const resetButton = screen.getByTitle(/Reset terminal/i);
      expect(resetButton).toBeTruthy();
      expect((resetButton as HTMLButtonElement).disabled).toBe(false);
    });

    const resetButton = screen.getByTitle(/Reset terminal/i);
    expect(() => fireEvent.click(resetButton)).not.toThrow();
  });
});
