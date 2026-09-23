/**
 * Truncated text always has a tooltip: one document-level `mouseover`
 * listener gives any element that is cut off with `text-overflow:
 * ellipsis` (the hovered element or one of its two nearest ancestors) a
 * native `title` with its full text, and removes that title again once
 * the text fits. Elements with their own `title` or `aria-label`, or a
 * `data-no-overflow-title` attribute, are left alone.
 */

const AUTO = "data-overflow-title";

function isTruncated(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/** Update the automatic title of `el`; returns true when it is an ellipsis element. */
export function syncOverflowTitle(el: HTMLElement, view: Window = window): boolean {
  if (el.hasAttribute("data-no-overflow-title")) return false;
  const style = view.getComputedStyle(el);
  const clamped = !!style.webkitLineClamp && style.webkitLineClamp !== "none";
  if (style.textOverflow !== "ellipsis" && !clamped) return false;
  const auto = el.hasAttribute(AUTO);
  if (!auto && (el.hasAttribute("title") || el.hasAttribute("aria-label"))) return true;
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text && isTruncated(el)) {
    if (el.getAttribute("title") !== text) el.setAttribute("title", text);
    el.setAttribute(AUTO, "");
  } else if (auto) {
    el.removeAttribute("title");
    el.removeAttribute(AUTO);
  }
  return true;
}

/** Install the listener once per document; returns an uninstall function. */
export function installOverflowTitles(doc: Document = document): () => void {
  const view = doc.defaultView ?? window;
  const onOver = (event: Event) => {
    let el = event.target instanceof view.HTMLElement ? event.target : null;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
      if (syncOverflowTitle(el, view)) return;
    }
  };
  doc.addEventListener("mouseover", onOver, { passive: true });
  return () => doc.removeEventListener("mouseover", onOver);
}
