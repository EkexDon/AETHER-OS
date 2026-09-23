import React, { useEffect, useState, useMemo } from "react";
import { FileText, ChevronRight, Folder, FolderOpen, FilePlus2 } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { countPins, usePinsStore } from "../lib/pinsStore";
import { EmptyState, IconButton, SearchField } from "../ui";
import { useShellStore } from "../shell/shellStore";
import { PinsPanel } from "./home/PinsPanel";

/** localStorage key of the collapsed state of the sidebar's "Pinned" section. */
export const SIDEBAR_PINS_COLLAPSED_KEY = "aether-sidebar-pins-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_PINS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_PINS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // storage unavailable — the state still applies for this session
  }
}

/**
 * Pins (notes, projects, commands, chats, links) above the note tree, under
 * a collapsible "Pinned" header whose state persists. Hidden without pins.
 */
export function SidebarPins() {
  const total = usePinsStore((s) => countPins(s.groups));
  const [collapsed, setCollapsed] = useState(readCollapsed);
  if (total === 0) return null;

  const toggle = () => {
    const next = !collapsed;
    writeCollapsed(next);
    setCollapsed(next);
  };

  return (
    <section className={`sidebar-pins${collapsed ? " is-collapsed" : ""}`} aria-label="Pinned">
      <div className="sidebar-header sidebar-pins-header">
        <button
          type="button"
          className="sidebar-section-toggle"
          aria-expanded={!collapsed}
          aria-controls="sidebar-pins-body"
          onClick={toggle}
        >
          <span className={`tree-chevron${collapsed ? "" : " is-open"}`} aria-hidden="true">
            <ChevronRight size={14} />
          </span>
          <span className="sidebar-title">
            Pinned
            <span className="sidebar-count">{total}</span>
          </span>
        </button>
      </div>
      {!collapsed && (
        <div className="sidebar-pins-body" id="sidebar-pins-body">
          <PinsPanel variant="compact" className="sidebar-pins-panel" />
        </div>
      )}
    </section>
  );
}

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

  // While filtering, every folder with a match is open (matches must not hide
  // in collapsed folders); folders closed during the search stay closed until
  // the query changes.
  const filtering = query.trim().length > 0;
  const [collapsedWhileFiltering, setCollapsedWhileFiltering] = useState<Set<string>>(new Set());
  useEffect(() => setCollapsedWhileFiltering(new Set()), [query]);
  const shownExpanded = useMemo(
    () => (filtering ? new Set(treeDirs(tree).filter((d) => !collapsedWhileFiltering.has(d))) : expanded),
    [filtering, tree, collapsedWhileFiltering, expanded]
  );

  // Reveal the open note (opened from the launcher, a link, a plugin…).
  useEffect(() => {
    if (!selectedNotePath) return;
    const dirs = ancestorDirs(selectedNotePath, vaultPath);
    if (dirs.length === 0) return;
    setExpanded((prev) => (dirs.every((d) => prev.has(d)) ? prev : new Set([...prev, ...dirs])));
  }, [selectedNotePath, vaultPath]);

  const handleSelect = (path: string) => {
    selectNote(path);
    setView("editor");
  };

  const toggle = (dir: string) => {
    const flip = (prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    };
    if (filtering) setCollapsedWhileFiltering(flip);
    else setExpanded(flip);
  };

  return (
    <aside className="vault-sidebar" style={{ width, minWidth: width }} aria-label="Vault">
      <SidebarPins />
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
          placeholder="Search notes…"
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
            expanded={shownExpanded}
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

/** Every folder path of a tree (depth first). */
export function treeDirs(nodes: TreeNodeData[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (!node.isDir) continue;
    out.push(node.path);
    out.push(...treeDirs(node.children));
  }
  return out;
}

/** Tree folder paths (`/01-Projects`, `/01-Projects/app`) that contain `notePath`. */
export function ancestorDirs(notePath: string, vaultRoot?: string | null): string[] {
  const prefix = vaultRoot ? vaultRoot.replace(/[\\/]+$/, "") + "/" : null;
  const rel = prefix && notePath.startsWith(prefix) ? notePath.slice(prefix.length) : null;
  if (!rel) return [];
  const parts = rel.split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"));
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
            <ChevronRight size={14} />
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
