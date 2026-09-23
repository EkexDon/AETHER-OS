import { useEffect, useMemo, useState } from "react";
import { Check, Cloud, Database, HardDrive, LifeBuoy, RefreshCw } from "lucide-react";
import { useAetherStore, type AiProvider } from "../../lib/store";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { useHomeStore } from "../../lib/homeStore";
import {
  getEmbeddingModel,
  getSystemProfile,
  isDesktopRuntime,
  listCloudModels,
  setEmbeddingModel,
  setOpenRouterKey,
} from "../../lib/ipc";
import {
  EMBEDDING_MODEL,
  OLLAMA_URL,
  embeddingModelOptions,
  isModelInstalled,
  isValidModelName,
  normalizeModelName,
  recommendModel,
  type ModelRecommendation,
} from "../../lib/onboarding/models";
import { refreshHealth } from "../../lib/onboarding/vaultActions";
import { Badge, Button, Input, SegmentedControl, Select, useToast } from "../../ui";
import { PullModelControl } from "../../components/onboarding/PullModelControl";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Provider default, Ollama models and downloads, OpenRouter key and model, semantic search. */
export function AiProviderSettings() {
  const toast = useToast();
  const health = useAetherStore((s) => s.health);
  const provider = useAetherStore((s) => s.provider);
  const setProvider = useAetherStore((s) => s.setProvider);
  const modelByProvider = useAetherStore((s) => s.modelByProvider);
  const setModelForProvider = useAetherStore((s) => s.setModelForProvider);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const indexing = useAetherStore((s) => s.indexing);
  const runIndex = useHomeStore((s) => s.runIndex);
  const installed = useOnboardingStore((s) => s.installedModels);
  const refreshModels = useOnboardingStore((s) => s.refreshModels);
  const openGuide = useOnboardingStore((s) => s.openOllamaGuide);

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [cloudModels, setCloudModels] = useState<string[] | null>(null);
  const [cloudDraft, setCloudDraft] = useState(modelByProvider.openrouter);
  const [checking, setChecking] = useState(false);
  const [pullName, setPullName] = useState("");
  const [recommendation, setRecommendation] = useState<ModelRecommendation>(() => recommendModel(null));
  const [embeddingModel, setEmbeddingModelState] = useState<string | null>(null);
  const [embeddingDraft, setEmbeddingDraft] = useState("");
  const [savingEmbedding, setSavingEmbedding] = useState(false);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);
  const desktop = isDesktopRuntime();

  const ollama = !!health?.ollama_online;
  const openrouter = !!health?.openrouter_configured;

  useEffect(() => {
    if (!desktop) return;
    void refreshModels();
    getSystemProfile()
      .then((p) => setRecommendation(recommendModel(p)))
      .catch(() => undefined);
  }, [desktop, refreshModels]);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    getEmbeddingModel()
      .then((m) => {
        if (!alive) return;
        setEmbeddingModelState(m);
        setEmbeddingDraft(m);
      })
      .catch((e) => alive && setEmbeddingError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !openrouter) return;
    let alive = true;
    listCloudModels()
      .then((m) => alive && setCloudModels([...m].sort()))
      .catch(() => alive && setCloudModels(null));
    return () => {
      alive = false;
    };
  }, [desktop, openrouter]);

  const recheck = async () => {
    setChecking(true);
    try {
      await refreshHealth();
      await refreshModels();
    } catch (e) {
      toast.error("Could not check the providers", { description: errorText(e) });
    } finally {
      setChecking(false);
    }
  };

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setKeyStatus("saving");
    setKeyMessage(null);
    try {
      await setOpenRouterKey(apiKeyInput.trim());
      setApiKeyInput("");
      await refreshHealth();
      setKeyStatus("saved");
      setKeyMessage("Key saved.");
      window.setTimeout(() => setKeyStatus("idle"), 2000);
    } catch (e) {
      setKeyMessage(errorText(e));
      setKeyStatus("error");
    }
  };

  const handleTestKey = async () => {
    setKeyStatus("saving");
    setKeyMessage(null);
    try {
      const models = await listCloudModels();
      setCloudModels([...models].sort());
      setKeyStatus("saved");
      setKeyMessage(`Connected — ${models.length} models available.`);
      window.setTimeout(() => setKeyStatus("idle"), 3000);
    } catch (e) {
      setKeyMessage(errorText(e));
      setKeyStatus("error");
    }
  };

  const handleRemoveKey = async () => {
    setKeyStatus("saving");
    setKeyMessage(null);
    try {
      await setOpenRouterKey(null);
      await refreshHealth();
      setCloudModels(null);
      if (provider === "openrouter") setProvider("ollama");
      setKeyStatus("idle");
      toast.success("OpenRouter key removed");
    } catch (e) {
      setKeyMessage(errorText(e));
      setKeyStatus("error");
    }
  };

  const saveEmbeddingModel = async () => {
    const wanted = embeddingDraft.trim();
    if (!wanted || !isValidModelName(wanted) || wanted === embeddingModel) return;
    setSavingEmbedding(true);
    setEmbeddingError(null);
    try {
      const stored = await setEmbeddingModel(wanted);
      setEmbeddingModelState(stored);
      setEmbeddingDraft(stored);
      toast.info("Vault must be re-indexed", {
        description: `Semantic search now uses ${stored}; the previous index was cleared.`,
        duration: 12_000,
        action: vaultPath ? { label: "Index now", onClick: () => void runIndex() } : undefined,
      });
    } catch (e) {
      setEmbeddingError(errorText(e));
    } finally {
      setSavingEmbedding(false);
    }
  };

  const localModel = modelByProvider.ollama;
  const localInstalled = isModelInstalled(installed, localModel);
  const localOptions = [
    ...(installed ?? []).map((m) => ({ value: m, label: m })),
    ...(localInstalled ? [] : [{ value: localModel, label: `${localModel} (not installed)` }]),
  ];
  const activeEmbedding = embeddingModel ?? EMBEDDING_MODEL;
  const embeddingInstalled = isModelInstalled(installed, activeEmbedding);
  const trimmedEmbedding = embeddingDraft.trim();
  const embeddingDraftValid = !trimmedEmbedding || isValidModelName(trimmedEmbedding);
  const embeddingChanged =
    !!trimmedEmbedding && embeddingModel !== null && normalizeModelName(trimmedEmbedding) !== normalizeModelName(embeddingModel);
  const trimmedPull = pullName.trim();
  const embeddingOptions = useMemo(() => embeddingModelOptions(installed), [installed]);
  const cloudOptions = cloudModels
    ? [
        ...(cloudModels.includes(modelByProvider.openrouter) ? [] : [modelByProvider.openrouter]),
        ...cloudModels,
      ].map((m) => ({ value: m, label: m }))
    : null;

  return (
    <SettingsPage
      title="AI Providers"
      description="AETHER chats through local Ollama by default, or cloud models via OpenRouter (Claude, GPT, Gemini and more)."
    >
      <SettingsGroup>
        <SettingsRow
          label="Default provider"
          hint="Used by the agent panel; switch per conversation from its model picker."
          control={
            <SegmentedControl<AiProvider>
              aria-label="Default provider"
              value={provider}
              onChange={setProvider}
              options={[
                { value: "ollama", label: "Ollama", icon: <HardDrive size={14} /> },
                { value: "openrouter", label: "OpenRouter", icon: <Cloud size={14} /> },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Local — Ollama">
        <SettingsRow
          label="Connection"
          hint={`AETHER-OS only talks to ${OLLAMA_URL} (fixed). Nothing leaves your computer.`}
          control={
            <div className="obs-inline">
              <Badge variant={ollama ? "success" : health ? "warning" : "neutral"} dot icon={<HardDrive size={14} />}>
                {ollama ? "Connected" : health ? "Offline" : "Unknown"}
              </Badge>
              <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={14} />} loading={checking} onClick={() => void recheck()}>
                Check
              </Button>
              {!ollama && health && (
                <Button size="sm" variant="secondary" iconLeft={<LifeBuoy size={14} />} onClick={openGuide}>
                  How to fix
                </Button>
              )}
            </div>
          }
        />
        <SettingsRow
          label="Default model"
          hint={
            localInstalled
              ? "Installed. Pick any model you have downloaded."
              : `${localModel} is not installed yet — download it or pick another model.`
          }
          htmlFor="settings-ollama-model"
          control={
            <div className="obs-inline">
              {!localInstalled && <PullModelControl model={localModel} installed={false} disabled={!ollama} compact />}
              <Select
                id="settings-ollama-model"
                size="sm"
                className="settings-select"
                value={localModel}
                disabled={!installed || installed.length === 0}
                onChange={(e) => setModelForProvider("ollama", e.target.value)}
                options={localOptions}
              />
            </div>
          }
        />
        <SettingsRow
          label="Download a model"
          hint={
            <>
              Recommended for this machine: <span className="mono">{recommendation.name}</span> ({recommendation.sizeGb} GB).{" "}
              {recommendation.reason} Any name from ollama.com/library works.
            </>
          }
          stacked
        >
          <div className="ui-field-row">
            <Input
              aria-label="Model to download"
              size="sm"
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              placeholder={recommendation.name}
              spellCheck={false}
              invalid={!!trimmedPull && !isValidModelName(trimmedPull)}
            />
            <PullModelControl
              model={trimmedPull || recommendation.name}
              installed={isModelInstalled(installed, trimmedPull || recommendation.name)}
              disabled={!ollama || (!!trimmedPull && !isValidModelName(trimmedPull))}
              onInstalled={(name) => {
                if (!localInstalled) setModelForProvider("ollama", name);
              }}
            />
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Cloud — OpenRouter">
        <SettingsRow
          label="Connection"
          hint="Your key is stored in the app's private data directory — never in the browser or your vault."
          control={
            <div className="obs-inline">
              <Badge variant={openrouter ? "success" : "neutral"} dot icon={<Cloud size={14} />}>
                {openrouter ? "Key configured" : "No key"}
              </Badge>
              {openrouter && (
                <Button size="sm" variant="ghost" onClick={() => void handleRemoveKey()} disabled={keyStatus === "saving"}>
                  Remove key
                </Button>
              )}
            </div>
          }
        />
        <SettingsRow label="API key" stacked htmlFor="settings-openrouter-key">
          <div className="ui-field-row">
            <Input
              id="settings-openrouter-key"
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={openrouter ? "•••••••• (saved)" : "sk-or-v1-…"}
              autoComplete="off"
              spellCheck={false}
              invalid={keyStatus === "error"}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveKey();
              }}
            />
            <Button
              variant="secondary"
              onClick={() => void handleTestKey()}
              loading={keyStatus === "saving" && !apiKeyInput.trim()}
              disabled={keyStatus === "saving" || !openrouter}
              iconLeft={<Cloud size={14} />}
            >
              Test
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSaveKey()}
              loading={keyStatus === "saving" && !!apiKeyInput.trim()}
              disabled={keyStatus === "saving" || !apiKeyInput.trim()}
              iconLeft={keyStatus === "saved" ? <Check size={14} /> : undefined}
            >
              {keyStatus === "saved" ? "Saved" : "Save key"}
            </Button>
          </div>
          {keyMessage && (
            <p className={keyStatus === "error" ? "ui-field-error settings-inline-error" : "ui-field-hint settings-inline-hint"}>
              {keyMessage}
            </p>
          )}
        </SettingsRow>
        <SettingsRow
          label="Default cloud model"
          hint={openrouter ? "Prompts and the notes you select are sent to openrouter.ai for this model." : "Save a key to choose from OpenRouter's models."}
          htmlFor="settings-cloud-model"
          control={
            cloudOptions ? (
              <Select
                id="settings-cloud-model"
                size="sm"
                className="settings-select"
                value={modelByProvider.openrouter}
                onChange={(e) => setModelForProvider("openrouter", e.target.value)}
                options={cloudOptions}
              />
            ) : (
              <div className="obs-inline">
                <Input
                  id="settings-cloud-model"
                  size="sm"
                  value={cloudDraft}
                  onChange={(e) => setCloudDraft(e.target.value)}
                  spellCheck={false}
                  className="settings-select"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && cloudDraft.trim()) setModelForProvider("openrouter", cloudDraft.trim());
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!cloudDraft.trim() || cloudDraft.trim() === modelByProvider.openrouter}
                  onClick={() => setModelForProvider("openrouter", cloudDraft.trim())}
                >
                  Use
                </Button>
              </div>
            )
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Semantic search">
        <SettingsRow
          label="Embedding model"
          hint={
            embeddingError ? (
              <span className="ui-field-error">{embeddingError}</span>
            ) : (
              <>
                Turns notes into vectors on this machine. Pick an installed Ollama model or type any name — switching clears
                the index, so the vault has to be indexed again.{" "}
                {embeddingModel !== null &&
                  (embeddingInstalled ? (
                    <>
                      <span className="mono">{activeEmbedding}</span> is installed.
                    </>
                  ) : (
                    <>
                      <span className="mono">{activeEmbedding}</span> is not installed yet.
                    </>
                  ))}
              </>
            )
          }
          htmlFor="settings-embedding-model"
          stacked
        >
          <div className="ui-field-row">
            <Input
              id="settings-embedding-model"
              size="sm"
              list="settings-embedding-models"
              value={embeddingDraft}
              placeholder={EMBEDDING_MODEL}
              spellCheck={false}
              autoComplete="off"
              disabled={!desktop || embeddingModel === null}
              invalid={!embeddingDraftValid}
              onChange={(e) => setEmbeddingDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveEmbeddingModel();
                if (e.key === "Escape" && embeddingModel !== null && embeddingDraft !== embeddingModel) {
                  e.preventDefault();
                  e.stopPropagation();
                  setEmbeddingDraft(embeddingModel);
                }
              }}
            />
            <datalist id="settings-embedding-models">
              {embeddingOptions.map((m) => (
                <option key={m.name} value={m.name} label={m.installed ? "Installed" : "Not installed"} />
              ))}
            </datalist>
            <Button
              size="sm"
              variant="secondary"
              loading={savingEmbedding}
              disabled={!embeddingChanged || !embeddingDraftValid}
              onClick={() => void saveEmbeddingModel()}
            >
              Save
            </Button>
            {embeddingModel !== null && !embeddingInstalled && (
              <PullModelControl
                model={activeEmbedding}
                installed={false}
                sizeLabel={normalizeModelName(activeEmbedding) === EMBEDDING_MODEL ? "270 MB" : undefined}
                disabled={!ollama}
                compact
              />
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Index vault"
          hint={!vaultPath ? "Connect a vault first." : "Embeds every note on this machine. Run it again after larger changes."}
          control={
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Database size={14} />}
              loading={indexing}
              disabled={!vaultPath || !ollama || !embeddingInstalled}
              onClick={() => void runIndex()}
            >
              Index now
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
