/** Mock handlers for `commands/diagnostics_commands.rs`: an in-memory
 *  crash report list (seeded with one sample) and frontend error log. */
import pkg from "../../../package.json";
import type { AppInfo, CrashReport, CrashReportSummary, FrontendErrorPayload } from "../../types";
import { argObject, argString, registerReset, type MockHandlerMap } from "./runtime";

const DATA_DIR = "/Users/demo/Library/Application Support/com.ekin.aetheros";

interface DiagnosticsState {
  reports: CrashReport[];
  log: string[];
}

function reportId(date: Date): string {
  return date.toISOString().replace(/:/g, "-");
}

function renderFrontendReport(payload: FrontendErrorPayload, at: Date): string {
  const lines = [
    "AETHER-OS crash report",
    "",
    "kind: frontend",
    `time: ${at.toISOString()}`,
    `app_version: ${pkg.version}`,
    "os: macOS 15 (aarch64) — mock",
    `source: ${payload.source ?? "unknown"}`,
    `view: ${payload.view ?? "unknown"}`,
    `url: ${payload.url ?? ""}`,
    `message: ${payload.message.split("\n")[0]}`,
    "",
    "full message:",
    `    ${payload.message}`,
  ];
  if (payload.stack) lines.push("", "stack:", ...payload.stack.split("\n").map((l) => `    ${l}`));
  if (payload.component_stack) {
    lines.push("", "component stack:", ...payload.component_stack.split("\n").map((l) => `    ${l}`));
  }
  return `${lines.join("\n")}\n`;
}

function seed(): DiagnosticsState {
  const at = new Date(Date.now() - 26 * 3600 * 1000);
  const sample: FrontendErrorPayload = {
    message: "TypeError: Cannot read properties of undefined (reading 'nodes')",
    stack: "TypeError: Cannot read properties of undefined (reading 'nodes')\n    at VaultGraph (VaultGraph.tsx:88:21)",
    component_stack: "    at VaultGraph\n    at Suspense\n    at App",
    source: "boundary",
    view: "Graph",
    url: "http://127.0.0.1:1420/",
    fatal: true,
  };
  return {
    reports: [{ id: reportId(at), created_at: at.toISOString(), kind: "frontend", content: renderFrontendReport(sample, at) }],
    log: [],
  };
}

let state = seed();
registerReset(() => {
  state = seed();
});

/** Lines written by `cmd_log_frontend_error` (tests inspect this). */
export function mockDiagnosticsLog(): string[] {
  return [...state.log];
}

function summarize(report: CrashReport): CrashReportSummary {
  const message = /^message: (.*)$/m.exec(report.content)?.[1] ?? "";
  return {
    id: report.id,
    created_at: report.created_at,
    kind: report.kind,
    message,
    size: new TextEncoder().encode(report.content).length,
  };
}

export const diagnosticsHandlers: MockHandlerMap = {
  cmd_list_crash_reports: () =>
    [...state.reports].sort((a, b) => b.id.localeCompare(a.id)).map(summarize),
  cmd_read_crash_report: (args) => {
    const id = argString(args, "id");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id.includes("..")) {
      throw new Error(`invalid input: invalid crash report id: ${id}`);
    }
    const report = state.reports.find((r) => r.id === id);
    if (!report) throw new Error(`invalid input: crash report not found: ${id}`);
    return report;
  },
  cmd_clear_crash_reports: () => {
    const removed = state.reports.length;
    state.reports = [];
    return removed;
  },
  cmd_log_frontend_error: (args) => {
    const payload = argObject<FrontendErrorPayload>(args, "payload");
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message) throw new Error("invalid input: frontend error message is empty");
    const full: FrontendErrorPayload = { ...payload, message };
    const at = new Date();
    state.log.push(`${at.toISOString()} ERROR [frontend] ${message}${payload.source ? ` [source=${payload.source}]` : ""}`);
    console.warn("[mock] frontend error logged:", message);
    if (payload.fatal) {
      let id = reportId(at);
      for (let n = 1; state.reports.some((r) => r.id === id); n++) id = `${reportId(at)}-${n}`;
      state.reports.push({ id, created_at: at.toISOString(), kind: "frontend", content: renderFrontendReport(full, at) });
    }
  },
  cmd_open_app_data_dir: () => {
    console.info(`[mock] reveal app data dir: ${DATA_DIR}`);
  },
  cmd_get_app_info: (): AppInfo => ({
    version: pkg.version,
    tauri_version: "2 (mock)",
    os: "macos",
    arch: "aarch64",
    data_dir: DATA_DIR,
  }),
};
