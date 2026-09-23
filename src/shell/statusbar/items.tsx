import { Database, FolderClosed } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { useHomeStore } from "../../lib/homeStore";
import { relativeTime } from "../../lib/home/format";
import { Spinner, Tooltip } from "../../ui";
import { useShellStore } from "../shellStore";

/** Base name of a path (`/Users/me/Vault` → `Vault`). */
export function vaultName(path: string | null): string {
  if (!path) return "No vault";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Vault name and note count; opens the vault settings. */
export function VaultStatusItem() {
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const noteCount = useAetherStore((s) => s.vaultStats?.note_count ?? s.vaultNotes.length);
  const openSettings = useShellStore((s) => s.openSettings);
  return (
    <Tooltip content={vaultPath ?? "No vault connected — choose one in Settings"} placement="top">
      <button type="button" className="statusbar-item" onClick={() => openSettings("vault")}>
        <FolderClosed size={14} />
        <span className="statusbar-strong">{vaultName(vaultPath)}</span>
        {vaultPath && <span className="statusbar-muted tabular">{noteCount} notes</span>}
      </button>
    </Tooltip>
  );
}

/**
 * Semantic indexing state; click to (re-)index the vault. Runs through
 * Home's `runIndex`, so the run is recorded (`aether-home-last-index`) and
 * Home's Vault block and this item always agree on the last index time.
 */
export function IndexingStatusItem() {
  const indexing = useAetherStore((s) => s.indexing);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const lastIndex = useHomeStore((s) => s.lastIndex);
  const runIndex = useHomeStore((s) => s.runIndex);

  if (!vaultPath) return null;
  const tooltip = indexing
    ? "Building the semantic index…"
    : lastIndex
      ? `Indexed ${relativeTime(lastIndex.at, Date.now())} (${lastIndex.result.indexed} of ${lastIndex.result.total} notes) — click to re-index`
      : "Not indexed yet — click to index the vault for semantic search";
  return (
    <Tooltip content={tooltip} placement="top">
      <button type="button" className="statusbar-item" onClick={() => void runIndex()} aria-busy={indexing || undefined}>
        {indexing ? <Spinner size={14} /> : <Database size={14} />}
        <span className="statusbar-muted">{indexing ? "Indexing…" : "Index"}</span>
      </button>
    </Tooltip>
  );
}

/** Ollama / OpenRouter connection dots; opens the AI settings. */
export function ProvidersStatusItem() {
  const health = useAetherStore((s) => s.health);
  const openSettings = useShellStore((s) => s.openSettings);
  const ollama = !!health?.ollama_online;
  const openrouter = !!health?.openrouter_configured;
  return (
    <>
      <Tooltip
        content={ollama ? "Ollama is running locally" : "Ollama is offline — start it with `ollama serve`"}
        placement="top"
      >
        <button type="button" className="statusbar-item" onClick={() => openSettings("ai")}>
          <span className={`statusbar-dot ${ollama ? "is-online" : "is-offline"}`} aria-hidden="true" />
          <span className="statusbar-muted">Ollama</span>
          <span className="sr-only">{ollama ? "online" : "offline"}</span>
        </button>
      </Tooltip>
      <Tooltip
        content={openrouter ? "OpenRouter API key configured" : "No OpenRouter key — add one in Settings"}
        placement="top"
      >
        <button type="button" className="statusbar-item" onClick={() => openSettings("ai")}>
          <span className={`statusbar-dot ${openrouter ? "is-online" : "is-idle"}`} aria-hidden="true" />
          <span className="statusbar-muted">OpenRouter</span>
          <span className="sr-only">{openrouter ? "configured" : "not configured"}</span>
        </button>
      </Tooltip>
    </>
  );
}
