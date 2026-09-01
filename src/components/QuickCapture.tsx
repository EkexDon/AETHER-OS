import { useState, useEffect, useRef } from "react";
import { Zap, X, Loader2 } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { appendDaily } from "../lib/ipc";

export function QuickCapture() {
  const { showQuickCapture, setShowQuickCapture, selectNote, setView } = useAetherStore();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showQuickCapture) {
      setText("");
      setError(null);
      setSavedPath(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [showQuickCapture]);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const path = await appendDaily(trimmed);
      setSavedPath(path);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenDaily = () => {
    if (!savedPath) return;
    selectNote(savedPath);
    setView("editor");
    setShowQuickCapture(false);
  };

  if (!showQuickCapture) return null;

  return (
    <div className="quick-capture-overlay" onClick={() => setShowQuickCapture(false)}>
      <div className="quick-capture-modal" onClick={(e) => e.stopPropagation()}>
        <div className="quick-capture-header">
          <Zap size={18} />
          <span>Quick Capture</span>
          <span className="quick-capture-hint">→ Today's Daily Note</span>
          <button className="btn btn-icon" onClick={() => setShowQuickCapture(false)}>
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          type="text"
          className="quick-capture-input"
          placeholder="Capture a thought…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
            if (e.key === "Escape") {
              setShowQuickCapture(false);
            }
          }}
          disabled={saving}
        />
        {error && <div className="quick-capture-error">{error}</div>}
        {savedPath && (
          <div className="quick-capture-success">
            <span>Saved to daily note ✓</span>
            <button className="btn btn-ghost btn-sm" onClick={handleOpenDaily}>
              Open note
            </button>
          </div>
        )}
        <div className="quick-capture-footer">
          <span className="quick-capture-shortcut">Enter to save · Esc to close</span>
          {saving && <Loader2 size={14} className="spin" />}
        </div>
      </div>
    </div>
  );
}
