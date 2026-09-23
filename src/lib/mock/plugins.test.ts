import { beforeEach, describe, expect, it } from "vitest";
import type { PluginInfo } from "../../types";
import { mockInvoke, resetMockState, setMockLatency } from "./backend";
import { mockVault } from "./vaultStore";
import { MOCK_VAULT_ROOT } from "./fixtures/vault";

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("plugin mock", () => {
  it("installs the bundled examples once", async () => {
    expect(await invoke<string[]>("cmd_plugins_install_examples")).toEqual([
      "aether.word-count",
      "aether.daily-review",
      "aether.random-note",
    ]);
    expect(await invoke<string[]>("cmd_plugins_install_examples")).toEqual([]);
    const list = await invoke<PluginInfo[]>("cmd_plugins_list");
    expect(list.map((p) => p.manifest.name)).toEqual(["Daily Review", "Random Note", "Word Count"]);
    expect(list.find((p) => p.manifest.id === "aether.word-count")).toMatchObject({ enabled: true, bundled: true });
    await invoke("cmd_plugins_uninstall", { id: "aether.random-note" });
    expect(await invoke<string[]>("cmd_plugins_install_examples")).toEqual([]);
  });

  it("checks permissions like the Rust commands", async () => {
    await invoke("cmd_plugins_install_examples");
    await expect(invoke("cmd_plugins_vault_list", { id: "aether.random-note" })).rejects.toBe(
      'invalid input: plugin "aether.random-note" is disabled'
    );
    await invoke("cmd_plugins_set_enabled", { id: "aether.random-note", enabled: true });
    await expect(invoke("cmd_plugins_vault_list", { id: "aether.random-note" })).rejects.toBe(
      'invalid input: permission denied: plugin "aether.random-note" has not been granted "vault:read"'
    );
    await expect(
      invoke("cmd_plugins_set_permissions", { id: "aether.random-note", permissions: ["vault:write"] })
    ).rejects.toContain("does not request");
    await invoke("cmd_plugins_set_permissions", { id: "aether.random-note", permissions: ["vault:read"] });
    const notes = await invoke<{ path: string }[]>("cmd_plugins_vault_list", { id: "aether.random-note" });
    expect(notes.every((n) => !n.path.startsWith("/"))).toBe(true);
    await expect(
      invoke("cmd_plugins_vault_read", { id: "aether.random-note", path: "../secret.md" })
    ).rejects.toContain("invalid vault path");
  });

  it("writes and creates notes inside the vault", async () => {
    await invoke("cmd_plugins_install_examples");
    await invoke("cmd_plugins_set_enabled", { id: "aether.daily-review", enabled: true });
    await invoke("cmd_plugins_set_permissions", { id: "aether.daily-review", permissions: ["vault:write"] });
    await invoke("cmd_plugins_vault_write", { id: "aether.daily-review", path: "reviews/2026/w38.md", content: "# W38" });
    expect(mockVault.read(`${MOCK_VAULT_ROOT}/reviews/2026/w38.md`)).toBe("# W38");
  });

  it("rejects unsafe packages and validates settings and storage", async () => {
    await expect(invoke("cmd_plugins_install_from_path", { path: "/Users/demo/Downloads/zip-slip.zip" })).rejects.toContain(
      "escapes the plugin folder"
    );
    await expect(invoke("cmd_plugins_install_from_path", { path: "/nope" })).rejects.toContain("no such file or folder");
    const zen = await invoke<PluginInfo>("cmd_plugins_install_from_path", { path: "/Users/demo/Downloads/github-zen" });
    expect(zen.enabled).toBe(false);

    await invoke("cmd_plugins_install_examples");
    await expect(
      invoke("cmd_plugins_set_settings", { id: "aether.word-count", values: { wordsPerMinute: "fast" } })
    ).rejects.toContain("must be a finite number");
    const settings = await invoke<Record<string, unknown>>("cmd_plugins_set_settings", {
      id: "aether.word-count",
      values: { wordsPerMinute: 400 },
    });
    expect(settings).toEqual({ wordsPerMinute: 400, showCharacters: true });

    await invoke("cmd_plugins_storage_set", { id: "aether.word-count", key: "k", value: { n: 1 } });
    expect(await invoke("cmd_plugins_storage_get", { id: "aether.word-count", key: "k" })).toEqual({ n: 1 });
    await expect(
      invoke("cmd_plugins_storage_set", { id: "aether.word-count", key: "big", value: "x".repeat(1024 * 1024) })
    ).rejects.toContain("limited to 1 MB");
  });
});
