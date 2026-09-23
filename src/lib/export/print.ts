/**
 * "Print / Save as PDF…" for one note.
 *
 * The print document from `cmd_export_print_document` is mounted in a
 * shadow root (so the app's CSS and the document's CSS never mix) at the
 * end of `<body>`. It is hidden on screen; for print media a global style
 * hides the app and shows only the document. Then `window.print()` opens
 * the system print dialog — in the desktop app Tauri routes it to the
 * webview's native print operation, where macOS offers "Save as PDF".
 *
 * The native dialog renders pages while it is open, so the document stays
 * mounted until `afterprint` fires or the user interacts with the app
 * again; it is replaced by the next print.
 */
import type { PrintDocument } from "../../types";

/** Id of the print host element. */
export const PRINT_ROOT_ID = "aether-print-root";
/** Id of the global print stylesheet. */
export const PRINT_STYLE_ID = "aether-print-style";
/** Body class active while a print document is mounted. */
export const PRINTING_CLASS = "is-export-printing";

const GLOBAL_PRINT_CSS = `
@media screen { #${PRINT_ROOT_ID} { display: none !important; } }
@media print {
  @page { size: A4; margin: 18mm 16mm 20mm; }
  html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; }
  /* Paper is light whatever the app theme: a dark color-scheme would paint a dark canvas. */
  html { color-scheme: light !important; background: Canvas !important; }
  body { background: none !important; }
  body.${PRINTING_CLASS} > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
  #${PRINT_ROOT_ID} { display: block !important; }
}
`;

/** Remove a mounted print document (no-op when none is mounted). */
export function unmountPrintDocument(doc: Document = document): void {
  doc.getElementById(PRINT_ROOT_ID)?.remove();
  doc.body.classList.remove(PRINTING_CLASS);
}

/** Mount `print` for print media; returns the host element. */
export function mountPrintDocument(print: PrintDocument, doc: Document = document): HTMLElement {
  unmountPrintDocument(doc);
  if (!doc.getElementById(PRINT_STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = PRINT_STYLE_ID;
    style.textContent = GLOBAL_PRINT_CSS;
    doc.head.appendChild(style);
  }
  const host = doc.createElement("div");
  host.id = PRINT_ROOT_ID;
  host.setAttribute("aria-hidden", "true");
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = print.css;
  const container = doc.createElement("div");
  container.innerHTML = print.body;
  shadow.append(style, container);
  doc.body.appendChild(host);
  doc.body.classList.add(PRINTING_CLASS);
  return host;
}

/** Resolve once every image in `root` has loaded (or failed), or after `timeoutMs`. */
export function waitForImages(root: ParentNode, timeoutMs = 3000): Promise<void> {
  const pending = [...root.querySelectorAll("img")].filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const done = () => {
      left -= 1;
      if (left <= 0) resolve();
    };
    pending.forEach((img) => {
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    });
    setTimeout(resolve, timeoutMs);
  });
}

/**
 * Print a note: mount the document, wait for its images, open the print
 * dialog with the note title as the job (and PDF file) name, clean up
 * afterwards.
 */
export async function printDocument(print: PrintDocument, win: Window = window): Promise<void> {
  const doc = win.document;
  const host = mountPrintDocument(print, doc);
  const previousTitle = doc.title;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    win.removeEventListener("afterprint", cleanup);
    doc.removeEventListener("pointerdown", cleanup, true);
    doc.removeEventListener("keydown", cleanup, true);
    if (doc.getElementById(PRINT_ROOT_ID) === host) unmountPrintDocument(doc);
    doc.title = previousTitle;
  };
  win.addEventListener("afterprint", cleanup);
  doc.title = print.title;
  try {
    if (host.shadowRoot) await waitForImages(host.shadowRoot);
    await Promise.resolve(win.print());
  } catch (error) {
    cleanup();
    throw error instanceof Error ? error : new Error(String(error));
  }
  // Browsers block in print() and fire afterprint; the desktop dialog is
  // asynchronous — keep the document until the user is back in the app.
  if (!cleaned) {
    doc.addEventListener("pointerdown", cleanup, true);
    doc.addEventListener("keydown", cleanup, true);
  }
}
