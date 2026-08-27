import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Code2,
  FileCode,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Loader2,
  PanelBottomClose,
  PanelBottomOpen,
  Save,
  TerminalSquare,
  X,
} from "lucide-react";
import { useIdeStore, isDirty } from "../lib/ideStore";
import { useAetherStore } from "../lib/store";
import {
  getProjectDirs,
  ideReadFile,
  ideRoots,
  ideWriteFile,
  scanProjects,
} from "../lib/ipc";
import { CodeEditor } from "./CodeEditor";
import { IdeDiffView } from "./IdeDiffView";
import { IdeFileTree } from "./IdeFileTree";
import { IdeSourceControl } from "./IdeSourceControl";
import { Terminal } from "./Terminal";
import { connectLanguage, type LspStatus } from "../lib/lspMonaco";
import { setupMonaco } from "../lib/monaco";
import { usePanelDrag } from "../lib/usePanelDrag";
import type { Project } from "../types";

const TREE_WIDTH = 240;

export function IdeView() {
  const { rootPath, tabs, activePath, setRoot, openFile, closeFile, setActive, updateContent, markSaved, closeAll } =
    useIdeStore();
  const setView = useAetherStore((s) => s.setView);

  const [projects, setProjects] = useState<Project[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  // Once the terminal panel has been opened it stays mounted (hidden via
  // CSS when closed) so its PTY session and scrollback survive toggling.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const toggleTerminal = useCallback(() => {
    setShowTerminal((s) => {
      const next = !s;
      if (next) setTerminalMounted(true);
      return next;
    });
  }, []);
  const [saving, setSaving] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"files" | "git">("files");
  const [diff, setDiff] = useState<{ file: string; staged: boolean } | null>(null);
  const [lspStatuses, setLspStatuses] = useState<Record<string, LspStatus>>({});
  const [sidebarWidth, setSidebarWidth] = useState(TREE_WIDTH);
  const [terminalHeight, setTerminalHeight] = useState(220);

  const dragSidebar = usePanelDrag({
    axis: "x",
    storageKey: "ide-sidebar-width",
    defaultSize: TREE_WIDTH,
    min: 170,
    max: 480,
    onChange: setSidebarWidth,
  });
  const dragTerminal = usePanelDrag({
    axis: "y",
    storageKey: "ide-terminal-height",
    defaultSize: 220,
    min: 120,
    max: 720,
    // The terminal is anchored at the bottom edge: dragging the divider
    // UP must make the panel taller, so the pointer delta is negated.
    invert: true,
    onChange: setTerminalHeight,
  });

  const activeFile = tabs.find((t) => t.path === activePath) ?? null;

  // ── LSP sessions: one per language among the open tabs ──────
  useEffect(() => {
    if (!rootPath) return;
    const disposers = new Map<string, () => void>();
    let cancelled = false;
    const monaco = setupMonaco();

    const ensureLanguage = (languageId: string) => {
      if (disposers.has(languageId)) return;
      disposers.set(languageId, () => undefined); // reserve slot while connecting
      void connectLanguage({
        rootPath,
        languageId,
        monaco,
        onStatus: (status) => {
          if (!cancelled) {
            setLspStatuses((prev) => ({ ...prev, [languageId]: status }));
          }
        },
      }).then((dispose) => {
        disposers.set(languageId, dispose ?? (() => undefined));
        if (!cancelled && dispose) {
          setLspStatuses((prev) => ({ ...prev, [languageId]: "ready" }));
        }
      });
    };

    // Connect lazily as languages appear in tabs.
    for (const tab of useIdeStore.getState().tabs) {
      ensureLanguage(tab.language);
    }
    const unsubscribe = useIdeStore.subscribe((state) => {
      for (const tab of state.tabs) ensureLanguage(tab.language);
    });

    return () => {
      cancelled = true;
      unsubscribe();
      disposers.forEach((dispose) => dispose());
      disposers.clear();
    };
  }, [rootPath]);

  // Discover openable folders: the sandbox roots plus every project inside them.
  useEffect(() => {
    if (rootPath) return;
    let cancelled = false;
    setScanning(true);
    void (async () => {
      try {
        const [allowedRoots, dirs] = await Promise.all([ideRoots(), getProjectDirs()]);
        if (cancelled) return;
        setRoots(allowedRoots);
        if (dirs.length > 0) {
          const found = await scanProjects(dirs);
          if (!cancelled) setProjects(found);
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const handleOpenFile = useCallback(
    async (path: string) => {
      try {
        const content = await ideReadFile(path);
        openFile(path, content);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [openFile]
  );

  const handleSave = useCallback(async () => {
    const file = useIdeStore.getState().tabs.find((t) => t.path === useIdeStore.getState().activePath);
    if (!file || !isDirty(file)) return;
    setSaving(true);
    try {
      await ideWriteFile(file.path, file.content);
      markSaved(file.path);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [markSaved]);

  // Cmd/Ctrl+S also works when focus is outside the editor (tabs, tree).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  const handleCloseFolder = useCallback(() => {
    closeAll();
    setRoot(null);
  }, [closeAll, setRoot]);

  // After a git mutation (branch switch, discard, commit) reload open tabs
  // whose buffer has no unsaved edits, so they reflect the working tree.
  const handleGitChanged = useCallback(async () => {
    const { tabs, markSaved } = useIdeStore.getState();
    await Promise.all(
      tabs
        .filter((t) => t.content === t.savedContent)
        .map(async (t) => {
          try {
            const fresh = await ideReadFile(t.path);
            updateContent(t.path, fresh);
            markSaved(t.path);
          } catch {
            // File vanished (deleted in a commit/discard) — leave the tab.
          }
        })
    );
  }, [updateContent]);

  // ── Folder picker ────────────────────────────────────────────
  if (!rootPath) {
    const openable = [
      ...projects.map((p) => ({ name: p.name, path: p.path, language: p.language, branch: p.git_branch })),
      ...roots
        .filter((r) => !projects.some((p) => p.path === r))
        .map((r) => ({
          name: r.split("/").filter(Boolean).pop() ?? r,
          path: r,
          language: "folder",
          branch: null as string | null,
        })),
    ];

    return (
      <div className="ide-picker">
        <div className="ide-picker-inner">
          <Code2 size={40} className="ide-picker-icon" />
          <h2>Open a project</h2>
          <p className="ide-picker-sub">
            The editor can only reach your configured project directories and the vault.
          </p>

          {error && (
            <div className="ide-error">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          {scanning && (
            <div className="ide-picker-loading">
              <Loader2 size={16} className="spin" /> Scanning projects…
            </div>
          )}

          {!scanning && openable.length === 0 && (
            <div className="ide-picker-empty">
              <p>No project directories configured yet.</p>
              <button className="btn btn-primary" onClick={() => setView("projects")}>
                <FolderGit2 size={16} /> Add a directory
              </button>
            </div>
          )}

          <div className="ide-picker-list">
            {openable.map((item) => (
              <button key={item.path} className="ide-picker-item" onClick={() => setRoot(item.path)}>
                <FolderOpen size={16} className="ide-picker-item-icon" />
                <div className="ide-picker-item-text">
                  <span className="ide-picker-item-name">{item.name}</span>
                  <span className="ide-picker-item-path">{item.path}</span>
                </div>
                {item.branch && <span className="ide-picker-item-branch">{item.branch}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── IDE shell ────────────────────────────────────────────────
  return (
    <div className="ide-shell">
      <div className="ide-sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
        <div className="ide-sidebar-header">
          <div className="ide-sidebar-tabs">
            <button
              className={`ide-side-tab${sidebarTab === "files" ? " ide-side-tab-active" : ""}`}
              onClick={() => setSidebarTab("files")}
              title="Files"
            >
              <FileCode size={13} /> Files
            </button>
            <button
              className={`ide-side-tab${sidebarTab === "git" ? " ide-side-tab-active" : ""}`}
              onClick={() => setSidebarTab("git")}
              title="Source control"
            >
              <GitBranch size={13} /> Git
            </button>
          </div>
          {sidebarTab === "files" && (
            <button className="btn btn-icon" onClick={handleCloseFolder} title="Close folder">
              <X size={13} />
            </button>
          )}
        </div>
        {sidebarTab === "files" ? (
          <IdeFileTree rootPath={rootPath} activePath={activePath} onOpenFile={handleOpenFile} />
        ) : (
          <IdeSourceControl
            rootPath={rootPath}
            onOpenDiff={(file, staged) => setDiff({ file, staged })}
            onChanged={handleGitChanged}
          />
        )}
      </div>

      <div
        className="ide-resizer"
        onMouseDown={dragSidebar}
        onDoubleClick={() => setSidebarWidth(TREE_WIDTH)}
        title="Drag to resize · double-click to reset"
      />

      <div className="ide-main">
        <div className="ide-tabbar">
          <div className="ide-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.path}
                className={`ide-tab${activePath === tab.path ? " ide-tab-active" : ""}`}
                onClick={() => setActive(tab.path)}
                title={tab.path}
              >
                <span className="ide-tab-name">{tab.name}</span>
                {isDirty(tab) && <span className="ide-tab-dirty">●</span>}
                <button
                  className="ide-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeFile(tab.path);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          <div className="ide-tabbar-actions">
            {Object.entries(lspStatuses)
              .filter(([, status]) => status === "starting" || status === "error")
              .map(([language, status]) => (
                <span
                  key={language}
                  className={`ide-lsp-chip${status === "error" ? " ide-lsp-chip-error" : ""}`}
                  title={
                    status === "starting"
                      ? `${language} language server starting…`
                      : `${language} language server crashed`
                  }
                >
                  {status === "starting" ? <Loader2 size={11} className="spin" /> : "⚠"} {language}
                </span>
              ))}
            {saving && <Loader2 size={13} className="spin" />}
            <button
              className="btn btn-icon"
              onClick={() => void handleSave()}
              disabled={!activeFile || !isDirty(activeFile)}
              title="Save (Cmd+S)"
            >
              <Save size={14} />
            </button>
            <button
              className={`btn btn-icon${showTerminal ? " btn-active" : ""}`}
              onClick={toggleTerminal}
              title="Toggle terminal"
            >
              {showTerminal ? <PanelBottomClose size={14} /> : <PanelBottomOpen size={14} />}
            </button>
          </div>
        </div>

        {error && (
          <div className="ide-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div className="ide-editor-area">
          {activeFile ? (
            <CodeEditor
              path={activeFile.path}
              value={activeFile.content}
              language={activeFile.language}
              onChange={(content) => updateContent(activeFile.path, content)}
              onSave={() => void handleSave()}
            />
          ) : (
            <div className="ide-no-file">
              <Code2 size={32} />
              <p>Select a file from the tree to start editing.</p>
            </div>
          )}
          {diff && (
            <IdeDiffView
              rootPath={rootPath}
              file={diff.file}
              staged={diff.staged}
              onClose={() => setDiff(null)}
            />
          )}
        </div>

        {terminalMounted && (
          <div
            className={`ide-terminal-panel${showTerminal ? "" : " ide-terminal-panel-hidden"}`}
            style={showTerminal ? { height: terminalHeight } : undefined}
          >
            <div
              className="ide-terminal-header"
              onMouseDown={dragTerminal}
              onDoubleClick={() => setTerminalHeight(220)}
              title="Drag to resize terminal · double-click to reset"
            >
              <span className="ide-terminal-header-title">
                <TerminalSquare size={12} /> Terminal
              </span>
              <button
                className="btn btn-icon"
                onClick={() => setShowTerminal(false)}
                title="Close terminal panel (session stays alive)"
              >
                <PanelBottomClose size={13} />
              </button>
            </div>
            <div className="ide-terminal-body">
              <Terminal defaultCwd={rootPath} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
