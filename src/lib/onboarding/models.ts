/**
 * Local model helpers: RAM-based recommendation, installed-model matching,
 * download progress formatting and the Ollama guidance rules.
 */
import type { OllamaPullProgress, SystemHealth, SystemProfile } from "../../types";

/** Embedding model used by semantic search (fixed in the backend). */
export const EMBEDDING_MODEL = "nomic-embed-text";
/** Approximate download size of {@link EMBEDDING_MODEL}. */
export const EMBEDDING_MODEL_SIZE_GB = 0.27;
/** The only Ollama endpoint AETHER-OS talks to. */
export const OLLAMA_URL = "http://localhost:11434";

/** A chat model AETHER-OS knows to work well locally. */
export interface ModelChoice {
  name: string;
  /** Human label, e.g. "Llama 3.2 · 3B". */
  label: string;
  /** Approximate download size in GB. */
  sizeGb: number;
  /** Minimum installed RAM (GiB) for a smooth experience. */
  minRamGb: number;
}

/** Curated chat models, smallest first. All emit agent actions reliably. */
export const MODEL_CHOICES: ModelChoice[] = [
  { name: "llama3.2:1b", label: "Llama 3.2 · 1B", sizeGb: 1.3, minRamGb: 0 },
  { name: "gemma2:2b", label: "Gemma 2 · 2B", sizeGb: 1.6, minRamGb: 6 },
  { name: "llama3.2:3b", label: "Llama 3.2 · 3B", sizeGb: 2.0, minRamGb: 8 },
  { name: "qwen2.5:7b", label: "Qwen 2.5 · 7B", sizeGb: 4.7, minRamGb: 16 },
  { name: "llama3.1:8b", label: "Llama 3.1 · 8B", sizeGb: 4.9, minRamGb: 16 },
  { name: "qwen2.5:14b", label: "Qwen 2.5 · 14B", sizeGb: 9.0, minRamGb: 32 },
];

/** A recommendation with the reason shown to the user. */
export interface ModelRecommendation extends ModelChoice {
  reason: string;
}

/**
 * Recommend a chat model for this machine: the model sizes that leave
 * enough memory for the OS and other apps at each RAM tier.
 */
export function recommendModel(profile: SystemProfile | null): ModelRecommendation {
  const ram = profile?.total_ram_gb ?? 0;
  const pick = (name: string) => MODEL_CHOICES.find((m) => m.name === name) as ModelChoice;
  if (!profile || ram <= 0) {
    return { ...pick("llama3.2:3b"), reason: "A small, capable default when the memory size is unknown." };
  }
  const gb = Math.round(ram);
  if (ram < 8) return { ...pick("llama3.2:1b"), reason: `Fits comfortably in ${gb} GB of memory.` };
  if (ram < 16) return { ...pick("llama3.2:3b"), reason: `Fast on ${gb} GB of memory and good at following instructions.` };
  if (ram < 32) return { ...pick("qwen2.5:7b"), reason: `Noticeably smarter and still quick with ${gb} GB of memory.` };
  return { ...pick("qwen2.5:14b"), reason: `${gb} GB of memory runs a 14B model with room to spare.` };
}

/** `llama3.2` and `llama3.2:latest` are the same model. */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.endsWith(":latest") ? trimmed.slice(0, -":latest".length) : trimmed;
}

/** Whether `name` is among the installed Ollama models. */
export function isModelInstalled(installed: readonly string[] | null | undefined, name: string): boolean {
  if (!installed) return false;
  const wanted = normalizeModelName(name);
  return installed.some((m) => normalizeModelName(m) === wanted);
}

/** Same rules the backend applies before a pull. */
export function isValidModelName(name: string): boolean {
  const n = name.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(n) && !n.includes("..") && !n.includes("//");
}

/** Well-known Ollama embedding models, suggested even before they are installed. */
export const KNOWN_EMBEDDING_MODELS = [EMBEDDING_MODEL, "mxbai-embed-large", "bge-m3", "all-minilm", "snowflake-arctic-embed"];

