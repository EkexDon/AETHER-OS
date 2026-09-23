/** Update check types — mirror `engine/updater.rs`. */

/** Result of `cmd_check_for_updates`. */
export interface UpdateInfo {
  current: string;
  latest: string;
  update_available: boolean;
  /** Release page on github.com. */
  url: string;
  /** Release notes (Markdown). */
  notes: string;
  /** RFC 3339 publication time. */
  published_at: string | null;
}
