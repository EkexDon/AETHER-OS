# Export & Publishing (roadmap 5.2)

## What

Get knowledge out of the vault in polished, portable form — entirely on
this machine:

- **Single note → standalone HTML** — one self-contained `.html` file with
  inlined styles and (optionally) inlined images, syntax-highlighted code,
  resolved wikilinks, tags, a frontmatter header and a "Linked from" section.
- **Single note → PDF** — the same document through the system print
  dialog ("Save as PDF" on macOS).
- **Static site** — a self-hosted Obsidian-Publish equivalent: index page,
  one page per note with backlinks, tag pages, client-side search, light and
  dark theme, `sitemap.xml`, optional `CNAME`. Works from a folder
  (`file://`), a sub-path or any static host (GitHub Pages, Netlify, S3 …).
- **Markdown bundle** — a `.zip` with the notes (folder structure kept), the
  attachments they reference and a `manifest.json`; `[[wikilinks]]` can be
  converted into standard relative Markdown links.

## Why

A vault is only useful to others once it leaves the app: sharing one note
with a colleague, printing a report, publishing a digital garden or handing
a project's notes to someone who does not use Obsidian/NoPes. Doing it
locally keeps notes private until *you* decide where the files go.

## How to use

Open **Export** in the rail (Knowledge group) or use the palette (⌘K):

| Shortcut | Command | What it does |
| --- | --- | --- |
| ⌘⇧E | *Export: current note as HTML* | Opens the HTML wizard for the note open in the editor |
| ⌘⌥P | *Export: print / save as PDF* | Prints the current note right away (opens the wizard to pick a note when none is open) |
| ⌘⌥W | *Export: publish vault as site* | Opens the site wizard with the whole vault |
| ⌘⌥Z | *Export: bundle vault* | Opens the bundle wizard with the whole vault |
| ⌘↵ | (inside a wizard) | Run the export |
| Esc | (inside a wizard) | Close (disabled while an export runs) |

Every wizard has three steps on the left and a live preview on the right:

1. **What to export** — *Note* (search the vault), *Folder* (tree with note
   counts), *Whole vault*, *Tag* (all tags with counts; nested tags such as
   `#project/alpha` are included by `#project`) or *Selection* (search +
   checkboxes, "Select shown", "Clear"). The footer shows the resolved note
   count; errors (e.g. an empty tag) appear there too.
2. **Options** — theme (Auto/Light/Dark), frontmatter header, "Linked from"
   section, attachments (embed for HTML, copy for site/bundle), mermaid
   script (opt-in, see limitations), site title/description, public URL
   (sitemap) and custom domain (CNAME); for bundles: convert wikilinks.
   Options are remembered per flow.
3. **Destination** — a file (`.html`, `.zip`) or a folder (site), with a
   native picker. The folder of the last export is remembered. A
   destination inside the vault shows a warning and needs an explicit
   "Export into the vault anyway".

The preview renders the real export (sandboxed iframe, no scripts) and can
switch themes; for bundles it shows the converted Markdown. Multi-note
scopes let you pick which note to preview.

While a site or bundle is written, a progress bar shows the phase
(*Rendering pages → Writing pages → Copying attachments → Finishing*). The
report lists pages, tag pages, attachments, unresolved links (with a list),
size and time, plus **Open site in browser** / **Open in browser** and
**Reveal in Finder**. The **Recent exports** list on the view keeps the last
25 exports with the same actions; outputs that were moved or deleted are
flagged.

### Rendering rules

- `[[Note]]`, `[[Note|Alias]]`, `[[Folder/Note]]`, `[[Note#Heading]]`,
  `[[#Heading]]` resolve like Obsidian (exact path → relative to the linking
  note → by name, same folder first, then the shortest path). On a site they
  link to the note's page (and heading anchor); in a standalone document
  they are styled text. Unresolved links (or links to notes outside the
  export) render as plain text with `class="missing"` and are reported.
- `![[image.png]]`, `![[image.png|300]]`, `![[image.png|300x200]]` and
  `![alt](path/to/image.png)` embed attachments; `![[Note]]` links to the
  note; `[[file.pdf]]` links to the file.
- `#tags` (frontmatter `tags:` and inline, not in code) become tag chips —
  links to tag pages on a site. Tags compare case-insensitively.
- `- [ ]` / `- [x]` render as disabled checkboxes; GFM tables,
  strikethrough, footnotes and `> [!NOTE]` alerts are supported.
- Frontmatter `title`, `date`/`created`, `description` and `tags` fill the
  page header; a leading `# H1` equal to the title is not repeated.
  `publish: false` excludes a note from site exports.
- Code fences are highlighted by syntect into CSS classes (no JavaScript);
  ```` ```mermaid ```` becomes `<pre class="mermaid">`.
- Raw HTML in notes passes an allowlist sanitizer: `<script>`, `<style>`,
  `<iframe>`, event handlers and `javascript:` URLs never reach an export.
  Links keep only `http`, `https`, `mailto` and `tel`; app schemes such as
  `obsidian:` or `vscode:` are dropped (in a published page they would let
  a visitor's local app act on the link), and `data:` URLs are allowed only
  as `data:image/…` image sources.

### Static site layout

```text
index.html            title, description, recently updated, notes by folder, tags
notes/<slug>.html     one page per note; slugs transliterate umlauts (Über → ueber),
                      keep other Unicode letters, collisions get -2, -3 …
