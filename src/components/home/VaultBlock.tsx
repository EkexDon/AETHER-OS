import { Database, FolderOpen, Library, Sparkles } from "lucide-react";
import type { VaultStats } from "../../types";
import type { LastIndexRun } from "../../lib/homeStore";
import { relativeTime } from "../../lib/home/format";
import { Button, EmptyState } from "../../ui";
import { HomeBlock } from "./HomeBlock";

export interface VaultBlockProps {
  vaultPath: string | null;
  stats: VaultStats | null;
  noteCount: number;
  indexing: boolean;
  lastIndex: LastIndexRun | null;
  now: number;
  onIndex: () => void;
  onOpenGraph: () => void;
  onChooseVault: () => void;
}

/** Vault counters as stat tiles plus "Index vault for AI" with its last run. */
export function VaultBlock({
  vaultPath,
  stats,
  noteCount,
  indexing,
  lastIndex,
  now,
  onIndex,
  onOpenGraph,
  onChooseVault,
}: VaultBlockProps) {
  if (!vaultPath) {
    return (
      <HomeBlock title="Vault" icon={Library} className="home-vault" actionLabel="Settings" onAction={onChooseVault}>
        <EmptyState
          size="sm"
          icon={FolderOpen}
          title="No vault connected"
          description="Choose your Markdown vault to see notes, tasks and links here."
          action={
            <Button size="sm" onClick={onChooseVault}>
              Choose vault
            </Button>
          }
        />
      </HomeBlock>
    );
  }

  const tiles = [
    { label: "Notes", value: stats?.note_count ?? noteCount },
    { label: "Open tasks", value: stats?.open_tasks ?? 0, hint: stats ? `of ${stats.total_tasks}` : undefined },
    { label: "Tags", value: stats?.total_tags ?? 0 },
    { label: "Links", value: stats?.total_links ?? 0 },
  ];

  return (
    <HomeBlock title="Vault" icon={Library} className="home-vault" actionLabel="Graph" onAction={onOpenGraph}>
      <dl className="home-vault-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="home-vault-tile">
            <dt>{t.label}</dt>
            <dd>
              <span className="tabular">{t.value.toLocaleString("en-US")}</span>
              {t.hint && <span className="home-vault-tile-hint">{t.hint}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="home-index">
        <Button
          size="sm"
          variant="secondary"
          iconLeft={indexing ? undefined : <Sparkles size={14} />}
          loading={indexing}
          onClick={onIndex}
        >
          {indexing ? "Indexing…" : "Index vault for AI"}
        </Button>
        <span className="home-index-meta" aria-live="polite">
          {indexing ? (
            "Embedding notes with the local model…"
          ) : lastIndex ? (
            <>
              <Database size={14} aria-hidden="true" />
              Indexed {relativeTime(lastIndex.at, now)} · {lastIndex.result.indexed} of {lastIndex.result.total} embedded
            </>
          ) : (
            "Not indexed from Home yet"
          )}
        </span>
        {indexing && <span className="home-index-progress" role="progressbar" aria-label="Indexing the vault" />}
      </div>
    </HomeBlock>
  );
}
