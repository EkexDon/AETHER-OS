/**
 * What happens when a search result is opened from the launcher or the
 * Universal Search view. Every open is recorded as a recent (drives the
 * Recents section and frecency ranking).
 *
 * `alternate` is the `mod+Enter` "other context" action:
 * note → raw Markdown in the IDE, project/file → preferred external editor,
 * event → week instead of day, task → board without the detail dialog,
 * memory → Search view preview, conversation → transcript preview in the
 * Search view (Enter loads the conversation into the agent panel).
 */
import type { SearchHit } from "../../types";
import { browserOpen, copyClip, ideReadFile, launchApp, openProject, recordSearchRecent } from "../ipc";
import { useAetherStore } from "../store";
import { isDirty, useIdeStore } from "../ideStore";
import { runCommand } from "../commands/registry";
import { useShellStore } from "../../shell/shellStore";
import { toast } from "../../ui/Toast";
import { useSearchStore } from "../searchStore";
import { openConversation } from "../agentChatBus";
import { editorLabel } from "../editors";

/** Options for opening a result. */
export interface OpenOptions {
  /** `mod+Enter`: open in the alternate context. */
  alternate?: boolean;
}

/** Display name of an editor key stored in `preferredEditor` (see `lib/editors.ts`). */
export { editorLabel };

function extraString(hit: SearchHit, key: string): string | null {
  const value = hit.extra?.[key];
  return typeof value === "string" && value ? value : null;
}

function closeLauncher() {
  useShellStore.getState().setLauncherOpen(false);
}

function remember(id: string, kind: string, title: string) {
  // Recents are a convenience; a failure must never block navigation.
  void recordSearchRecent(id, kind, title).catch(() => undefined);
}

/**
 * Point the IDE at `root` and open `file` in it. Refuses to switch roots
 * while files of another folder have unsaved changes.
 */
export async function openInIde(root: string, file?: string): Promise<void> {
  const ide = useIdeStore.getState();
  if (ide.rootPath !== root) {
    if (ide.tabs.some(isDirty)) {
      throw new Error("Save or close the files with unsaved changes in the IDE first.");
    }
    ide.closeAll();
    ide.setRoot(root);
  }
  if (file) {
    const content = await ideReadFile(file);
    useIdeStore.getState().openFile(file, content);
  }
  useAetherStore.getState().setView("ide");
}

/** Open a backend search hit. Errors are surfaced as a toast and re-thrown. */
export async function openHit(hit: SearchHit, options: OpenOptions = {}): Promise<void> {
  const alternate = options.alternate ?? false;
  const aether = useAetherStore.getState();
  closeLauncher();
  remember(hit.id, hit.kind, hit.title);
  try {
    switch (hit.kind) {
      case "note": {
        if (alternate) {
          const vault = aether.vaultPath;
          if (!vault) throw new Error("No vault is configured.");
          await openInIde(vault, hit.path);
        } else {
          aether.selectNote(hit.path);
          aether.setView("editor");
        }
        return;
      }
      case "project": {
        if (alternate) {
          await openProject(hit.path, aether.preferredEditor);
          toast.success(`Opened ${hit.title} in ${editorLabel(aether.preferredEditor)}`);
        } else {
          await openInIde(hit.path);
        }
        return;
      }
      case "file": {
        if (alternate) {
          await openProject(hit.path, aether.preferredEditor);
          toast.success(`Opened ${hit.title} in ${editorLabel(aether.preferredEditor)}`);
        } else {
          const root = extraString(hit, "root") ?? hit.path.slice(0, hit.path.lastIndexOf("/"));
          await openInIde(root, hit.path);
        }
        return;
      }
      case "app": {
        await launchApp(hit.path);
        return;
      }
      case "event": {
        const date = extraString(hit, "date");
        if (date) aether.setCalendarDate(date);
        aether.setCalendarView(alternate ? "week" : "day");
        aether.setView("calendar");
        return;
      }
      case "task": {
        const projectId = extraString(hit, "project_id");
        const taskId = extraString(hit, "task_id");
        if (projectId) aether.setSelectedProjectId(projectId);
        if (!alternate && taskId) {
          aether.setSelectedTaskId(taskId);
          aether.setTaskDetailModalOpen(true);
        }
        aether.setView("tasks");
        return;
      }
      case "memory": {
        if (alternate) {
          useSearchStore.getState().showInSearchView(hit.title, hit.id, "memory");
          aether.setView("search");
        } else {
          aether.setView("memory");
        }
        return;
      }
      case "conversation": {
        if (alternate) {
          useSearchStore.getState().showInSearchView(hit.title, hit.id, "conversation");
          aether.setView("search");
        } else {
          await openConversation(extraString(hit, "conversation_id") ?? hit.id.replace(/^conversation:/, ""));
        }
        return;
      }
    }
  } catch (e) {
    toast.error(`Could not open ${hit.title}`, { description: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** Run a registered command from the launcher. */
export async function openCommand(id: string, title: string): Promise<void> {
  closeLauncher();
  remember(`command:${id}`, "command", title);
  // `runCommand` already toasts failures.
  await runCommand(id).catch(() => undefined);
}

/** Open a browser bookmark in the system browser. */
export async function openBookmark(url: string, title: string): Promise<void> {
  closeLauncher();
  remember(`bookmark:${url}`, "bookmark", title);
  try {
    await browserOpen(url);
  } catch (e) {
    toast.error(`Could not open ${title}`, { description: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Copy a clipboard-history item back to the system clipboard (clipboard
 * feature); `alternate` opens the clipboard history view instead.
 */
export async function openClip(id: string, preview: string, options: OpenOptions = {}): Promise<void> {
  closeLauncher();
  remember(`clip:${id}`, "clip", preview);
  if (options.alternate) {
    await runCommand("clipboard.open").catch(() => undefined);
    return;
  }
  try {
    await copyClip(id);
    toast.success("Copied to the clipboard", { description: preview.slice(0, 80) });
  } catch (e) {
    toast.error("Could not copy the clip", { description: e instanceof Error ? e.message : String(e) });
  }
}
