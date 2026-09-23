import React, { useState, useMemo } from "react";
import { FileText, ChevronRight, Folder, FolderOpen, FilePlus2 } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { EmptyState, IconButton, SearchField } from "../ui";
import { useShellStore } from "../shell/shellStore";

export function VaultSidebar({ width = 240 }: { width?: number }) {
  const { vaultNotes, selectedNotePath, selectNote, setView, vaultPath } = useAetherStore();
  const openNewNote = useShellStore((s) => s.setNewNoteOpen);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!query.trim()) return vaultNotes;
    const q = query.toLowerCase();
    return vaultNotes.filter((n) => n.name.toLowerCase().includes(q));
  }, [vaultNotes, query]);

  const tree = useMemo(() => buildTree(filtered, vaultPath), [filtered, vaultPath]);

  const handleSelect = (path: string) => {
    selectNote(path);
    setView("editor");
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
    <aside className="vault-sidebar" style={{ width, minWidth: width }} aria-label="Vault">
      <div className="sidebar-header">
        <span className="sidebar-title">
          Vault
          <span className="sidebar-count">{vaultNotes.length}</span>
        </span>
        <span className="sidebar-header-actions">
          <IconButton
            label="New note"
            shortcut="mod+n"
            size="sm"
            icon={<FilePlus2 size={14} />}
            onClick={() => openNewNote(true)}
          />
        </span>
      </div>
      <div className="sidebar-search">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search notes..."
          size="sm"
          className="sidebar-search-input"
        />
      </div>
      <div className="sidebar-tree" role="tree" aria-label="Notes">
        {tree.length === 0 && (
          <EmptyState
            size="sm"
            icon={FileText}
            title="No notes found"
            description={query.trim() ? "Try a different name." : "Create a note or connect a vault in Settings."}
            className="sidebar-empty"
          />
        )}
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

export interface TreeNodeData {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNodeData[];
}

/**
 * Build the folder tree. Paths are shown relative to the vault root, so the
 * tree starts at the vault's own folders instead of `/Users/...`.
 */
export function buildTree(notes: { path: string; name: string }[], vaultRoot?: string | null): TreeNodeData[] {
  const root: TreeNodeData[] = [];
  const prefix = vaultRoot ? vaultRoot.replace(/[\\/]+$/, "") + "/" : null;
  for (const note of notes) {
    const rel = prefix && note.path.startsWith(prefix) ? note.path.slice(prefix.length) : note.path;
    const parts = rel.split("/").filter(Boolean);
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
  return sortTree(root);
}

/** Folders first, then notes; each alphabetically (natural number order). */
function sortTree(nodes: TreeNodeData[]): TreeNodeData[] {
  nodes.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
  for (const n of nodes) if (n.children.length > 0) sortTree(n.children);
  return nodes;
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (node.isDir) onToggle(node.path);
      else onSelect(node.path);
    } else if (node.isDir && e.key === "ArrowRight" && !isExpanded) {
      e.preventDefault();
      onToggle(node.path);
    } else if (node.isDir && e.key === "ArrowLeft" && isExpanded) {
      e.preventDefault();
      onToggle(node.path);
    }
  };

  if (node.isDir) {
    return (
      <div className="tree-node" role="none">
        <div
          className="tree-row tree-dir"
          role="treeitem"
          aria-expanded={isExpanded}
          tabIndex={0}
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => onToggle(node.path)}
          onKeyDown={onKeyDown}
        >
          <span className={`tree-chevron${isExpanded ? " is-open" : ""}`}>
            <ChevronRight size={13} />
          </span>
          {isExpanded ? (
            <FolderOpen size={14} className="tree-folder-icon" />
          ) : (
            <Folder size={14} className="tree-folder-icon" />
          )}
          <span>{node.name}</span>
        </div>
        {isExpanded && (
          <div role="group">
            {node.children.map((child) => (
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
        )}
      </div>
    );
  }

  return (
    <div
      className={`tree-row tree-file${isSelected ? " tree-selected" : ""}`}
      role="treeitem"
      aria-selected={isSelected}
      tabIndex={0}
      style={{ paddingLeft: depth * 14 + 25 }}
      onClick={() => onSelect(node.path)}
      onKeyDown={onKeyDown}
      title={node.path}
    >
      <FileText size={14} className="tree-file-icon" />
      <span>{node.name}</span>
    </div>
  );
}
