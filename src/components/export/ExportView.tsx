import { useEffect, type ReactNode } from "react";
import {
  ExternalLink,
  FileCode2,
  FolderOpen,
  Globe,
  History,
  PackageOpen,
  Printer,
  Share,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, Card, EmptyState, IconButton, Kbd, ListRow, Spinner, ViewHeader, useToast } from "../../ui";
import { useAetherStore } from "../../lib/store";
import { useExportStore } from "../../lib/exportStore";
import { exportOpenPath, exportPrintDocument } from "../../lib/ipc";
import { formatBytes, formatRelative, kindLabel, plural } from "../../lib/export/format";
import { loadFlowOptions } from "../../lib/export/options";
import { printDocument } from "../../lib/export/print";
import { joinPath } from "../../lib/export/scope";
import type { ExportFlow, ExportKind, RecentExport } from "../../types";
import { ExportWizard } from "./ExportWizard";
import "../../styles/views/export.css";

const KIND_ICONS: Record<ExportKind, LucideIcon> = {
  html: FileCode2,
  site: Globe,
  bundle: PackageOpen,
};

interface FlowCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  features: string[];
  /** Shortcut of the flow's command, shown in the card corner. */
  shortcut: string;
  featured?: boolean;
  children: ReactNode;
  aside?: ReactNode;
}

