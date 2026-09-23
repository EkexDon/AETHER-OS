import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logFrontendError = vi.fn(async () => undefined);
const openAppDataDir = vi.fn(async () => undefined);
vi.mock("../../lib/ipc", () => ({
  logFrontendError: (...args: unknown[]) => logFrontendError(...(args as [])),
  openAppDataDir: () => openAppDataDir(),
  isDesktopRuntime: () => true,
}));

import { flushFrontendErrors, resetDiagnosticsState } from "../../lib/diagnostics";
import { ErrorBoundary, withViewBoundary } from "./ErrorBoundary";

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error("Kaboom in render");
  return <p>Recovered content</p>;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  shouldThrow = true;
  resetDiagnosticsState();
  logFrontendError.mockClear();
  openAppDataDir.mockClear();
  // React logs caught render errors; keep the test output clean.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    shouldThrow = false;
    render(
      <ErrorBoundary name="Editor">
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByText("Recovered content")).toBeInTheDocument();
  });

  it("shows the crash panel and reports a fatal frontend error", async () => {
    render(
      <ErrorBoundary name="Editor">
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Editor ran into a problem")).toBeInTheDocument();
    expect(screen.getByText("Kaboom in render")).toBeInTheDocument();

    await act(() => flushFrontendErrors());
    expect(logFrontendError).toHaveBeenCalledTimes(1);
    expect(logFrontendError.mock.calls[0]).toEqual([
      expect.objectContaining({ message: "Kaboom in render", source: "boundary", view: "Editor", fatal: true }),
    ]);
  });

  it("reloads the view by remounting its children", () => {
    render(
      <ErrorBoundary name="Editor">
        <Bomb />
      </ErrorBoundary>
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload view" }));
    expect(screen.getByText("Recovered content")).toBeInTheDocument();
  });

  it("copies a report to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ErrorBoundary name="Graph">
        <Bomb />
      </ErrorBoundary>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("message: Kaboom in render"));
    expect(screen.getByRole("status")).toHaveTextContent("Report copied");
  });

  it("opens the data folder", async () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open data folder" }));
    });
    expect(openAppDataDir).toHaveBeenCalledTimes(1);
  });

  it("withViewBoundary wraps a component and names it", () => {
    function Calendar(): never {
      throw new Error("calendar failed");
    }
    const Wrapped = withViewBoundary(Calendar, "Calendar");
    expect(Wrapped.displayName).toBe("withViewBoundary(Calendar)");
    render(<Wrapped />);
    expect(screen.getByText("Calendar ran into a problem")).toBeInTheDocument();
  });
});
