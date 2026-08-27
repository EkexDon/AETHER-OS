import { useEffect, useState, useCallback, useRef, lazy, Suspense } from "react";
import { LayoutDashboard, Search, GitBranch, Notebook, Settings, Bot, Wifi, WifiOff, FolderGit2, Brain, TerminalSquare, Activity, Globe, Edit3, Zap, Clipboard, Code2, Loader2 } from "lucide-react";
import { useAetherStore, type ViewMode } from "./lib/store";
import { VaultSidebar } from "./components/VaultSidebar";
import { Dashboard } from "./components/Dashboard";
import { AgentChat } from "./components/AgentChat";
import { SemanticSearch } from "./components/SemanticSearch";
import { VaultGraph } from "./components/VaultGraph";
import { AetherNotes } from "./components/AetherNotes";
import { Projects } from "./components/Projects";
import { MemoryPanel } from "./components/MemoryPanel";
import { CommandBar } from "./components/CommandBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { Terminal } from "./components/Terminal";
import { SystemMonitor } from "./components/SystemMonitor";
import { Browser } from "./components/Browser";
import { NoteEditor } from "./components/NoteEditor";
import { QuickCapture } from "./components/QuickCapture";
import { WebClipper } from "./components/WebClipper";
import { getVaultPath, getVaultNotes, getVaultStats, getVaultGraph, getHealth } from "./lib/ipc";

// Monaco is several megabytes, so the IDE is split into its own chunk and
// only fetched when the user actually opens that view.
const IdeView = lazy(() =>
  import("./components/IdeView").then((m) => ({ default: m.IdeView }))
);

