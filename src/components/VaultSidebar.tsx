import React, { useState, useMemo } from "react";
import { FileText, Search, ChevronRight, ChevronDown } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getNoteContent } from "../lib/ipc";

export function VaultSidebar({ width = 240 }: { width?: number }) {
  const { vaultNotes, selectedNotePath, selectNote, setNoteContent, setView } = useAetherStore();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!query.trim()) return vaultNotes;
    const q = query.toLowerCase();
    return vaultNotes.filter((n) => n.name.toLowerCase().includes(q));
  }, [vaultNotes, query]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const handleSelect = async (path: string) => {
    selectNote(path);
    setView("editor");
    try {
      const content = await getNoteContent(path);
      setNoteContent(content);
    } catch {
      setNoteContent(null);
    }
  };

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  return (
    <aside className="vault-sidebar" style={{ width, minWidth: width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">Vault</span>
        <span className="sidebar-count">{vaultNotes.length}</span>
      </div>
      <div className="sidebar-search">
        <Search size={14} className="sidebar-search-icon" />
        <input
          type="text"
          placeholder="Search notes..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="sidebar-search-input"
        />
      </div>
      <div className="sidebar-tree">
        {tree.length === 0 && <div className="sidebar-empty">No notes found</div>}
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            onSelect={handleSelect}
            selectedPath={selectedNotePath}
          />
        ))}
      </div>
    </aside>
  );
}

interface TreeNodeData {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNodeData[];
}

function buildTree(notes: { path: string; name: string }[]): TreeNodeData[] {
  const root: TreeNodeData[] = [];
  for (const note of notes) {
    const parts = note.path.split("/").filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const existing = current.find((c) => c.name === part);
      if (existing) {
        current = existing.children;
      } else {
        const node: TreeNodeData = {
          name: isLast ? part.replace(/\.md$/i, "") : part,
          path: isLast ? note.path : "/" + parts.slice(0, i + 1).join("/"),
          isDir: !isLast,
          children: [],
        };
        current.push(node);
        current = node.children;
      }
    }
  }
  return root;
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  onSelect,
  selectedPath,
}: {
  node: TreeNodeData;
  depth: number;
  expanded: Set<string>;
  onToggle: (dir: string) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selectedPath === node.path;

  if (node.isDir) {
    return (
      <div className="tree-node">
        <div
          className="tree-row tree-dir"
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => onToggle(node.path)}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{node.name}</span>
        </div>
        {isExpanded &&
          node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              selectedPath={selectedPath}
            />
          ))}
      </div>
    );
  }

  return (
    <div
      className={`tree-row tree-file${isSelected ? " tree-selected" : ""}`}
      style={{ paddingLeft: depth * 16 + 24 }}
      onClick={() => onSelect(node.path)}
    >
      <FileText size={13} className="tree-file-icon" />
      <span>{node.name}</span>
    </div>
  );
}
