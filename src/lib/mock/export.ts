/**
 * Mock handlers for `commands/export_commands.rs`. Previews are rendered by
 * the TS mock renderer (`src/lib/export/mockRender.ts`) from the live mock
 * vault; site and bundle exports validate scope and destination like Rust,
 * stream `export-progress` events for ~1 s and return realistic reports
 * (nothing is written — the preview has no filesystem). Recent exports are
 * kept in memory and seeded with two entries.
 */
import type {
  BundleReport,
  ExportKind,
  ExportOptions,
  ExportScope,
  NoteExportReport,
  PrintDocument,
  RecentExport,
  ScopePreview,
  SiteReport,
  TagCount,
  VaultNote,
} from "../../types";
import {
  convertWikilinksMock,
  MOCK_DOC_CSS,
  MOCK_PRINT_CSS,
  renderMockArticle,
  renderMockDocument,
} from "../export/mockRender";
import { extractTags, extractWikilinks } from "./markdown";
import {
  argBool,
  argObject,
  argString,
  basename,
  dirname,
  isWithin,
  mockEvents,
  mockUuid,
  normalizePath,
  registerReset,
  sleep,
  type MockHandlerMap,
} from "./runtime";
import { mockVault } from "./vaultStore";

const DEFAULTS: ExportOptions = {
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
  overwrite: false,
};

function options(args: Record<string, unknown>): ExportOptions {
  return { ...DEFAULTS, ...(argObject<ExportOptions>(args, "options") as Partial<ExportOptions>) };
}

function root(): string {
  const r = mockVault.root;
  if (!r) throw new Error("No vault path configured. Open Settings to set a vault path.");
  return r;
}

const invalid = (msg: string) => new Error(`invalid input: ${msg}`);

function resolveInside(path: string): string {
  const r = root();
  const trimmed = path.trim();
  if (!trimmed) throw invalid("path is empty");
  const abs = normalizePath(trimmed.startsWith("/") ? trimmed : `${r}/${trimmed}`);
  if (!isWithin(abs, r)) throw invalid(`path is outside the vault: ${path}`);
  if (!mockVault.hasFile(abs) && !mockVault.hasDir(abs)) throw invalid(`no such file or folder: ${path}`);
  return abs;
}

function noteForPath(path: string): VaultNote {
  const abs = resolveInside(path);
  const note = mockVault.list().find((n) => n.path === abs);
  if (!note) throw invalid(`not a Markdown note of the vault: ${path}`);
  return note;
}

const byRel = (a: VaultNote, b: VaultNote) =>
  a.path.toLowerCase().localeCompare(b.path.toLowerCase());

