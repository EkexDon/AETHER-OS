import { useEffect, useState, useCallback, useRef } from "react";
import { useAetherStore } from "./lib/store";
import { initTheme } from "./lib/theme";
import { initAppearance, useAppearanceStore } from "./lib/appearance";
import { getVaultPath, getVaultNotes, getVaultStats, getVaultGraph, getHealth } from "./lib/ipc";
import { getView } from "./views/registry";
import { VaultSidebar } from "./components/VaultSidebar";
import { AgentChat } from "./components/AgentChat";
import { Launcher } from "./components/launcher/Launcher";
import { SettingsPanel } from "./components/SettingsPanel";
import { QuickCapture } from "./components/QuickCapture";
import { WebClipper } from "./components/WebClipper";
import { Titlebar } from "./shell/Titlebar";
import { NavRail } from "./shell/NavRail";
import { StatusBar } from "./shell/StatusBar";
import { ViewHost } from "./shell/ViewHost";
import { ShortcutsOverlay } from "./shell/ShortcutsOverlay";
import { NewNoteDialog } from "./shell/NewNoteDialog";
import { useShellStore } from "./shell/shellStore";
import { useGlobalShortcuts } from "./shell/useGlobalShortcuts";
import { ShellErrorBoundary } from "./shell/ErrorBoundary";
import { ToastProvider, cx } from "./ui";

// Apply theme, accent and density before the first render.
initTheme();
initAppearance();

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;
const CHAT_MIN = 280;
const CHAT_MAX = 640;

function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  } catch {
    return fallback;
  }
}

export function App() {
  const { view, setVaultPath, setVaultNotes, setVaultStats, setGraph, setHealth, showQuickCapture, chatOpen } =
    useAetherStore();
  const railExpanded = useAppearanceStore((s) => s.railExpanded);
  const shell = useShellStore();

  const [sidebarWidth, setSidebarWidth] = useState(() => readWidth("aether-sidebar-width", 232, SIDEBAR_MIN, SIDEBAR_MAX));
  const [chatWidth, setChatWidth] = useState(() => readWidth("aether-chat-width", 320, CHAT_MIN, CHAT_MAX));
  const [dragging, setDragging] = useState<null | "sidebar" | "chat">(null);
  const latestWidths = useRef({ sidebar: sidebarWidth, chat: chatWidth });
  latestWidths.current = { sidebar: sidebarWidth, chat: chatWidth };

  useGlobalShortcuts();

  // Drag updates are coalesced into animation frames: one layout pass per
  // frame instead of one React render per mousemove event.
  useEffect(() => {
    if (!dragging) return;
    let frame: number | null = null;
    let nextSidebar: number | undefined;
    let nextChat: number | undefined;
    const railRight = document.querySelector(".nav-rail")?.getBoundingClientRect().right ?? 52;

    const apply = () => {
      frame = null;
      if (nextSidebar !== undefined) setSidebarWidth(nextSidebar);
      if (nextChat !== undefined) setChatWidth(nextChat);
    };

    const onMove = (e: MouseEvent) => {
      if (dragging === "sidebar") {
        nextSidebar = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, e.clientX - railRight));
        nextChat = undefined;
      } else {
        nextChat = Math.max(CHAT_MIN, Math.min(CHAT_MAX, window.innerWidth - e.clientX));
        nextSidebar = undefined;
      }
      if (frame === null) frame = requestAnimationFrame(apply);
    };

    const onUp = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      setDragging(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem("aether-sidebar-width", String(latestWidths.current.sidebar));
        window.localStorage.setItem("aether-chat-width", String(latestWidths.current.chat));
      } catch {
        // storage unavailable — widths still apply for this session
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

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

  const current = getView(view);
  const showSidebar = !current?.hidesVaultSidebar;

  return (
    <ToastProvider>
      <div className={cx("app-root", railExpanded && "is-rail-expanded", dragging && "is-resizing")}>
        <Titlebar />
        <div className="app-shell">
          <NavRail />

          {/* The IDE brings its own project tree, so the vault tree would only
              compete with it for space. */}
          {showSidebar && (
            <>
              <ShellErrorBoundary label="Vault sidebar">
                <VaultSidebar width={sidebarWidth} />
              </ShellErrorBoundary>
              <div
                className="resizer resizer-sidebar"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                onMouseDown={() => startDrag("sidebar")}
              />
            </>
          )}

          <main className="main-content" data-view={view}>
            <ViewHost view={view} />
          </main>

          {chatOpen && (
            <>
              <div
                className="resizer resizer-chat"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize agent panel"
                onMouseDown={() => startDrag("chat")}
              />
              <ShellErrorBoundary label="AI agent panel">
                <AgentChat width={chatWidth} />
              </ShellErrorBoundary>
            </>
          )}
        </div>
        <StatusBar />

        {shell.settingsOpen && (
          <SettingsPanel
            onClose={shell.closeSettings}
            initialSection={shell.settingsSection}
            onSectionChange={shell.setSettingsSection}
          />
        )}
        <Launcher open={shell.commandBarOpen} onClose={() => shell.setCommandBarOpen(false)} />
        {showQuickCapture && <QuickCapture />}
        {shell.webClipperOpen && <WebClipper onClose={() => shell.setWebClipperOpen(false)} />}
        <ShortcutsOverlay open={shell.shortcutsOpen} onClose={() => shell.setShortcutsOpen(false)} />
        <NewNoteDialog open={shell.newNoteOpen} onClose={() => shell.setNewNoteOpen(false)} />
      </div>
    </ToastProvider>
  );
}
