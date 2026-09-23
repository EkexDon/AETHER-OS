import { useMemo } from "react";
import type { VaultTaskItem, VaultTaskPriority, VaultTaskStatus } from "../../types";
import { useToast } from "../../ui";
import { useVaultTasksStore } from "../../lib/vaultTasksStore";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Store actions wrapped with toasts: edits are optimistic in the store and
 * roll back on failure; this hook tells the user what happened.
 */
export function useTaskActions() {
  const toast = useToast();
  return useMemo(() => {
    const store = () => useVaultTasksStore.getState();
    const guard = async (title: string, run: () => Promise<unknown>) => {
      try {
        await run();
        return true;
      } catch (e) {
        toast.error(title, { description: errorText(e) });
        return false;
      }
    };
    return {
      toggle: (task: VaultTaskItem, checked: boolean) =>
        guard("Couldn't update the task", () => store().toggle(task, checked)),
      setStatus: (task: VaultTaskItem, status: VaultTaskStatus) =>
        guard("Couldn't change the status", () => store().setStatus(task, status)),
      setDue: (task: VaultTaskItem, due: string | null) =>
        guard("Couldn't change the due date", () => store().setDue(task, due)),
      setPriority: (task: VaultTaskItem, priority: VaultTaskPriority) =>
        guard("Couldn't change the priority", () => store().setPriority(task, priority)),
      /** Open the task's note in the editor at its line. */
      openNote: (task: VaultTaskItem) => {
        store().openTaskNote(task);
        toast.info(`Opened ${task.note_name} · line ${task.line + 1}`);
      },
      /** Open a `[[wikilink]]` target. */
      openLink: (target: string) => {
        if (!store().openNoteByName(target)) {
          toast.info(`No note named "${target}"`, { description: "Create it from the Notes view to follow this link." });
        }
      },
      filterByTag: (tag: string) => {
        store().setTagFilter(tag);
        toast.info(`Filtered by #${tag}`, { action: { label: "Clear", onClick: () => store().setTagFilter(null) } });
      },
    };
  }, [toast]);
}
