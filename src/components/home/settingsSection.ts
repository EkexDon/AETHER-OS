/** Settings → "Focus & Pomodoro", registered at the `home` settings anchor. */
import { Timer } from "lucide-react";
import type { SettingsSection } from "../../settings/registry";
import { HOME_SETTINGS_ID } from "../../lib/home/commands";
import { FocusSettings } from "./FocusSettings";

export const homeSettingsSection: SettingsSection = {
  id: HOME_SETTINGS_ID,
  title: "Focus & Pomodoro",
  icon: Timer,
  order: 58,
  component: FocusSettings,
  keywords: ["pomodoro", "timer", "focus", "break", "notifications", "sound", "home"],
};
