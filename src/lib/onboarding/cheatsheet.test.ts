import { describe, expect, it } from "vitest";
import { buildCheatSheet, collectShortcuts, filterShortcuts, withShortcutsOnly, type CommandLike } from "./cheatsheet";

const COMMANDS: CommandLike[] = [
  { id: "app.commandPalette", title: "Command palette", group: "General", shortcut: "mod+k", keywords: ["launcher"] },
  { id: "note.new", title: "New note", group: "Capture", shortcut: "mod+n" },
  { id: "theme.light", title: "Use light theme", group: "Appearance" },
  { id: "capture.quick", title: "Quick capture | daily", group: "Capture", shortcut: "mod+shift+n" },
  { id: "note.new", title: "Duplicate id", group: "Capture", shortcut: "mod+d" },
];
const EDITOR = [{ group: "Notes editor", items: [{ title: "Bold", shortcut: "mod+b" }] }];

describe("shortcut cheat sheet", () => {
  it("groups commands in first-seen order and appends editor shortcuts", () => {
    const groups = collectShortcuts(COMMANDS, EDITOR);
    expect(groups.map((g) => g.group)).toEqual(["General", "Capture", "Appearance", "Notes editor"]);
    expect(groups[1].entries.map((e) => e.title)).toEqual(["New note", "Quick capture | daily"]);
    expect(groups[3].entries[0]).toMatchObject({ title: "Bold", runnable: false, shortcut: "mod+b" });
  });

  it("filters by title, group, keyword and key", () => {
    const groups = collectShortcuts(COMMANDS, EDITOR);
    expect(filterShortcuts(groups, "launcher", true).flatMap((g) => g.entries.map((e) => e.id))).toEqual(["app.commandPalette"]);
    expect(filterShortcuts(groups, "appearance", true).map((g) => g.group)).toEqual(["Appearance"]);
    expect(filterShortcuts(groups, "⇧⌘N", true).flatMap((g) => g.entries.map((e) => e.id))).toContain("capture.quick");
    expect(filterShortcuts(groups, "shift+n", false).flatMap((g) => g.entries.map((e) => e.id))).toContain("capture.quick");
    expect(filterShortcuts(groups, "   ", true)).toBe(groups);
    expect(withShortcutsOnly(groups).map((g) => g.group)).toEqual(["General", "Capture", "Notes editor"]);
  });

  it("renders a Markdown table per group and escapes pipes", () => {
    const md = buildCheatSheet(collectShortcuts(COMMANDS, EDITOR), { mac: true, version: "0.2.0" });
    expect(md.startsWith("# AETHER-OS keyboard shortcuts\n")).toBe(true);
    expect(md).toContain("Version 0.2.0 · ⌘ = Command");
    expect(md).toContain("## Capture\n\n| Action | Shortcut |\n| --- | --- |\n| New note | `⌘N` |");
    expect(md).toContain("| Quick capture \\| daily | `⇧⌘N` |");
    expect(md).not.toContain("Use light theme");
    expect(md).not.toContain("## Appearance");
    expect(md.endsWith("\n")).toBe(true);

    const pc = buildCheatSheet(collectShortcuts(COMMANDS, EDITOR), { mac: false });
    expect(pc).toContain("| Command palette | `Ctrl+K` |");
  });
});
