import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, FileCode2, Globe, PackageOpen, Printer, Replace, type LucideIcon } from "lucide-react";
import { Button, Kbd, Modal, useToast } from "../../ui";
import { useAetherStore } from "../../lib/store";
import { useExportStore } from "../../lib/exportStore";
import {
  exportBundle,
  exportNoteHtml,
  exportOpenPath,
  exportPrintDocument,
  exportResolveScope,
  exportSite,
  onExportProgress,
} from "../../lib/ipc";
import { loadFlowOptions, loadLastDir, saveFlowOptions, saveLastDir } from "../../lib/export/options";
import { existingPathFromError, isAlreadyExistsError, phaseLabel, plural, progressPercent } from "../../lib/export/format";
import { printDocument } from "../../lib/export/print";
import {
  baseName,
  defaultExportDir,
  defaultScope,
  isInsideVault,
  isScopeReady,
  parentDir,
  scopeSummary,
  suggestDestination,
} from "../../lib/export/scope";
import type { ExportFlow, ExportOptions, ExportProgress, ExportScope, ScopePreview } from "../../types";
import { ScopePicker } from "./ScopePicker";
import { ExportOptionsForm } from "./ExportOptionsForm";
import { DestinationField } from "./DestinationField";
import { PreviewPane } from "./PreviewPane";
import { ExportReport, type ExportResult } from "./ExportReport";

const FLOWS: Record<ExportFlow, { title: string; description: string; icon: LucideIcon; action: string }> = {
  html: {
    title: "Export note as HTML",
    description: "A single self-contained page — or print it to PDF.",
    icon: FileCode2,
    action: "Export HTML",
  },
  site: {
    title: "Publish as static site",
    description: "Index, note pages, backlinks, tags and search as plain files.",
    icon: Globe,
    action: "Publish site",
  },
  bundle: {
    title: "Create Markdown bundle",
    description: "A zip of Markdown notes, attachments and a manifest.",
    icon: PackageOpen,
    action: "Create bundle",
  },
};

/** Debounce for resolving the scope while the user picks. */
const RESOLVE_DEBOUNCE_MS = 150;

export interface ExportWizardProps {
  flow: ExportFlow;
  initialScope: ExportScope | null;
  onClose: () => void;
}

