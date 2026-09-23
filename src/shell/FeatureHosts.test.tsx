import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockEvents, mockInvoke, requestMockQuit, resetMockState, setMockLatency } from "../lib/mock/backend";
import { mockQuitConfirmations } from "../lib/mock/app";
import { useOnboardingStore } from "../lib/onboardingStore";
import { useVaultTasksStore } from "../lib/vaultTasksStore";
import { useToastStore } from "../ui/Toast";
import { getStatusItems } from "./statusbar/registry";
import { FEATURE_HOSTS, FeatureHosts } from "./FeatureHosts";
import { QuitConfirmHost, quitTitle } from "./QuitConfirmHost";

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  useToastStore.getState().clear();
  useOnboardingStore.setState({ generalPrefs: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("FeatureHosts", () => {
  it("hosts the invisible feature components instead of the status bar", () => {
    expect(FEATURE_HOSTS.map((h) => h.id)).toEqual(["onboarding.host", "vaulttasks.quickAdd", "plugins.bootstrap", "shell.quitConfirm"]);
    const statusIds = getStatusItems().map((i) => i.id);
    for (const id of ["onboarding.host", "vaulttasks.quickAdd"]) expect(statusIds).not.toContain(id);
    // Real status items stay.
    expect(statusIds).toEqual(expect.arrayContaining(["vaulttasks.due", "plugins", "onboarding.ollama"]));
  });

  it("isolates a crashing host", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error("boom");
    };
    const Fine = () => <p>still here</p>;
    render(
      <FeatureHosts
        hosts={[
          { id: "test.boom", component: Boom },
          { id: "test.fine", component: Fine },
        ]}
      />
    );
    expect(screen.getByText("still here")).toBeInTheDocument();
  });

  it("registers the note-task quick-add host", () => {
    useVaultTasksStore.setState({ quickAddHosts: 0 });
    const { unmount } = render(<FeatureHosts hosts={FEATURE_HOSTS.filter((h) => h.id === "vaulttasks.quickAdd")} />);
    expect(useVaultTasksStore.getState().quickAddHosts).toBe(1);
    unmount();
    expect(useVaultTasksStore.getState().quickAddHosts).toBe(0);
  });
});

describe("QuitConfirmHost", () => {
  it("titles the dialog by the number of sessions", () => {
    expect(quitTitle(1)).toBe("1 terminal session is running — quit anyway?");
    expect(quitTitle(3)).toBe("3 terminal sessions are running — quit anyway?");
  });

  it("asks on quit-requested and quits on confirm", async () => {
    render(<QuitConfirmHost />);
    await waitFor(() => expect(mockEvents.listenerCount("quit-requested")).toBe(1));
    await act(async () => {
      await requestMockQuit(2);
    });
    const dialog = await screen.findByRole("dialog", { name: "2 terminal sessions are running — quit anyway?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog.textContent).toContain("again within a few seconds");
    fireEvent.click(within(dialog).getByRole("button", { name: "Quit" }));
    await waitFor(() => expect(mockQuitConfirmations()).toBe(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the app open on cancel", async () => {
    render(<QuitConfirmHost />);
    await waitFor(() => expect(mockEvents.listenerCount("quit-requested")).toBe(1));
    act(() => mockEvents.emit("quit-requested", { terminals: 1 }));
    const dialog = await screen.findByRole("dialog", { name: quitTitle(1) });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockQuitConfirmations()).toBe(0);
  });

  it("turns the confirmation off with Don't ask again", async () => {
    render(<QuitConfirmHost />);
    await waitFor(() => expect(mockEvents.listenerCount("quit-requested")).toBe(1));
    act(() => mockEvents.emit("quit-requested", { terminals: 1 }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Don't ask again/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Quit" }));
    await waitFor(() => expect(mockQuitConfirmations()).toBe(1));
    expect(await mockInvoke("cmd_onboarding_get_general_prefs")).toEqual({ confirm_quit_with_terminals: false });
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<QuitConfirmHost />);
    await waitFor(() => expect(mockEvents.listenerCount("quit-requested")).toBe(1));
    unmount();
    expect(mockEvents.listenerCount("quit-requested")).toBe(0);
  });
});
