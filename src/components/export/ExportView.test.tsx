import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RecentExport } from "../../types";

vi.mock("../../lib/ipc", () => ({
  isTauriRuntime: () => false,
  exportListRecent: vi.fn(),
  exportClearRecent: vi.fn().mockResolvedValue(undefined),
  exportOpenPath: vi.fn().mockResolvedValue(undefined),
  exportPrintDocument: vi.fn(),
  exportResolveScope: vi.fn().mockResolvedValue({ total: 0, notes: [], truncated: false, label: "" }),
  exportPreviewHtml: vi.fn().mockResolvedValue("<p>x</p>"),
  exportPreviewMarkdown: vi.fn().mockResolvedValue(""),
  exportListTags: vi.fn().mockResolvedValue([]),
  onExportProgress: vi.fn(async () => () => undefined),
}));

import * as ipc from "../../lib/ipc";
import { ExportView } from "./ExportView";
import { ToastProvider } from "../../ui";
import { useExportStore } from "../../lib/exportStore";
import { useAetherStore } from "../../lib/store";

const RECENTS: RecentExport[] = [
  {
    id: "1",
    kind: "site",
    title: "Garden",
    scope_label: "Whole vault (3 notes)",
    path: "/Users/demo/Sites/garden",
    created_at: new Date().toISOString(),
    items: 3,
    bytes: 4096,
    exists: true,
  },
  {
    id: "2",
    kind: "bundle",
    title: "notes",
    scope_label: "#rust (2 notes)",
    path: "/Users/demo/notes.zip",
    created_at: new Date().toISOString(),
    items: 2,
    bytes: 100,
    exists: false,
  },
];

const renderView = () =>
  render(
    <ToastProvider>
      <ExportView />
    </ToastProvider>
  );

describe("ExportView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExportStore.setState({ wizard: null, recents: [], recentsStatus: "idle", recentsError: null });
    useAetherStore.setState({ vaultPath: "/Users/demo/Vault", vaultNotes: [], selectedNotePath: null });
  });

  it("offers the three export flows", async () => {
    vi.mocked(ipc.exportListRecent).mockResolvedValue([]);
    renderView();
    expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();
    for (const title of ["Static site", "Single note", "Markdown bundle"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(await screen.findByText("No exports yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Publish site/ }));
    expect(await screen.findByRole("dialog", { name: "Publish as static site" })).toBeInTheDocument();
  });

  it("lists recent exports with open and reveal actions", async () => {
    vi.mocked(ipc.exportListRecent).mockResolvedValue(RECENTS);
    renderView();
    expect(await screen.findByText("Garden")).toBeInTheDocument();
    expect(screen.getByText("Moved or deleted")).toBeInTheDocument();
    const row = screen.getByText("Garden").closest(".ui-list-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Open site in browser" }));
    expect(ipc.exportOpenPath).toHaveBeenCalledWith("/Users/demo/Sites/garden/index.html", false);
    fireEvent.click(within(row).getByRole("button", { name: "Reveal in Finder" }));
    expect(ipc.exportOpenPath).toHaveBeenCalledWith("/Users/demo/Sites/garden", true);
    const missing = screen.getByText("notes").closest(".ui-list-row") as HTMLElement;
    expect(within(missing).queryByRole("button", { name: "Reveal in Finder" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Clear list/ }));
    await waitFor(() => expect(ipc.exportClearRecent).toHaveBeenCalled());
    expect(await screen.findByText("No exports yet")).toBeInTheDocument();
  });

  it("opens the HTML wizard to pick a note when printing without one", async () => {
    vi.mocked(ipc.exportListRecent).mockResolvedValue([]);
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Print / PDF" }));
    expect(await screen.findByRole("dialog", { name: "Export note as HTML" })).toBeInTheDocument();
    expect(ipc.exportPrintDocument).not.toHaveBeenCalled();
  });

  it("shows loading errors", async () => {
    vi.mocked(ipc.exportListRecent).mockRejectedValue(new Error("disk unreadable"));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("disk unreadable");
  });
});
