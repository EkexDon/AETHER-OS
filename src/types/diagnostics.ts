/** Diagnostics types — mirror `engine/diagnostics.rs` / `commands/diagnostics_commands.rs`. */

/** Row of the crash report list (newest first). */
export interface CrashReportSummary {
  /** File stem; pass to `readCrashReport`. */
  id: string;
  /** RFC 3339 timestamp (UTC). */
  created_at: string;
  /** "panic" (Rust) or "frontend" (webview render crash). */
  kind: string;
  /** First line of the crash message. */
  message: string;
  /** Size in bytes. */
  size: number;
}

/** Full crash report. */
export interface CrashReport {
  id: string;
  created_at: string;
  kind: string;
  content: string;
}

/** Error details sent to `cmd_log_frontend_error` (snake_case: nested struct). */
export interface FrontendErrorPayload {
  message: string;
  stack?: string | null;
  component_stack?: string | null;
  /** "boundary" | "window.onerror" | "unhandledrejection" | … */
  source?: string | null;
  view?: string | null;
  url?: string | null;
  /** True when the error took down a view; also writes a crash report. */
  fatal?: boolean;
}

/** Version and platform of the running app. */
export interface AppInfo {
  version: string;
  tauri_version: string;
  os: string;
  arch: string;
  data_dir: string;
}
