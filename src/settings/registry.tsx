import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";
import { Bot, FolderOpen, Info, Palette, SquarePen } from "lucide-react";
import { VaultSettings } from "./sections/VaultSettings";
import { AiProviderSettings } from "./sections/AiProviderSettings";
import { EditorSettings } from "./sections/EditorSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { AboutSettings } from "./sections/AboutSettings";
// Feature settings imports go directly above your anchor:
// @anchor:settings-import:clipboard
// @anchor:settings-import:search
// @anchor:settings-import:history
// @anchor:settings-import:home
// @anchor:settings-import:vaulttasks
// @anchor:settings-import:intel
// @anchor:settings-import:plugins
// @anchor:settings-import:export
// @anchor:settings-import:sync
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
  /** Sort key in the section list (built-ins use 10–50, About is last). */
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
  // @anchor:settings:clipboard
  // @anchor:settings:search
  // @anchor:settings:history
  // @anchor:settings:home
  // @anchor:settings:vaulttasks
  // @anchor:settings:intel
  // @anchor:settings:plugins
  // @anchor:settings:export
  // @anchor:settings:sync
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

/** Resolve the section to show: the requested id if it exists, else the first. */
export function resolveSettingsSection(
  id: string | null | undefined,
  sections: SettingsSection[] = getSettingsSections()
): SettingsSection | undefined {
  return sections.find((s) => s.id === id) ?? sections[0];
}
