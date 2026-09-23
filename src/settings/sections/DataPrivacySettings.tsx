import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bug,
  ClipboardCopy,
  Cloud,
  Eye,
  FolderOpen,
  Globe,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  SquareArrowOutUpRight,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { AppInfo, AppLogTail, CrashReport, CrashReportSummary, DataLocation } from "../../types";
import {
  clearCrashReports,
  getAppInfo,
  getDataLocations,
  isDesktopRuntime,
  isTauriRuntime,
  listCrashReports,
  openAppDataDir,
  readAppLog,
  readCrashReport,
  resetAppData,
  revealVault,
} from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { copyText } from "../../lib/onboarding/clipboard";
import { formatBytes } from "../../lib/onboarding/models";
import { Badge, Button, Checkbox, EmptyState, IconButton, Input, ListRow, Modal, Spinner, Switch, useToast } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";
import "../../styles/views/onboarding.css";

/** Word the user types to confirm a reset. */
export const RESET_CONFIRM_WORD = "RESET";
const LOG_BYTES = 64 * 1024;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Keep only the lines written for the webview (`[frontend]`). */
export function frontendLines(log: string): string {
  return log
    .split("\n")
    .filter((line) => line.includes("[frontend]"))
    .join("\n");
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Reloads the browser preview after a mock reset (a seam for tests). */
export const previewReload = { run: () => window.location.reload() };

/** Remove the per-browser preferences that belong to the app (`aether-*`). */
export function clearAppStorage(storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null): number {
  if (!storage) return 0;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith("aether-")) keys.push(key);
  }
  keys.forEach((k) => storage.removeItem(k));
  return keys.length;
}

/** Two-step confirmation for resetting the app data. */
function ResetDialog({ open, onClose, keepVault }: { open: boolean; onClose: () => void; keepVault: boolean }) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setUnderstood(false);
    setTyped("");
    setError(null);
  }, [open]);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await resetAppData(keepVault);
      clearAppStorage();
      toast.info("App data moved to a backup", {
        description: `${outcome.backup_path} — ${outcome.restarting ? "AETHER-OS restarts now." : "reloading…"}`,
        duration: 0,
      });
      if (!outcome.restarting) window.setTimeout(() => previewReload.run(), 900);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      dismissible={!busy}
      size="sm"
      icon={TriangleAlert}
      title={step === 1 ? "Reset app data?" : "Confirm the reset"}
      description={step === 1 ? "Start over with a fresh AETHER-OS." : `Type ${RESET_CONFIRM_WORD} to move your app data aside and restart.`}
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" disabled={!understood} onClick={() => setStep(2)}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
              Back
            </Button>
            <Button variant="danger" loading={busy} disabled={typed.trim() !== RESET_CONFIRM_WORD} onClick={() => void reset()}>
              Reset and restart
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="ob-step-stack">
          <ul className="obs-leaves">
            <li>
              <Trash2 size={14} />
              <span>
                AI notes, memory, calendar, tasks, the search index, logs, crash reports and every setting are moved to a dated
                backup folder next to the data folder — nothing is deleted.
              </span>
            </li>
            <li>
              <ShieldCheck size={14} />
              <span>
                <strong>Your vault folder is never touched.</strong>{" "}
                {keepVault ? "It stays connected after the restart." : "You will connect it again in the setup wizard."}
              </span>
            </li>
          </ul>
          <Checkbox checked={understood} onChange={setUnderstood} label="I understand AETHER-OS will restart with a fresh setup" />
        </div>
      ) : (
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="obs-reset-confirm">
            Type {RESET_CONFIRM_WORD}
          </label>
          <Input
            id="obs-reset-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && typed.trim() === RESET_CONFIRM_WORD && !busy) void reset();
            }}
          />
          {error && <span className="ui-field-error">{error}</span>}
        </div>
      )}
    </Modal>
  );
}

