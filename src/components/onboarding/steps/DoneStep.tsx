import type { ReactNode } from "react";
import { CircleCheck, CircleDashed } from "lucide-react";
import { useAetherStore } from "../../../lib/store";
import { useOnboardingStore } from "../../../lib/onboardingStore";
import { EMBEDDING_MODEL, isModelInstalled } from "../../../lib/onboarding/models";
import { folderName } from "../../../lib/onboarding/vaultActions";
import type { WizardStepId } from "../../../lib/onboarding/wizard";
import { Kbd, Switch } from "../../../ui";

function SummaryRow({ ok, label, value }: { ok: boolean; label: string; value: ReactNode }) {
  return (
    <li className={ok ? "ob-summary-row is-ok" : "ob-summary-row"}>
      {ok ? <CircleCheck size={15} /> : <CircleDashed size={15} />}
      <span className="ob-summary-label">{label}</span>
      <span className="ob-summary-value">{value}</span>
    </li>
  );
}

/** Step 6 — what is set up, the update-check opt-in and where to find help. */
export function DoneStep({ skipped }: { skipped: WizardStepId[] }) {
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const noteCount = useAetherStore((s) => s.vaultStats?.note_count ?? s.vaultNotes.length);
  const health = useAetherStore((s) => s.health);
  const provider = useAetherStore((s) => s.provider);
  const models = useAetherStore((s) => s.modelByProvider);
  const installed = useOnboardingStore((s) => s.installedModels);
  const autoCheck = useOnboardingStore((s) => s.prefs.autoCheckUpdates);
  const setPrefs = useOnboardingStore((s) => s.setPrefs);

  const localReady = !!health?.ollama_online && isModelInstalled(installed, models.ollama);
  const cloudReady = !!health?.openrouter_configured;
  const aiOk = provider === "openrouter" ? cloudReady : localReady;
  const aiValue =
    provider === "openrouter"
      ? cloudReady
        ? `OpenRouter · ${models.openrouter}`
        : "OpenRouter selected, but no key saved"
      : localReady
        ? `Ollama · ${models.ollama}`
        : health?.ollama_online
          ? `${models.ollama} is not installed yet`
          : "Ollama is offline — fix it later from the status bar";
  const embeddingsOk = isModelInstalled(installed, EMBEDDING_MODEL);

  return (
    <div className="ob-step-stack">
      <ul className="ob-summary">
        <SummaryRow
          ok={!!vaultPath}
          label="Vault"
          value={vaultPath ? `${folderName(vaultPath)} · ${noteCount} notes` : skipped.includes("vault") ? "Skipped" : "Not connected"}
        />
        <SummaryRow ok={aiOk} label="AI" value={skipped.includes("ai") && !aiOk ? "Skipped" : aiValue} />
        <SummaryRow
          ok={embeddingsOk}
          label="Semantic search"
          value={embeddingsOk ? `${EMBEDDING_MODEL} installed` : skipped.includes("embeddings") ? "Skipped" : "Embedding model missing"}
        />
      </ul>

      <div className="ob-card">
        <Switch
          checked={autoCheck}
          onChange={(v) => setPrefs({ autoCheckUpdates: v })}
          label="Check for updates once a day"
          description="One anonymous request to GitHub's release page when the app starts. Nothing is downloaded automatically."
        />
      </div>

      <p className="ob-muted ob-help-line">
        Press <Kbd shortcut="mod+/" /> for every shortcut, <Kbd shortcut="mod+k" /> for everything else. Run “Help: run setup
        again” from the palette to come back here.
      </p>
    </div>
  );
}
