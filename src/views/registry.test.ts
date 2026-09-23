import { describe, expect, it, vi } from "vitest";

// The registry imports every view component; stub the heavy/IPC-bound ones.
vi.mock("../lib/ipc", () => ({
  isDesktopRuntime: () => false,
  isTauriRuntime: () => false,
}));

import { VIEWS, getView, viewsByGroup } from "./registry";
import { VIEW_GROUPS } from "./modes";
import { getCommands } from "../lib/commands/registry";
import registrySource from "./registry.tsx?raw";
import modesSource from "./modes.ts?raw";

const FEATURES = ["clipboard", "search", "history", "home", "vaulttasks", "intel", "plugins", "export", "sync", "onboarding"];

describe("view registry", () => {
  it("contains all 13 existing views with unique modes", () => {
    const modes = VIEWS.map((v) => v.mode);
    expect(new Set(modes).size).toBe(modes.length);
    expect(modes).toEqual(
      expect.arrayContaining([
        "dashboard",
        "editor",
        "search",
        "graph",
        "notes",
        "memory",
        "ide",
        "projects",
        "terminal",
        "calendar",
        "tasks",
        "monitor",
        "browser",
      ])
    );
  });

  it("groups views as knowledge · build · life · system", () => {
    const groups = viewsByGroup();
    expect(groups.get("knowledge")?.map((v) => v.mode)).toEqual(["dashboard", "editor", "search", "graph", "notes", "memory"]);
    expect(groups.get("build")?.map((v) => v.mode)).toEqual(["ide", "projects", "terminal"]);
    expect(groups.get("life")?.map((v) => v.mode)).toEqual(["calendar", "tasks"]);
    expect(groups.get("system")?.map((v) => v.mode)).toEqual(["monitor", "browser"]);
    expect(VIEW_GROUPS.map((g) => g.id)).toEqual(["knowledge", "build", "life", "system"]);
  });

  it("binds mod+1..9 to the first nine views in rail order", () => {
    const railOrder = VIEW_GROUPS.flatMap((g) => viewsByGroup().get(g.id) ?? []);
    railOrder.slice(0, 9).forEach((v, i) => expect(v.shortcut).toBe(`mod+${i + 1}`));
    const shortcuts = VIEWS.map((v) => v.shortcut).filter(Boolean);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("keeps the terminal alive and hides the vault sidebar for the IDE", () => {
    expect(getView("terminal")?.keepAlive).toBe(true);
    expect(getView("ide")?.hidesVaultSidebar).toBe(true);
    expect(getView("editor")?.hidesVaultSidebar).toBeFalsy();
  });

  it("registers a navigation command per view", () => {
    const ids = getCommands().map((c) => c.id);
    for (const v of VIEWS) expect(ids).toContain(`view.${v.mode}`);
  });

  it("has view, import and mode anchors for every feature", () => {
    for (const f of FEATURES) {
      expect(registrySource).toContain(`// @anchor:view:${f}`);
      expect(registrySource).toContain(`// @anchor:view-import:${f}`);
      expect(modesSource).toContain(`// @anchor:mode:${f}`);
    }
  });
});