function FlowCard({ icon: Icon, title, description, features, shortcut, featured, children, aside }: FlowCardProps) {
  return (
    <Card padding="none" raised={featured} className={featured ? "export-flow is-featured" : "export-flow"}>
      <div className="export-flow-main">
        <div className="export-flow-top">
          <span className="export-flow-icon" aria-hidden="true">
            <Icon size={18} strokeWidth={1.75} />
          </span>
          <Kbd shortcut={shortcut} />
        </div>
        <h2 className="export-flow-title">{title}</h2>
        <p className="export-flow-description">{description}</p>
        <ul className="export-flow-features" aria-label={`${title} features`}>
          {features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="export-flow-actions">{children}</div>
      </div>
      {aside}
    </Card>
  );
}

/** The folder structure of a published site, shown on the featured card. */
function SiteSketch() {
  const rows: [string, string][] = [
    ["index.html", "notes by folder"],
    ["notes/", "one page per note"],
    ["tags/", "a page per tag"],
    ["files/", "attachments"],
    ["search-index.js", "instant search"],
    ["sitemap.xml", "for search engines"],
  ];
  return (
    <div className="export-site-sketch" aria-hidden="true">
      <div className="export-site-sketch-head">my-garden/</div>
      {rows.map(([name, note]) => (
        <div key={name} className="export-site-sketch-row">
          <span className="export-site-sketch-name">{name}</span>
          <span className="export-site-sketch-note">{note}</span>
        </div>
      ))}
    </div>
  );
}

function recentOpenTarget(r: RecentExport): string | null {
  if (r.kind === "site") return joinPath(r.path, "index.html");
  if (r.kind === "html") return r.path;
  return null;
}

/** Export & publishing workspace. */
export function ExportView() {
  const toast = useToast();
  const selectedNotePath = useAetherStore((s) => s.selectedNotePath);
  const { wizard, openWizard, closeWizard, recents, recentsStatus, recentsError, loadRecents, clearRecents } =
    useExportStore();

  useEffect(() => {
    void loadRecents();
  }, [loadRecents]);

  const open = (flow: ExportFlow) => {
    openWizard(flow, flow === "html" && selectedNotePath ? { kind: "note", value: selectedNotePath } : null);
  };

  const printCurrent = async () => {
    if (!selectedNotePath) {
      openWizard("html");
      return;
    }
    try {
      const doc = await exportPrintDocument(selectedNotePath, loadFlowOptions("html"));
      await printDocument(doc);
    } catch (e) {
      toast.error("Could not print the note", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const openPath = async (path: string, reveal: boolean) => {
    try {
      await exportOpenPath(path, reveal);
    } catch (e) {
      toast.error(reveal ? "Could not reveal the export" : "Could not open the export", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const clear = async () => {
    try {
      await clearRecents();
      toast.success("Recent exports cleared", { description: "The exported files were not touched." });
    } catch (e) {
      toast.error("Could not clear recent exports", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="view export-view">
      <ViewHeader
        icon={Share}
        title="Export"
        subtitle="HTML, PDF, websites and Markdown bundles — generated on this machine, nothing is uploaded."
        actions={
          <Button variant="secondary" iconLeft={<Printer size={14} />} onClick={() => void printCurrent()}>
            Print current note
          </Button>
        }
      />
      <div className="view-body export-body">
        <section className="export-flows" aria-label="Export formats">
          <FlowCard
            featured
            icon={Globe}
            title="Static site"
            description="A self-hosted Obsidian Publish: an index, one page per note with backlinks, tag pages and instant search. Open it from a folder or upload it to GitHub Pages or any static host."
            features={["Backlinks", "Tag pages", "Client-side search", "Light & dark", "Sitemap"]}
            shortcut="mod+alt+w"
            aside={<SiteSketch />}
          >
            <Button variant="primary" iconLeft={<Globe size={14} />} onClick={() => open("site")}>
              Publish site…
            </Button>
          </FlowCard>
          <FlowCard
            icon={FileCode2}
            title="Single note"
            description="One note as a self-contained HTML file with inlined styles and images, or printed to PDF."
            features={["Syntax highlighting", "Wikilinks & tags", "Print to PDF"]}
            shortcut="mod+shift+e"
          >
            <Button variant="secondary" iconLeft={<FileCode2 size={14} />} onClick={() => open("html")}>
              Export HTML…
            </Button>
            <Button variant="ghost" iconLeft={<Printer size={14} />} onClick={() => void printCurrent()}>
              Print / PDF
            </Button>
          </FlowCard>
          <FlowCard
            icon={PackageOpen}
            title="Markdown bundle"
            description="A zip of notes with their attachments and a manifest. Wikilinks become standard Markdown links, so it reads well anywhere."
            features={["Folder structure kept", "Attachments", "manifest.json"]}
            shortcut="mod+alt+z"
          >
            <Button variant="secondary" iconLeft={<PackageOpen size={14} />} onClick={() => open("bundle")}>
              Create bundle…
            </Button>
          </FlowCard>
        </section>

        <section className="export-recents" aria-labelledby="export-recents-title">
          <div className="export-section-head">
            <h2 id="export-recents-title" className="ui-section-label">
              <History size={12} /> Recent exports
            </h2>
            {recents.length > 0 && (
              <Button variant="ghost" size="sm" iconLeft={<Trash2 size={13} />} onClick={() => void clear()}>
                Clear list
              </Button>
            )}
          </div>
          {recentsStatus === "loading" && recents.length === 0 ? (
            <div className="export-recents-loading">
              <Spinner size={14} label="Loading recent exports" />
            </div>
          ) : recentsStatus === "error" && recents.length === 0 ? (
            <div className="ui-notice ui-notice-danger" role="alert">
              {recentsError ?? "Could not load recent exports."}
            </div>
          ) : recents.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Share}
              title="No exports yet"
              description="Exports you create show up here with shortcuts to reveal or open them."
            />
          ) : (
            <div className="export-recents-list" role="list">
              {recents.map((r) => {
                const Icon = KIND_ICONS[r.kind];
                const target = recentOpenTarget(r);
                return (
                  <ListRow
                    key={r.id}
                    role="listitem"
                    icon={<Icon size={14} />}
                    title={r.title}
                    description={`${kindLabel(r.kind)} · ${r.scope_label} · ${formatRelative(r.created_at)}`}
                    meta={
                      r.exists ? (
                        <span className="export-recent-meta tabular">
                          {plural(r.items, r.kind === "bundle" ? "note" : "page")} · {formatBytes(r.bytes)}
                        </span>
                      ) : (
                        <Badge variant="warning">Moved or deleted</Badge>
                      )
                    }
                    actions={
                      r.exists ? (
                        <>
                          {target && (
                            <IconButton
                              size="sm"
                              label={r.kind === "site" ? "Open site in browser" : "Open in browser"}
                              icon={<ExternalLink size={13} />}
                              onClick={() => void openPath(target, false)}
                            />
                          )}
                          <IconButton
                            size="sm"
                            label="Reveal in Finder"
                            icon={<FolderOpen size={13} />}
                            onClick={() => void openPath(r.path, true)}
                          />
                        </>
                      ) : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
      {wizard && (
        <ExportWizard key={wizard.key} flow={wizard.flow} initialScope={wizard.scope} onClose={closeWizard} />
      )}
    </div>
  );
}
