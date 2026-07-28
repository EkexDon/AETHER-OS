import React, { useEffect, useState, useMemo } from "react";
import {
  FolderGit2, Search, Plus, X, RefreshCw, ExternalLink, Terminal, FolderOpen,
  GitBranch, Circle, Clock, Code2,
} from "lucide-react";
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
    <div className="projects-view">
      <div className="projects-header">
        <div className="projects-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="projects-search-input"
          />
        </div>
        <button className="btn btn-icon" onClick={() => void rescan(dirs)} disabled={scanning} title="Rescan">
          <RefreshCw size={16} className={scanning ? "spin" : ""} />
        </button>
        <button className="btn btn-secondary" onClick={handleAddDir}>
          <Plus size={16} /> Add Folder
        </button>
      </div>

      {dirs.length > 0 && (
        <div className="projects-dirs">
          {dirs.map((d) => (
            <span key={d} className="projects-dir-chip">
              <FolderOpen size={10} />
              {d.replace(/^\/Users\/[^/]+/, "~")}
              <button className="dir-chip-remove" onClick={() => void handleRemoveDir(d)}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <div className="projects-error">{error}</div>}

      {dirs.length === 0 ? (
        <div className="projects-empty">
          <FolderGit2 size={48} className="dashboard-empty-icon" />
          <p>Add a folder to scan for your projects</p>
          <button className="btn btn-primary" onClick={handleAddDir}>
            <Plus size={16} /> Add Folder
          </button>
        </div>
      ) : filtered.length === 0 && !scanning ? (
        <div className="projects-empty">
          <p>{projects.length === 0 ? "No projects found in these folders" : "No projects match your search"}</p>
        </div>
      ) : (
        <div className="projects-grid">
          {filtered.map((p) => (
            <div
              key={p.path}
              className="project-card"
              onClick={() => void handleOpen(p)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, project: p });
              }}
            >
              <div className="project-card-top">
                <span
                  className="project-lang-dot"
                  style={{ background: LANGUAGE_COLORS[p.language] ?? LANGUAGE_COLORS.unknown }}
                />
                <span className="project-name">{p.name}</span>
                <ExternalLink size={12} className="project-open-icon" />
              </div>
              <div className="project-meta">
                {p.git_branch && (
                  <span className="project-branch">
                    <GitBranch size={10} /> {p.git_branch}
                  </span>
                )}
                {p.git_status && (
                  <span className={`project-status ${p.git_status === "clean" ? "status-clean" : "status-dirty"}`}>
                    <Circle size={8} /> {p.git_status}
                  </span>
                )}
              </div>
              {p.last_commit_msg && (
                <div className="project-commit">
                  <Code2 size={10} />
                  <span className="project-commit-msg">{p.last_commit_msg}</span>
                </div>
              )}
              {p.last_commit_date && (
                <div className="project-time">
                  <Clock size={10} /> {timeAgo(p.last_commit_date)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {contextMenu && (
        <div className="project-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button onClick={() => void handleOpen(contextMenu.project)}>
            <ExternalLink size={12} /> Open in Cursor
          </button>
          <button onClick={() => void openInTerminal(contextMenu.project.path)}>
            <Terminal size={12} /> Open in Terminal
          </button>
          <button onClick={() => void openInFinder(contextMenu.project.path)}>
            <FolderOpen size={12} /> Open in Finder
          </button>
        </div>
      )}
    </div>
  );
}
