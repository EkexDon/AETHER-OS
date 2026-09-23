import { describe, expect, it, vi } from "vitest";
import { Zap } from "lucide-react";

vi.mock("../lib/ipc", () => ({
  isTauriRuntime: () => false,
  isDesktopRuntime: () => false,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { SETTINGS_SECTIONS, getSettingsSections, resolveSettingsSection, type SettingsSection } from "./registry";
import source from "./registry.tsx?raw";

const Dummy = () => null;

describe("settings registry", () => {
  it("contains the built-in sections in order, About last", () => {
    const ids = getSettingsSections().map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(["vault", "ai", "editor", "appearance"]);
    expect(ids[ids.length - 1]).toBe("about");
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length);
  });

  it("sorts by order and keeps registration order for ties", () => {
    const list: SettingsSection[] = [
      { id: "b", title: "B", icon: Zap, order: 20, component: Dummy },
      { id: "a", title: "A", icon: Zap, order: 10, component: Dummy },
      { id: "c", title: "C", icon: Zap, order: 20, component: Dummy },
    ];
    expect(getSettingsSections(list).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("resolves the requested section or falls back to the first", () => {
    expect(resolveSettingsSection("appearance")?.id).toBe("appearance");
    expect(resolveSettingsSection("nope")?.id).toBe("vault");
    expect(resolveSettingsSection(null)?.id).toBe("vault");
  });

  it("has an anchor for every feature", () => {
    for (const f of ["clipboard", "search", "history", "home", "vaulttasks", "intel", "plugins", "export", "sync", "onboarding"]) {
      expect(source).toContain(`// @anchor:settings:${f}`);
      expect(source).toContain(`// @anchor:settings-import:${f}`);
    }
  });
});