/** Same rules as `VaultModel::resolve_scope`. */
function resolveScope(scope: ExportScope): VaultNote[] {
  const notes = [...mockVault.list()].sort(byRel);
  let out: VaultNote[];
  switch (scope.kind) {
    case "note":
      out = [noteForPath(scope.value)];
      break;
    case "folder": {
      const dir = resolveInside(scope.value);
      if (!mockVault.hasDir(dir)) throw invalid(`not a folder: ${scope.value}`);
      out = notes.filter((n) => isWithin(n.path, dir));
      break;
    }
    case "vault":
      out = notes;
      break;
    case "tag": {
      const wanted = scope.value.trim().replace(/^#/, "").toLowerCase();
      if (!wanted) throw invalid("tag is empty");
      out = notes.filter((n) =>
        extractTags(mockVault.read(n.path)).some((t) => {
          const tag = t.toLowerCase();
          return tag === wanted || tag.startsWith(`${wanted}/`);
        })
      );
      break;
    }
    case "selection": {
      if (!scope.value.length) throw invalid("the selection is empty");
      const seen = new Set<string>();
      out = [];
      for (const p of scope.value) {
        const note = noteForPath(p);
        if (!seen.has(note.path)) {
          seen.add(note.path);
          out.push(note);
        }
      }
      out.sort(byRel);
      break;
    }
  }
  if (!out.length) throw invalid("the export scope contains no notes");
  return out;
}

function describeScope(scope: ExportScope, count: number): string {
  const r = root();
  switch (scope.kind) {
    case "note":
      return noteForPath(scope.value).name;
    case "folder": {
      const rel = resolveInside(scope.value).slice(r.length + 1);
      return rel ? `${rel}/ (${count} notes)` : `Whole vault (${count} notes)`;
    }
    case "vault":
      return `Whole vault (${count} notes)`;
    case "tag":
      return `#${scope.value.replace(/^#/, "").toLowerCase()} (${count} notes)`;
    case "selection":
      return `${count} selected note${count === 1 ? "" : "s"}`;
  }
}

function resolveName(target: string, pool: VaultNote[]): VaultNote | undefined {
  const t = target.trim().replace(/\.md$/i, "").toLowerCase();
  const name = t.split("/").pop() ?? t;
  return pool.find((n) => n.name.toLowerCase() === name);
}

function backlinksOf(note: VaultNote): string[] {
  const names = new Set<string>();
  for (const b of mockVault.backlinks(note.name)) if (b.note_path !== note.path) names.add(b.note_name);
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function renderDocument(note: VaultNote, opts: ExportOptions): string {
  const all = mockVault.list();
  return renderMockDocument({
    name: note.name,
    content: mockVault.read(note.path),
    options: opts,
    backlinks: backlinksOf(note),
    ctx: { resolveNote: (t) => resolveName(t, all)?.name ?? null },
  });
}

/** Same rules as `check_output_path` (mock filesystem: parents are not checked). */
function checkOutput(path: string, opts: ExportOptions, ext?: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) throw invalid(`choose an absolute destination path (got "${trimmed}")`);
  let out = normalizePath(trimmed);
  const r = root();
  if (out === r) throw invalid("the destination cannot be the vault folder itself");
  if (isWithin(out, r) && !opts.allow_inside_vault) {
    throw invalid(
      `the destination ${out} is inside the vault; exported files would show up as notes. Choose a folder outside the vault or enable "Allow export into the vault"`
    );
  }
  if (out === "/") throw invalid("the destination cannot be a filesystem root");
  if (ext && !out.toLowerCase().endsWith(`.${ext}`)) out = `${out}.${ext}`;
  return out;
}

let recents: RecentExport[] = [];

/**
 * `check_output_file`: an HTML page or bundle that already exists (in the
 * mock: a previous export to the same path) is only replaced with
 * `overwrite: true`, with the same message as Rust.
 */
function checkOutputFile(path: string, opts: ExportOptions, ext: "html" | "zip"): string {
  const out = checkOutput(path, opts, ext);
  const exists = recents.some((r) => r.kind !== "site" && r.exists && r.path === out);
  if (exists && !opts.overwrite) {
    throw invalid(`${out} already exists. Choose another name or confirm replacing it (overwrite)`);
  }
  return out;
}

function seedRecents(now = Date.now()): RecentExport[] {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  return [
    {
      id: mockUuid(),
      kind: "site",
      title: "Second Brain",
      scope_label: "03-Resources/ (10 notes)",
      path: "/Users/demo/Sites/second-brain",
      created_at: iso(26 * 3_600_000),
      items: 10,
      bytes: 412_880,
      exists: true,
    },
    {
      id: mockUuid(),
      kind: "bundle",
      title: "masterarbeit-notes",
      scope_label: "#masterarbeit (3 notes)",
      path: "/Users/demo/Desktop/masterarbeit-notes.zip",
      created_at: iso(4 * 86_400_000),
      items: 3,
      bytes: 18_422,
      exists: true,
    },
  ];
}

function record(kind: ExportKind, title: string, scopeLabel: string, path: string, items: number, bytes: number) {
  const entry: RecentExport = {
    id: mockUuid(),
    kind,
    title,
    scope_label: scopeLabel,
    path,
    created_at: new Date().toISOString(),
    items,
    bytes,
    exists: true,
  };
  recents = [entry, ...recents.filter((r) => !(r.path === path && r.kind === kind))].slice(0, 25);
}

/** Emit progress for `steps` items over ~1 s (like a mid-sized export). */
async function simulateProgress(items: { name: string; phase: string }[]): Promise<void> {
  const total = items.length + 1;
  const delay = Math.max(8, Math.min(60, Math.round(1100 / total)));
  for (let i = 0; i < items.length; i++) {
    mockEvents.emit("export-progress", { done: i, total, current: items[i].name, phase: items[i].phase });
    await sleep(delay);
  }
  mockEvents.emit("export-progress", { done: total - 1, total, current: "Finishing", phase: "finishing" });
  await sleep(delay);
  mockEvents.emit("export-progress", { done: total, total, current: "Done", phase: "finishing" });
}

const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)|!\[\[([^\]|]+\.(?:png|jpe?g|gif|webp|svg))(?:\|[^\]]*)?\]\]/gi;

