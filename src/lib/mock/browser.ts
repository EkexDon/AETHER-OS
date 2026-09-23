/** Mock handlers for `commands/browser_commands.rs`. External opens are
 *  logged; embedded webviews are tracked by label and emit navigation and
 *  title events, but nothing is rendered (there is no native webview). */
import type { BrowserInfo } from "../../types";
import { argString, mockEvents, registerReset, type MockHandlerMap } from "./runtime";

let webviews = new Map<string, string>();
let counter = 0;
registerReset(() => {
  webviews = new Map();
  counter = 0;
});

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error("relative URL without a base");
  }
}

function openExternal(url: string): void {
  const parsed = parseUrl(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid input: only http(s) URLs can be opened, got ${parsed.protocol}`);
  }
  console.info(`[mock] open in system browser: ${url}`);
}

function requireWebview(label: string): string {
  const url = webviews.get(label);
  if (url === undefined) throw new Error(`Webview ${label} not found`);
  return url;
}

function announce(label: string, url: string): void {
  setTimeout(() => {
    mockEvents.emit("browser-webview-nav", { label, url });
    mockEvents.emit("browser-webview-title", { label, title: parseUrl(url).hostname.replace(/^www\./, "") });
  }, 120);
}

export { openExternal as mockOpenExternal };

export const browserHandlers: MockHandlerMap = {
  cmd_browser_info: (): BrowserInfo => ({
    librewolf_installed: false,
    librewolf_path: null,
    default_browser: "Safari",
  }),
  cmd_browser_open: (args) => openExternal(argString(args, "url")),
  cmd_browser_open_librewolf: () => {
    throw new Error("invalid input: LibreWolf is not installed");
  },
  cmd_browser_webview_open: (args) => {
    const url = argString(args, "url");
    parseUrl(url);
    counter += 1;
    const label = `browser-webview-${counter}`;
    webviews.set(label, url);
    announce(label, url);
    return label;
  },
  cmd_browser_webview_close: (args) => {
    webviews.delete(argString(args, "label"));
  },
  cmd_browser_webview_navigate: (args) => {
    const label = argString(args, "label");
    const url = argString(args, "url");
    requireWebview(label);
    parseUrl(url);
    webviews.set(label, url);
    announce(label, url);
  },
  cmd_browser_webview_back: (args) => {
    requireWebview(argString(args, "label"));
  },
  cmd_browser_webview_forward: (args) => {
    requireWebview(argString(args, "label"));
  },
  cmd_browser_webview_reload: (args) => {
    const label = argString(args, "label");
    announce(label, requireWebview(label));
  },
  cmd_browser_webview_list: () => [...webviews.entries()],
  cmd_browser_webview_set_bounds: (args) => {
    requireWebview(argString(args, "label"));
  },
  cmd_browser_webview_show: (args) => {
    requireWebview(argString(args, "label"));
  },
  cmd_browser_webview_hide: (args) => {
    requireWebview(argString(args, "label"));
  },
  cmd_browser_webview_hide_all: () => undefined,
};
