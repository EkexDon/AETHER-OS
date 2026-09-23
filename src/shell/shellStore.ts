import { create } from "zustand";

/**
 * State of the application shell's overlays (settings, command palette,
 * web clipper, shortcuts overlay, new-note dialog). Quick Capture keeps its
 * flag in `useAetherStore` because the component reads it from there.
 */
interface ShellState {
  settingsOpen: boolean;
  /** Section to show when the settings modal opens. */
  settingsSection: string | null;
  launcherOpen: boolean;
  webClipperOpen: boolean;
  shortcutsOpen: boolean;
  newNoteOpen: boolean;
  openSettings: (section?: string | null) => void;
  closeSettings: () => void;
  setSettingsSection: (section: string) => void;
  setLauncherOpen: (open: boolean) => void;
  toggleLauncher: () => void;
  setWebClipperOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  toggleShortcuts: () => void;
  setNewNoteOpen: (open: boolean) => void;
}

export const useShellStore = create<ShellState>((set) => ({
  settingsOpen: false,
  settingsSection: null,
  launcherOpen: false,
  webClipperOpen: false,
  shortcutsOpen: false,
  newNoteOpen: false,
  openSettings: (section = null) => set({ settingsOpen: true, settingsSection: section, launcherOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setLauncherOpen: (launcherOpen) => set({ launcherOpen }),
  toggleLauncher: () => set((s) => ({ launcherOpen: !s.launcherOpen })),
  setWebClipperOpen: (webClipperOpen) => set({ webClipperOpen, launcherOpen: false }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen, launcherOpen: false }),
  toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen, launcherOpen: false })),
  setNewNoteOpen: (newNoteOpen) => set({ newNoteOpen, launcherOpen: false }),
}));
