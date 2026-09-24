import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import type { VaultNote } from "../../types";
import { noteEditorExtensions } from "./extensions";
import { editorMarkdown } from "./noteBody";
import { headingLine, isCreatableNoteName, resolveWikilink, storeWikilinkHost, type WikilinkHost } from "./wikilinkHost";
import { useAetherStore } from "../store";
import { useVaultTasksStore } from "../vaultTasksStore";
import { clearVaultAssetCache } from "../vaultAssets";
import { resetMockState, setMockLatency } from "../mock/backend";
import { MOCK_VAULT_ROOT } from "../mock/fixtures/vault";

const ROOT = "/vault";
const NOTES: VaultNote[] = [
  { path: `${ROOT}/AETHER-OS.md`, name: "AETHER-OS", mtime: 1 },
  { path: `${ROOT}/sub/Deep Note.md`, name: "Deep Note", mtime: 1 },
];

function host(overrides: Partial<WikilinkHost> = {}): WikilinkHost {
  return {
    notes: () => NOTES,
    vaultRoot: () => ROOT,
    currentNotePath: () => `${ROOT}/AETHER-OS.md`,
    open: vi.fn(),
    create: vi.fn(async () => null),
    subscribe: () => () => {},
    ...overrides,
  };
}

beforeAll(() => {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (!proto.getClientRects) proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(markdown: string, h: WikilinkHost = host()): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: noteEditorExtensions({ wikilinks: h }), content: "" });
  editor.commands.setContent(markdown, { emitUpdate: false });
  return element;
}

describe("wikilink chips", () => {
  it("shows the label, marks missing notes and opens the link on click", () => {
    const h = host();
    const root = mount("See [[AETHER-OS#Pillars|the project]] and [[Missing note]].", h);
    const chips = [...root.querySelectorAll<HTMLElement>(".wikilink")];
    expect(chips.map((c) => c.textContent)).toEqual(["the project", "Missing note"]);
    expect(chips.map((c) => c.dataset.state)).toEqual(["resolved", "unresolved"]);
    expect(chips[0].title).toContain("AETHER-OS");
    chips[0].dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(h.open).toHaveBeenCalledWith({ target: "AETHER-OS", heading: "Pillars", alias: "the project" });
    // The document still saves the exact source.
    expect(editorMarkdown(editor!)).toBe("See [[AETHER-OS#Pillars|the project]] and [[Missing note]].");
  });

  it("re-resolves when the note list changes", () => {
    let notes: VaultNote[] = [];
    const listeners = new Set<() => void>();
    const h = host({
      notes: () => notes,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });
    const root = mount("[[AETHER-OS]]", h);
    const chip = root.querySelector<HTMLElement>(".wikilink")!;
    expect(chip.dataset.state).toBe("unresolved");
    notes = NOTES;
    listeners.forEach((l) => l());
    expect(chip.dataset.state).toBe("resolved");
    editor!.destroy();
    editor = null;
    expect(listeners.size).toBe(0);
  });

  it("opens the selected link with Enter", () => {
    const h = host();
    mount("[[Deep Note]]", h);
    editor!.view.dispatch(editor!.state.tr.setSelection(NodeSelection.create(editor!.state.doc, 1)));
    const handled = editor!.view.someProp("handleKeyDown", (f) => f(editor!.view, new KeyboardEvent("keydown", { key: "Enter" })));
    expect(handled).toBe(true);
    expect(h.open).toHaveBeenCalledWith({ target: "Deep Note", heading: null, alias: null });
  });

  it("turns back into editable text on double-click", () => {
    const root = mount("Go [[AETHER-OS]] now");
    root.querySelector(".wikilink")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(editor!.state.doc.textContent).toBe("Go [[AETHER-OS]] now");
    expect(editor!.state.doc.firstChild!.childCount).toBe(1);
  });
});

