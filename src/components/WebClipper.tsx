import { useState } from "react";
import { Globe, Loader2, X, FileText, Check } from "lucide-react";
import { clipUrl, createNote, getVaultNotes } from "../lib/ipc";
import { useAetherStore } from "../lib/store";
import { buildClipNote, clipNoteName } from "../lib/clipper";
import type { ClippedPage } from "../types";

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
    <div className="web-clipper-overlay" onClick={onClose}>
      <div className="web-clipper-modal" onClick={(e) => e.stopPropagation()}>
        <div className="web-clipper-header">
          <Globe size={18} />
          <span>Web Clipper</span>
          <button className="btn btn-icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="web-clipper-input-row">
          <input
            type="text"
            className="web-clipper-url-input"
            placeholder="Paste a URL…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleClip()}
            autoFocus
            disabled={loading}
          />
          <button
            className="btn btn-primary"
            onClick={handleClip}
            disabled={!url.trim() || loading}
          >
            {loading ? <Loader2 size={16} className="spin" /> : "Clip"}
          </button>
        </div>
        {error && <div className="web-clipper-error">{error}</div>}
        {clipped && (
          <div className="web-clipper-result">
            <div className="web-clipper-result-header">
              <FileText size={16} />
              <span className="web-clipper-result-title">{clipped.title}</span>
            </div>
            <div className="web-clipper-result-url">{clipped.url}</div>
            <div className="web-clipper-result-excerpt">{clipped.excerpt}</div>
            {!saved ? (
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={loading}
              >
                Save to Vault
              </button>
            ) : (
              <div className="web-clipper-saved">
                <Check size={16} />
                <span>Saved to vault and opened in editor</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
