/** Crash reports & diagnostics commands (`src-tauri/src/commands/diagnostics_commands.rs`). */
import type { AppInfo, CrashReport, CrashReportSummary, FrontendErrorPayload } from "../../types";
import { call } from "./core";

/** Local crash reports, newest first. */
export const listCrashReports = () => call<CrashReportSummary[]>("cmd_list_crash_reports");
/** Full text of one crash report. */
export const readCrashReport = (id: string) => call<CrashReport>("cmd_read_crash_report", { id });
/** Delete all crash reports; returns how many were removed. */
export const clearCrashReports = () => call<number>("cmd_clear_crash_reports");
/** Append a frontend error to `logs/aether.log` (fatal ones also become crash reports). */
export const logFrontendError = (payload: FrontendErrorPayload) =>
  call<void>("cmd_log_frontend_error", { payload });
/** Reveal the app data directory in the file manager. */
export const openAppDataDir = () => call<void>("cmd_open_app_data_dir");
/** Version, platform and data directory of the running app. */
export const getAppInfo = () => call<AppInfo>("cmd_get_app_info");
