import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({
  isDesktopRuntime: () => false,
  getSystemMetrics: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { SystemMonitor } from "./SystemMonitor";

describe("SystemMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows error message when not in desktop runtime", async () => {
    render(<SystemMonitor />);
    await vi.waitFor(() => {
      expect(screen.getByText(/desktop runtime/i)).toBeTruthy();
    });
  });

  it("renders the monitor title in error state", async () => {
    render(<SystemMonitor />);
    await vi.waitFor(() => {
      expect(screen.getByText(/System Monitor/i)).toBeTruthy();
    });
  });
});
