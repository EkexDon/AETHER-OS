/**
 * Mock handlers for `commands/onboarding_commands.rs`.
 *
 * - The wizard state starts as a first run (`completed_at: null`) so the
 *   setup wizard shows in the preview. Once it is finished or skipped, the
 *   state is kept in localStorage so reloads do not show it again;
 *   `window.__AETHER_MOCK__.reset()` (or "Help: run setup again") brings it
 *   back.
 * - Vault detection returns two fake vaults (Obsidian + plain Markdown).
 * - Model pulls stream fake `ollama-pull-progress` events over ≈3 s and
 *   the pulled model then appears in `cmd_list_local_models`.
 * - Reset app data returns a backup path and restores the first-run state;
 *   the frontend reloads the page instead of restarting.
 */
import changelog from "../../../CHANGELOG.md?raw";
import type {
  AppLogTail,
  DataLocation,
  OllamaPullProgress,
  OnboardingState,
  PullOutcome,
  ResetOutcome,
  SystemProfile,
  VaultInfo,
  VaultPrefs,
} from "../../types";
import { MOCK_LOCAL_MODELS } from "./ai";
import { mockDiagnosticsLog } from "./diagnostics";
import {
  argBool,
  argNumber,
  argObject,
  argString,
  isWithin,
  mockEvents,
  normalizePath,
  registerReset,
  sleep,
  type MockHandlerMap,
} from "./runtime";
import { mockVault } from "./vaultStore";

/** Home folder of the fake user. */
export const MOCK_HOME = "/Users/demo";
const DATA_DIR = `${MOCK_HOME}/Library/Application Support/com.ekin.aetheros`;
/** localStorage key that keeps the mock wizard state across reloads. */
export const MOCK_ONBOARDING_STORAGE_KEY = "aether-mock-onboarding";
/** Total duration of a fake model download. */
export const MOCK_PULL_DURATION_MS = 3000;
const PULL_EVENT = "ollama-pull-progress";
const ORIGINAL_MODELS = [...MOCK_LOCAL_MODELS];
/** Models the fake Ollama "knows" beyond the curated names (anything valid is accepted). */
const UNKNOWN_MODEL = /^(does-not-exist|nope)(:|$)/;

/** Fake vaults reported by `cmd_onboarding_detect_vaults`. */
export const MOCK_DETECTED_VAULTS: VaultInfo[] = [
  { path: `${MOCK_HOME}/Documents/Obsidian Vault`, name: "Obsidian Vault", note_count: 128, kind: "obsidian" },
  { path: `${MOCK_HOME}/Notes/Zettelkasten`, name: "Zettelkasten", note_count: 42, kind: "plain" },
];

interface OnboardingMockState {
  onboarding: OnboardingState;
  prefs: VaultPrefs;
  /** Vault folders created through the wizard. */
  created: Set<string>;
  pulls: Map<string, { cancelled: boolean }>;
}

const FIRST_RUN: OnboardingState = { completed_at: null, version_seen: null, skipped_steps: [] };

