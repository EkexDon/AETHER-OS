import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetMockState, setMockLatency } from "../../lib/mock/backend";
import { DEFAULT_INTEL_SETTINGS, useIntelStore } from "../../lib/intelStore";
import { ToastProvider } from "../../ui";
import { IntelSettings, relativeTime } from "./IntelSettings";

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useIntelStore.setState({ settings: { ...DEFAULT_INTEL_SETTINGS }, settingsLoaded: false, allowRules: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function renderSettings() {
  return render(
    <ToastProvider>
      <IntelSettings />
    </ToastProvider>
  );
}

describe("IntelSettings", () => {
  it("loads settings and the agent activity log", async () => {
    renderSettings();
    expect(await screen.findByText(/Run `git status`/)).toBeInTheDocument();
    expect(screen.getByText("denied")).toBeInTheDocument();
    await waitFor(() => expect(useIntelStore.getState().settingsLoaded).toBe(true));
    expect(screen.getByRole("switch", { name: "Compact automatically" })).toHaveAttribute("aria-checked", "true");
  });

  it("saves changes through the backend", async () => {
    renderSettings();
    await waitFor(() => expect(useIntelStore.getState().settingsLoaded).toBe(true));
    fireEvent.click(screen.getByRole("switch", { name: "Compact automatically" }));
    await waitFor(() => expect(useIntelStore.getState().settings.auto_compact).toBe(false));
    fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "12000" } });
    await waitFor(() => expect(useIntelStore.getState().settings.compact_threshold_tokens).toBe(12_000));
  });

  it("lists and revokes allow rules", async () => {
    useIntelStore.getState().addAllowRule({ action: "run_command", command: "ls", cwd: "/work/app" });
    renderSettings();
    expect(await screen.findByText("Shell commands in /work/app")).toBeInTheDocument();
    expect(screen.getByText("this session")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke rule" }));
    expect(useIntelStore.getState().allowRules).toHaveLength(0);
  });

  it("clears the log after a second click", async () => {
    renderSettings();
    await screen.findByText(/Run `git status`/);
    const clear = screen.getByRole("button", { name: "Clear log" });
    fireEvent.click(clear);
    expect(screen.getByRole("button", { name: "Click again to clear" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Click again to clear" }));
    expect(await screen.findByText("No agent activity yet")).toBeInTheDocument();
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(relativeTime("2026-09-23T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-23T11:50:00Z", now)).toBe("10 min ago");
    expect(relativeTime("2026-09-23T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("not a date", now)).toBe("not a date");
  });
});
