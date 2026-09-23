import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";
import { Bot, FolderOpen, Info, Palette, SquarePen } from "lucide-react";
import { VaultSettings } from "./sections/VaultSettings";
import { AiProviderSettings } from "./sections/AiProviderSettings";
import { EditorSettings } from "./sections/EditorSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { AboutSettings } from "./sections/AboutSettings";
// Feature settings imports go directly above your anchor:
import { ClipboardList as ClipboardSettingsIcon } from "lucide-react";
import { ClipboardSettingsSection } from "../components/clipboard/ClipboardSettingsSection";
// @anchor:settings-import:clipboard
import { ScanSearch as SearchSettingsIcon } from "lucide-react";
import { SearchSettings } from "../components/search/SearchSettings";
// @anchor:settings-import:search
import { History as HistoryIcon } from "lucide-react";
import { HistorySettings } from "../components/history/HistorySettings";
// @anchor:settings-import:history
import { homeSettingsSection } from "../components/home/settingsSection";
// @anchor:settings-import:home
// @anchor:settings-import:vaulttasks
import { Sparkles as IntelSettingsIcon } from "lucide-react";
import { IntelSettings } from "../components/intel/IntelSettings";
// @anchor:settings-import:intel
// @anchor:settings-import:plugins
// @anchor:settings-import:export
import { RefreshCw as SyncSettingsIcon } from "lucide-react";
import { SyncSettingsSection } from "../components/sync/SyncSettingsSection";
// @anchor:settings-import:sync
import { CircleArrowUp, Keyboard as KeyboardIcon, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { GeneralSettings } from "./sections/GeneralSettings";
import { ShortcutsSettings } from "./sections/ShortcutsSettings";
import { DataPrivacySettings } from "./sections/DataPrivacySettings";
import { UpdatesSettings } from "./sections/UpdatesSettings";
// @anchor:settings-import:onboarding

/**
 * One page in the Settings modal. Build its content with the helpers in
 * `src/settings/layout.tsx` (`SettingsPage`, `SettingsGroup`, `SettingsRow`).
 */
export interface SettingsSection {
  /** `"<feature>"`, unique; also used by `openSettings("<id>")`. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** Sort key in the section list (General 5 first, built-ins 10–50, About last). */
  order: number;
  component: ComponentType | LazyExoticComponent<ComponentType>;
  /** Extra words for the settings filter. */
  keywords?: string[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "vault", title: "Vault", icon: FolderOpen, order: 10, component: VaultSettings, keywords: ["folder", "path", "nopes"] },
  {
    id: "ai",
    title: "AI Providers",
    icon: Bot,
    order: 20,
    component: AiProviderSettings,
    keywords: ["ollama", "openrouter", "api key", "model"],
  },
  { id: "editor", title: "Editor", icon: SquarePen, order: 30, component: EditorSettings, keywords: ["cursor", "vs code", "external"] },
  {
    id: "appearance",
    title: "Appearance",
    icon: Palette,
    order: 40,
    component: AppearanceSettings,
    keywords: ["theme", "dark", "light", "accent", "density", "labels"],
  },
  { id: "clipboard", title: "Clipboard", icon: ClipboardSettingsIcon, order: 45, component: ClipboardSettingsSection, keywords: ["paste", "history", "privacy", "retention", "secrets"] },
  // @anchor:settings:clipboard
  { id: "search", title: "Search", icon: SearchSettingsIcon, order: 55, component: SearchSettings, keywords: ["launcher", "shortcut", "global", "index", "files", "apps", "spotlight"] },
  // @anchor:settings:search
  { id: "history", title: "History", icon: HistoryIcon, order: 55, component: HistorySettings, keywords: ["versions", "git", "snapshot", "restore", "time machine"] },
  // @anchor:settings:history
  homeSettingsSection,
  // @anchor:settings:home
  // @anchor:settings:vaulttasks
  { id: "intel", title: "AI Intelligence", icon: IntelSettingsIcon, order: 25, component: IntelSettings, keywords: ["compaction", "summary", "tokens", "related", "tags", "approval", "audit", "agent activity", "run command"] },
  // @anchor:settings:intel
  // @anchor:settings:plugins
  // @anchor:settings:export
  { id: "sync", title: "Sync & Backup", icon: SyncSettingsIcon, order: 60, component: SyncSettingsSection, keywords: ["backup", "restore", "encryption", "passphrase", "icloud", "dropbox", "syncthing", "devices"] },
  // @anchor:settings:sync
  { id: "general", title: "General", icon: SlidersHorizontal, order: 5, component: GeneralSettings, keywords: ["start", "startup", "language", "setup", "wizard", "agent panel", "quit", "terminal"] },
  { id: "shortcuts", title: "Shortcuts", icon: KeyboardIcon, order: 70, component: ShortcutsSettings, keywords: ["keys", "keyboard", "hotkeys", "cheat sheet"] },
  { id: "privacy", title: "Data & Privacy", icon: ShieldCheck, order: 80, component: DataPrivacySettings, keywords: ["data", "crash", "log", "reset", "telemetry", "backup"] },
  { id: "updates", title: "Updates", icon: CircleArrowUp, order: 90, component: UpdatesSettings, keywords: ["version", "release", "changelog", "what's new"] },
  // @anchor:settings:onboarding
  { id: "about", title: "About", icon: Info, order: 1000, component: AboutSettings, keywords: ["version", "license", "github"] },
];

/** Sections sorted by `order` (stable for equal orders). */
export function getSettingsSections(sections: SettingsSection[] = SETTINGS_SECTIONS): SettingsSection[] {
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.order - b.s.order || a.i - b.i)
    .map(({ s }) => s);
}

/** Resolve the section to show: the requested id if it exists, else the first (General). */
export function resolveSettingsSection(
  id: string | null | undefined,
  sections: SettingsSection[] = getSettingsSections()
): SettingsSection | undefined {
  return sections.find((s) => s.id === id) ?? sections[0];
}
