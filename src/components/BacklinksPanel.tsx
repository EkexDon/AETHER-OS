import { Link2, FileText, X } from "lucide-react";
import type { Backlink } from "../types";

interface BacklinksPanelProps {
  backlinks: Backlink[];
  noteName: string;
  onSelect: (path: string) => void;
}

export function BacklinksPanel({ backlinks, noteName, onSelect }: BacklinksPanelProps) {
  return (
    <div className="backlinks-panel">
      <div className="backlinks-header">
        <Link2 size={14} />
        <span className="backlinks-title">
          Backlinks ({backlinks.length})
        </span>
        <span className="backlinks-note-name">{noteName}</span>
      </div>
      {backlinks.length === 0 ? (
        <div className="backlinks-empty">
          <p>No notes link to this note yet.</p>
          <p className="backlinks-hint">
            Use <code>{`[[${noteName}]]`}</code> in other notes to create a backlink.
          </p>
        </div>
      ) : (
        <div className="backlinks-list">
          {backlinks.map((bl, i) => (
            <div
              key={`${bl.note_path}-${bl.line}-${i}`}
              className="backlink-item"
              onClick={() => onSelect(bl.note_path)}
            >
              <div className="backlink-item-header">
                <FileText size={12} />
                <span className="backlink-item-name">{bl.note_name}</span>
                <span className="backlink-item-line">L{bl.line}</span>
              </div>
              <div className="backlink-item-context">{bl.context}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
