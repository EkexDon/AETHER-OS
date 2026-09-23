import { useEffect, useState } from "react";
import { Database, Search } from "lucide-react";
import type { IndexingResult } from "../../../types";
import { indexVault } from "../../../lib/ipc";
import { useAetherStore } from "../../../lib/store";
import { useOnboardingStore } from "../../../lib/onboardingStore";
import { EMBEDDING_MODEL, EMBEDDING_MODEL_SIZE_GB, isModelInstalled } from "../../../lib/onboarding/models";
import { Badge, Button, useToast } from "../../../ui";
import { PullModelControl } from "../PullModelControl";

/** Step 4 — explain semantic search, pull the embedding model, index the vault. */
export function EmbeddingsStep() {
  const toast = useToast();
  const health = useAetherStore((s) => s.health);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const indexing = useAetherStore((s) => s.indexing);
  const setIndexing = useAetherStore((s) => s.setIndexing);
  const installed = useOnboardingStore((s) => s.installedModels);
  const refreshModels = useOnboardingStore((s) => s.refreshModels);
  const [result, setResult] = useState<IndexingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const online = !!health?.ollama_online;
  const hasModel = isModelInstalled(installed, EMBEDDING_MODEL);
  const blocker = !vaultPath
    ? "Connect a vault first (previous step)."
    : !online
      ? "Ollama must be running to create embeddings."
      : !hasModel
        ? `Download ${EMBEDDING_MODEL} first.`
        : null;

  const runIndex = async () => {
    if (indexing) return;
    setIndexing(true);
    setError(null);
    try {
      const r = await indexVault();
      setResult(r);
      toast.success("Vault indexed", { description: `${r.indexed} of ${r.total} notes are searchable by meaning.` });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIndexing(false);
    }
  };

  return (
    <div className="ob-step-stack">
      <div className="ob-example">
        <div className="ob-example-query">
          <Search size={14} /> “ideas about sleep”
        </div>
        <div className="ob-example-arrow" aria-hidden="true" />
        <div className="ob-example-hit">
          <span className="ob-example-title">Circadian rhythm notes</span>
          <span className="ob-muted">matches by meaning — the word “sleep” never appears</span>
        </div>
      </div>

      <div className="ob-card">
        <div className="ob-card-row">
          <div className="ob-card-head-text">
            <div className="ob-card-title">
              Embedding model <span className="mono">{EMBEDDING_MODEL}</span>
            </div>
            <p className="ob-muted">Turns each note into a vector on this machine — about {Math.round(EMBEDDING_MODEL_SIZE_GB * 1000)} MB.</p>
          </div>
          <PullModelControl model={EMBEDDING_MODEL} installed={hasModel} sizeLabel="270 MB" disabled={!online} />
        </div>
        <div className="ob-card-row">
          <div className="ob-card-head-text">
            <div className="ob-card-title">Index your vault</div>
            <p className="ob-muted">
              {result
                ? `${result.indexed} of ${result.total} notes indexed${result.skipped ? ` · ${result.skipped} skipped (empty or unreadable)` : ""}.`
                : blocker ?? "Reads every note once. Re-index any time from the status bar."}
            </p>
          </div>
          {result ? (
            <Badge variant="success">Indexed</Badge>
          ) : (
            <Button size="sm" variant="primary" iconLeft={<Database size={14} />} loading={indexing} disabled={!!blocker} onClick={() => void runIndex()}>
              Index now
            </Button>
          )}
        </div>
        {error && (
          <p className="ui-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
