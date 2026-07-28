import React, { useEffect, useState } from "react";
import { FileText, Trash2, Clock } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getAetherNotes, deleteAetherNote } from "../lib/ipc";

export function AetherNotes() {
  const { aetherNotes, setAetherNotes } = useAetherStore();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void getAetherNotes().then(setAetherNotes).catch(console.error);
  }, [setAetherNotes]);

  const handleDelete = async (id: string) => {
    try {
      await deleteAetherNote(id);
      const notes = await getAetherNotes();
      setAetherNotes(notes);
      if (selected === id) setSelected(null);
    } catch (e) {
      console.error("Delete failed:", e);
    }
  };

  const selectedNote = aetherNotes.find((n) => n.id === selected);

  return (
    <div className="aether-notes">
      <div className="notes-list">
        <div className="notes-list-header">
          <span>AI Notes</span>
          <span className="notes-count">{aetherNotes.length}</span>
        </div>
        {aetherNotes.length === 0 && (
          <div className="notes-empty">
            <FileText size={32} />
            <p>No AI notes yet. Save agent responses to create notes.</p>
          </div>
        )}
        {aetherNotes.map((note) => (
          <div
            key={note.id}
            className={`note-item${selected === note.id ? " note-selected" : ""}`}
            onClick={() => setSelected(note.id)}
          >
            <div className="note-item-title">{note.title}</div>
            <div className="note-item-meta">
              <Clock size={10} />
              {new Date(note.created_at).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>

      {selectedNote && (
        <div className="note-detail">
          <div className="note-detail-header">
            <span>{selectedNote.title}</span>
            <button className="btn btn-icon" onClick={() => handleDelete(selectedNote.id)}>
              <Trash2 size={14} />
            </button>
          </div>
          {selectedNote.source_query && (
            <div className="note-source">Query: {selectedNote.source_query}</div>
          )}
          {selectedNote.related_notes.length > 0 && (
            <div className="note-related">
              {selectedNote.related_notes.map((p) => (
                <span key={p} className="related-chip">
                  {p.split("/").pop()?.replace(/\.md$/, "")}
                </span>
              ))}
            </div>
          )}
          <pre className="note-content">{selectedNote.content}</pre>
        </div>
      )}
    </div>
  );
}
