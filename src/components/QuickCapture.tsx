import { useState, useEffect, useRef, type RefObject } from "react";
import { Zap, CheckCircle2 } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { appendDaily } from "../lib/ipc";
import { Button, Kbd, Modal, Spinner } from "../ui";

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
      // Keep capturing: focus returns to the field after each save.
      setTimeout(() => inputRef.current?.focus(), 0);
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
    <Modal
      open
      onClose={() => setShowQuickCapture(false)}
      size="md"
      position="top"
      hideCloseButton
      flush
      aria-label="Quick Capture"
      className="quick-capture-modal"
      initialFocusRef={inputRef as RefObject<HTMLElement>}
    >
      <div className="quick-capture-header">
        <span className="quick-capture-badge">
          <Zap size={14} />
          Quick Capture
        </span>
        <span className="quick-capture-hint">→ Today's Daily Note</span>
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
            e.preventDefault();
            setShowQuickCapture(false);
          }
        }}
        disabled={saving}
        aria-label="Thought to capture"
      />
      {error && <div className="quick-capture-error">{error}</div>}
      {savedPath && (
        <div className="quick-capture-success">
          <CheckCircle2 size={14} />
          <span>Saved to daily note ✓</span>
          <Button variant="ghost" size="sm" onClick={handleOpenDaily}>
            Open note
          </Button>
        </div>
      )}
      <div className="quick-capture-footer">
        <span className="quick-capture-shortcut">
          <Kbd>↵</Kbd> save
          <Kbd>Esc</Kbd> close
        </span>
        {saving && <Spinner size={14} label="Saving" />}
      </div>
    </Modal>
  );
}
