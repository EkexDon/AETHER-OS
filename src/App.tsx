import { useEffect, useState, useCallback } from "react";
import { LayoutDashboard, Search, GitBranch, Notebook, Settings, Bot, Wifi, WifiOff, FolderGit2, Brain } from "lucide-react";
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
import { getVaultPath, getVaultNotes, getVaultStats, getVaultGraph, getHealth } from "./lib/ipc";

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
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [chatWidth, setChatWidth] = useState(340);
  const [dragging, setDragging] = useState<null | "sidebar" | "chat">(null);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (dragging === "sidebar") {
        const w = Math.max(160, Math.min(480, e.clientX - 52));
        setSidebarWidth(w);
      } else if (dragging === "chat") {
        const w = Math.max(240, Math.min(600, window.innerWidth - e.clientX));
        setChatWidth(w);
      }
    };
    const onUp = () => {
      setDragging(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
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
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
    { mode: "projects", icon: <FolderGit2 size={18} />, label: "Projects" },
    { mode: "memory", icon: <Brain size={18} />, label: "Memory" },
    { mode: "search", icon: <Search size={18} />, label: "Search" },
    { mode: "graph", icon: <GitBranch size={18} />, label: "Graph" },
    { mode: "notes", icon: <Notebook size={18} />, label: "AI Notes" },
  ];

  return (
    <div className="app-shell">
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

      <VaultSidebar width={sidebarWidth} />

      <div className="resizer resizer-sidebar" onMouseDown={() => startDrag("sidebar")} />

      <main className="main-content">
        {view === "dashboard" && <Dashboard />}
        {view === "projects" && <Projects />}
        {view === "memory" && <MemoryPanel />}
        {view === "search" && <SemanticSearch />}
        {view === "graph" && <VaultGraph />}
        {view === "notes" && <AetherNotes />}
      </main>

      <div className="resizer resizer-chat" onMouseDown={() => startDrag("chat")} />

      <AgentChat width={chatWidth} />

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showCommandBar && <CommandBar onClose={() => setShowCommandBar(false)} />}
    </div>
  );
}