function attachmentsOf(content: string): string[] {
  return [...content.matchAll(IMAGE_RE)].map((m) => (m[1] ?? m[2]).trim()).filter((a) => !/^https?:/.test(a));
}

function publishable(content: string): boolean {
  return !/^---[\s\S]*?\npublish:\s*(false|no|off|0)\s*\n[\s\S]*?---/.test(content);
}

export const exportHandlers: MockHandlerMap = {
  cmd_export_preview_html: (args) => renderDocument(noteForPath(argString(args, "path")), options(args)),

  cmd_export_preview_markdown: (args) => {
    const scope = argObject<ExportScope>(args, "scope") as ExportScope;
    const pool = resolveScope(scope);
    const note = noteForPath(argString(args, "path"));
    const content = mockVault.read(note.path);
    if (!options(args).convert_wikilinks) return content;
    const from = dirname(note.path);
    const relTo = (target: string) => {
      const parts = from.split("/").filter(Boolean);
      const to = target.split("/").filter(Boolean);
      let common = 0;
      while (common < parts.length && parts[common] === to[common]) common++;
      return [...Array(parts.length - common).fill(".."), ...to.slice(common)].join("/");
    };
    return convertWikilinksMock(content, (target) => {
      if (!target) return "";
      if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(target)) return relTo(`${root()}/attachments/${basename(target)}`);
      const hit = resolveName(target, pool);
      return hit ? relTo(hit.path) : null;
    });
  },

  cmd_export_note_html: async (args) => {
    const opts = options(args);
    const note = noteForPath(argString(args, "path"));
    const out = checkOutputFile(argString(args, "outPath"), opts, "html");
    const html = renderDocument(note, opts);
    await sleep(120);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? note.name;
    record("html", title, note.name, out, 1, html.length);
    const report: NoteExportReport = {
      path: out,
      title,
      bytes: html.length,
      attachments: opts.include_attachments ? attachmentsOf(mockVault.read(note.path)).length : 0,
      missing_links: (html.match(/class="missing"/g) ?? []).length,
      warnings: [],
      ms: 120,
    };
    return report;
  },

  cmd_export_print_document: (args) => {
    const opts = options(args);
    const note = noteForPath(argString(args, "path"));
    const all = mockVault.list();
    const { title, article } = renderMockArticle({
      name: note.name,
      content: mockVault.read(note.path),
      options: { ...opts, theme: "light" },
      backlinks: backlinksOf(note),
      ctx: { resolveNote: (t) => resolveName(t, all)?.name ?? null },
    });
    const doc: PrintDocument = {
      title,
      css: `${MOCK_DOC_CSS}\n${MOCK_PRINT_CSS}`,
      body: `<div class="aether-doc aether-print" data-theme="light" lang="en"><main class="doc-main">\n${article}</main></div>`,
      warnings: [],
    };
    return doc;
  },

  cmd_export_site: async (args) => {
    const started = Date.now();
    const opts = options(args);
    const scope = argObject<ExportScope>(args, "scope") as ExportScope;
    const notes = resolveScope(scope);
    const out = checkOutput(argString(args, "outDir"), opts);
    const published = notes.filter((n) => publishable(mockVault.read(n.path)));
    if (!published.length) throw invalid("nothing to publish: every note in the scope has `publish: false`");
    const tags = new Set<string>();
    const attachments = new Set<string>();
    const missing: { note: string; target: string }[] = [];
    let missingCount = 0;
    for (const note of published) {
      const content = mockVault.read(note.path);
      extractTags(content).forEach((t) => tags.add(t.toLowerCase()));
      if (opts.include_attachments) attachmentsOf(content).forEach((a) => attachments.add(a));
      for (const link of extractWikilinks(content)) {
        if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(link)) continue;
        if (!resolveName(link, published)) {
          missingCount++;
          if (missing.length < 200) missing.push({ note: note.name, target: link });
        }
      }
    }
    await simulateProgress([
      ...published.map((n) => ({ name: n.name, phase: "pages" })),
      ...[...attachments].map((a) => ({ name: basename(a), phase: "attachments" })),
    ]);
    const bytes = published.reduce((sum, n) => sum + mockVault.read(n.path).length * 3 + 2400, 38_000);
    const title = opts.site_title.trim() || basename(root());
    record("site", title, describeScope(scope, notes.length), out, published.length, bytes);
    const warnings = opts.base_path.trim() ? [] : ["No public URL set — sitemap.xml was not generated."];
    const report: SiteReport = {
      out_dir: out,
      index_path: `${out}/index.html`,
      pages: published.length,
      tag_pages: tags.size,
      attachments: attachments.size,
      skipped: notes.length - published.length,
      missing_links: missing,
      missing_link_count: missingCount,
      removed_stale: 0,
      bytes,
      warnings,
      ms: Date.now() - started,
    };
    return report;
  },

  cmd_export_bundle: async (args) => {
    const started = Date.now();
    const opts = options(args);
    const scope = argObject<ExportScope>(args, "scope") as ExportScope;
    const notes = resolveScope(scope);
    const out = checkOutputFile(argString(args, "outPath"), opts, "zip");
    let converted = 0;
    let unresolved = 0;
    const attachments = new Set<string>();
    for (const note of notes) {
      const content = mockVault.read(note.path);
      if (opts.include_attachments) attachmentsOf(content).forEach((a) => attachments.add(a));
      if (!opts.convert_wikilinks) continue;
      for (const link of extractWikilinks(content)) {
        if (resolveName(link, notes)) converted++;
        else unresolved++;
      }
    }
    await simulateProgress([
      ...notes.map((n) => ({ name: n.name, phase: "notes" })),
      ...[...attachments].map((a) => ({ name: basename(a), phase: "attachments" })),
    ]);
    const bytes = Math.round(notes.reduce((sum, n) => sum + mockVault.read(n.path).length, 900) * 0.42);
    const title = basename(out).replace(/\.zip$/i, "");
    record("bundle", title, describeScope(scope, notes.length), out, notes.length, bytes);
    const report: BundleReport = {
      path: out,
      notes: notes.length,
      attachments: attachments.size,
      converted_links: converted,
      unresolved_links: unresolved,
      bytes,
      warnings: [],
      ms: Date.now() - started,
    };
    return report;
  },

  cmd_export_open_path: (args) => {
    const path = normalizePath(argString(args, "path"));
    const reveal = argBool(args, "reveal");
    const allowed = recents.some((r) => r.path === path || (r.kind === "site" && isWithin(path, r.path)));
    if (!allowed) throw invalid(`only exported files can be opened: ${path}`);
    if (!reveal && /\.[a-z0-9]+$/i.test(basename(path)) && !/\.html?$/i.test(path)) {
      throw invalid(`only HTML files and folders can be opened directly: ${path}`);
    }
    console.info(`[mock] ${reveal ? "reveal in Finder" : "open"}: ${path}`);
  },

  cmd_export_list_recent: () => recents,

  cmd_export_clear_recent: () => {
    recents = [];
  },

  cmd_export_resolve_scope: (args) => {
    const scope = argObject<ExportScope>(args, "scope") as ExportScope;
    const notes = resolveScope(scope);
    const r = root();
    const preview: ScopePreview = {
      total: notes.length,
      notes: notes.slice(0, 500).map((n) => ({ path: n.path, rel: n.path.slice(r.length + 1), title: n.name })),
      truncated: notes.length > 500,
      label: describeScope(scope, notes.length),
    };
    return preview;
  },

  cmd_export_list_tags: () => {
    const counts = new Map<string, TagCount>();
    for (const entry of mockVault.index().notes) {
      const seen = new Set<string>();
      for (const tag of entry.tags) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = counts.get(key);
        if (hit) hit.count++;
        else counts.set(key, { tag, count: 1 });
      }
    }
    return [...counts.values()].sort(
      (a, b) => b.count - a.count || a.tag.toLowerCase().localeCompare(b.tag.toLowerCase())
    );
  },
};

recents = seedRecents();
registerReset(() => {
  recents = seedRecents();
});
