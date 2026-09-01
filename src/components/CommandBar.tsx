import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search, LayoutDashboard, GitBranch, Notebook, FolderGit2, Brain,
  FileText, ExternalLink, CornerDownLeft,
} from "lucide-react";
import { useAetherStore, type ViewMode } from "../lib/store";
import { openProject } from "../lib/ipc";

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandBar({ onClose }: { onClose: () => void }) {
  const { setView, projects, vaultNotes, selectNote } = useAetherStore();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands = useMemo<Command[]>(() => {
    const views: { mode: ViewMode; label: string; icon: React.ReactNode }[] = [
      { mode: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={14} /> },
      { mode: "projects", label: "Projects", icon: <FolderGit2 size={14} /> },
      { mode: "memory", label: "AI Memory", icon: <Brain size={14} /> },
      { mode: "search", label: "Semantic Search", icon: <Search size={14} /> },
      { mode: "graph", label: "Knowledge Graph", icon: <GitBranch size={14} /> },
      { mode: "notes", label: "AI Notes", icon: <Notebook size={14} /> },
    ];

    const viewCommands: Command[] = views.map((v) => ({
      id: `view:${v.mode}`,
      label: v.label,
      hint: "Go to view",
      icon: v.icon,
      run: () => {
        setView(v.mode);
        onClose();
      },
    }));

    const projectCommands: Command[] = projects.map((p) => ({
      id: `project:${p.path}`,
      label: p.name,
      hint: "Open in Cursor",
      icon: <ExternalLink size={14} />,
      run: () => {
        void openProject(p.path, "cursor").catch(() => openProject(p.path, "code"));
        onClose();
      },
    }));

    const noteCommands: Command[] = vaultNotes.map((n) => ({
      id: `note:${n.path}`,
      label: n.name,
      hint: "Open note",
      icon: <FileText size={14} />,
      run: () => {
        selectNote(n.path);
        setView("editor");
        onClose();
      },
    }));

    return [...viewCommands, ...projectCommands, ...noteCommands];
  }, [projects, vaultNotes, setView, selectNote, onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands.slice(0, 12);
    const q = query.toLowerCase();
    return commands
      .filter((c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
      .slice(0, 12);
  }, [commands, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[selected]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmdbar-overlay" onClick={onClose}>
      <div className="cmdbar" onClick={(e) => e.stopPropagation()}>
        <div className="cmdbar-input-row">
          <Search size={16} />
          <input
            ref={inputRef}
            type="text"
            className="cmdbar-input"
            placeholder="Search views, projects, notes..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="cmdbar-kbd">ESC</kbd>
        </div>

        <div className="cmdbar-results">
          {filtered.length === 0 ? (
            <div className="cmdbar-empty">No results</div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                className={`cmdbar-item${i === selected ? " cmdbar-item-active" : ""}`}
                onClick={() => c.run()}
                onMouseEnter={() => setSelected(i)}
              >
                <span className="cmdbar-item-icon">{c.icon}</span>
                <span className="cmdbar-item-label">{c.label}</span>
                <span className="cmdbar-item-hint">{c.hint}</span>
                {i === selected && <CornerDownLeft size={12} className="cmdbar-item-enter" />}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
