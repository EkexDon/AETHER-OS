import { useEffect, useState } from "react";
import { Cloud, Cpu, RefreshCw, Sparkles } from "lucide-react";
import type { SystemProfile } from "../../../types";
import { getSystemProfile, setOpenRouterKey } from "../../../lib/ipc";
import { useAetherStore } from "../../../lib/store";
import { useOnboardingStore } from "../../../lib/onboardingStore";
import { MODEL_CHOICES, isModelInstalled, ollamaInstallCommand, recommendModel } from "../../../lib/onboarding/models";
import { refreshHealth } from "../../../lib/onboarding/vaultActions";
import { Badge, Button, Input, Select, Spinner, useToast } from "../../../ui";
import { CopyCommand } from "../CopyCommand";
import { PullModelControl } from "../PullModelControl";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "16 GB memory · 10 cores · Apple silicon" */
export function describeProfile(profile: SystemProfile): string {
  const arch =
    profile.arch === "aarch64" && profile.os === "macos"
      ? "Apple silicon"
      : profile.arch === "aarch64"
        ? "ARM64"
        : profile.arch === "x86_64"
          ? "Intel/AMD 64-bit"
          : profile.arch;
  return `${Math.round(profile.total_ram_gb)} GB memory · ${profile.cpu_cores} cores · ${arch}`;
}

/** Step 3 — Ollama status, recommended model download, or OpenRouter. */
export function AiStep() {
  const toast = useToast();
  const health = useAetherStore((s) => s.health);
  const provider = useAetherStore((s) => s.provider);
  const setProvider = useAetherStore((s) => s.setProvider);
  const defaultModel = useAetherStore((s) => s.modelByProvider.ollama);
  const setModelForProvider = useAetherStore((s) => s.setModelForProvider);
  const installed = useOnboardingStore((s) => s.installedModels);
  const refreshModels = useOnboardingStore((s) => s.refreshModels);
  const [profile, setProfile] = useState<SystemProfile | null>(null);
  const [checking, setChecking] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [showCloud, setShowCloud] = useState(false);
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const online = !!health?.ollama_online;
  const recommendation = recommendModel(profile);
  const selected = choice ?? recommendation.name;
  const selectedInfo = MODEL_CHOICES.find((m) => m.name === selected) ?? recommendation;

  useEffect(() => {
    let alive = true;
    getSystemProfile()
      .then((p) => alive && setProfile(p))
      .catch(() => undefined);
    void refreshModels();
    return () => {
      alive = false;
    };
  }, [refreshModels]);

  const recheck = async () => {
    setChecking(true);
    try {
      const h = await refreshHealth();
      await refreshModels();
      if (h.ollama_online) toast.success("Ollama is running");
      else toast.info("Ollama is still offline", { description: "Start it with `ollama serve`, then check again." });
    } catch (e) {
      toast.error("Could not check Ollama", { description: errorText(e) });
    } finally {
      setChecking(false);
    }
  };

  const useModel = (name: string) => {
    setModelForProvider("ollama", name);
    setProvider("ollama");
  };

  const saveKey = async () => {
    setSavingKey(true);
    setKeyError(null);
    try {
      await setOpenRouterKey(key.trim());
      setKey("");
      await refreshHealth();
      setProvider("openrouter");
      toast.success("OpenRouter connected", { description: "Cloud models are now the default. Change it any time in Settings → AI." });
    } catch (e) {
      setKeyError(errorText(e));
    } finally {
      setSavingKey(false);
    }
  };

  const install = ollamaInstallCommand(profile?.os);
  const installedNames = installed ?? [];

  return (
    <div className="ob-step-stack">
      <div className="ob-status-line">
        <Badge variant={online ? "success" : health ? "warning" : "neutral"} dot>
          {online ? "Ollama is running" : health ? "Ollama is offline" : "Checking Ollama…"}
        </Badge>
        {profile && (
          <span className="ob-muted ob-inline-icon">
            <Cpu size={13} /> {describeProfile(profile)}
          </span>
        )}
        <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={13} />} loading={checking} onClick={() => void recheck()}>
          Check again
        </Button>
      </div>

      {!online && health && (
        <div className="ob-card">
          <div className="ob-card-title">Install and start Ollama</div>
          <p className="ob-muted">
            Ollama runs AI models on this machine. Install it once, start it, then check again. Or skip and use a cloud
            model below.
          </p>
          <CopyCommand label="Install" command={install.install} />
          <CopyCommand label="Start" command={install.start} />
        </div>
      )}

      <div className="ob-card is-highlight">
        <div className="ob-card-head">
          <Sparkles size={15} className="ob-card-icon" />
          <div className="ob-card-head-text">
            <div className="ob-card-title">
              Recommended for this machine: {recommendation.label}
            </div>
            <p className="ob-muted">
              {profile ? recommendation.reason : <><Spinner size={11} /> Reading memory size…</>}
            </p>
          </div>
        </div>
        <div className="ob-model-row">
          <Select
            aria-label="Local model"
            size="sm"
            value={selected}
            onChange={(e) => setChoice(e.target.value)}
            options={MODEL_CHOICES.map((m) => ({
              value: m.name,
              label: `${m.label} — ${m.sizeGb} GB${m.name === recommendation.name ? " (recommended)" : ""}`,
            }))}
            className="ob-model-select"
          />
          <PullModelControl
            model={selected}
            installed={isModelInstalled(installed, selected)}
            sizeLabel={`${selectedInfo.sizeGb} GB`}
            disabled={!online}
            onInstalled={useModel}
          />
          {isModelInstalled(installed, selected) &&
            (defaultModel === selected && provider === "ollama" ? (
              <Badge variant="accent">Default</Badge>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => useModel(selected)}>
                Make default
              </Button>
            ))}
        </div>
      </div>

      {online && (
        <div className="ob-section">
          <h3 className="ui-section-label">Installed models</h3>
          {installedNames.length === 0 ? (
            <p className="ob-muted">No models yet — download the recommended one above.</p>
          ) : (
            <div className="ob-chips">
              {installedNames.map((m) => {
                const active = provider === "ollama" && m === defaultModel;
                return (
                  <button
                    key={m}
                    type="button"
                    className={active ? "ob-chip is-active" : "ob-chip"}
                    aria-pressed={active}
                    onClick={() => useModel(m)}
                    title={active ? "Default model" : "Use as default"}
                  >
                    <span className="mono">{m}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="ob-section">
        <Button size="sm" variant="ghost" iconLeft={<Cloud size={13} />} onClick={() => setShowCloud((v) => !v)} aria-expanded={showCloud}>
          {health?.openrouter_configured ? "OpenRouter is connected" : "Use a cloud model instead (OpenRouter)"}
        </Button>
        {showCloud && (
          <div className="ob-inline-form">
            <label className="ui-field-label" htmlFor="ob-openrouter-key">
              OpenRouter API key
            </label>
            <div className="ui-field-row">
              <Input
                id="ob-openrouter-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={health?.openrouter_configured ? "•••••••• (saved)" : "sk-or-v1-…"}
                autoComplete="off"
                spellCheck={false}
                invalid={!!keyError}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && key.trim()) void saveKey();
                }}
              />
              <Button variant="primary" loading={savingKey} disabled={!key.trim()} onClick={() => void saveKey()}>
                Save key
              </Button>
            </div>
            <span className={keyError ? "ui-field-error" : "ui-field-hint"}>
              {keyError ??
                "Stored in the app's private data folder, never in the browser or your vault. Prompts and the notes you select are sent to openrouter.ai."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
