import { TriangleAlert } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { detectOllamaIssue } from "../../lib/onboarding/models";
import { Tooltip } from "../../ui";
import "../../styles/views/onboarding.css";

/**
 * Status bar guard: "Ollama offline · fix" or "Model missing · fix" when
 * local AI cannot work; opens the guidance modal. Hidden when all is well
 * or while health is unknown.
 */
export function OllamaStatusItem() {
  const health = useAetherStore((s) => s.health);
  const provider = useAetherStore((s) => s.provider);
  const defaultModel = useAetherStore((s) => s.modelByProvider.ollama);
  const installed = useOnboardingStore((s) => s.installedModels);
  const openGuide = useOnboardingStore((s) => s.openOllamaGuide);

  const issue = detectOllamaIssue(health, installed, provider, defaultModel);
  if (!issue) return null;

  const label = issue.kind === "offline" ? "Ollama offline" : "Model missing";
  const tip =
    issue.kind === "offline"
      ? "Ollama is not reachable on localhost:11434 — click for install and start commands"
      : `${issue.model} is not installed in Ollama — click to download it`;

  return (
    <Tooltip content={tip} placement="top">
      <button type="button" className="statusbar-item ob-status-warning" onClick={openGuide}>
        <TriangleAlert size={12} />
        <span className="statusbar-strong">{label}</span>
        <span className="statusbar-muted">· fix</span>
      </button>
    </Tooltip>
  );
}