tags/index.html       all tags · tags/<slug>.html one page per tag
files/<vault path>    copied attachments
assets/style.css      theme · assets/search.js search (vanilla JS, "/" to focus)
search-index.js       index for search.js (works on file://) · search-index.json (same data)
sitemap.xml           only when a public URL is set
CNAME, .nojekyll      GitHub Pages helpers
.aether-site.json     marker + file list
```

All links are relative and no page contains an absolute path. Re-exporting
into the same folder replaces the previous export and removes pages that no
longer exist; a non-empty folder that is not an AETHER-OS site is refused.

## Where data lives

- Exports are written only where you choose. Nothing is uploaded.
- Recent exports: `<app data>/export/recents.json`
  (macOS: `~/Library/Application Support/com.ekin.aetheros/export/`).
- Wizard options and last folders: `localStorage`
  (`aether-export-options-<flow>`, `aether-export-dir-<flow>`).

## IPC

| Command | Input | Output |
| --- | --- | --- |
| `cmd_export_preview_html` | `path`, `options` | `String` (standalone HTML document) |
| `cmd_export_preview_markdown` | `scope`, `path`, `options` | `String` (the note as it would be in a bundle of `scope`) |
| `cmd_export_note_html` | `path`, `outPath`, `options` | `NoteExportReport { path, title, bytes, attachments, missing_links, warnings, ms }` |
| `cmd_export_print_document` | `path`, `options` | `PrintDocument { title, css, body, warnings }` |
| `cmd_export_site` | `scope`, `outDir`, `options` | `SiteReport { out_dir, index_path, pages, tag_pages, attachments, skipped, missing_links, missing_link_count, removed_stale, bytes, warnings, ms }` + `export-progress` events |
| `cmd_export_bundle` | `scope`, `outPath`, `options` | `BundleReport { path, notes, attachments, converted_links, unresolved_links, bytes, warnings, ms }` + `export-progress` events |
| `cmd_export_open_path` | `path`, `reveal` | none — reveal in Finder, or open a folder/HTML file |
| `cmd_export_list_recent` | none | `RecentExport[]` (newest first, `exists` refreshed) |
| `cmd_export_clear_recent` | none | none |
| `cmd_export_resolve_scope` | `scope` | `ScopePreview { total, notes (≤ 500), truncated, label }` |
| `cmd_export_list_tags` | none | `TagCount[]` (most used first) |

`ExportScope` is `{ kind: "note" | "folder" | "tag", value: string }`,
`{ kind: "vault" }` or `{ kind: "selection", value: string[] }`.
`ExportOptions` (all optional, snake_case): `include_attachments`,
`convert_wikilinks`, `include_backlinks`, `include_frontmatter`,
`theme: auto|light|dark`, `site_title`, `site_description`, `base_path`,
`cname`, `include_mermaid_script`, `allow_inside_vault`, `overwrite` (replace
an existing HTML file or bundle; off by default, so a file export never
replaces an existing file unless that was confirmed — otherwise it fails with
"… already exists. Choose another name or confirm replacing it"). Event
`export-progress`: `{ done, total, current, phase }`.

Security: note/folder paths must resolve inside the vault (canonicalised;
symlinked files are never exported), output paths must be absolute with an
existing parent and outside the vault unless allowed, zips are written to a
temporary file and renamed, and `cmd_export_open_path` only accepts
recorded export outputs (files inside an exported site included) — `open`
without `reveal` is limited to folders and `.html` files.

Code: `src-tauri/src/engine/export.rs` (+ `export/html.rs`, `site.rs`,
`bundle.rs`, `pdf.rs`, `templates/`), `src-tauri/src/commands/export_commands.rs`,
`src/components/export/`, `src/lib/export/`, `src/lib/exportStore.ts`,
`src/lib/mock/export.ts` (mock mode renders previews with
`src/lib/export/mockRender.ts` and the real export stylesheet).

## Limitations

- **PDF goes through the print dialog.** Tauri 2 has no print-to-file API
  and a headless browser would add ~150 MB, so "Print / Save as PDF…"
  mounts the note (always light, images inlined) and calls the system print
  dialog; choose *Save as PDF* there. Exported HTML files also carry print
  styles, so printing them from any browser works too.
- **Mermaid diagrams** render only when "Render mermaid diagrams" is on:
  exports then load `mermaid@11` from `cdn.jsdelivr.net` — the only network
  resource an export can reference. The in-app preview and the print
  document never run scripts, so diagrams appear as their source there.
- Syntax highlighting covers syntect's default grammars (Rust, JS/TS via
  JavaScript, Python, Go, C/C++, Java, shell, SQL, YAML, JSON, HTML, CSS,
  Markdown …); other languages are shown as plain code.
- Raw HTML `<img src>` inside notes is kept as written (not rewritten or
  copied); use Markdown images or embeds for attachments.
- Note transclusion (`![[Note]]`) renders a link, not the embedded content.
- Images larger than 8 MB are linked instead of inlined in standalone HTML.
- The search index keeps the first 2 000 characters of each note.
- In the browser preview (`npm run dev:mock`) exports are simulated (no
  files are written) and the destination has to be typed.
