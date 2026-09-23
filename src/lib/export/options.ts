/**
 * Export option defaults and their per-flow persistence (a per-user
 * convenience in `localStorage`; the Rust side has its own defaults).
 */
import type { ExportFlow, ExportOptions, ExportTheme } from "../../types";

/** Same defaults as `ExportOptions::default()` in Rust. */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  include_attachments: true,
  convert_wikilinks: true,
  include_backlinks: true,
  include_frontmatter: true,
  theme: "auto",
  site_title: "",
  site_description: "",
  base_path: "",
  cname: "",
  include_mermaid_script: false,
  allow_inside_vault: false,
};

const OPTIONS_KEY = (flow: ExportFlow) => `aether-export-options-${flow}`;
const DEST_KEY = (flow: ExportFlow) => `aether-export-dir-${flow}`;
const THEMES: ExportTheme[] = ["auto", "light", "dark"];
const BOOL_KEYS = [
  "include_attachments",
  "convert_wikilinks",
  "include_backlinks",
  "include_frontmatter",
  "include_mermaid_script",
  "allow_inside_vault",
] as const;
const STRING_KEYS = ["site_title", "site_description", "base_path", "cname"] as const;

/** Keep only well-typed fields of `raw`, falling back to the defaults. */
export function sanitizeOptions(raw: unknown): ExportOptions {
  const out: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const key of BOOL_KEYS) if (typeof r[key] === "boolean") out[key] = r[key] as boolean;
  for (const key of STRING_KEYS) if (typeof r[key] === "string") out[key] = (r[key] as string).slice(0, 500);
  if (THEMES.includes(r.theme as ExportTheme)) out.theme = r.theme as ExportTheme;
  // Never persist the "inside the vault" override between exports.
  out.allow_inside_vault = false;
  return out;
}

/** Last options used for `flow`. */
export function loadFlowOptions(flow: ExportFlow): ExportOptions {
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY(flow));
    return sanitizeOptions(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_EXPORT_OPTIONS };
  }
}

/** Remember the options of a successful export. */
export function saveFlowOptions(flow: ExportFlow, options: ExportOptions): void {
  try {
    window.localStorage.setItem(OPTIONS_KEY(flow), JSON.stringify(sanitizeOptions(options)));
  } catch {
    // Storage unavailable (private mode) — the defaults apply next time.
  }
}

/** Folder of the last export of `flow`, if any. */
export function loadLastDir(flow: ExportFlow): string | null {
  try {
    const dir = window.localStorage.getItem(DEST_KEY(flow));
    return dir && dir.startsWith("/") ? dir : null;
  } catch {
    return null;
  }
}

/** Remember the folder of a successful export. */
export function saveLastDir(flow: ExportFlow, dir: string): void {
  try {
    window.localStorage.setItem(DEST_KEY(flow), dir);
  } catch {
    // Storage unavailable — the default folder applies next time.
  }
}
