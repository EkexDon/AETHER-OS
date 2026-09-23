/** Browser types — mirror `engine/browser.rs` / `commands/browser_commands.rs`. */

/** Installed external browsers. */
export interface BrowserInfo {
  librewolf_installed: boolean;
  librewolf_path: string | null;
  default_browser: string;
}