/** Scope → options → destination → preview → export, for one flow. */
export function ExportWizard({ flow, initialScope, onClose }: ExportWizardProps) {
  const toast = useToast();
  const vaultRoot = useAetherStore((s) => s.vaultPath);
  const notes = useAetherStore((s) => s.vaultNotes);
  const currentNote = useAetherStore((s) => s.selectedNotePath);
  const loadRecents = useExportStore((s) => s.loadRecents);
  const meta = FLOWS[flow];

  const [scope, setScope] = useState<ExportScope>(() => initialScope ?? defaultScope(flow, currentNote));
  const [options, setOptions] = useState<ExportOptions>(() => loadFlowOptions(flow));
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [destTouched, setDestTouched] = useState(false);
  /** Destination picked in the native save dialog (it already confirmed replacing). */
  const [dialogPath, setDialogPath] = useState<string | null>(null);
  /** An existing file the user is asked to replace. */
  const [replacePath, setReplacePath] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolveId = useRef(0);

  const vaultName = vaultRoot ? baseName(vaultRoot) : "Vault";

  // Resolve the scope (count, label, preview candidates).
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    if (!isScopeReady(scope)) {
      setPreview(null);
      setScopeError(null);
      return;
    }
    const id = ++resolveId.current;
    const timer = setTimeout(() => {
      exportResolveScope(scope)
        .then((p) => {
          if (id !== resolveId.current) return;
          setPreview(p);
          setScopeError(null);
        })
        .catch((e) => {
          if (id !== resolveId.current) return;
          setPreview(null);
          setScopeError(e instanceof Error ? e.message : String(e));
        });
    }, RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `scope` is compared by value through `scopeKey`.
  }, [scopeKey]);

  // Suggest a destination until the user edits it.
  const suggestion = useMemo(() => {
    const dir = loadLastDir(flow) ?? defaultExportDir(vaultRoot);
    if (!dir) return "";
    const title =
      flow === "site"
        ? options.site_title.trim() || vaultName
        : flow === "html"
          ? (preview?.notes[0]?.title ?? "note")
          : preview && preview.total === 1
            ? preview.notes[0].title
            : `${vaultName} ${scope.kind === "vault" ? "notes" : scopeSummary(scope, vaultRoot).replace(/[#/]/g, " ")}`;
    return suggestDestination(flow, dir, title);
  }, [flow, vaultRoot, vaultName, options.site_title, preview, scope]);

  useEffect(() => {
    if (!destTouched) setDestination(suggestion);
  }, [suggestion, destTouched]);

  const patchOptions = (patch: Partial<ExportOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const inside = isInsideVault(destination, vaultRoot);
  const notePath = flow === "html" && scope.kind === "note" ? scope.value : null;
  const canExport =
    !running &&
    !!preview &&
    !scopeError &&
    destination.trim().startsWith("/") &&
    (!inside || options.allow_inside_vault);

  const openPath = async (path: string, reveal: boolean) => {
    try {
      await exportOpenPath(path, reveal);
    } catch (e) {
      toast.error(reveal ? "Could not reveal the export" : "Could not open the export", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Export. HTML pages and bundles never replace an existing file unless
   * the user confirmed it: in the native save dialog (`dialogPath`) or in
   * the "Replace existing file?" prompt, which retries with `replace`.
   */
  const run = async (replace = false) => {
    if (!canExport) return;
    setRunning(true);
    setError(null);
    setProgress(null);
    setReplacePath(null);
    const target = destination.trim();
    const overwrite = flow !== "site" && (replace || dialogPath === target);
    const sent: ExportOptions = { ...options, overwrite };
    const unlisten = await onExportProgress(setProgress);
    try {
      let next: ExportResult;
      if (flow === "html") {
        if (!notePath) throw new Error("Choose a note to export.");
        next = { flow, report: await exportNoteHtml(notePath, target, sent) };
      } else if (flow === "site") {
        next = { flow, report: await exportSite(scope, target, sent) };
      } else {
        next = { flow, report: await exportBundle(scope, target, sent) };
      }
      saveFlowOptions(flow, options);
      const out = next.flow === "site" ? next.report.out_dir : next.report.path;
      saveLastDir(flow, parentDir(out));
      setResult(next);
      toast.success(
        next.flow === "site" ? "Site published" : next.flow === "bundle" ? "Bundle created" : "Note exported",
        { description: out }
      );
      void loadRecents();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (flow !== "site" && !overwrite && isAlreadyExistsError(message)) {
        setReplacePath(existingPathFromError(message.replace(/^invalid input: /, "")) ?? target);
      } else {
        setError(message);
        toast.error("Export failed", { description: message });
      }
    } finally {
      unlisten();
      setRunning(false);
    }
  };

  const print = async () => {
    if (!notePath) return;
    setPrinting(true);
    try {
      const doc = await exportPrintDocument(notePath, options);
      await printDocument(doc);
    } catch (e) {
      toast.error("Could not print the note", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPrinting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !result) {
      e.preventDefault();
      void run(false);
    }
  };

  const percent = progressPercent(progress);
  const footerStart = running ? (
    <div className="export-progress" aria-live="polite">
      <div
        className="export-progress-track"
        role="progressbar"
        aria-label="Export progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="export-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="export-progress-label">
        {progress ? `${phaseLabel(progress.phase)} · ${progress.current}` : "Preparing…"}
      </span>
    </div>
  ) : result ? null : (
    <span className="export-footer-summary">
      {scopeError ? (
        <span className="export-footer-error">{scopeError}</span>
      ) : preview ? (
        <>
          <strong className="tabular">{plural(preview.total, "note")}</strong> ·{" "}
          {preview.label.replace(/\s*\(\d+ notes?\)$/, "")}
        </>
      ) : (
        scopeSummary(scope, vaultRoot)
      )}
    </span>
  );

  const footer = result ? (
    <>
      <Button variant="ghost" iconLeft={<ArrowLeft size={14} />} onClick={() => setResult(null)}>
        Back to options
      </Button>
      <Button variant="secondary" onClick={onClose}>
        Done
      </Button>
    </>
  ) : (
    <>
      <Kbd shortcut="mod+enter" className="export-footer-kbd" />
      <Button variant="ghost" onClick={onClose} disabled={running}>
        Cancel
      </Button>
      {flow === "html" && (
        <Button
          variant="secondary"
          iconLeft={<Printer size={14} />}
          onClick={() => void print()}
          loading={printing}
          disabled={!notePath || !preview || running}
        >
          Print / PDF
        </Button>
      )}
      <Button variant="primary" onClick={() => void run(false)} loading={running} disabled={!canExport}>
        {meta.action}
      </Button>
    </>
  );

  return (
    <Modal
      open
      onClose={running ? () => undefined : onClose}
      dismissible={!running}
      title={meta.title}
      description={meta.description}
      icon={meta.icon}
      size="xl"
      className="export-wizard-modal"
      bodyClassName="export-wizard-body"
      footerStart={footerStart}
      footer={footer}
    >
      <div className="export-wizard" onKeyDown={onKeyDown}>
        {result ? (
          <ExportReport result={result} onOpen={(p, reveal) => void openPath(p, reveal)} />
        ) : (
          <>
            <div className="export-wizard-form">
              <section className="export-step" aria-labelledby="export-step-scope">
                <h3 className="export-step-title" id="export-step-scope">
                  <span className="export-step-index">1</span>
                  {flow === "html" ? "Note" : "What to export"}
                </h3>
                <ScopePicker
                  flow={flow}
                  scope={scope}
                  onChange={setScope}
                  notes={notes}
                  vaultRoot={vaultRoot}
                  currentNote={currentNote}
                />
              </section>
              <section className="export-step" aria-labelledby="export-step-options">
                <h3 className="export-step-title" id="export-step-options">
                  <span className="export-step-index">2</span>
                  Options
                </h3>
                <ExportOptionsForm flow={flow} options={options} onChange={patchOptions} vaultName={vaultName} />
              </section>
              <section className="export-step" aria-labelledby="export-step-dest">
                <h3 className="export-step-title" id="export-step-dest">
                  <span className="export-step-index">3</span>
                  Destination
                </h3>
                <DestinationField
                  flow={flow}
                  value={destination}
                  onChange={(v, fromDialog) => {
                    setDestTouched(true);
                    setDestination(v);
                    setDialogPath(fromDialog ? v.trim() : null);
                  }}
                  vaultRoot={vaultRoot}
                  allowInsideVault={options.allow_inside_vault}
                  onAllowInsideVault={(allow) => patchOptions({ allow_inside_vault: allow })}
                  onError={(m) => toast.error("Could not open the file dialog", { description: m })}
                />
              </section>
              {error && (
                <div className="ui-notice ui-notice-danger export-error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <PreviewPane
              flow={flow}
              scope={scope}
              options={options}
              notes={preview?.notes ?? []}
              onThemeChange={(theme) => patchOptions({ theme })}
            />
          </>
        )}
      </div>
      <Modal
        open={replacePath !== null}
        onClose={() => setReplacePath(null)}
        size="sm"
        icon={Replace}
        title="Replace existing file?"
        description="A file with this name already exists. Replacing it cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReplacePath(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void run(true)}>
              Replace
            </Button>
          </>
        }
      >
        <code className="export-replace-path">{replacePath}</code>
      </Modal>
    </Modal>
  );
}
