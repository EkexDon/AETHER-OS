import { useEffect, useRef, useState } from "react";
import { FolderKanban, Trash2 } from "lucide-react";
import { Button, Modal } from "../ui";
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
    <Modal
      open
      onClose={onClose}
      title={project ? "Edit project" : "New project"}
      icon={FolderKanban}
      size="sm"
      className="project-modal"
      footerStart={
        project && (
          <button
            type="button"
            className={`event-editor-delete${confirmingDelete ? " confirming" : ""}`}
            onClick={() => void handleDelete()}
            disabled={saving}
          >
            <Trash2 size={13} /> {confirmingDelete ? "Confirm delete" : "Delete"}
          </button>
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={!name.trim() || saving} loading={saving}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </>
      }
    >
        <div className="event-editor-body" onKeyDown={handleKeyDown}>
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
    </Modal>
  );
}
