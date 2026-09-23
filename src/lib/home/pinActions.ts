/**
 * What happens when a pin is activated, plus pin metadata. Dependencies are
 * injected so the routing is testable; `livePinDeps()` binds them to the
 * real stores, the command registry and the IPC layer.
 */
import type { LucideIcon } from "lucide-react";
import { Command as CommandIcon, FileText, FolderGit2, Globe, MessagesSquare } from "lucide-react";
import type { PinItem, PinKind, VaultNote } from "../../types";
import type { ViewMode } from "../../views/modes";
import { agentOpenUrl } from "../ipc";
import { useAetherStore } from "../store";
import { useIdeStore } from "../ideStore";
import { getCommands, runCommand } from "../commands/registry";

/** Display metadata per pin kind. */
export const PIN_KIND_META: Record<PinKind, { label: string; icon: LucideIcon }> = {
  note: { label: "Note", icon: FileText },
  project: { label: "Project", icon: FolderGit2 },
  command: { label: "Command", icon: CommandIcon },
  conversation: { label: "Conversation", icon: MessagesSquare },
  url: { label: "Link", icon: Globe },
};

/** Everything `openPin` needs from the app. */
export interface PinOpenDeps {
  /** Current vault notes (empty while not loaded). */
  notes: () => VaultNote[];
  selectNote: (path: string) => void;
  setView: (mode: ViewMode) => void;
  setIdeRoot: (path: string) => void;
  /** Resolves `false` when the command is unknown or disabled. */
  runCommand: (id: string) => Promise<boolean>;
  openChat: () => void;
  openUrl: (url: string) => Promise<unknown>;
}

/**
 * Accept `https://…`, `http://…` or a bare host (`example.com/x` → https).
 * Returns `null` for anything else (other schemes, spaces, no host).
 */
export function normalizePinUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname || (!url.hostname.includes(".") && url.hostname !== "localhost")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A short label for a URL pin: host + path without trailing slash. */
export function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/**
 * Whether a pin's target is known to be gone: a note that is not in the
 * (loaded) vault, or a command that is not registered.
 */
export function isPinStale(pin: PinItem, notes: VaultNote[], commandIds: ReadonlySet<string>): boolean {
  if (pin.kind === "note") return notes.length > 0 && !notes.some((n) => n.path === pin.ref);
  if (pin.kind === "command") return commandIds.size > 0 && !commandIds.has(pin.ref);
  return false;
}

/**
 * Open a pin: note → editor, project → IDE with that root, command → run
 * it, conversation → open the agent panel, url → system browser. Throws an
 * `Error` with a readable message when the target cannot be opened.
 */
export async function openPin(pin: PinItem, deps: PinOpenDeps): Promise<void> {
  switch (pin.kind) {
    case "note": {
      const notes = deps.notes();
      if (notes.length > 0 && !notes.some((n) => n.path === pin.ref)) {
        throw new Error(`"${pin.label}" is no longer in the vault. It may have been moved or deleted.`);
      }
      deps.selectNote(pin.ref);
      deps.setView("editor");
      return;
    }
    case "project":
      deps.setIdeRoot(pin.ref);
      deps.setView("ide");
      return;
    case "command": {
      const ran = await deps.runCommand(pin.ref);
      if (!ran) throw new Error(`The command "${pin.label}" is not available right now.`);
      return;
    }
    case "conversation":
      deps.openChat();
      return;
    case "url": {
      const url = normalizePinUrl(pin.ref);
      if (!url) throw new Error(`"${pin.ref}" is not a valid web address.`);
      await deps.openUrl(url);
      return;
    }
  }
}

/** Dependencies bound to the running app. */
export function livePinDeps(): PinOpenDeps {
  return {
    notes: () => useAetherStore.getState().vaultNotes,
    selectNote: (path) => useAetherStore.getState().selectNote(path),
    setView: (mode) => useAetherStore.getState().setView(mode),
    setIdeRoot: (path) => useIdeStore.getState().setRoot(path),
    runCommand: (id) => runCommand(id),
    openChat: () => useAetherStore.getState().setChatOpen(true),
    openUrl: (url) => agentOpenUrl(url),
  };
}

/** Ids of all registered commands (for stale-pin detection). */
export function registeredCommandIds(): Set<string> {
  return new Set(getCommands().map((c) => c.id));
}
