import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { noteEditorExtensions } from "./extensions";
import { imageSourceKind } from "./vaultImage";
import { useAetherStore } from "../store";
import { clearVaultAssetCache } from "../vaultAssets";
import { resetMockState, setMockLatency } from "../mock/backend";
import { MOCK_VAULT_ROOT } from "../mock/fixtures/vault";

let editor: Editor | null = null;

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  clearVaultAssetCache();
  useAetherStore.setState({ vaultPath: MOCK_VAULT_ROOT, selectedNotePath: `${MOCK_VAULT_ROOT}/03-Resources/Sauerteigbrot Rezept.md` });
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  vi.unstubAllEnvs();
});

function mount(markdown: string): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: noteEditorExtensions(), content: "" });
  editor.commands.setContent(markdown, { emitUpdate: false });
  return element;
}

describe("VaultImage", () => {
  it("classifies sources", () => {
    expect(imageSourceKind("https://example.com/a.png")).toBe("direct");
    expect(imageSourceKind("data:image/png;base64,AAAA")).toBe("direct");
    expect(imageSourceKind("attachments/a.png")).toBe("vault");
    expect(imageSourceKind("javascript:alert(1)")).toBe("blocked");
    expect(imageSourceKind("")).toBe("blocked");
  });

  it("loads vault images in the editor without changing the Markdown", async () => {
    const root = mount("# Brot\n\n![Brot](attachments/sourdough.jpg)\n");
    const wrapper = root.querySelector(".editor-image") as HTMLElement;
    expect(wrapper.dataset.state).toBe("loading");
    await vi.waitFor(() => expect(root.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/));
    const storage = editor!.storage as unknown as { markdown: { getMarkdown: () => string } };
    expect(storage.markdown.getMarkdown()).toContain("![Brot](attachments/sourdough.jpg)");
  });

  it("shows a placeholder for missing files", async () => {
    const root = mount("![Gone](nope/missing.png)\n");
    await vi.waitFor(() => expect((root.querySelector(".editor-image") as HTMLElement).dataset.state).toBe("error"));
    expect(root.querySelector(".editor-image-state")?.textContent).toBe("Image unavailable · Gone");
  });
});
