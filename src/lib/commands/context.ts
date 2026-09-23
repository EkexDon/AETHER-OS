import { useAetherStore } from "../store";
import { useThemeStore } from "../theme";
import { useAppearanceStore } from "../appearance";
import { useShellStore } from "../../shell/shellStore";
import { toast, type ToastApi } from "../../ui/Toast";
import type { ViewMode } from "../../views/modes";

/**
 * Everything a command may need to do. Built fresh from the global stores
 * on every run, so commands never hold stale state.
 */
export interface CommandContext {
  /** The active view. */
  view: ViewMode;
  setView: (mode: ViewMode) => void;
  openSettings: (sectionId?: string) => void;
  toggleCommandBar: () => void;
  closeCommandBar: () => void;
  openQuickCapture: () => void;
  openWebClipper: () => void;
  openShortcuts: () => void;
  openNewNote: () => void;
  toggleTheme: () => void;
  setThemePreference: (preference: "system" | "light" | "dark") => void;
  toggleRailLabels: () => void;
  toggleDensity: () => void;
  toggleAgentPanel: () => void;
  toast: ToastApi;
}

/** Build a context bound to the live stores. */
export function createCommandContext(): CommandContext {
  const aether = useAetherStore.getState();
  const shell = useShellStore.getState();
  return {
    view: aether.view,
    setView: (mode) => {
      useAetherStore.getState().setView(mode);
      useShellStore.getState().setCommandBarOpen(false);
    },
    openSettings: (sectionId) => shell.openSettings(sectionId ?? null),
    toggleCommandBar: () => useShellStore.getState().toggleCommandBar(),
    closeCommandBar: () => useShellStore.getState().setCommandBarOpen(false),
    openQuickCapture: () => {
      useShellStore.getState().setCommandBarOpen(false);
      useAetherStore.getState().setShowQuickCapture(true);
    },
    openWebClipper: () => useShellStore.getState().setWebClipperOpen(true),
    openShortcuts: () => useShellStore.getState().toggleShortcuts(),
    openNewNote: () => useShellStore.getState().setNewNoteOpen(true),
    toggleTheme: () => useThemeStore.getState().toggle(),
    setThemePreference: (preference) => useThemeStore.getState().setPreference(preference),
    toggleRailLabels: () => useAppearanceStore.getState().toggleRailExpanded(),
    toggleDensity: () => {
      const a = useAppearanceStore.getState();
      a.setDensity(a.density === "compact" ? "comfortable" : "compact");
    },
    toggleAgentPanel: () => {
      const s = useAetherStore.getState();
      s.setChatOpen(!s.chatOpen);
    },
    toast,
  };
}
