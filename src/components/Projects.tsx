import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import {
  FolderGit2, Plus, X, RefreshCw, ExternalLink, Terminal, FolderOpen,
  GitBranch, Clock, Code2,
} from "lucide-react";
import { Button, Card, EmptyState, IconButton, SearchField, ViewHeader, toast } from "../ui";
import { useAetherStore } from "../lib/store";
import { editorLabel } from "../lib/search/actions";
import { isMacPlatform } from "../lib/shortcuts";
import { useShellStore } from "../shell/shellStore";
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
};

/** Language dot color (data color); unknown languages use the neutral tertiary tone. */
function languageColor(language: string): string {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_COLORS, language) ? LANGUAGE_COLORS[language] : "var(--color-fg-tertiary)";
}

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

  const editorName = editorLabel(preferredEditor);

  /**
   * Open in the configured editor. When it cannot be started and it is not
   * VS Code already, fall back to VS Code and say so; if that fails too,
   * point to the editor setting.
   */
  const handleOpen = async (project: Project) => {
    const editor = preferredEditor.trim() || "code";
    const openSettings = { label: "Editor settings", onClick: () => useShellStore.getState().openSettings("editor") };
    try {
      await openProject(project.path, editor);
      return;
    } catch (first) {
      const reason = first instanceof Error ? first.message : String(first);
      if (editor !== "code") {
        try {
          await openProject(project.path, "code");
          toast.info(`Opened ${project.name} in VS Code`, {
            description: `${editorName} could not be started: ${reason}`,
            action: openSettings,
          });
          return;
        } catch {
          // Report the configured editor's error below; it is the one the user can fix.
        }
      }
      toast.error(`Could not open ${project.name} in ${editorName}`, { description: reason, action: openSettings });
    }
  };

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  // Keep the menu inside the window and move focus into it for keyboard use.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!contextMenu || !menu) {
      setMenuPos(null);
      return;
    }
    const rect = menu.getBoundingClientRect();
    setMenuPos({
      left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8)),
    });
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }, [contextMenu]);

  return (
    <div className="view projects-view">
      <ViewHeader
        title="Projects"
        subtitle={
          dirs.length === 0
            ? "Git repositories in your project folders"
            : `${projects.length} project${projects.length === 1 ? "" : "s"} in ${dirs.length} folder${dirs.length === 1 ? "" : "s"}`
        }
        actions={
          <>
            <SearchField
              size="sm"
              value={search}
              onChange={setSearch}
              placeholder="Search projects…"
              className="projects-search"
            />
            <IconButton
              label="Rescan folders"
              size="sm"
              icon={<RefreshCw size={14} className={scanning ? "spin" : ""} />}
              variant="secondary"
              onClick={() => void rescan(dirs)}
              disabled={scanning}
            />
            <Button variant="secondary" size="sm" iconLeft={<Plus size={14} />} onClick={() => void handleAddDir()}>
              Add folder
            </Button>
          </>
        }
      />
      <div className="view-body">
        {dirs.length > 0 && (
          <div className="projects-dirs">
            {dirs.map((d) => (
              <span key={d} className="projects-dir-chip" title={d}>
                <FolderOpen size={14} />
                <span className="projects-dir-path">{d.replace(/^\/Users\/[^/]+/, "~")}</span>
                <button
                  type="button"
                  className="dir-chip-remove"
                  onClick={() => void handleRemoveDir(d)}
                  aria-label={`Remove ${d}`}
                >
                  <X size={14} />
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
                Add folder
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
                title={`${p.path}\nClick to open in ${editorName} · right-click for more`}
              >
                <div className="project-card-top">
                  <span
                    className="project-lang-dot"
                    style={{ background: languageColor(p.language) }}
                    title={p.language}
                  />
                  <span className="project-name">{p.name}</span>
                  <ExternalLink size={14} className="project-open-icon" />
                </div>
                <div className="project-meta">
                  {p.git_branch && (
                    <span className="project-branch">
                      <GitBranch size={14} /> {p.git_branch}
                    </span>
                  )}
                  {p.git_status && (
                    <span className={`project-status ${p.git_status === "clean" ? "status-clean" : "status-dirty"}`}>
                      <span className="project-status-dot" aria-hidden="true" /> {p.git_status}
                    </span>
                  )}
                </div>
                {p.last_commit_msg && (
                  <div className="project-commit">
                    <Code2 size={14} />
                    <span className="project-commit-msg">{p.last_commit_msg}</span>
                  </div>
                )}
                {p.last_commit_date && (
                  <div className="project-time">
                    <Clock size={14} /> {timeAgo(p.last_commit_date)}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu project-context-menu"
          style={{
            left: menuPos?.left ?? contextMenu.x,
            top: menuPos?.top ?? contextMenu.y,
            visibility: menuPos ? "visible" : "hidden",
          }}
          role="menu"
          aria-label={`${contextMenu.project.name} actions`}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
          }}
        >
          <button type="button" role="menuitem" className="ui-menu-item" onClick={() => void handleOpen(contextMenu.project)}>
            <ExternalLink size={14} /> Open in {editorName}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ui-menu-item"
            onClick={() =>
              openInTerminal(contextMenu.project.path).catch((e) =>
                toast.error("Could not open a terminal", { description: e instanceof Error ? e.message : String(e) })
              )
            }
          >
            <Terminal size={14} /> Open in Terminal
          </button>
          <button
            type="button"
            role="menuitem"
            className="ui-menu-item"
            onClick={() =>
              openInFinder(contextMenu.project.path).catch((e) =>
                toast.error("Could not open the folder", { description: e instanceof Error ? e.message : String(e) })
              )
            }
          >
            <FolderOpen size={14} /> {isMacPlatform() ? "Open in Finder" : "Open folder"}
          </button>
        </div>
      )}
    </div>
  );
}