/** Data locations, what leaves the machine, crash reports, the log and the reset danger zone. */
export function DataPrivacySettings() {
  const toast = useToast();
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [locations, setLocations] = useState<DataLocation[] | null>(null);
  const [reports, setReports] = useState<CrashReportSummary[] | null>(null);
  const [viewing, setViewing] = useState<CrashReport | null>(null);
  const [log, setLog] = useState<AppLogTail | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  const [frontendOnly, setFrontendOnly] = useState(false);
  const [keepVault, setKeepVault] = useState(true);
  const [resetOpen, setResetOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const desktop = isDesktopRuntime();

  const loadReports = useCallback(async () => {
    try {
      setReports(await listCrashReports());
    } catch (e) {
      setReports([]);
      toast.error("Could not list crash reports", { description: errorText(e) });
    }
  }, [toast]);

  const loadLog = useCallback(async () => {
    setLogBusy(true);
    try {
      setLog(await readAppLog(LOG_BYTES));
    } catch (e) {
      toast.error("Could not read the log", { description: errorText(e) });
    } finally {
      setLogBusy(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!desktop) return;
    getAppInfo()
      .then(setInfo)
      .catch((e) => setLoadError(errorText(e)));
    getDataLocations()
      .then(setLocations)
      .catch((e) => {
        setLocations([]);
        setLoadError(errorText(e));
      });
    void loadReports();
    void loadLog();
  }, [desktop, loadReports, loadLog]);

  const shownLog = useMemo(() => {
    if (!log) return "";
    return frontendOnly ? frontendLines(log.content) : log.content;
  }, [log, frontendOnly]);

  const act = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) toast.success(success);
    } catch (e) {
      toast.error(label, { description: errorText(e) });
    }
  };

  const view = async (id: string) => {
    try {
      setViewing(await readCrashReport(id));
    } catch (e) {
      toast.error("Could not open the crash report", { description: errorText(e) });
    }
  };

  const copyReport = async (id: string) => {
    await act(
      "Could not copy the crash report",
      async () => {
        const report = await readCrashReport(id);
        await copyText(report.content);
      },
      "Crash report copied"
    );
  };

  const clearReports = async () => {
    try {
      const removed = await clearCrashReports();
      setReports([]);
      toast.success(removed === 1 ? "1 crash report deleted" : `${removed} crash reports deleted`);
    } catch (e) {
      toast.error("Could not delete crash reports", { description: errorText(e) });
    }
  };

  const totalSize = locations?.reduce((n, l) => n + l.size_bytes, 0) ?? 0;

  return (
    <SettingsPage
      title="Data & Privacy"
      description="Everything AETHER-OS stores lives on this computer. Here is where, and what — if anything — leaves it."
    >
      <SettingsGroup title="Where your data lives">
        <SettingsRow
          label="Your notes"
          hint={vaultPath ?? "No vault connected."}
          control={
            <Button size="sm" variant="ghost" iconLeft={<SquareArrowOutUpRight size={13} />} disabled={!vaultPath} onClick={() => void act("Could not reveal the vault", revealVault)}>
              Reveal
            </Button>
          }
        />
        <SettingsRow
          label="App data"
          hint={info ? `${info.data_dir} · ${formatBytes(totalSize)}` : loadError ?? "Loading…"}
          control={
            <Button size="sm" variant="secondary" iconLeft={<FolderOpen size={13} />} onClick={() => void act("Could not open the data folder", openAppDataDir)}>
              Open folder
            </Button>
          }
        />
        {locations === null ? (
          <div className="ob-loading obs-pad">
            <Spinner size={14} /> Reading the data folder…
          </div>
        ) : locations.length > 0 ? (
          <table className="obs-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Contains</th>
                <th scope="col" className="obs-size">
                  Size
                </th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.path}>
                  <td className="obs-name" title={l.path}>
                    {l.name}
                    {l.is_dir ? "/" : ""}
                  </td>
                  <td>{l.description}</td>
                  <td className="obs-size">{formatBytes(l.size_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="What leaves this machine">
        <ul className="obs-leaves">
          <li>
            <HardDrive size={14} />
            <span>
              <strong>Local AI stays local.</strong> Chat, embeddings and model downloads go to Ollama on localhost:11434 only.
              Downloads come from Ollama's registry, requested by Ollama itself.
            </span>
          </li>
          <li>
            <Cloud size={14} />
            <span>
              <strong>OpenRouter, only when you choose it.</strong> With a key and a cloud model, your prompt and the notes in
              the agent's context are sent to openrouter.ai.
            </span>
          </li>
          <li>
            <RefreshCw size={14} />
            <span>
              <strong>Update check.</strong> An anonymous request to GitHub's releases API when you click “Check for updates”, or
              once a day if you turned that on.
            </span>
          </li>
          <li>
            <Globe size={14} />
            <span>
              <strong>Pages you open.</strong> The browser view and the web clipper load the URLs you give them.
            </span>
          </li>
          <li>
            <ShieldCheck size={14} />
            <span>
              <strong>Nothing else.</strong> No account, no analytics, no telemetry. Crash reports and logs are written to the
              data folder and never uploaded.
            </span>
          </li>
        </ul>
      </SettingsGroup>

      <SettingsGroup title="Crash reports" description="Written locally when a view or the backend crashes. Share one with a bug report if you like.">
        {reports === null ? (
          <div className="ob-loading obs-pad">
            <Spinner size={14} /> Loading…
          </div>
        ) : reports.length === 0 ? (
          <EmptyState size="sm" icon={Bug} title="No crash reports" description="Nothing has crashed. Nice." />
        ) : (
          <>
            <div className="obs-list">
              {reports.map((r) => (
                <ListRow
                  key={r.id}
                  icon={<Bug size={14} />}
                  title={r.message || "(no message)"}
                  description={`${formatWhen(r.created_at)} · ${r.kind} · ${formatBytes(r.size)}`}
                  actions={
                    <>
                      <IconButton size="sm" label="View crash report" icon={<Eye size={13} />} onClick={() => void view(r.id)} />
                      <IconButton size="sm" label="Copy crash report" icon={<ClipboardCopy size={13} />} onClick={() => void copyReport(r.id)} />
                    </>
                  }
                  onClick={() => void view(r.id)}
                />
              ))}
            </div>
            <SettingsRow
              label={`${reports.length} ${reports.length === 1 ? "report" : "reports"}`}
              control={
                <Button size="sm" variant="danger" iconLeft={<Trash2 size={13} />} onClick={() => void clearReports()}>
                  Delete all
                </Button>
              }
            />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Application log" description={log ? `${log.path} · ${formatBytes(log.size_bytes)}${log.truncated ? " · showing the last 64 KB" : ""}` : undefined}>
        <SettingsRow
          label="Frontend errors only"
          hint="Errors reported by the interface (render crashes, unhandled promise rejections)."
          control={
            <div className="obs-inline">
              <Switch checked={frontendOnly} onChange={setFrontendOnly} aria-label="Frontend errors only" />
              <IconButton size="sm" label="Reload log" icon={<RefreshCw size={13} />} loading={logBusy} onClick={() => void loadLog()} />
              <IconButton
                size="sm"
                label="Copy log"
                icon={<ClipboardCopy size={13} />}
                disabled={!shownLog}
                onClick={() => void act("Could not copy the log", () => copyText(shownLog), "Log copied")}
              />
            </div>
          }
        />
        <pre className="obs-log" aria-label="Application log" tabIndex={0}>
          {log === null ? "Loading…" : shownLog || (frontendOnly ? "No frontend errors logged." : "The log is empty.")}
        </pre>
      </SettingsGroup>

      <SettingsGroup title="Danger zone" className="obs-danger">
        <SettingsRow
          label="Keep the vault connection"
          hint="After the reset, AETHER-OS still points at your vault folder."
          control={<Switch checked={keepVault} onChange={setKeepVault} aria-label="Keep the vault connection" />}
        />
        <SettingsRow
          label="Reset app data"
          hint={
            isTauriRuntime()
              ? "Moves the data folder to a dated backup and restarts with a fresh setup. Your vault is never touched."
              : "Browser preview: resets the mock backend and reloads the page."
          }
          control={
            <Button size="sm" variant="danger" onClick={() => setResetOpen(true)}>
              Reset app data…
            </Button>
          }
        />
      </SettingsGroup>

      <ResetDialog open={resetOpen} onClose={() => setResetOpen(false)} keepVault={keepVault} />

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        size="lg"
        icon={Bug}
        title="Crash report"
        description={viewing ? `${formatWhen(viewing.created_at)} · ${viewing.kind}` : undefined}
        headerActions={viewing ? <Badge>{viewing.id}</Badge> : undefined}
        footer={
          <Button
            variant="primary"
            iconLeft={<ClipboardCopy size={13} />}
            onClick={() => viewing && void act("Could not copy the crash report", () => copyText(viewing.content), "Crash report copied")}
          >
            Copy
          </Button>
        }
      >
        <pre className="obs-report">{viewing?.content}</pre>
      </Modal>
    </SettingsPage>
  );
}
