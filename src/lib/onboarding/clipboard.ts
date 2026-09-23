/**
 * Copy text to the system clipboard. Uses the async Clipboard API and falls
 * back to a hidden textarea + `execCommand("copy")` where the API is not
 * available (older webviews, non-secure contexts). Throws when both fail.
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Permission denied or unsupported: try the legacy path below.
  }
  if (typeof document === "undefined") throw new Error("The clipboard is not available.");
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    area.remove();
    previous?.focus();
  }
  if (!ok) throw new Error("The clipboard is not available.");
}
