import { describe, expect, it, vi } from "vitest";
import { Zap } from "lucide-react";
import {
  CORE_COMMANDS,
  findCommandForEvent,
  getCommands,
  groupCommands,
  isCommandEnabled,
  registerCommands,
  runCommand,
  viewNavigationCommands,
  type CommandContext,
  type CommandContribution,
} from "./registry";
import { fuzzyScore, scoreFields } from "./fuzzy";
import registrySource from "./registry.ts?raw";

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  const noop = () => undefined;
  return {
    view: "dashboard",
    setView: vi.fn(),
    openSettings: vi.fn(),
    toggleLauncher: vi.fn(),
    closeLauncher: noop,
    openQuickCapture: vi.fn(),
    openWebClipper: vi.fn(),
    openShortcuts: vi.fn(),
    openNewNote: vi.fn(),
    toggleTheme: vi.fn(),
    setThemePreference: vi.fn(),
    toggleRailLabels: vi.fn(),
    toggleDensity: vi.fn(),
    toggleAgentPanel: vi.fn(),
    toast: { success: vi.fn(() => 1), error: vi.fn(() => 1), info: vi.fn(() => 1), dismiss: vi.fn() },
    ...overrides,
  };
}

describe("command registry", () => {
  it("ships the required built-in commands with unique ids", () => {
    const ids = CORE_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "app.commandPalette",
      "theme.toggle",
      "appearance.toggleRailLabels",
      "app.settings",
      "capture.quick",
      "capture.webClip",
      "note.new",
      "app.shortcuts",
    ]) {
      expect(ids).toContain(id);
    }
    expect(getCommands().map((c) => c.id)).toEqual(expect.arrayContaining(ids));
  });

  it("has an anchor for every feature key", () => {
    for (const f of ["clipboard", "search", "history", "home", "vaulttasks", "intel", "plugins", "export", "sync", "onboarding"]) {
      expect(registrySource).toContain(`// @anchor:command:${f}`);
    }
  });

  it("registers, replaces and unregisters contributions", () => {
    const a: CommandContribution = { id: "test.a", title: "Alpha", group: "Test", run: vi.fn() };
    const off = registerCommands([a]);
    expect(getCommands().find((c) => c.id === "test.a")).toBe(a);
    const a2 = { ...a, title: "Alpha 2" };
    const off2 = registerCommands([a2]);
    expect(getCommands().filter((c) => c.id === "test.a")).toHaveLength(1);
    off(); // stale disposer must not remove the replacement
    expect(getCommands().find((c) => c.id === "test.a")?.title).toBe("Alpha 2");
    off2();
    expect(getCommands().find((c) => c.id === "test.a")).toBeUndefined();
  });

  it("runs commands with the given context and honours `when`", async () => {
    const run = vi.fn();
    const off = registerCommands([
      { id: "test.run", title: "Run", group: "Test", run },
      { id: "test.hidden", title: "Hidden", group: "Test", run, when: () => false },
    ]);
    const c = ctx();
    expect(await runCommand("test.run", c)).toBe(true);
    expect(run).toHaveBeenCalledWith(c);
    expect(await runCommand("test.hidden", c)).toBe(false);
    expect(await runCommand("does.not.exist", c)).toBe(false);
    off();
  });

  it("surfaces failures as an error toast", async () => {
    const off = registerCommands([
      {
        id: "test.fail",
        title: "Explode",
        group: "Test",
        run: () => {
          throw new Error("boom");
        },
      },
    ]);
    const c = ctx();
    await expect(runCommand("test.fail", c)).rejects.toThrow("boom");
    expect(c.toast.error).toHaveBeenCalledWith("Explode failed", { description: "boom" });
    off();
  });

  it("treats a throwing `when` as disabled", () => {
    expect(isCommandEnabled({ id: "x", title: "x", group: "g", run: vi.fn(), when: () => { throw new Error(); } }, ctx())).toBe(false);
  });

  it("finds the command bound to a key event", () => {
    const c = ctx();
    const palette = findCommandForEvent({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, c);
    const alt = findCommandForEvent({ key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, c);
    expect([palette?.id, alt?.id]).toContain("app.commandPalette");
  });

  it("groups commands preserving first-seen order", () => {
    const groups = groupCommands([
      { id: "1", title: "a", group: "B", run: vi.fn() },
      { id: "2", title: "b", group: "A", run: vi.fn() },
      { id: "3", title: "c", group: "B", run: vi.fn() },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["B", "A"]);
    expect(groups[0].commands.map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("derives navigation commands from views", () => {
    const [cmd] = viewNavigationCommands([{ mode: "tasks", label: "Tasks", icon: Zap, shortcut: "mod+0" }]);
    expect(cmd).toMatchObject({ id: "view.tasks", title: "Go to Tasks", shortcut: "mod+0", group: "Navigation" });
    const c = ctx();
    void cmd.run(c);
    expect(c.setView).toHaveBeenCalledWith("tasks");
  });
});

describe("fuzzy", () => {
  it("ranks exact > prefix > word > substring > subsequence", () => {
    const exact = fuzzyScore("notes", "notes");
    const prefix = fuzzyScore("not", "notes view");
    const word = fuzzyScore("vie", "notes view");
    const sub = fuzzyScore("tes", "notes view");
    const seq = fuzzyScore("stp", "setup");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
    expect(seq).toBeGreaterThan(0);
  });

  it("rejects scattered subsequences and misses", () => {
    expect(fuzzyScore("sett", "Ollama Setup Tutorial")).toBe(0);
    expect(fuzzyScore("xyz", "notes")).toBe(0);
    expect(fuzzyScore("", "anything")).toBe(1);
  });

  it("weights secondary fields below the title", () => {
    expect(scoreFields("theme", "Toggle light / dark theme")).toBeGreaterThan(0);
    expect(scoreFields("dark mode", "Toggle", ["dark mode"])).toBeLessThan(fuzzyScore("dark mode", "dark mode"));
  });
});
