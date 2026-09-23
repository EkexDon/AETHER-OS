/** Onboarding & settings commands (`src-tauri/src/commands/onboarding_commands.rs`). */
import type {
  AppLogTail,
  DataLocation,
  GeneralPrefs,
  OllamaPullProgress,
  OnboardingState,
  PullOutcome,
  ResetOutcome,
  SystemProfile,
  VaultInfo,
  VaultPrefs,
} from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Event carrying {@link OllamaPullProgress} while a model downloads. */
export const OLLAMA_PULL_PROGRESS_EVENT = "ollama-pull-progress";

/** The persisted wizard state (`completed_at: null` on first run). */
export const getOnboardingState = () => call<OnboardingState>("cmd_onboarding_get_state");
/** Validate and persist the wizard state; resolves to what was stored. */
export const setOnboardingState = (onboarding: OnboardingState) =>
  call<OnboardingState>("cmd_onboarding_set_state", { onboarding });
/** Create a starter vault at `path` (inside the home folder, new or empty). Does not connect it. */
export const createStarterVault = (path: string) => call<VaultInfo>("cmd_onboarding_create_vault", { path });
/** Existing Obsidian / NoPes / plain Markdown vaults under `~/Documents` and `~`. */
export const detectVaults = () => call<VaultInfo[]>("cmd_onboarding_detect_vaults");
/** A free default location for a new vault (`~/Documents/AETHER Vault`). */
export const suggestVaultPath = () => call<string>("cmd_onboarding_suggest_vault_path");
/** RAM, cores and architecture of this machine. */
export const getSystemProfile = () => call<SystemProfile>("cmd_onboarding_system_profile");
/** Download a model with the local Ollama; progress arrives via {@link onOllamaPullProgress}. */
export const pullOllamaModel = (name: string) => call<PullOutcome>("cmd_onboarding_pull_model", { name });
/** Stop a running download; resolves to whether one was running. */
export const cancelOllamaPull = (name: string) => call<boolean>("cmd_onboarding_cancel_pull", { name });
/** Daily-note folder and filename pattern. */
export const getVaultPrefs = () => call<VaultPrefs>("cmd_onboarding_get_vault_prefs");
/** Validate and store the vault preferences; resolves to what was stored. */
export const setVaultPrefs = (prefs: VaultPrefs) => call<VaultPrefs>("cmd_onboarding_set_vault_prefs", { prefs });
/** General preferences shared with the Rust side (quit confirmation). */
export const getGeneralPrefs = () => call<GeneralPrefs>("cmd_onboarding_get_general_prefs");
/** Store the general preferences; resolves to what was stored. */
export const setGeneralPrefs = (prefs: GeneralPrefs) => call<GeneralPrefs>("cmd_onboarding_set_general_prefs", { prefs });
/** Reveal the connected vault in the file manager. */
export const revealVault = () => call<void>("cmd_onboarding_reveal_vault");
/** Top-level files and folders of the app data directory with sizes. */
export const getDataLocations = () => call<DataLocation[]>("cmd_onboarding_data_locations");
/** The last `maxBytes` of the application log (whole lines). */
export const readAppLog = (maxBytes = 64 * 1024) => call<AppLogTail>("cmd_onboarding_read_app_log", { maxBytes });
/** The changelog bundled with this build (Markdown). */
export const readChangelog = () => call<string>("cmd_onboarding_read_changelog");
/** Move the app data aside as a backup and restart fresh (desktop) — the vault folder is never touched. */
export const resetAppData = (keepVault: boolean) => call<ResetOutcome>("cmd_onboarding_reset_app_data", { keepVault });

/** Subscribe to model download progress. */
export function onOllamaPullProgress(handler: (progress: OllamaPullProgress) => void): Promise<UnlistenFn> {
  return listenSafe<OllamaPullProgress>(OLLAMA_PULL_PROGRESS_EVENT, handler);
}
