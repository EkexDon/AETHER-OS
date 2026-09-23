import { beforeEach, describe, expect, it } from "vitest";
import type {
  BundleReport,
  ExportProgress,
  NoteExportReport,
  PrintDocument,
  RecentExport,
  ScopePreview,
  SiteReport,
  TagCount,
} from "../../types";
import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "./backend";
import { MOCK_VAULT_ROOT } from "./fixtures/vault";

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);
const WELCOME = `${MOCK_VAULT_ROOT}/Welcome.md`;
const options = {};

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("export mock", () => {
  it("renders previews from the live vault", async () => {
    const html = await invoke<string>("cmd_export_preview_html", { path: WELCOME, options: { theme: "dark" } });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain("Welcome to your Second Brain");
    const md = await invoke<string>("cmd_export_preview_markdown", {
      scope: { kind: "vault" },
      path: WELCOME,
      options,
    });
    expect(md).toContain("](01-Projects/AETHER-OS.md)");
    expect(md).not.toContain("[[AETHER-OS]]");
  });

  it("resolves scopes with the same rules as Rust", async () => {
    const vault = await invoke<ScopePreview>("cmd_export_resolve_scope", { scope: { kind: "vault" } });
    expect(vault.total).toBeGreaterThanOrEqual(25);
    expect(vault.label).toMatch(/^Whole vault \(\d+ notes\)$/);
    const folder = await invoke<ScopePreview>("cmd_export_resolve_scope", {
      scope: { kind: "folder", value: `${MOCK_VAULT_ROOT}/01-Projects` },
    });
    expect(folder.notes.every((n) => n.rel.startsWith("01-Projects/"))).toBe(true);
    const tags = await invoke<TagCount[]>("cmd_export_list_tags");
    expect(tags.length).toBeGreaterThan(5);
    const tag = await invoke<ScopePreview>("cmd_export_resolve_scope", { scope: { kind: "tag", value: tags[0].tag } });
    expect(tag.total).toBe(tags[0].count);
    await expect(
      invoke("cmd_export_resolve_scope", { scope: { kind: "note", value: "/etc/passwd" } })
    ).rejects.toMatch(/outside the vault/);
    await expect(invoke("cmd_export_resolve_scope", { scope: { kind: "selection", value: [] } })).rejects.toMatch(
      /selection is empty/
    );
    await expect(invoke("cmd_export_resolve_scope", { scope: { kind: "tag", value: "no-such-tag" } })).rejects.toMatch(
      /contains no notes/
    );
  });

  it("exports a note and records it in the recents", async () => {
    const report = await invoke<NoteExportReport>("cmd_export_note_html", {
      path: WELCOME,
      outPath: "/Users/demo/Desktop/welcome",
      options,
    });
    expect(report.path).toBe("/Users/demo/Desktop/welcome.html");
    const recents = await invoke<RecentExport[]>("cmd_export_list_recent");
    expect(recents[0]).toMatchObject({ kind: "html", path: report.path });
    await expect(
      invoke("cmd_export_note_html", { path: WELCOME, outPath: `${MOCK_VAULT_ROOT}/out.html`, options })
    ).rejects.toMatch(/inside the vault/);
    await expect(
      invoke("cmd_export_note_html", { path: WELCOME, outPath: `${MOCK_VAULT_ROOT}/out.html`, options: { allow_inside_vault: true } })
    ).resolves.toBeTruthy();
    await expect(invoke("cmd_export_note_html", { path: WELCOME, outPath: "relative.html", options })).rejects.toMatch(
      /absolute destination/
    );
  });

  it("publishes a site with progress events", async () => {
    const events: ExportProgress[] = [];
    const off = mockEvents.listen<ExportProgress>("export-progress", (p) => events.push(p));
    const report = await invoke<SiteReport>("cmd_export_site", {
      scope: { kind: "vault" },
      outDir: "/Users/demo/Sites/garden",
      options: { base_path: "https://x.dev" },
    });
    off();
    expect(report.pages).toBeGreaterThan(20);
    expect(report.index_path).toBe("/Users/demo/Sites/garden/index.html");
    expect(report.warnings).toEqual([]);
    expect(events.length).toBeGreaterThan(report.pages);
    expect(events[events.length - 1].done).toBe(events[events.length - 1].total);
    // The site can now be opened and revealed; unrelated paths cannot.
    await expect(invoke("cmd_export_open_path", { path: report.index_path, reveal: false })).resolves.toBeNull();
    await expect(invoke("cmd_export_open_path", { path: "/Users/demo/Sites/garden", reveal: true })).resolves.toBeNull();
    await expect(invoke("cmd_export_open_path", { path: "/Applications/Calculator.app", reveal: false })).rejects.toMatch(
      /only exported files/
    );
  });

  it("bundles notes and converts links", async () => {
    const report = await invoke<BundleReport>("cmd_export_bundle", {
      scope: { kind: "folder", value: `${MOCK_VAULT_ROOT}/03-Resources` },
      outPath: "/Users/demo/Desktop/resources",
      options,
    });
    expect(report.path).toBe("/Users/demo/Desktop/resources.zip");
    expect(report.notes).toBeGreaterThan(5);
    expect(report.converted_links + report.unresolved_links).toBeGreaterThan(0);
    await expect(invoke("cmd_export_open_path", { path: report.path, reveal: false })).rejects.toMatch(/only HTML/);
    await expect(invoke("cmd_export_open_path", { path: report.path, reveal: true })).resolves.toBeNull();
  });

  it("builds a light print document and clears recents", async () => {
    const doc = await invoke<PrintDocument>("cmd_export_print_document", { path: WELCOME, options: { theme: "dark" } });
    expect(doc.title).toBe("Welcome");
    expect(doc.body).toContain('data-theme="light"');
    expect((await invoke<RecentExport[]>("cmd_export_list_recent")).length).toBe(2);
    await invoke("cmd_export_clear_recent");
    expect(await invoke<RecentExport[]>("cmd_export_list_recent")).toEqual([]);
  });
});
