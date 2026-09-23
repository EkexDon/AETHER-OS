import { browserOpen, isTauriRuntime } from "../ipc";

/**
 * Open a URL in the system browser (desktop app) or a new tab (browser
 * preview). Throws with the backend's message when the desktop open fails.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) await browserOpen(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