const EMBEDDING_HINT = /embed|minilm|bge|\be5\b|gte|arctic/i;

/** One suggestion for the embedding model field. */
export interface EmbeddingModelOption {
  name: string;
  installed: boolean;
}

/**
 * Suggestions for the embedding model: installed models that look like
 * embedding models first, then the other installed models, then well-known
 * embedding models that are not installed yet. Names are unique
 * (`:latest` is ignored when comparing).
 */
export function embeddingModelOptions(installed: readonly string[] | null | undefined): EmbeddingModelOption[] {
  const seen = new Set<string>();
  const out: EmbeddingModelOption[] = [];
  const push = (name: string, isInstalled: boolean) => {
    const key = normalizeModelName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name, installed: isInstalled });
  };
  const list = [...(installed ?? [])].sort((a, b) => a.localeCompare(b));
  list.filter((m) => EMBEDDING_HINT.test(m)).forEach((m) => push(m, true));
  list.filter((m) => !EMBEDDING_HINT.test(m)).forEach((m) => push(m, true));
  KNOWN_EMBEDDING_MODELS.forEach((m) => push(m, false));
  return out;
}

/** Percentage (0–100) of the current layer, `null` when unknown. */
export function pullPercent(progress: Pick<OllamaPullProgress, "completed" | "total"> | null | undefined): number | null {
  if (!progress?.total || progress.total <= 0 || progress.completed === null) return null;
  return Math.max(0, Math.min(100, Math.floor((progress.completed / progress.total) * 100)));
}

/** Human-readable byte size (`1.2 GB`, `340 MB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** A friendly line for Ollama's status (`downloading sha256:…` → `Downloading · 42%`). */
export function describePullStatus(progress: Pick<OllamaPullProgress, "status" | "completed" | "total">): string {
  const status = progress.status.toLowerCase();
  if (status === "success") return "Ready";
  if (status === "starting") return "Starting download…";
  if (status === "cancelled") return "Cancelled";
  if (status.startsWith("pulling manifest")) return "Fetching the model manifest…";
  if (status.startsWith("verifying")) return "Verifying download…";
  if (status.startsWith("writing manifest")) return "Finishing…";
  if (status.startsWith("removing")) return "Cleaning up…";
  if (status.startsWith("downloading") || status.startsWith("pulling")) {
    const pct = pullPercent(progress);
    if (pct === null) return "Downloading…";
    const detail = progress.total ? ` of ${formatBytes(progress.total)}` : "";
    return `Downloading · ${pct}%${detail}`;
  }
  return progress.status.charAt(0).toUpperCase() + progress.status.slice(1);
}

/** Something the user should fix about the local AI setup. */
export type OllamaIssue = { kind: "offline" } | { kind: "model-missing"; model: string };

/**
 * The Ollama problem to surface, if any: Ollama offline (health known and
 * `ollama_online === false`), or — with Ollama as the chat provider and the
 * model list loaded — the default model not installed.
 */
export function detectOllamaIssue(
  health: SystemHealth | null,
  installed: readonly string[] | null,
  provider: "ollama" | "openrouter",
  defaultModel: string
): OllamaIssue | null {
  if (!health) return null;
  if (!health.ollama_online) return { kind: "offline" };
  if (provider === "ollama" && installed && !isModelInstalled(installed, defaultModel)) {
    return { kind: "model-missing", model: defaultModel };
  }
  return null;
}

/** Install + start commands per platform (`os` from the system profile or app info). */
export function ollamaInstallCommand(os: string | null | undefined): { install: string; start: string; url: string } {
  const url = "https://ollama.com/download";
  switch (os) {
    case "linux":
      return { install: "curl -fsSL https://ollama.com/install.sh | sh", start: "ollama serve", url };
    case "windows":
      return { install: "winget install Ollama.Ollama", start: "ollama serve", url };
    default:
      return { install: "brew install ollama", start: "ollama serve", url };
  }
}
