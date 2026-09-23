/** Onboarding & settings types — mirror `src-tauri/src/engine/onboarding.rs`. */

/** Persisted wizard state (`<data_dir>/onboarding.json`). */
export interface OnboardingState {
  /** RFC 3339 time the wizard was finished or skipped; `null` on first run. */
  completed_at: string | null;
  /** App version whose "What's new" note the user has seen. */
  version_seen: string | null;
  /** Wizard steps the user skipped. */
  skipped_steps: string[];
}

/** What kind of notes folder a vault is. */
export type VaultKind = "obsidian" | "nopes" | "plain";

/** A vault on disk (detected or freshly created). */
export interface VaultInfo {
  path: string;
  /** Folder name. */
  name: string;
  /** Markdown files, excluding hidden folders. */
  note_count: number;
  kind: VaultKind;
}

/** Hardware facts used to recommend a local model. */
export interface SystemProfile {
  /** Installed memory in GiB, one decimal. */
  total_ram_gb: number;
  /** Logical CPU cores. */
  cpu_cores: number;
  physical_cores: number | null;
  /** `aarch64`, `x86_64`, … */
  arch: string;
  /** `macos`, `linux`, `windows`. */
  os: string;
}

/** Payload of the `ollama-pull-progress` event. */
export interface OllamaPullProgress {
  /** Model being pulled. */
  name: string;
  /** Ollama status line: `pulling manifest`, `downloading sha256:…`, `verifying sha256 digest`, `writing manifest`, `success`. */
  status: string;
  /** Bytes downloaded of the current layer. */
  completed: number | null;
  /** Size of the current layer in bytes. */
  total: number | null;
}

/** Result of `cmd_onboarding_pull_model`. */
export interface PullOutcome {
  name: string;
  /** `true` when the download was cancelled. */
  cancelled: boolean;
}

/** Daily-note location and naming (`<data_dir>/vault_prefs.json`). */
export interface VaultPrefs {
  /** Vault-relative folder (`""` = vault root). */
  daily_folder: string;
  /** File name pattern without `.md`; tokens `YYYY`, `MM`, `DD`. */
  daily_filename_pattern: string;
}

/** One top-level entry of the app data directory. */
export interface DataLocation {
  name: string;
  path: string;
  is_dir: boolean;
  /** Recursive size in bytes. */
  size_bytes: number;
  /** What AETHER-OS keeps there. */
  description: string;
}

/** The end of `logs/aether.log`. */
export interface AppLogTail {
  path: string;
  /** Whole lines only. */
  content: string;
  /** Size of the whole log file. */
  size_bytes: number;
  /** `true` when older lines were cut off. */
  truncated: boolean;
}

/** Result of `cmd_onboarding_reset_app_data`. */
export interface ResetOutcome {
  /** Where the previous data directory now lives. */
  backup_path: string;
  /** Files copied back into the fresh data directory. */
  kept: string[];
  /** The desktop app restarts on its own; the browser preview reloads. */
  restarting: boolean;
}