export function App() {
  const {
    view,
    setView,
    setVaultPath,
    setVaultNotes,
    setVaultStats,
    setGraph,
    setHealth,
    health,
  } = useAetherStore();

  const [showSettings, setShowSettings] = useState(false);
  const [showCommandBar, setShowCommandBar] = useState(false);
  const [showWebClipper, setShowWebClipper] = useState(false);
  const { showQuickCapture, setShowQuickCapture, chatOpen, setChatOpen } = useAetherStore();
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = window.localStorage.getItem("aether-sidebar-width");
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? Math.max(160, Math.min(480, parsed)) : 240;
  });
  const [chatWidth, setChatWidth] = useState(() => {
    const raw = window.localStorage.getItem("aether-chat-width");
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? Math.max(240, Math.min(600, parsed)) : 340;
  });
  const [dragging, setDragging] = useState<null | "sidebar" | "chat">(null);
  const latestWidths = useRef({ sidebar: sidebarWidth, chat: chatWidth });
  latestWidths.current = { sidebar: sidebarWidth, chat: chatWidth };

  // Drag updates are coalesced into animation frames: one layout pass per
  // frame instead of one React render per mousemove event.
  useEffect(() => {
    if (!dragging) return;
    let frame: number | null = null;
    let nextSidebar: number | undefined;
    let nextChat: number | undefined;

    const apply = () => {
      frame = null;
      if (nextSidebar !== undefined) setSidebarWidth(nextSidebar);
      if (nextChat !== undefined) setChatWidth(nextChat);
    };

    const onMove = (e: MouseEvent) => {
      if (dragging === "sidebar") {
        nextSidebar = Math.max(160, Math.min(480, e.clientX - 52));
        nextChat = undefined;
      } else {
        nextChat = Math.max(240, Math.min(600, window.innerWidth - e.clientX));
        nextSidebar = undefined;
      }
      if (frame === null) frame = requestAnimationFrame(apply);
    };

    const onUp = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      setDragging(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.localStorage.setItem("aether-sidebar-width", String(latestWidths.current.sidebar));
      window.localStorage.setItem("aether-chat-width", String(latestWidths.current.chat));
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowCommandBar((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setShowQuickCapture(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        setShowWebClipper(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Save is handled by the editor's own Cmd+S handler
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setShowQuickCapture]);

  const startDrag = useCallback((which: "sidebar" | "chat") => {
    setDragging(which);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [path, notes, stats, graph, h] = await Promise.all([
          getVaultPath(),
          getVaultNotes(),
          getVaultStats(),
          getVaultGraph(),
          getHealth(),
        ]);
        if (path) setVaultPath(path);
        setVaultNotes(notes);
        setVaultStats(stats);
        setGraph(graph);
        setHealth(h);
      } catch (e) {
        console.error("Init failed:", e);
      }
    })();
  }, [setVaultPath, setVaultNotes, setVaultStats, setGraph, setHealth]);

  const navItems: { mode: ViewMode; icon: React.ReactNode; label: string }[] = [
    { mode: "dashboard", icon: <LayoutDashboard size={18} />, label: "Dashboard" },
    { mode: "editor", icon: <Edit3 size={18} />, label: "Editor" },
    { mode: "ide", icon: <Code2 size={18} />, label: "IDE" },
    { mode: "projects", icon: <FolderGit2 size={18} />, label: "Projects" },
    { mode: "memory", icon: <Brain size={18} />, label: "Memory" },
    { mode: "search", icon: <Search size={18} />, label: "Search" },
    { mode: "graph", icon: <GitBranch size={18} />, label: "Graph" },
    { mode: "notes", icon: <Notebook size={18} />, label: "AI Notes" },
    { mode: "terminal", icon: <TerminalSquare size={18} />, label: "Terminal" },
    { mode: "monitor", icon: <Activity size={18} />, label: "Monitor" },
    { mode: "browser", icon: <Globe size={18} />, label: "Browser" },
  ];

  return (
    <div className="app-shell">
      {/* macOS traffic lights sit over this strip; dragging it moves the window. */}
      <div className="titlebar" data-tauri-drag-region />
      <nav className="nav-rail">
        <div className="nav-logo">
          <Bot size={24} />
        </div>
        <div className="nav-items">
          {navItems.map((item) => (
            <button
              key={item.mode}
              className={`nav-item${view === item.mode ? " nav-active" : ""}`}
              onClick={() => setView(item.mode)}
              title={item.label}
            >
              {item.icon}
            </button>
          ))}
        </div>
        <div className="nav-bottom">
          <div className="nav-status">
            {health?.ollama_online ? (
              <Wifi size={16} className="status-online" />
            ) : (
              <WifiOff size={16} className="status-offline" />
            )}
          </div>
          <button
            className="nav-item"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </nav>

      {/* The IDE brings its own project tree, so the vault tree would only
          compete with it for space. */}
      {view !== "ide" && (
        <>
          <VaultSidebar width={sidebarWidth} />
          <div className="resizer resizer-sidebar" onMouseDown={() => startDrag("sidebar")} />
        </>
      )}

      <main className={`main-content${view === "browser" ? " browser-active" : ""}${view === "ide" ? " ide-active" : ""}`}>
        {view === "dashboard" && <Dashboard />}
        {view === "editor" && <NoteEditor />}
        {view === "projects" && <Projects />}
        {view === "memory" && <MemoryPanel />}
        {view === "search" && <SemanticSearch />}
        {view === "graph" && <VaultGraph />}
        {view === "notes" && <AetherNotes />}
        {view === "monitor" && <SystemMonitor />}
        {view === "browser" && <Browser />}
        {view === "ide" && (
          <Suspense
            fallback={
              <div className="ide-loading">
                <Loader2 size={20} className="spin" /> Loading editor…
              </div>
            }
          >
            <IdeView />
          </Suspense>
        )}
        {/* The terminal is hidden instead of unmounted on view switches:
            unmounting would destroy the xterm buffers, tab list and scrollback
            while the PTY sessions keep running in the backend (as orphans). */}
        <div className={`terminal-keepalive${view === "terminal" ? "" : " terminal-keepalive-hidden"}`}>
          <Terminal />
        </div>
      </main>

      {chatOpen && (
        <>
          <div className="resizer resizer-chat" onMouseDown={() => startDrag("chat")} />
          <AgentChat width={chatWidth} />
        </>
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showCommandBar && <CommandBar onClose={() => setShowCommandBar(false)} />}
      {showQuickCapture && <QuickCapture />}
      {showWebClipper && <WebClipper onClose={() => setShowWebClipper(false)} />}

      <div
        className="fab-stack"
        style={{ right: chatOpen ? chatWidth + 16 : 16 }}
      >
        <button
          className="floating-action-btn"
          onClick={() => setShowQuickCapture(true)}
          title="Quick Capture (Cmd+Shift+N)"
        >
          <Zap size={20} />
        </button>
        <button
          className="floating-action-btn floating-clip-btn"
          onClick={() => setShowWebClipper(true)}
          title="Web Clipper (Cmd+Shift+C)"
        >
          <Clipboard size={20} />
        </button>
        {!chatOpen && (
          <button
            className="floating-action-btn floating-agent-btn"
            onClick={() => setChatOpen(true)}
            title="Open AETHER Agent"
          >
            <Bot size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
