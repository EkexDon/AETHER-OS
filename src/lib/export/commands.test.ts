import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  exportPrintDocument: vi.fn(),
  exportListRecent: vi.fn().mockResolvedValue([]),
  exportClearRecent: vi.fn(),
}));
vi.mock("./print", () => ({ printDocument: vi.fn().mockResolvedValue(undefined) }));

import { exportPrintDocument } from "../ipc";
import { printDocument } from "./print";
import { exportCommands, printCurrentNote } from "./commands";
import { useExportStore } from "../exportStore";
import { useAetherStore } from "../store";
import { CORE_COMMANDS, type CommandContext } from "../commands/registry";

function ctx(): CommandContext & { views: string[]; infos: string[] } {
  const views: string[] = [];
  const infos: string[] = [];
  return {
    views,
    infos,
    view: "dashboard",
    setView: (mode: string) => views.push(mode),
    openSettings: vi.fn(),
    toggleCommandBar: vi.fn(),
    closeCommandBar: vi.fn(),
    openQuickCapture: vi.fn(),
    openWebClipper: vi.fn(),
    openShortcuts: vi.fn(),
    openNewNote: vi.fn(),
    toggleTheme: vi.fn(),
    setThemePreference: vi.fn(),
    toggleRailLabels: vi.fn(),
    toggleDensity: vi.fn(),
    toggleAgentPanel: vi.fn(),
    toast: {
      success: vi.fn(() => 1),
      error: vi.fn(() => 1),
      info: vi.fn((title: unknown) => {
        infos.push(String(title));
        return 1;
      }),
      dismiss: vi.fn(),
    },
  } as unknown as CommandContext & { views: string[]; infos: string[] };
}

describe("export commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExportStore.setState({ wizard: null });
    useAetherStore.setState({ selectedNotePath: null });
  });

  it("have unique ids and shortcuts that do not clash with core commands", () => {
    const ids = exportCommands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("export."))).toBe(true);
    const core = new Set(CORE_COMMANDS.filter((c) => !c.id.startsWith("export.")).map((c) => c.shortcut));
    for (const c of exportCommands) {
      expect(c.shortcut).toBeTruthy();
      expect(core.has(c.shortcut)).toBe(false);
    }
  });

  it("open the matching wizard in the Export view", async () => {
    const c = ctx();
    useAetherStore.setState({ selectedNotePath: "/v/Note.md" });
    await exportCommands.find((x) => x.id === "export.noteHtml")!.run(c);
    expect(c.views).toEqual(["export"]);
    expect(useExportStore.getState().wizard).toMatchObject({ flow: "html", scope: { kind: "note", value: "/v/Note.md" } });
    await exportCommands.find((x) => x.id === "export.site")!.run(c);
    expect(useExportStore.getState().wizard).toMatchObject({ flow: "site", scope: { kind: "vault" } });
    await exportCommands.find((x) => x.id === "export.bundle")!.run(c);
    expect(useExportStore.getState().wizard?.flow).toBe("bundle");
  });

  it("print the current note, or ask for one", async () => {
    const c = ctx();
    await printCurrentNote(c);
    expect(c.infos).toEqual(["Open a note to print it"]);
    expect(useExportStore.getState().wizard?.flow).toBe("html");
    expect(printDocument).not.toHaveBeenCalled();

    const doc = { title: "T", css: "", body: "", warnings: [] };
    vi.mocked(exportPrintDocument).mockResolvedValue(doc);
    useAetherStore.setState({ selectedNotePath: "/v/Note.md" });
    await printCurrentNote(ctx());
    expect(exportPrintDocument).toHaveBeenCalledWith("/v/Note.md", expect.objectContaining({ theme: "auto" }));
    expect(printDocument).toHaveBeenCalledWith(doc);
  });
});
