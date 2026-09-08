import { useEffect, useRef, useState } from "react";
import { X, FolderKanban, Trash2 } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { createTaskProject, updateTaskProject, deleteTaskProject } from "../lib/ipc";
import { CALENDAR_COLORS, DEFAULT_CALENDAR_COLOR } from "../lib/calendarColors";
import type { TaskProject } from "../types";

export function ProjectModal({
  project,
  onClose,
}: {
  project: TaskProject | null;
  onClose: () => void;
}) {
  const { upsertTaskProject, removeTaskProject, setSelectedProjectId, taskProjects } =
    useAetherStore();

  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [color, setColor] = useState(project?.color ?? DEFAULT_CALENDAR_COLOR);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    if (!confirmingDelete) return;
    const t = setTimeout(() => setConfirmingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmingDelete]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (project) {
        const updated = await updateTaskProject(project.id, {
          name: trimmed,
          description: description.trim(),
          color,
        });
        upsertTaskProject(updated);
      } else {
        const created = await createTaskProject({
          name: trimmed,
          description: description.trim(),
          color,
        });
        upsertTaskProject(created);
        setSelectedProjectId(created.id);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteTaskProject(project.id);
      removeTaskProject(project.id);
      const remaining = taskProjects.filter((p) => p.id !== project.id);
      setSelectedProjectId(remaining[0]?.id ?? null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="event-editor-overlay" onClick={onClose}>
      <div
        className="event-editor-modal"
        style={{ width: 440 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="event-editor-header">
          <FolderKanban size={15} style={{ color }} />
          <span>{project ? "Edit Project" : "New Project"}</span>
          <button className="btn btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="event-editor-body">
          <label className="event-editor-field">
            <span className="event-editor-field-label">Project Name</span>
            <input
              ref={nameRef}
              className="settings-input"
              type="text"
              placeholder="e.g. AETHER-OS, Roguelike Game"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>

          <label className="event-editor-field">
            <span className="event-editor-field-label">Description (optional)</span>
            <textarea
              className="settings-input"
              rows={3}
              placeholder="Project goals or notes"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="event-editor-field">
            <span className="event-editor-field-label">Color Theme</span>
            <div className="event-editor-color-row">
              {CALENDAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`calendar-color-swatch${c === color ? " selected" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>

          {error && <div className="calendar-dialog-status error">{error}</div>}
        </div>
        <div className="event-editor-footer">
          <div>
            {project && (
              <button
                type="button"
                className={`event-editor-delete${confirmingDelete ? " confirming" : ""}`}
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                <Trash2 size={12} /> {confirmingDelete ? "Confirm Delete" : "Delete"}
              </button>
            )}
          </div>
          <div className="event-editor-footer-right">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSave()}
              disabled={!name.trim() || saving}
            >
              {project ? "Save Changes" : "Create Project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