function readStored(): OnboardingState | null {
  try {
    const raw = globalThis.localStorage?.getItem(MOCK_ONBOARDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      completed_at: typeof parsed.completed_at === "string" ? parsed.completed_at : null,
      version_seen: typeof parsed.version_seen === "string" ? parsed.version_seen : null,
      skipped_steps: Array.isArray(parsed.skipped_steps) ? parsed.skipped_steps.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return null;
  }
}

function writeStored(state: OnboardingState | null): void {
  try {
    if (state) globalThis.localStorage?.setItem(MOCK_ONBOARDING_STORAGE_KEY, JSON.stringify(state));
    else globalThis.localStorage?.removeItem(MOCK_ONBOARDING_STORAGE_KEY);
  } catch {
    // Storage unavailable: the state lives for this page only.
  }
}

function seed(fromStorage: boolean): OnboardingMockState {
  return {
    onboarding: (fromStorage ? readStored() : null) ?? { ...FIRST_RUN },
    prefs: { daily_folder: "daily", daily_filename_pattern: "YYYY-MM-DD" },
    created: new Set(),
    pulls: new Map(),
  };
}

let state = seed(true);
registerReset(() => {
  writeStored(null);
  state = seed(false);
  MOCK_LOCAL_MODELS.splice(0, MOCK_LOCAL_MODELS.length, ...ORIGINAL_MODELS);
});

function invalid(text: string): Error {
  return new Error(`invalid input: ${text}`);
}

function validateState(input: Partial<OnboardingState>): OnboardingState {
  const completed = input.completed_at ?? null;
  if (completed !== null && (typeof completed !== "string" || Number.isNaN(Date.parse(completed)))) {
    throw invalid(`completed_at is not an RFC 3339 time: ${String(completed)}`);
  }
  const version = typeof input.version_seen === "string" ? input.version_seen.trim() : null;
  if (version !== null && !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw invalid(`version_seen is not a version: ${version}`);
  const steps: string[] = [];
  for (const raw of input.skipped_steps ?? []) {
    const step = String(raw).trim();
    if (!/^[a-z0-9_-]{1,32}$/.test(step)) throw invalid(`invalid wizard step id: ${step}`);
    if (!steps.includes(step)) steps.push(step);
  }
  if (steps.length > 16) throw invalid("too many skipped wizard steps");
  return { completed_at: completed, version_seen: version, skipped_steps: steps };
}

function validatePrefs(input: Partial<VaultPrefs>): VaultPrefs {
  const folder = String(input.daily_folder ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (folder.length > 120) throw invalid("daily note folder is too long");
  if (folder && folder.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith(".") || /[<>:"|?*]/.test(s))) {
    throw invalid(`invalid daily note folder: ${folder}`);
  }
  const pattern = String(input.daily_filename_pattern ?? "").trim();
  if (!pattern || pattern.length > 64) throw invalid("daily note file name pattern must be 1–64 characters");
  for (const token of ["YYYY", "MM", "DD"]) {
    if (!pattern.includes(token)) throw invalid(`daily note file name pattern must contain ${token}`);
  }
  if (!/^[A-Za-z0-9 ._-]*$/.test(pattern.replace(/YYYY|MM|DD/g, ""))) {
    throw invalid("daily note file name pattern may only contain letters, digits, spaces, '-', '_' and '.'");
  }
  return { daily_folder: folder, daily_filename_pattern: pattern };
}

function validateModelName(raw: string): string {
  const name = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(name) || name.includes("..") || name.includes("//")) {
    throw invalid(`"${name}" is not a valid Ollama model name`);
  }
  return name;
}

function folderExists(path: string): boolean {
  return (
    state.created.has(path) ||
    MOCK_DETECTED_VAULTS.some((v) => v.path === path) ||
    (mockVault.root !== null && (path === mockVault.root || isWithin(mockVault.root, path)))
  );
}

function emitPull(progress: OllamaPullProgress): void {
  mockEvents.emit(PULL_EVENT, progress);
}

/** Fake download: manifest, two layers over ≈3 s, verify, write, success. */
async function fakePull(name: string, token: { cancelled: boolean }): Promise<PullOutcome> {
  const step = MOCK_PULL_DURATION_MS / 20;
  emitPull({ name, status: "pulling manifest", completed: null, total: null });
  await sleep(step * 2);
  // Embedding models are small; chat models weigh in at a few GB.
  const main = /embed/i.test(name) ? 274_000_000 : 1_320_000_000;
  const layers = [
    { digest: "sha256:6a0746a1ec1a", total: main, ticks: 12 },
    { digest: "sha256:4fa551d4f938", total: 12_400_000, ticks: 2 },
  ];
  for (const layer of layers) {
    for (let i = 1; i <= layer.ticks; i++) {
      if (token.cancelled) return { name, cancelled: true };
      emitPull({
        name,
        status: `downloading ${layer.digest}`,
        completed: Math.round((layer.total * i) / layer.ticks),
        total: layer.total,
      });
      await sleep(step);
    }
  }
  if (token.cancelled) return { name, cancelled: true };
  emitPull({ name, status: "verifying sha256 digest", completed: null, total: null });
  await sleep(step * 2);
  emitPull({ name, status: "writing manifest", completed: null, total: null });
  await sleep(step);
  if (token.cancelled) return { name, cancelled: true };
  emitPull({ name, status: "success", completed: null, total: null });
  if (!MOCK_LOCAL_MODELS.some((m) => m === name || m === `${name}:latest`)) MOCK_LOCAL_MODELS.push(name);
  return { name, cancelled: false };
}

function starterCount(): number {
  return 5;
}

export const onboardingHandlers: MockHandlerMap = {
  cmd_onboarding_get_state: (): OnboardingState => state.onboarding,
  cmd_onboarding_set_state: (args): OnboardingState => {
    const next = validateState(argObject<OnboardingState>(args, "onboarding"));
    state.onboarding = next;
    writeStored(next);
    return next;
  },
  cmd_onboarding_create_vault: (args): VaultInfo => {
    const raw = argString(args, "path").trim();
    if (!raw) throw invalid("a folder for the new vault is required");
    if (!raw.startsWith("/")) throw invalid(`the vault folder must be an absolute path: ${raw}`);
    if (raw.split("/").some((part) => part === ".." || part === ".")) {
      throw invalid(`the vault folder must not contain '.' or '..': ${raw}`);
    }
    const path = normalizePath(raw);
    if (!isWithin(path, MOCK_HOME) || path === MOCK_HOME) {
      throw invalid(`the new vault must be a folder inside your home folder (${MOCK_HOME})`);
    }
    if (folderExists(path)) throw invalid(`${path} already exists and is not empty — choose a new or empty folder`);
    state.created.add(path);
    return { path, name: path.slice(path.lastIndexOf("/") + 1), note_count: starterCount(), kind: "plain" };
  },
  cmd_onboarding_detect_vaults: async (): Promise<VaultInfo[]> => {
    await sleep(400);
    return MOCK_DETECTED_VAULTS;
  },
  cmd_onboarding_suggest_vault_path: (): string => {
    const base = `${MOCK_HOME}/Documents/AETHER Vault`;
    if (!folderExists(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base} ${n}`;
      if (!folderExists(candidate)) return candidate;
    }
    return base;
  },
  cmd_onboarding_system_profile: (): SystemProfile => ({
    total_ram_gb: 16,
    cpu_cores: 10,
    physical_cores: 10,
    arch: "aarch64",
    os: "macos",
  }),
  cmd_onboarding_pull_model: async (args): Promise<PullOutcome> => {
    const name = validateModelName(argString(args, "name"));
    if (state.pulls.has(name)) throw invalid(`${name} is already downloading`);
    if (UNKNOWN_MODEL.test(name)) {
      await sleep(300);
      throw new Error(`AI engine error: Ollama has no model called "${name}" — check the name on ollama.com/library`);
    }
    const token = { cancelled: false };
    state.pulls.set(name, token);
    try {
      return await fakePull(name, token);
    } finally {
      state.pulls.delete(name);
    }
  },
  cmd_onboarding_cancel_pull: (args): boolean => {
    const token = state.pulls.get(argString(args, "name").trim());
    if (!token) return false;
    token.cancelled = true;
    return true;
  },
  cmd_onboarding_get_vault_prefs: (): VaultPrefs => state.prefs,
  cmd_onboarding_set_vault_prefs: (args): VaultPrefs => {
    state.prefs = validatePrefs(argObject<VaultPrefs>(args, "prefs"));
    return state.prefs;
  },
  cmd_onboarding_reveal_vault: () => {
    if (!mockVault.root) throw new Error("No vault is connected.");
    console.info(`[mock] reveal vault in Finder: ${mockVault.root}`);
  },
  cmd_onboarding_data_locations: (): DataLocation[] => {
    const entry = (name: string, is_dir: boolean, size_bytes: number, description: string): DataLocation => ({
      name,
      path: `${DATA_DIR}/${name}`,
      is_dir,
      size_bytes,
      description,
    });
    return [
      entry("aether", true, 48_200, "Saved AI answers (AI Notes)"),
      entry("ai", true, 212, "AI provider settings, including the OpenRouter key"),
      entry("calendar", true, 18_900, "Calendar events and reminder settings"),
      entry("crash-reports", true, 2_140, "Local crash reports"),
      entry("logs", true, 96_400, "Application log (rotates at 5 MB, keeps 3 old files)"),
      entry("memory", true, 31_700, "Agent memory facts and recent conversations"),
      entry("tasks", true, 12_300, "Task projects and issues"),
      entry("vectors", true, 4_180_000, "Semantic search index (embeddings of your notes)"),
      entry("config.json", false, 64, "Vault connection (which folder AETHER-OS reads)"),
      entry("onboarding.json", false, 118, "Setup wizard progress"),
    ];
  },
  cmd_onboarding_read_app_log: (args): AppLogTail => {
    const max = Math.max(1024, Math.min(1024 * 1024, argNumber(args, "maxBytes")));
    const start = Date.now() - 3 * 3600_000;
    const seeded = [
      `${new Date(start).toISOString()} INFO [app] AETHER-OS started (mock backend)`,
      `${new Date(start + 2_000).toISOString()} INFO [vault] connected ${mockVault.root ?? "no vault"}`,
      `${new Date(start + 65_000).toISOString()} ERROR [frontend] TypeError: Cannot read properties of undefined (reading 'nodes') [source=boundary]`,
      `${new Date(start + 90_000).toISOString()} INFO [ai] indexed 33 notes with nomic-embed-text`,
    ];
    let content = `${[...seeded, ...mockDiagnosticsLog()].join("\n")}\n`;
    const size = new TextEncoder().encode(content).length;
    const truncated = size > max;
    if (truncated) {
      content = content.slice(content.length - max);
      content = content.slice(content.indexOf("\n") + 1);
    }
    return { path: `${DATA_DIR}/logs/aether.log`, content, size_bytes: size, truncated };
  },
  cmd_onboarding_read_changelog: (): string => changelog,
  cmd_onboarding_reset_app_data: (args): ResetOutcome => {
    const keep = argBool(args, "keepVault");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    writeStored(null);
    state = seed(false);
    return {
      backup_path: `${DATA_DIR}-backup-${stamp}`,
      kept: keep ? ["config.json"] : [],
      restarting: false,
    };
  },
};
