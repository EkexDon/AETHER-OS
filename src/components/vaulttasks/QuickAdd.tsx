import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ListPlus, Plus } from "lucide-react";
import type { VaultTaskItem, VaultTaskPriority } from "../../types";
import { Button, Input, Kbd, Modal, Select, useToast } from "../../ui";
import { useVaultTasksStore } from "../../lib/vaultTasksStore";
import { composeTaskText } from "../../lib/vaulttasks/edit";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shared submit logic: append to today's daily note and confirm with a toast. */
function useAddToDaily() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const add = async (text: string): Promise<VaultTaskItem | null> => {
    if (!text.trim() || busy) return null;
    setBusy(true);
    try {
      const store = useVaultTasksStore.getState();
      const task = await store.addToDailyNote(text);
      toast.success("Task added to today's daily note", {
        description: task.text_clean || task.text_raw,
        action: { label: "Open note", onClick: () => useVaultTasksStore.getState().openTaskNote(task) },
      });
      return task;
    } catch (e) {
      toast.error("Couldn't add the task", { description: errorText(e) });
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { add, busy };
}

/** Inline "Add task to today's daily note" field at the top of the view. */
export function QuickAddInline() {
  const [text, setText] = useState("");
  const { add, busy } = useAddToDaily();
  const inputRef = useRef<HTMLInputElement>(null);
  const focusToken = useVaultTasksStore((s) => s.quickAddFocusToken);

  useEffect(() => {
    if (focusToken > 0) inputRef.current?.focus();
  }, [focusToken]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await add(text)) setText("");
  };

  return (
    <form className="vt-quickadd" onSubmit={(e) => void submit(e)}>
      <Input
        ref={inputRef}
        className="vt-quickadd-input"
        iconLeft={<Plus size={14} />}
        placeholder="Add task to today's daily note"
        aria-label="New task for today's daily note"
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        suffix={!text ? <Kbd shortcut="mod+shift+t" /> : undefined}
      />
      <Button type="submit" variant="primary" loading={busy} disabled={!text.trim()}>
        Add
      </Button>
    </form>
  );
}

const PRIORITIES: Array<{ value: VaultTaskPriority; label: string }> = [
  { value: "none", label: "No priority" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

/** ⌘⇧T dialog: text, optional due date and priority → today's daily note. */
export function QuickAddModal() {
  const open = useVaultTasksStore((s) => s.quickAddOpen);
  const close = useVaultTasksStore((s) => s.closeQuickAdd);
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<VaultTaskPriority>("none");
  const { add, busy } = useAddToDaily();
  const textRef = useRef<HTMLInputElement>(null);
  const ids = { text: useId(), due: useId(), priority: useId() };

  useEffect(() => {
    if (!open) {
      setText("");
      setDue("");
      setPriority("none");
    }
  }, [open]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (await add(composeTaskText(text, due || null, priority))) close();
  };
  // Two date/text fields block the browser's implicit submission, so Enter is handled here.
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add task to daily note"
      description="Appends a checkbox to today's daily note."
      icon={ListPlus}
      size="sm"
      position="top"
      initialFocusRef={textRef}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void submit()}>
            Add task
          </Button>
        </>
      }
    >
      <form className="vt-quickadd-form" onSubmit={(e) => void submit(e)}>
        <div className="ui-field">
          <label className="ui-field-label" htmlFor={ids.text}>
            Task
          </label>
          <Input
            ref={textRef}
            id={ids.text}
            placeholder="e.g. Call the moving company #umzug"
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onEnter}
          />
          <span className="ui-field-hint">Tags, [[links]] and due:YYYY-MM-DD work as in any note.</span>
        </div>
        <div className="vt-quickadd-row">
          <div className="ui-field">
            <label className="ui-field-label" htmlFor={ids.due}>
              Due date
            </label>
            <Input id={ids.due} type="date" value={due} onChange={(e) => setDue(e.target.value)} onKeyDown={onEnter} />
          </div>
          <div className="ui-field">
            <label className="ui-field-label" htmlFor={ids.priority}>
              Priority
            </label>
            <Select
              id={ids.priority}
              value={priority}
              onChange={(e) => setPriority(e.target.value as VaultTaskPriority)}
              options={PRIORITIES}
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}
