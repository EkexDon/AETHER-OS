import { useEffect, useState } from "react";
import { Trash2, Sparkles, MousePointerClick, MessageSquareQuote } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getAetherNotes, deleteAetherNote } from "../lib/ipc";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { Badge, EmptyState, IconButton, ListRow, ViewHeader } from "../ui";

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
    <div className="view aether-notes-view">
      <ViewHeader
        title="AI Notes"
        subtitle={`${aetherNotes.length} saved agent answer${aetherNotes.length === 1 ? "" : "s"}`}
      />
      <div className="view-body aether-notes">
        <div className="notes-list" role="list" aria-label="AI notes">
          {aetherNotes.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              size="sm"
              title="No AI notes yet"
              description="Save an agent answer with the save button in the agent panel to keep it here."
            />
          ) : (
            aetherNotes.map((note) => (
              <ListRow
                key={note.id}
                role="listitem"
                className="note-item"
                title={note.title}
                description={new Date(note.created_at).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
                selected={selected === note.id}
                onClick={() => setSelected(note.id)}
              />
            ))
          )}
        </div>

        <section className="note-detail" aria-live="polite">
          {selectedNote ? (
            <>
              <header className="note-detail-header">
                <h2 className="note-detail-title">{selectedNote.title}</h2>
                <IconButton
                  label="Delete note"
                  variant="danger"
                  icon={<Trash2 size={15} />}
                  onClick={() => void handleDelete(selectedNote.id)}
                />
              </header>
              {selectedNote.source_query && (
                <div className="note-source">
                  <MessageSquareQuote size={13} />
                  <span>{selectedNote.source_query}</span>
                </div>
              )}
              {selectedNote.related_notes.length > 0 && (
                <div className="note-related">
                  {selectedNote.related_notes.map((p) => (
                    <Badge key={p} className="related-chip">
                      {p.split("/").pop()?.replace(/\.md$/, "")}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="note-content">
                <MarkdownRenderer content={selectedNote.content} />
              </div>
            </>
          ) : (
            aetherNotes.length > 0 && (
              <EmptyState
                icon={MousePointerClick}
                title="Select a note"
                description="Pick a saved answer on the left to read it here."
              />
            )
          )}
        </section>
      </div>
    </div>
  );
}
