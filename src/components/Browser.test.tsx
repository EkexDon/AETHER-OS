import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({
  isDesktopRuntime: () => false,
  getBrowserInfo: vi.fn(),
  browserOpen: vi.fn(),
  browserOpenLibreWolf: vi.fn(),
  browserWebviewOpen: vi.fn(),
  browserWebviewClose: vi.fn(),
  browserWebviewNavigate: vi.fn(),
  browserWebviewBack: vi.fn(),
  browserWebviewForward: vi.fn(),
  browserWebviewReload: vi.fn(),
  browserWebviewList: vi.fn(),
  browserWebviewSetBounds: vi.fn(),
  browserWebviewShow: vi.fn(),
  browserWebviewHide: vi.fn(),
  browserWebviewHideAll: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { Browser } from "./Browser";

describe("Browser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { localStorage.clear(); } catch { /* jsdom may not support */ }
  });

  it("shows error when not in desktop runtime", () => {
    render(<Browser />);
    expect(screen.getByText(/desktop runtime/i)).toBeTruthy();
  });

  it("renders browser error with Globe icon text", () => {
    render(<Browser />);
    expect(screen.getByText(/Browser requires the desktop runtime/i)).toBeTruthy();
  });
});
