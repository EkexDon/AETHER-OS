import { describe, expect, it, vi } from "vitest";

// The registry imports every view component; stub the heavy/IPC-bound ones.
vi.mock("../lib/ipc", () => ({
  isDesktopRuntime: () => false,
  isTauriRuntime: () => false,
}));

import { VIEWS, getView, viewsByGroup } from "./registry";
import { VIEW_GROUPS, type ViewGroup } from "./modes";
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

  // Feature views join these groups over time, so the assertions check that
  // the core views keep their group and relative order rather than pinning
  // the exact membership of each group.
  it("groups views as knowledge · build · life · system", () => {
    const groups = viewsByGroup();
    const inOrder = (group: ViewGroup, expected: string[]) => {
      const modes = groups.get(group)?.map((v) => v.mode) ?? [];
      const present = modes.filter((m) => expected.includes(m));
      expect(present).toEqual(expected);
    };
    inOrder("knowledge", ["dashboard", "editor", "search", "graph", "notes", "memory"]);
    inOrder("build", ["ide", "projects", "terminal"]);
    inOrder("life", ["calendar", "tasks"]);
    inOrder("system", ["monitor", "browser"]);
    expect(VIEW_GROUPS.map((g) => g.id)).toEqual(["knowledge", "build", "life", "system"]);
    for (const v of VIEWS) expect(VIEW_GROUPS.some((g) => g.id === v.group)).toBe(true);
  });

  it("keeps view shortcuts unique and within mod+1..9", () => {
    const shortcuts = VIEWS.map((v) => v.shortcut).filter((s): s is string => Boolean(s));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    // Numbered shortcuts stay in the mod+1..9 range; feature views may use
    // other chords (e.g. mod+alt+c).
    for (const s of shortcuts.filter((x) => /^mod\+\d+$/.test(x))) expect(s).toMatch(/^mod\+[1-9]$/);
    expect(getView("dashboard")?.shortcut).toBe("mod+1");
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
