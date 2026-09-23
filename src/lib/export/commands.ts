/**
 * Command palette contributions of the export feature (registered in
 * `src/lib/commands/registry.ts`).
 */
import { FileCode2, Globe, PackageOpen, Printer } from "lucide-react";
import type { CommandContribution, CommandContext } from "../commands/registry";
import type { ExportFlow, ExportScope } from "../../types";
import { useAetherStore } from "../store";
import { useExportStore } from "../exportStore";
import { exportPrintDocument } from "../ipc";
import { loadFlowOptions } from "./options";
import { printDocument } from "./print";

/** Palette group of the export commands. */
export const EXPORT_COMMAND_GROUP = "Export";

/** Switch to the Export view and open the wizard for `flow`. */
export function openExportFlow(ctx: CommandContext, flow: ExportFlow, scope: ExportScope | null = null): void {
  ctx.setView("export");
  useExportStore.getState().openWizard(flow, scope);
}

/** The note open in the editor, if any. */
function currentNote(): string | null {
  return useAetherStore.getState().selectedNotePath;
}

/** Print the current note (or open the HTML wizard to pick one). */
export async function printCurrentNote(ctx: CommandContext): Promise<void> {
  const path = currentNote();
  if (!path) {
    ctx.toast.info("Open a note to print it", { description: "Pick the note to print in the export wizard." });
    openExportFlow(ctx, "html");
    return;
  }
  const doc = await exportPrintDocument(path, loadFlowOptions("html"));
  await printDocument(doc);
}

export const exportCommands: CommandContribution[] = [
  {
    id: "export.noteHtml",
    title: "Export: current note as HTML",
    group: EXPORT_COMMAND_GROUP,
    icon: FileCode2,
    shortcut: "mod+shift+e",
    keywords: ["html", "standalone", "share", "publish", "save"],
    run: (ctx) => {
      const path = currentNote();
      openExportFlow(ctx, "html", path ? { kind: "note", value: path } : null);
    },
  },
  {
    id: "export.printPdf",
    title: "Export: print / save as PDF",
    group: EXPORT_COMMAND_GROUP,
    icon: Printer,
    shortcut: "mod+alt+p",
    keywords: ["pdf", "print", "paper", "document"],
    run: (ctx) => printCurrentNote(ctx),
  },
  {
    id: "export.site",
    title: "Export: publish vault as site",
    group: EXPORT_COMMAND_GROUP,
    icon: Globe,
    shortcut: "mod+alt+w",
    keywords: ["website", "static", "publish", "garden", "github pages", "html"],
    run: (ctx) => openExportFlow(ctx, "site", { kind: "vault" }),
  },
  {
    id: "export.bundle",
    title: "Export: bundle vault",
    group: EXPORT_COMMAND_GROUP,
    icon: PackageOpen,
    shortcut: "mod+alt+z",
    keywords: ["zip", "markdown", "backup", "archive", "share"],
    run: (ctx) => openExportFlow(ctx, "bundle", { kind: "vault" }),
  },
];
