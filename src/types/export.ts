/**
 * Export & publishing types — mirror `src-tauri/src/engine/export.rs`
 * (serde field names, snake_case).
 */

/** What to export (adjacently tagged like the Rust enum). */
export type ExportScope =
  | { kind: "note"; value: string }
  | { kind: "folder"; value: string }
  | { kind: "vault" }
  | { kind: "tag"; value: string }
  | { kind: "selection"; value: string[] };

/** The scope variants, in picker order. */
export type ExportScopeKind = ExportScope["kind"];

/** Colour scheme of exported HTML. `auto` follows the reader's OS. */
export type ExportTheme = "auto" | "light" | "dark";

/** Export options. Every field has a Rust-side default. */
export interface ExportOptions {
  /** Copy (site, bundle) or embed (standalone HTML) referenced attachments. */
  include_attachments: boolean;
  /** Bundle: rewrite `[[wikilinks]]` into standard relative Markdown links. */
  convert_wikilinks: boolean;
  /** Render a "Linked from" section. */
  include_backlinks: boolean;
  /** Render title, date and tags from the frontmatter in a header. */
  include_frontmatter: boolean;
  theme: ExportTheme;
  /** Site title (defaults to the vault folder name). */
  site_title: string;
  site_description: string;
  /** Public URL the site is served from (enables `sitemap.xml`). */
  base_path: string;
  /** Custom domain for a `CNAME` file. */
  cname: string;
  /** Load mermaid from the jsDelivr CDN so diagrams render. */
  include_mermaid_script: boolean;
  /** Allow the destination to lie inside the vault. */
  allow_inside_vault: boolean;
}

/** `export-progress` event payload. */
export interface ExportProgress {
  done: number;
  total: number;
  current: string;
  /** `rendering` · `pages` · `attachments` · `notes` · `finishing`. */
  phase: string;
}

/** An unresolved link reported by a site export. */
export interface MissingLink {
  note: string;
  target: string;
}

/** Result of `cmd_export_note_html`. */
export interface NoteExportReport {
  path: string;
  title: string;
  bytes: number;
  attachments: number;
  missing_links: number;
  warnings: string[];
  ms: number;
}

/** Result of `cmd_export_site`. */
export interface SiteReport {
  out_dir: string;
  index_path: string;
  pages: number;
  tag_pages: number;
  attachments: number;
  /** Notes skipped because of `publish: false`. */
  skipped: number;
  /** First 200 unresolved links; `missing_link_count` is exact. */
  missing_links: MissingLink[];
  missing_link_count: number;
  removed_stale: number;
  bytes: number;
  warnings: string[];
  ms: number;
}

/** Result of `cmd_export_bundle`. */
export interface BundleReport {
  path: string;
  notes: number;
  attachments: number;
  converted_links: number;
  unresolved_links: number;
  bytes: number;
  warnings: string[];
  ms: number;
}

/** A note prepared for printing (`cmd_export_print_document`). */
export interface PrintDocument {
  title: string;
  /** Stylesheet scoped to `.aether-doc`. */
  css: string;
  /** `<div class="aether-doc aether-print">…</div>` markup. */
  body: string;
  warnings: string[];
}

/** Kind of a recorded export. */
export type ExportKind = "html" | "site" | "bundle";

/** One entry of `<data_dir>/export/recents.json`. */
export interface RecentExport {
  id: string;
  kind: ExportKind;
  title: string;
  scope_label: string;
  path: string;
  created_at: string;
  items: number;
  bytes: number;
  /** Whether the output still exists on disk. */
  exists: boolean;
}

/** A note of a resolved scope. */
export interface ScopeNote {
  path: string;
  rel: string;
  title: string;
}

/** Result of `cmd_export_resolve_scope`. */
export interface ScopePreview {
  total: number;
  /** First 500 notes. */
  notes: ScopeNote[];
  truncated: boolean;
  label: string;
}

/** A tag with its note count (`cmd_export_list_tags`). */
export interface TagCount {
  tag: string;
  count: number;
}

/** The three export flows offered by the Export view. */
export type ExportFlow = "html" | "site" | "bundle";
