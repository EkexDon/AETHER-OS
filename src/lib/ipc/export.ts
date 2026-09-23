/** Export & publishing commands (`src-tauri/src/commands/export_commands.rs`). */
import type {
  BundleReport,
  ExportOptions,
  ExportProgress,
  ExportScope,
  NoteExportReport,
  PrintDocument,
  RecentExport,
  ScopePreview,
  SiteReport,
  TagCount,
} from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Event emitted while a site or bundle export runs. */
export const EXPORT_PROGRESS_EVENT = "export-progress";

/** Standalone HTML of one note (for the preview frame). */
export const exportPreviewHtml = (path: string, options: ExportOptions) =>
  call<string>("cmd_export_preview_html", { path, options });

/** The Markdown a note would have inside a bundle of `scope`. */
export const exportPreviewMarkdown = (scope: ExportScope, path: string, options: ExportOptions) =>
  call<string>("cmd_export_preview_markdown", { scope, path, options });

/** Write one note as a standalone HTML file to `outPath`. */
export const exportNoteHtml = (path: string, outPath: string, options: ExportOptions) =>
  call<NoteExportReport>("cmd_export_note_html", { path, outPath, options });

/** The print document behind "Print / Save as PDF…". */
export const exportPrintDocument = (path: string, options: ExportOptions) =>
  call<PrintDocument>("cmd_export_print_document", { path, options });

/** Publish `scope` as a static website into `outDir` (emits progress). */
export const exportSite = (scope: ExportScope, outDir: string, options: ExportOptions) =>
  call<SiteReport>("cmd_export_site", { scope, outDir, options });

/** Write a Markdown bundle (zip) of `scope` to `outPath` (emits progress). */
export const exportBundle = (scope: ExportScope, outPath: string, options: ExportOptions) =>
  call<BundleReport>("cmd_export_bundle", { scope, outPath, options });

/** Reveal an export in Finder (`reveal`) or open it (folders and HTML only). */
export const exportOpenPath = (path: string, reveal: boolean) =>
  call<void>("cmd_export_open_path", { path, reveal });

/** Recent exports, newest first. */
export const exportListRecent = () => call<RecentExport[]>("cmd_export_list_recent");

/** Forget the recent exports list (files stay on disk). */
export const exportClearRecent = () => call<void>("cmd_export_clear_recent");

/** Resolve a scope to its notes (count, label, first 500 notes). */
export const exportResolveScope = (scope: ExportScope) =>
  call<ScopePreview>("cmd_export_resolve_scope", { scope });

/** Every tag of the vault with its note count, most used first. */
export const exportListTags = () => call<TagCount[]>("cmd_export_list_tags");

/** Subscribe to export progress; resolves to the unlisten function. */
export const onExportProgress = (handler: (progress: ExportProgress) => void): Promise<UnlistenFn> =>
  listenSafe<ExportProgress>(EXPORT_PROGRESS_EVENT, handler);
