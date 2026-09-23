import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExportProgress, ScopePreview, SiteReport } from "../../types";

let progressHandler: ((p: ExportProgress) => void) | null = null;

vi.mock("../../lib/ipc", () => ({
  isTauriRuntime: () => false,
  exportResolveScope: vi.fn(),
  exportPreviewHtml: vi.fn().mockResolvedValue("<!doctype html><title>x</title><p>Preview body</p>"),
  exportPreviewMarkdown: vi.fn().mockResolvedValue("# Converted\n[Alpha](Alpha.md)"),
  exportNoteHtml: vi.fn(),
  exportSite: vi.fn(),
  exportBundle: vi.fn(),
  exportPrintDocument: vi.fn(),
  exportOpenPath: vi.fn().mockResolvedValue(undefined),
  exportListRecent: vi.fn().mockResolvedValue([]),
  exportClearRecent: vi.fn(),
  exportListTags: vi.fn().mockResolvedValue([{ tag: "rust", count: 2 }]),
  onExportProgress: vi.fn(async (handler: (p: ExportProgress) => void) => {
    progressHandler = handler;
    return () => {
      progressHandler = null;
    };
  }),
}));

import * as ipc from "../../lib/ipc";
import { ExportWizard } from "./ExportWizard";
import { ToastProvider } from "../../ui";
import { useAetherStore } from "../../lib/store";

const ROOT = "/Users/demo/Vault";
const NOTE = `${ROOT}/Projects/Alpha.md`;
const preview = (total: number): ScopePreview => ({
  total,
  notes: [
    { path: NOTE, rel: "Projects/Alpha.md", title: "Alpha" },
    { path: `${ROOT}/Beta.md`, rel: "Beta.md", title: "Beta" },
  ].slice(0, total),
  truncated: false,
  label: total === 1 ? "Alpha" : `Whole vault (${total} notes)`,
});

function renderWizard(flow: "html" | "site" | "bundle", onClose = vi.fn()) {
  return render(
    <ToastProvider>
      <ExportWizard flow={flow} initialScope={flow === "html" ? { kind: "note", value: NOTE } : null} onClose={onClose} />
    </ToastProvider>
  );
}