describe("embeds", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AETHER_MOCK", "1");
    setMockLatency(0);
    resetMockState();
    clearVaultAssetCache();
    useAetherStore.setState({ vaultPath: MOCK_VAULT_ROOT, selectedNotePath: `${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS.md` });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("shows ![[image]] from the vault at the requested width and keeps the source", async () => {
    const root = mount("![[aether-architecture.png|480]]");
    const wrapper = root.querySelector<HTMLElement>(".editor-image")!;
    expect(wrapper).not.toBeNull();
    const img = wrapper.querySelector("img")!;
    expect(img.style.width).toBe("480px");
    await vi.waitFor(() => expect(img.getAttribute("src")).toMatch(/^data:image\//));
    expect(editorMarkdown(editor!)).toBe("![[aether-architecture.png|480]]");
  });

  it("shows note and media embeds as chips", () => {
    const h = host();
    const root = mount("![[Deep Note]] and ![[clip.mp4]]", h);
    const chips = [...root.querySelectorAll<HTMLElement>(".wikiembed-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["EmbedDeep Note", "Videoclip.mp4"]);
    chips[0].dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(h.open).toHaveBeenCalledWith({ target: "Deep Note", heading: null, alias: null });
    expect(editorMarkdown(editor!)).toBe("![[Deep Note]] and ![[clip.mp4]]");
  });
});

describe("raw source nodes", () => {
  it("show math and comments verbatim and edit them as text on double-click", () => {
    const root = mount("Euler $e^{i\\pi}$ and %%note%%");
    const raws = [...root.querySelectorAll<HTMLElement>(".md-raw")];
    expect(raws.map((r) => r.textContent)).toEqual(["$e^{i\\pi}$", "%%note%%"]);
    const pos = editor!.view.posAtDOM(raws[0], 0);
    editor!.view.someProp("handleDoubleClickOn", (f) => f(editor!.view, pos, editor!.state.doc.nodeAt(pos)!, pos, new MouseEvent("dblclick"), true));
    expect(editor!.state.doc.textContent).toBe("Euler $e^{i\\pi}$ and %%note%%");
    expect(editorMarkdown(editor!)).toBe("Euler $e^{i\\pi}$ and %%note%%");
  });
});

describe("wikilink host helpers", () => {
  it("resolves links by name, path and to the open note for [[#heading]]", () => {
    const h = host();
    expect(resolveWikilink(h, "aether-os")?.path).toBe(`${ROOT}/AETHER-OS.md`);
    expect(resolveWikilink(h, "sub/Deep Note|alias")?.name).toBe("Deep Note");
    expect(resolveWikilink(h, "#Heading")?.name).toBe("AETHER-OS");
    expect(resolveWikilink(h, "Nope")).toBeNull();
  });

  it("finds heading and block lines", () => {
    const content = "---\ntitle: x\n---\n# Title\n\n```\n## Not this\n```\n## Pillars ##\ntext ^block-1\n";
    expect(headingLine(content, "pillars")).toBe(8);
    expect(headingLine(content, "Not this")).toBeNull();
    expect(headingLine(content, "^block-1")).toBe(9);
  });

  it("accepts only names a vault can hold", () => {
    expect(isCreatableNoteName("Weekly review")).toBe(true);
    expect(isCreatableNoteName("folder/Note")).toBe(true);
    for (const bad of ["", "a|b", "a#b", "a:b", "../up", "/abs", "a]]"]) expect(isCreatableNoteName(bad), bad).toBe(false);
  });

  it("opens resolved notes in the editor and queues the heading line", async () => {
    vi.stubEnv("VITE_AETHER_MOCK", "1");
    setMockLatency(0);
    resetMockState();
    const { getVaultNotes } = await import("../ipc");
    useAetherStore.setState({ vaultPath: MOCK_VAULT_ROOT, vaultNotes: await getVaultNotes(), view: "dashboard", selectedNotePath: null, openNoteTabs: [] });
    useVaultTasksStore.setState({ pendingLine: null });
    storeWikilinkHost.open({ target: "AETHER-OS", heading: "Tasks", alias: null });
    const path = `${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS.md`;
    expect(useAetherStore.getState().selectedNotePath).toBe(path);
    expect(useAetherStore.getState().view).toBe("editor");
    await vi.waitFor(() => expect(useVaultTasksStore.getState().pendingLine?.notePath).toBe(path));
    vi.unstubAllEnvs();
  });

  it("creates a missing note when its link is followed", async () => {
    vi.stubEnv("VITE_AETHER_MOCK", "1");
    setMockLatency(0);
    resetMockState();
    const { getVaultNotes, getNoteContent } = await import("../ipc");
    useAetherStore.setState({ vaultPath: MOCK_VAULT_ROOT, vaultNotes: await getVaultNotes(), selectedNotePath: null, openNoteTabs: [] });
    storeWikilinkHost.open({ target: "Fresh idea", heading: null, alias: null });
    await vi.waitFor(() => expect(useAetherStore.getState().selectedNotePath).toMatch(/Fresh idea\.md$/));
    expect(await getNoteContent(useAetherStore.getState().selectedNotePath!)).toBe("# Fresh idea\n\n");
    expect(useAetherStore.getState().vaultNotes.some((n) => n.name === "Fresh idea")).toBe(true);
    vi.unstubAllEnvs();
  });
});
