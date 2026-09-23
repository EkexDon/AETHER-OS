/** Browser commands (`src-tauri/src/commands/browser_commands.rs`). */
import type { BrowserInfo } from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Installed external browsers. */
export const getBrowserInfo = () => call<BrowserInfo>("cmd_browser_info");
/** Open a URL in the system default browser. */
export const browserOpen = (url: string) => call<void>("cmd_browser_open", { url });
/** Open a URL in LibreWolf (errors when it is not installed). */
export const browserOpenLibreWolf = (url: string) => call<void>("cmd_browser_open_librewolf", { url });

/** Logical-pixel rectangle relative to the main window's content area. */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Open a native webview embedded in the main window; returns its label. */
export const browserWebviewOpen = (url: string, rect: BrowserRect) =>
  call<string>("cmd_browser_webview_open", { url, ...rect });
/** Close an embedded webview. */
export const browserWebviewClose = (label: string) =>
  call<void>("cmd_browser_webview_close", { label });
/** Navigate an embedded webview. */
export const browserWebviewNavigate = (label: string, url: string) =>
  call<void>("cmd_browser_webview_navigate", { label, url });
/** History back. */
export const browserWebviewBack = (label: string) =>
  call<void>("cmd_browser_webview_back", { label });
/** History forward. */
export const browserWebviewForward = (label: string) =>
  call<void>("cmd_browser_webview_forward", { label });
/** Reload the page. */
export const browserWebviewReload = (label: string) =>
  call<void>("cmd_browser_webview_reload", { label });
/** Open webviews as `[label, url]` pairs. */
export const browserWebviewList = () =>
  call<[string, string][]>("cmd_browser_webview_list");
/** Move/resize an embedded webview. */
export const browserWebviewSetBounds = (label: string, rect: BrowserRect) =>
  call<void>("cmd_browser_webview_set_bounds", { label, ...rect });
/** Show an embedded webview. */
export const browserWebviewShow = (label: string) =>
  call<void>("cmd_browser_webview_show", { label });
/** Hide an embedded webview. */
export const browserWebviewHide = (label: string) =>
  call<void>("cmd_browser_webview_hide", { label });
/** Hide every embedded webview (leaving the browser view). */
export const browserWebviewHideAll = () =>
  call<void>("cmd_browser_webview_hide_all");

/** Payload of `browser-webview-nav`. */
export interface BrowserNavEvent {
  label: string;
  url: string;
}

/** Payload of `browser-webview-title`. */
export interface BrowserTitleEvent {
  label: string;
  title: string;
}

/** Subscribe to navigation changes of embedded webviews. */
export function onBrowserWebviewNav(handler: (event: BrowserNavEvent) => void): Promise<UnlistenFn> {
  return listenSafe<BrowserNavEvent>("browser-webview-nav", handler);
}

/** Subscribe to document title changes of embedded webviews. */
export function onBrowserWebviewTitle(handler: (event: BrowserTitleEvent) => void): Promise<UnlistenFn> {
  return listenSafe<BrowserTitleEvent>("browser-webview-title", handler);
}