describe("ExportWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    progressHandler = null;
    useAetherStore.setState({
      vaultPath: ROOT,
      selectedNotePath: NOTE,
      vaultNotes: [
        { path: NOTE, name: "Alpha", mtime: 0 },
        { path: `${ROOT}/Beta.md`, name: "Beta", mtime: 0 },
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("exports a note as HTML with a live preview and a report", async () => {
    vi.mocked(ipc.exportResolveScope).mockResolvedValue(preview(1));
    vi.mocked(ipc.exportNoteHtml).mockResolvedValue({
      path: "/Users/demo/Desktop/Alpha.html",
      title: "Alpha",
      bytes: 2048,
      attachments: 1,
      missing_links: 0,
      warnings: [],
      ms: 40,
    });
    renderWizard("html");
    expect(screen.getByRole("dialog", { name: "Export note as HTML" })).toBeInTheDocument();
    const frame = await screen.findByTitle("Export preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Preview body");
    const dest = screen.getByLabelText("File") as HTMLInputElement;
    await waitFor(() => expect(dest.value).toBe("/Users/demo/Desktop/Alpha.html"));

    fireEvent.click(screen.getByRole("button", { name: "Export HTML" }));
    await screen.findByText("“Alpha” exported");
    expect(ipc.exportNoteHtml).toHaveBeenCalledWith(NOTE, "/Users/demo/Desktop/Alpha.html", expect.objectContaining({ theme: "auto" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(ipc.exportOpenPath).toHaveBeenCalledWith("/Users/demo/Desktop/Alpha.html", false);
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(ipc.exportOpenPath).toHaveBeenCalledWith("/Users/demo/Desktop/Alpha.html", true);
  });

  it("guards destinations inside the vault", async () => {
    vi.mocked(ipc.exportResolveScope).mockResolvedValue(preview(1));
    renderWizard("html");
    const dest = screen.getByLabelText("File");
    fireEvent.change(dest, { target: { value: `${ROOT}/exports/a.html` } });
    expect(await screen.findByText(/inside your vault/)).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: "Export HTML" });
    await waitFor(() => expect(ipc.exportResolveScope).toHaveBeenCalled());
    expect(exportButton).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Export into the vault anyway" }));
    await waitFor(() => expect(exportButton).not.toBeDisabled());
    fireEvent.change(dest, { target: { value: "relative/a.html" } });
    expect(screen.getByText("Enter an absolute path (starting with /).")).toBeInTheDocument();
    expect(exportButton).toBeDisabled();
  });

  it("publishes a site with progress and shows missing links", async () => {
    vi.mocked(ipc.exportResolveScope).mockResolvedValue(preview(2));
    let finish: (r: SiteReport) => void = () => undefined;
    vi.mocked(ipc.exportSite).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    renderWizard("site");
    expect(await screen.findByText("2 notes")).toBeInTheDocument();
    const publish = screen.getByRole("button", { name: "Publish site" });
    await waitFor(() => expect(publish).not.toBeDisabled());
    fireEvent.click(publish);
    await waitFor(() => expect(progressHandler).not.toBeNull());
    act(() => progressHandler!({ done: 1, total: 4, current: "Alpha", phase: "pages" }));
    const bar = screen.getByRole("progressbar", { name: "Export progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("Writing pages · Alpha")).toBeInTheDocument();
    await act(async () =>
      finish({
        out_dir: "/Users/demo/Desktop/vault-site",
        index_path: "/Users/demo/Desktop/vault-site/index.html",
        pages: 2,
        tag_pages: 1,
        attachments: 0,
        skipped: 1,
        missing_links: [{ note: "Alpha", target: "Ghost" }],
        missing_link_count: 1,
        removed_stale: 0,
        bytes: 9000,
        warnings: ["No public URL set — sitemap.xml was not generated."],
        ms: 120,
      })
    );
    expect(await screen.findByText("Site published — 2 pages")).toBeInTheDocument();
    expect(screen.getByText(/skipped because of/)).toBeInTheDocument();
    expect(screen.getByText("Ghost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open site in browser" }));
    expect(ipc.exportOpenPath).toHaveBeenCalledWith("/Users/demo/Desktop/vault-site/index.html", false);
    expect(ipc.exportSite).toHaveBeenCalledWith({ kind: "vault" }, "/Users/demo/Desktop/vault-site", expect.any(Object));
  });

  it("previews the converted Markdown of a bundle and switches scope kinds", async () => {
    vi.mocked(ipc.exportResolveScope).mockResolvedValue(preview(2));
    renderWizard("bundle");
    expect(await screen.findByLabelText("Converted Markdown")).toHaveTextContent("[Alpha](Alpha.md)");
    fireEvent.click(screen.getByRole("radio", { name: "Tag" }));
    expect(await screen.findByRole("option", { name: /rust/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /rust/ }));
    await waitFor(() =>
      expect(ipc.exportResolveScope).toHaveBeenLastCalledWith({ kind: "tag", value: "rust" })
    );
  });

  it("asks before replacing an existing file and retries with overwrite", async () => {
    vi.mocked(ipc.exportResolveScope).mockResolvedValue(preview(1));
    const report = {
      path: "/Users/demo/Desktop/Alpha.html",
      title: "Alpha",
      bytes: 2048,
      attachments: 0,
      missing_links: 0,
      warnings: [],
      ms: 40,
    };
    vi.mocked(ipc.exportNoteHtml).mockImplementation(async (_note, out, options) => {
      if (!options.overwrite) {
        throw new Error(`invalid input: ${out} already exists. Choose another name or confirm replacing it (overwrite)`);
      }
      return report;
    });
    renderWizard("html");
    const dest = screen.getByLabelText("File") as HTMLInputElement;
    await waitFor(() => expect(dest.value).toBe("/Users/demo/Desktop/Alpha.html"));
    fireEvent.click(screen.getByRole("button", { name: "Export HTML" }));

    const confirm = await screen.findByRole("dialog", { name: "Replace existing file?" });
    expect(confirm).toHaveTextContent("/Users/demo/Desktop/Alpha.html");
    expect(ipc.exportNoteHtml).toHaveBeenLastCalledWith(NOTE, "/Users/demo/Desktop/Alpha.html", expect.objectContaining({ overwrite: false }));
    // Keeping the file does nothing (no error, no export).
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Replace existing file?" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export HTML" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await screen.findByText("“Alpha” exported");
    expect(ipc.exportNoteHtml).toHaveBeenLastCalledWith(NOTE, "/Users/demo/Desktop/Alpha.html", expect.objectContaining({ overwrite: true }));
    // The confirmation is never remembered for the next export.
    expect(JSON.parse(window.localStorage.getItem("aether-export-options-html") ?? "{}").overwrite).toBeUndefined();
  });

  it("reports scope errors in the footer", async () => {
    vi.mocked(ipc.exportResolveScope).mockRejectedValue(new Error("invalid input: the export scope contains no notes"));
    renderWizard("site");
    expect(await screen.findByText("invalid input: the export scope contains no notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish site" })).toBeDisabled();
  });
});
