import React from "react";
import { FileText, CheckSquare, Square, Layers, Tag, Link2, Database } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { indexVault } from "../lib/ipc";
import { MarkdownRenderer } from "./MarkdownRenderer";

export function Dashboard() {
  const { vaultStats, vaultNotes, selectedNotePath, noteContent, indexing, setIndexing, busy } = useAetherStore();

  const handleIndex = async () => {
    setIndexing(true);
    try {
      await indexVault();
    } catch (e) {
      console.error("Indexing failed:", e);
    } finally {
      setIndexing(false);
    }
  };

  const activeNote = vaultNotes.find((n) => n.path === selectedNotePath);

  return (
    <div className="dashboard">
      <div className="dashboard-stats">
        <StatCard icon={<FileText size={20} />} label="Notes" value={vaultStats?.note_count ?? 0} />
        <StatCard icon={<Square size={20} />} label="Open Tasks" value={vaultStats?.open_tasks ?? 0} />
        <StatCard icon={<CheckSquare size={20} />} label="Total Tasks" value={vaultStats?.total_tasks ?? 0} />
        <StatCard icon={<Layers size={20} />} label="Flashcards" value={vaultStats?.total_cards ?? 0} />
        <StatCard icon={<Tag size={20} />} label="Tags" value={vaultStats?.total_tags ?? 0} />
        <StatCard icon={<Link2 size={20} />} label="Wikilinks" value={vaultStats?.total_links ?? 0} />
      </div>

      <div className="dashboard-actions">
        <button className="btn btn-primary" onClick={handleIndex} disabled={indexing || busy}>
          <Database size={16} />
          {indexing ? "Indexing..." : "Index Vault for AI"}
        </button>
      </div>

      {activeNote && noteContent !== null && (
        <div className="dashboard-note-preview">
          <div className="note-preview-header">
            <FileText size={16} />
            <span>{activeNote.name}</span>
          </div>
          <div className="note-preview-content">
            <MarkdownRenderer content={noteContent} />
          </div>
        </div>
      )}

      {!activeNote && (
        <div className="dashboard-empty">
          <FileText size={48} className="dashboard-empty-icon" />
          <p>Select a note from the sidebar to preview</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div className="stat-info">
        <span className="stat-value">{value}</span>
        <span className="stat-label">{label}</span>
      </div>
    </div>
  );
}
