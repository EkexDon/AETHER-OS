import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg></svg>" })) } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// jsdom has no Web Workers: run the real bootstrap in-process instead.
vi.mock("../../lib/plugins/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/host")>();
  const { inProcessWorkerDeps } = await import("../../lib/plugins/testHarness");
  let host: InstanceType<typeof actual.PluginHost> | null = null;
  const getPluginHost = () => (host ??= new actual.PluginHost(inProcessWorkerDeps()));
  return {
    ...actual,
    getPluginHost,
    startPluginHost: () => void getPluginHost().start(),
    __resetHost: async () => {
      await host?.shutdown();
      host = null;
    },
  };
});

import * as hostModule from "../../lib/plugins/host";
import { PluginsView } from "./PluginsView";
import { resetPluginsStoreForTests, usePluginsStore } from "../../lib/pluginsStore";
import { useAetherStore } from "../../lib/store";
import { useToastStore } from "../../ui/Toast";
import { getPluginSettings } from "../../lib/ipc";
import { resetMockState, setMockLatency } from "../../lib/mock/backend";
import { MOCK_VAULT_ROOT } from "../../lib/mock/fixtures/vault";
import { mockVault } from "../../lib/mock/vaultStore";

const cardOf = (name: string) => screen.getByRole("heading", { name, level: 3 }).closest(".plugin-card") as HTMLElement;

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  resetPluginsStoreForTests();
  useToastStore.getState().clear();
  useAetherStore.setState({ vaultPath: MOCK_VAULT_ROOT, vaultNotes: mockVault.list(), selectedNotePath: null, noteDirty: false, busy: false });
});

afterEach(async () => {
  await (hostModule as unknown as { __resetHost: () => Promise<void> }).__resetHost();
  vi.unstubAllEnvs();
});

describe("PluginsView", () => {
  it("lists the bundled examples with status, permissions and the Word Count panel", async () => {
    render(<PluginsView />);
    expect(await screen.findByRole("heading", { name: "Word Count", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Daily Review", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Random Note", level: 3 })).toBeInTheDocument();

    const wordCount = cardOf("Word Count");
    await waitFor(() => expect(within(wordCount).getByText("Running")).toBeInTheDocument());
    expect(within(wordCount).getByText("Read your notes")).toBeInTheDocument();
    expect(within(cardOf("Daily Review")).getByText("Disabled")).toBeInTheDocument();
    expect(await screen.findByText("Open a note to see its word count and reading time.")).toBeInTheDocument();
    expect(screen.getByText(/3 installed · 1 running/)).toBeInTheDocument();
  });

  it("asks for permissions before enabling a plugin for the first time", async () => {
    render(<PluginsView />);
    const card = cardOf((await screen.findByRole("heading", { name: "Random Note", level: 3 })).textContent!);
    fireEvent.click(within(card).getByRole("switch", { name: "Enable Random Note" }));

    const dialog = await screen.findByRole("dialog", { name: "Enable Random Note?" });
    expect(within(dialog).getByText("Read your notes")).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: /Add commands/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Enable plugin" }));

    await waitFor(() => expect(within(cardOf("Random Note")).getByText("Running")).toBeInTheDocument());
    expect(await within(cardOf("Random Note")).findByText("Open random note")).toBeInTheDocument();
    expect(usePluginsStore.getState().plugins.find((p) => p.manifest.id === "aether.random-note")?.granted_permissions).toEqual([
      "vault:read",
      "ui:commands",
    ]);
  });

  it("shows install errors inline and installs a valid package", async () => {
    render(<PluginsView />);
    await screen.findByRole("heading", { name: "Word Count", level: 3 });
    fireEvent.click(screen.getAllByRole("button", { name: "Install plugin" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Install plugin" });
    const input = within(dialog).getByLabelText("Folder or archive");

    fireEvent.change(input, { target: { value: "/Users/demo/Downloads/zip-slip.zip" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("escapes the plugin folder");

    fireEvent.change(input, { target: { value: "/Users/demo/Downloads/github-zen" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("heading", { name: "GitHub Zen", level: 3 })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Install plugin" })).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Installed GitHub Zen 0.3.0");
    expect(within(cardOf("GitHub Zen")).getByText("Connect to api.github.com")).toBeInTheDocument();
  });

  it("validates and saves plugin settings", async () => {
    render(<PluginsView />);
    const card = cardOf((await screen.findByRole("heading", { name: "Word Count", level: 3 })).textContent!);
    fireEvent.click(within(card).getByRole("button", { name: "Settings" }));
    const speed = await within(card).findByLabelText("Reading speed");
    const save = within(card).getByRole("button", { name: "Save settings" });

    fireEvent.change(speed, { target: { value: "5000" } });
    expect(within(card).getByText("Reading speed must be between 60 and 1000")).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(speed, { target: { value: "300" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Word Count settings saved"));
    expect((await getPluginSettings("aether.word-count")).wordsPerMinute).toBe(300);
  });

  it("uninstalls a plugin after confirmation", async () => {
    render(<PluginsView />);
    const card = cardOf((await screen.findByRole("heading", { name: "Daily Review", level: 3 })).textContent!);
    fireEvent.click(within(card).getByRole("button", { name: "Uninstall Daily Review" }));
    const dialog = await screen.findByRole("dialog", { name: "Uninstall Daily Review?" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Daily Review", level: 3 })).toBeNull());
    expect(screen.getByText(/2 installed/)).toBeInTheDocument();
  });
});
