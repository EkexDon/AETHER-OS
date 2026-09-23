import { useEffect, useState, useMemo } from "react";
import {
  FolderGit2, Plus, X, RefreshCw, ExternalLink, Terminal, FolderOpen,
  GitBranch, Circle, Clock, Code2,
} from "lucide-react";
import { Button, Card, EmptyState, IconButton, SearchField, ViewHeader } from "../ui";
import { useAetherStore } from "../lib/store";
import {
  scanProjects, openProject, openInTerminal, openInFinder,
  getProjectDirs, addProjectDir, removeProjectDir,
} from "../lib/ipc";
import { open } from "@tauri-apps/plugin-dialog";
import type { Project } from "../types";

const LANGUAGE_COLORS: Record<string, string> = {
  rust: "#dea584",
  typescript: "#3178c6",
  javascript: "#f7df1e",
  python: "#3572A5",
  go: "#00ADD8",
  unknown: "#6b7280",
};

function timeAgo(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}

export function Projects() {
  const { projects, setProjects, preferredEditor } = useAetherStore();
  const [dirs, setDirs] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; project: Project } | null>(null);

  useEffect(() => {
    void getProjectDirs().then(setDirs).catch(() => {});
  }, []);

  const rescan = async (directories: string[]) => {
    if (directories.length === 0) return;
    setScanning(true);
    setError(null);
    try {
      const found = await scanProjects(directories);
      setProjects(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (dirs.length > 0) {
      void rescan(dirs);
    }
  }, [dirs]);

  const handleAddDir = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        const updated = await addProjectDir(selected);
        setDirs(updated);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveDir = async (dir: string) => {
    try {
      const updated = await removeProjectDir(dir);
      setDirs(updated);
      if (updated.length === 0) setProjects([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.language.toLowerCase().includes(q) ||
        (p.git_branch ?? "").toLowerCase().includes(q)
    );
  }, [projects, search]);

  const handleOpen = async (project: Project) => {
    try {
      await openProject(project.path, preferredEditor);
    } catch {
      try {
        await openProject(project.path, "code");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  return (
    <div className="view projects-view">
      <ViewHeader
        title="Projects"
        subtitle={
          dirs.length === 0
            ? "Git repositories on this machine"
            : `${projects.length} project${projects.length === 1 ? "" : "s"} in ${dirs.length} folder${dirs.length === 1 ? "" : "s"}`
        }
        actions={
          <>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search projects..."
              className="projects-search"
            />
            <IconButton
              label="Rescan"
              icon={<RefreshCw size={15} className={scanning ? "spin" : ""} />}
              variant="secondary"
              onClick={() => void rescan(dirs)}
              disabled={scanning}
            />
            <Button variant="secondary" iconLeft={<Plus size={14} />} onClick={() => void handleAddDir()}>
              Add Folder
            </Button>
          </>
        }
      />
      <div className="view-body">
        {dirs.length > 0 && (
          <div className="projects-dirs">
            {dirs.map((d) => (
              <span key={d} className="projects-dir-chip" title={d}>
                <FolderOpen size={12} />
                <span className="projects-dir-path">{d.replace(/^\/Users\/[^/]+/, "~")}</span>
                <button
                  type="button"
                  className="dir-chip-remove"
                  onClick={() => void handleRemoveDir(d)}
                  aria-label={`Remove ${d}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {error && <div className="projects-error">{error}</div>}

        {dirs.length === 0 ? (
          <EmptyState
            icon={FolderGit2}
            title="Add a folder to scan for your projects"
            description="AETHER-OS finds every Git repository inside and shows branch, changes and the last commit."
            action={
              <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => void handleAddDir()}>
                Add Folder
              </Button>
            }
          />
        ) : filtered.length === 0 && !scanning ? (
          <EmptyState
            icon={FolderGit2}
            size="sm"
            title={projects.length === 0 ? "No projects found in these folders" : "No projects match your search"}
          />
        ) : (
          <div className="projects-grid">
            {filtered.map((p) => (
              <Card
                key={p.path}
                interactive
                padding="none"
                className="project-card"
                onClick={() => void handleOpen(p)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, project: p });
                }}
                title={p.path}
              >
                <div className="project-card-top">
                  <span
                    className="project-lang-dot"
                    style={{ background: LANGUAGE_COLORS[p.language] ?? LANGUAGE_COLORS.unknown }}
                    title={p.language}
                  />
                  <span className="project-name">{p.name}</span>
                  <ExternalLink size={13} className="project-open-icon" />
                </div>
                <div className="project-meta">
                  {p.git_branch && (
                    <span className="project-branch">
                      <GitBranch size={11} /> {p.git_branch}
                    </span>
                  )}
                  {p.git_status && (
                    <span className={`project-status ${p.git_status === "clean" ? "status-clean" : "status-dirty"}`}>
                      <Circle size={7} fill="currentColor" /> {p.git_status}
                    </span>
                  )}
                </div>
                {p.last_commit_msg && (
                  <div className="project-commit">
                    <Code2 size={11} />
                    <span className="project-commit-msg">{p.last_commit_msg}</span>
                  </div>
                )}
                {p.last_commit_date && (
                  <div className="project-time">
                    <Clock size={11} /> {timeAgo(p.last_commit_date)}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="context-menu project-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void handleOpen(contextMenu.project)}>
            <ExternalLink size={14} /> Open in Cursor
          </button>
          <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void openInTerminal(contextMenu.project.path)}>
            <Terminal size={14} /> Open in Terminal
          </button>
          <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void openInFinder(contextMenu.project.path)}>
            <FolderOpen size={14} /> Open in Finder
          </button>
        </div>
      )}
    </div>
  );
}
