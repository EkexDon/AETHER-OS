import { useEffect, useState } from "react";
import { ArrowUpRight, Cloud, HardDrive, RefreshCw } from "lucide-react";
import type { SystemProfile } from "../../types";
import { getSystemProfile } from "../../lib/ipc";
import { openExternalUrl } from "../../lib/onboarding/external";
import { useAetherStore } from "../../lib/store";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { useShellStore } from "../../shell/shellStore";
import {
  MODEL_CHOICES,
  OLLAMA_URL,
  detectOllamaIssue,
  isModelInstalled,
  ollamaInstallCommand,
  recommendModel,
} from "../../lib/onboarding/models";
import { refreshHealth } from "../../lib/onboarding/vaultActions";
import { Badge, Button, Modal, Select, useToast } from "../../ui";
import { CopyCommand } from "./CopyCommand";
import { PullModelControl } from "./PullModelControl";
import "../../styles/views/onboarding.css";

/**
 * Guidance instead of silent failures: explains why local AI is not working
 * (Ollama offline, default model missing), with copyable commands, a retry,
 * a one-click model download and the switch to OpenRouter.
 */
export function OllamaGuideModal() {
  const toast = useToast();
  const open = useOnboardingStore((s) => s.ollamaGuideOpen);
  const close = useOnboardingStore((s) => s.closeOllamaGuide);
  const installed = useOnboardingStore((s) => s.installedModels);
  const refreshModels = useOnboardingStore((s) => s.refreshModels);
  const health = useAetherStore((s) => s.health);
  const provider = useAetherStore((s) => s.provider);
  const defaultModel = useAetherStore((s) => s.modelByProvider.ollama);
  const setModelForProvider = useAetherStore((s) => s.setModelForProvider);
  const setProvider = useAetherStore((s) => s.setProvider);
  const openSettings = useShellStore((s) => s.openSettings);
  const [profile, setProfile] = useState<SystemProfile | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!open) return;
    void refreshModels();
    getSystemProfile()
      .then(setProfile)
      .catch(() => undefined);
  }, [open, refreshModels]);

  if (!open) return null;

  const issue = detectOllamaIssue(health, installed, provider, defaultModel);
  const online = !!health?.ollama_online;
  const install = ollamaInstallCommand(profile?.os);
  const recommendation = recommendModel(profile);

  const retry = async () => {
    setChecking(true);
    try {
      const h = await refreshHealth();
      const models = await refreshModels();
      if (h.ollama_online) {
        toast.success("Ollama is running", { description: models ? `${models.length} models installed.` : undefined });
      } else {
        toast.info("Ollama is still offline", { description: "Start it with `ollama serve` and try again." });
      }
    } catch (e) {
      toast.error("Could not check Ollama", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  };

  const useCloud = () => {
    close();
    openSettings("ai");
  };

  const title = issue?.kind === "offline" ? "Ollama isn't running" : issue?.kind === "model-missing" ? "Model not installed" : "Local AI is ready";
  const description =
    issue?.kind === "offline"
      ? `AETHER-OS talks to Ollama on ${OLLAMA_URL}. Local chat and semantic search need it.`
      : issue?.kind === "model-missing"
        ? `Your default model ${issue.model} isn't installed in Ollama yet.`
        : "Ollama is running and your default model is installed.";

  return (
    <Modal
      open
      onClose={close}
      size="md"
      icon={HardDrive}
      title={title}
      description={description}
      footerStart={
        <Button variant="ghost" size="sm" iconLeft={<Cloud size={13} />} onClick={useCloud}>
          Use OpenRouter instead
        </Button>
      }
      footer={
        <>
          <Button variant="secondary" iconLeft={<RefreshCw size={13} />} loading={checking} onClick={() => void retry()}>
            Check again
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className="ob-guide">
        {!online && (
          <ol className="ob-guide-steps">
            <li>
              <span className="ob-guide-step-title">Install Ollama</span>
              <CopyCommand command={install.install} />
              <Button
                variant="ghost"
                size="sm"
                iconRight={<ArrowUpRight size={12} />}
                onClick={() => void openExternalUrl(install.url).catch(() => undefined)}
              >
                Or download the app from ollama.com
              </Button>
            </li>
            <li>
              <span className="ob-guide-step-title">Start it</span>
              <CopyCommand command={install.start} />
              <span className="ob-muted">The Ollama menu-bar app starts the server automatically.</span>
            </li>
            <li>
              <span className="ob-guide-step-title">Check again</span>
              <span className="ob-muted">AETHER-OS connects as soon as Ollama answers on localhost.</span>
            </li>
          </ol>
        )}

        {online && (
          <div className="ob-guide-models">
            <div className="ob-card-row">
              <div className="ob-card-head-text">
                <div className="ob-card-title">
                  Default model <span className="mono">{defaultModel}</span>
                </div>
                <p className="ob-muted">
                  {isModelInstalled(installed, defaultModel) ? "Installed and ready." : "Download it now, or pick one you already have."}
                </p>
              </div>
              <PullModelControl model={defaultModel} installed={isModelInstalled(installed, defaultModel)} />
            </div>

            {installed && installed.length > 0 && (
              <div className="ob-card-row">
                <div className="ob-card-head-text">
                  <div className="ob-card-title">Use an installed model</div>
                  <p className="ob-muted">{installed.length} models in Ollama.</p>
                </div>
                <Select
                  aria-label="Installed models"
                  size="sm"
                  value={isModelInstalled(installed, defaultModel) ? defaultModel : ""}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setModelForProvider("ollama", e.target.value);
                    setProvider("ollama");
                    toast.success("Default model changed", { description: e.target.value });
                  }}
                  options={[
                    ...(isModelInstalled(installed, defaultModel) ? [] : [{ value: "", label: "Choose…" }]),
                    ...installed.map((m) => ({ value: m, label: m })),
                  ]}
                />
              </div>
            )}

            {!isModelInstalled(installed, recommendation.name) && recommendation.name !== defaultModel && (
              <div className="ob-card-row">
                <div className="ob-card-head-text">
                  <div className="ob-card-title">
                    Recommended: {recommendation.label}{" "}
                    <Badge size="sm">{MODEL_CHOICES.find((m) => m.name === recommendation.name)?.sizeGb} GB</Badge>
                  </div>
                  <p className="ob-muted">{recommendation.reason}</p>
                </div>
                <PullModelControl
                  model={recommendation.name}
                  installed={false}
                  onInstalled={(name) => {
                    setModelForProvider("ollama", name);
                    setProvider("ollama");
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
