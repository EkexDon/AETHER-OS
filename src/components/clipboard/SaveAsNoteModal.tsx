import { useEffect, useRef, useState, type FormEvent } from "react";
import { FilePlus2 } from "lucide-react";
import type { ClipItem } from "../../types";
import { useAetherStore } from "../../lib/store";
import { useClipboardStore } from "../../lib/clipboardStore";
import { getVaultNotes } from "../../lib/ipc";
import { suggestNoteTitle } from "../../lib/clipboard/format";
import { Button, Input, Modal, useToast } from "../../ui";

export interface SaveAsNoteModalProps {
  /** The clip to save; `null` closes the modal. */
  item: ClipItem | null;
  onClose: () => void;
}

/** Ask for a title and save the clip as `clipboard/<title>.md` in the vault. */
export function SaveAsNoteModal({ item, onClose }: SaveAsNoteModalProps) {
  const toast = useToast();
  const saveAsNote = useClipboardStore((s) => s.saveAsNote);
  const { setVaultNotes, selectNote, setView } = useAetherStore();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!item) return;
    setTitle(suggestNoteTitle(item));
    setError(null);
    setSaving(false);
  }, [item]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!item || saving) return;
    setSaving(true);
    setError(null);
    try {
      const path = await saveAsNote(item.id, title);
      onClose();
      toast.success("Saved as note", {
        description: path.split(/[\\/]/).slice(-2).join("/"),
        action: {
          label: "Open",
          onClick: () => {
            selectNote(path);
            setView("editor");
          },
        },
      });
      try {
        setVaultNotes(await getVaultNotes());
      } catch {
        // The sidebar refreshes on its own next time; the note exists.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      open={item !== null}
      onClose={onClose}
      title="Save clip as note"
      description="Creates a Markdown note in the clipboard folder of your vault."
      icon={FilePlus2}
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!title.trim()} onClick={() => void submit()}>
            Save note
          </Button>
        </>
      }
    >
      <form className="clip-save-form" onSubmit={(e) => void submit(e)}>
        <div className="ui-field">
          <label className="ui-field-label" htmlFor="clip-note-title">
            Title
          </label>
          <Input
            id="clip-note-title"
            ref={inputRef}
            value={title}
            maxLength={120}
            invalid={!!error}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
          <span className="ui-field-hint">
            Saved as <span className="mono">clipboard/{title.trim() || "…"}.md</span>
            {item?.kind === "image" ? "; the image goes to attachments/clipboard/." : "."}
          </span>
        </div>
        {error && (
          <div className="ui-notice ui-notice-danger" role="alert">
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
