import React from "react";
import { FileText, CheckSquare, Square, Layers, Tag, Link2, Database, MousePointerClick } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { indexVault } from "../lib/ipc";
import { formatShortcut } from "../lib/shortcuts";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { Button, Card, EmptyState, ViewHeader, toast } from "../ui";

function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Dashboard() {
  const { vaultStats, vaultNotes, selectedNotePath, noteContent, indexing, setIndexing, busy, setView } = useAetherStore();

  const handleIndex = async () => {
    setIndexing(true);
    try {
      const result = await indexVault();
      toast.success("Vault indexed", { description: `${result.indexed} of ${result.total} notes embedded.` });
    } catch (e) {
      console.error("Indexing failed:", e);
      toast.error("Indexing failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setIndexing(false);
    }
  };

  const activeNote = vaultNotes.find((n) => n.path === selectedNotePath);

  return (
    <div className="view dashboard">
      <ViewHeader
        title={greeting()}
        subtitle={`${vaultStats?.note_count ?? vaultNotes.length} notes in your vault`}
        actions={
          <Button
            variant="primary"
            iconLeft={<Database size={14} />}
            onClick={() => void handleIndex()}
            loading={indexing}
            disabled={busy}
          >
            {indexing ? "Indexing..." : "Index Vault for AI"}
          </Button>
        }
      />
      <div className="view-body">
        <div className="dashboard-stats">
          <StatCard icon={<FileText size={15} />} label="Notes" value={vaultStats?.note_count ?? 0} />
          <StatCard icon={<Square size={15} />} label="Open tasks" value={vaultStats?.open_tasks ?? 0} />
          <StatCard icon={<CheckSquare size={15} />} label="Total tasks" value={vaultStats?.total_tasks ?? 0} />
          <StatCard icon={<Layers size={15} />} label="Flashcards" value={vaultStats?.total_cards ?? 0} />
          <StatCard icon={<Tag size={15} />} label="Tags" value={vaultStats?.total_tags ?? 0} />
          <StatCard icon={<Link2 size={15} />} label="Wikilinks" value={vaultStats?.total_links ?? 0} />
        </div>

        {activeNote && noteContent !== null && (
          <Card padding="none" className="dashboard-note-preview">
            <div className="note-preview-header">
              <FileText size={14} />
              <span className="note-preview-title">{activeNote.name}</span>
              <Button variant="ghost" size="sm" onClick={() => setView("editor")}>
                Open in editor
              </Button>
            </div>
            <div className="note-preview-content">
              <MarkdownRenderer content={noteContent} />
            </div>
          </Card>
        )}

        {!activeNote && (
          <EmptyState
            icon={MousePointerClick}
            title="Select a note from the sidebar to preview"
            description={`Or press ${formatShortcut("mod+k")} to jump to any note, view or command.`}
            className="dashboard-empty"
          />
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="stat-card-top">
        <span className="stat-label">{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <span className="stat-value">{value.toLocaleString()}</span>
    </div>
  );
}
