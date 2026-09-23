import { useEffect, useRef, useState, type RefObject } from "react";
import { FilePlus2 } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { createNote, getVaultNotes } from "../lib/ipc";
import { Button, Input, Modal } from "../ui";

/** "New note" dialog behind the ⌘N command: creates the note and opens it. */
export function NewNoteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setVaultNotes = useAetherStore((s) => s.setVaultNotes);
  const selectNote = useAetherStore((s) => s.selectNote);
  const setView = useAetherStore((s) => s.setView);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      setSaving(false);
    }
  }, [open]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const path = await createNote(trimmed, `# ${trimmed}\n\n`);
      setVaultNotes(await getVaultNotes());
      selectNote(path);
      setView("editor");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New note"
      description="Creates a Markdown file in your vault and opens it."
      icon={FilePlus2}
      size="sm"
      position="top"
      initialFocusRef={inputRef as RefObject<HTMLElement>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} loading={saving} disabled={!name.trim()}>
            Create note
          </Button>
        </>
      }
    >
      <div className="ui-field">
        <label className="ui-field-label" htmlFor="new-note-name">
          Name
        </label>
        <Input
          id="new-note-name"
          ref={inputRef}
          value={name}
          placeholder="e.g. Project kickoff"
          invalid={!!error}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
        {error ? (
          <span className="ui-field-error">{error}</span>
        ) : (
          <span className="ui-field-hint">Use slashes for folders, e.g. “projects/kickoff”.</span>
        )}
      </div>
    </Modal>
  );
}
