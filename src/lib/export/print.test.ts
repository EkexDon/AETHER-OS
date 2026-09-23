import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountPrintDocument,
  printDocument,
  PRINT_ROOT_ID,
  PRINT_STYLE_ID,
  PRINTING_CLASS,
  unmountPrintDocument,
  waitForImages,
} from "./print";
import type { PrintDocument } from "../../types";

const DOC: PrintDocument = {
  title: "My Note",
  css: ".aether-doc { color: red; }",
  body: '<div class="aether-doc aether-print"><h1 class="doc-title">My Note</h1></div>',
  warnings: [],
};

afterEach(() => {
  unmountPrintDocument();
  document.getElementById(PRINT_STYLE_ID)?.remove();
  vi.restoreAllMocks();
});

describe("print document", () => {
  it("mounts the document in a shadow root and hides the app for print", () => {
    const host = mountPrintDocument(DOC);
    expect(document.getElementById(PRINT_ROOT_ID)).toBe(host);
    expect(host.shadowRoot?.querySelector(".doc-title")?.textContent).toBe("My Note");
    expect(host.shadowRoot?.querySelector("style")?.textContent).toContain("color: red");
    expect(document.body.classList.contains(PRINTING_CLASS)).toBe(true);
    const global = document.getElementById(PRINT_STYLE_ID)?.textContent ?? "";
    expect(global).toContain(`body.${PRINTING_CLASS} > *:not(#${PRINT_ROOT_ID})`);
    expect(global).toContain("@page");

    // Mounting again replaces the previous document.
    mountPrintDocument({ ...DOC, body: "<p>second</p>" });
    expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`)).toHaveLength(1);
    unmountPrintDocument();
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
    expect(document.body.classList.contains(PRINTING_CLASS)).toBe(false);
  });

  it("prints with the note title and cleans up after printing", async () => {
    document.title = "AETHER-OS";
    const print = vi.fn(() => {
      expect(document.title).toBe("My Note");
      expect(document.getElementById(PRINT_ROOT_ID)).not.toBeNull();
      window.dispatchEvent(new Event("afterprint"));
    });
    vi.spyOn(window, "print").mockImplementation(print);
    await printDocument(DOC);
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
    expect(document.title).toBe("AETHER-OS");
  });

  it("keeps the document for an asynchronous dialog until the user returns", async () => {
    vi.spyOn(window, "print").mockImplementation(() => undefined);
    await printDocument(DOC);
    expect(document.getElementById(PRINT_ROOT_ID)).not.toBeNull();
    document.dispatchEvent(new Event("pointerdown"));
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
  });

  it("cleans up and rethrows when printing fails", async () => {
    vi.spyOn(window, "print").mockImplementation(() => {
      throw new Error("no printer");
    });
    await expect(printDocument(DOC)).rejects.toThrow("no printer");
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
  });

  it("waits for images with a timeout", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { value: false });
    root.appendChild(img);
    let done = false;
    const wait = waitForImages(root, 500).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    img.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    await wait;
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});
