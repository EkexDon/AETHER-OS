import { afterEach, describe, expect, it } from "vitest";
import { installOverflowTitles, syncOverflowTitle } from "./overflowTitle";

function truncating(text: string, overflow: boolean): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  el.style.textOverflow = "ellipsis";
  el.style.overflow = "hidden";
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => (overflow ? 300 : 100) });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => 100 });
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("overflow titles", () => {
  it("adds the full text as a title while the text is cut off", () => {
    const el = truncating("A very long clipboard entry title", true);
    expect(syncOverflowTitle(el)).toBe(true);
    expect(el.getAttribute("title")).toBe("A very long clipboard entry title");
    Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => 100 });
    syncOverflowTitle(el);
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("never overrides an explicit title and ignores non-ellipsis elements", () => {
    const own = truncating("text", true);
    own.title = "Custom";
    syncOverflowTitle(own);
    expect(own.title).toBe("Custom");
    const plain = document.createElement("span");
    plain.textContent = "x";
    document.body.appendChild(plain);
    expect(syncOverflowTitle(plain)).toBe(false);
  });

  it("works through a single document listener on hover", () => {
    const uninstall = installOverflowTitles();
    const el = truncating("Hovered and truncated", true);
    const inner = document.createElement("b");
    inner.textContent = "!";
    el.appendChild(inner);
    inner.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(el.getAttribute("title")).toBe("Hovered and truncated!");
    uninstall();
  });
});
