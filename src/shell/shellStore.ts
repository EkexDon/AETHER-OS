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
  commandBarOpen: boolean;
  webClipperOpen: boolean;
  shortcutsOpen: boolean;
  newNoteOpen: boolean;
  openSettings: (section?: string | null) => void;
  closeSettings: () => void;
  setSettingsSection: (section: string) => void;
  setCommandBarOpen: (open: boolean) => void;
  toggleCommandBar: () => void;
  setWebClipperOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  toggleShortcuts: () => void;
  setNewNoteOpen: (open: boolean) => void;
}

export const useShellStore = create<ShellState>((set) => ({
  settingsOpen: false,
  settingsSection: null,
  commandBarOpen: false,
  webClipperOpen: false,
  shortcutsOpen: false,
  newNoteOpen: false,
  openSettings: (section = null) => set({ settingsOpen: true, settingsSection: section, commandBarOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setCommandBarOpen: (commandBarOpen) => set({ commandBarOpen }),
  toggleCommandBar: () => set((s) => ({ commandBarOpen: !s.commandBarOpen })),
  setWebClipperOpen: (webClipperOpen) => set({ webClipperOpen, commandBarOpen: false }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen, commandBarOpen: false }),
  toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen, commandBarOpen: false })),
  setNewNoteOpen: (newNoteOpen) => set({ newNoteOpen, commandBarOpen: false }),
}));
