import { useState } from "react";
import { Scissors, FileText, Check, Link2 } from "lucide-react";
import { clipUrl, createNote, getVaultNotes } from "../lib/ipc";
import { useAetherStore } from "../lib/store";
import { buildClipNote, clipNoteName } from "../lib/clipper";
import type { ClippedPage } from "../types";
import { Button, Input, Modal } from "../ui";

export function WebClipper({ onClose }: { onClose: () => void }) {
  const { setVaultNotes, selectNote, setNoteContent, setView } = useAetherStore();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clipped, setClipped] = useState<ClippedPage | null>(null);
  const [saved, setSaved] = useState(false);

  const handleClip = async () => {
    const trimmed = url.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setClipped(null);
    setSaved(false);
    try {
      const page = await clipUrl(trimmed);
      setClipped(page);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!clipped) return;
    setLoading(true);
    setError(null);
    try {
      const noteName = clipNoteName(clipped.title, new Date());
      const content = buildClipNote(clipped, new Date());
      const path = await createNote(`clips/${noteName}`, content);
      const notes = await getVaultNotes();
      setVaultNotes(notes);
      setSaved(true);
      // Offer to open the saved note
      selectNote(path);
      setNoteContent(content);
      setView("editor");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Web Clipper"
      description="Save any page as a clean Markdown note in your vault's clips/ folder."
      icon={Scissors}
      size="md"
      position="top"
      className="web-clipper-modal"
      footer={
        clipped &&
        (!saved ? (
          <Button variant="primary" onClick={() => void handleSave()} loading={loading}>
            Save to Vault
          </Button>
        ) : (
          <div className="web-clipper-saved">
            <Check size={14} />
            <span>Saved to vault and opened in editor</span>
          </div>
        ))
      }
    >
      <form
        className="web-clipper-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void handleClip();
        }}
      >
        <Input
          type="text"
          className="web-clipper-url-input"
          iconLeft={<Link2 size={14} />}
          placeholder="Paste a URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
          disabled={loading}
          spellCheck={false}
          aria-label="Page URL"
        />
        <Button type="submit" variant={clipped ? "secondary" : "primary"} disabled={!url.trim() || loading} loading={loading && !clipped}>
          Clip
        </Button>
      </form>
      {error && <div className="web-clipper-error ui-notice ui-notice-danger">{error}</div>}
      {clipped && (
        <div className="web-clipper-result">
          <div className="web-clipper-result-header">
            <FileText size={16} />
            <span className="web-clipper-result-title">{clipped.title}</span>
          </div>
          <div className="web-clipper-result-url">{clipped.url}</div>
          <div className="web-clipper-result-excerpt">{clipped.excerpt}</div>
        </div>
      )}
    </Modal>
  );
}
