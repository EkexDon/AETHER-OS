import { useEffect, useRef, useState, useCallback, memo } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Plus, X, TerminalSquare, RotateCcw } from "lucide-react";
import {
  terminalSpawn,
  terminalWrite,
  terminalResize,
  terminalKill,
  onTerminalOutput,
  isDesktopRuntime,
} from "../lib/ipc";
import { base64ToBytes } from "../lib/bytes";
import type { TerminalSession } from "../types";

const RESIZE_DEBOUNCE_MS = 120;

/**
 * A tab is identified by a stable `clientId` generated once on creation.
 * `clientId` is used for all React state/keys and never changes.
 */
interface Tab {
  clientId: string;
  sessionId: string | null;
  pending: boolean;
  title: string;
  cwd: string;
  shell: string;
}

function makeClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface TerminalProps {
  /** Directory new shells start in. Defaults to the backend's choice. */
  defaultCwd?: string;
}

interface TabPaneProps {
  tab: Tab;
  isActive: boolean;
  defaultCwd?: string;
  onSessionSpawned: (clientId: string, session: TerminalSession) => void;
  onRegisterTerm: (clientId: string, sessionId: string | null, term: XTerm, fitAddon: FitAddon) => void;
  onUnregisterTerm: (clientId: string) => void;
}

/**
 * An individual terminal pane. Each tab gets its own persistent XTerm instance
 * and container element that stays mounted across tab switches.
 */
const TerminalTabPane = memo(function TerminalTabPane({
  tab,
  isActive,
  defaultCwd,
  onSessionSpawned,
  onRegisterTerm,
  onUnregisterTerm,
}: TabPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(tab.sessionId);
  const resizeTimeoutRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const cwdRef = useRef(defaultCwd);

  sessionIdRef.current = tab.sessionId;
  cwdRef.current = defaultCwd;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#0a0a0c",
        foreground: "#e4e4e8",
        cursor: "#6b6bf5",
        selectionBackground: "rgba(107, 107, 245, 0.25)",
        black: "#0a0a0c",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e8",
        brightBlack: "#555560",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);
    xtermRef.current = term;
    fitRef.current = fitAddon;

    onRegisterTerm(tab.clientId, tab.sessionId, term, fitAddon);

    if (!isDesktopRuntime()) {
      term.writeln("\x1b[90mAETHER-OS Terminal\x1b[0m");
      term.writeln("\x1b[90mStart the desktop app to use the terminal: \x1b[1mnpm run app\x1b[0m");
      term.writeln("");
      return () => {
        onUnregisterTerm(tab.clientId);
        term.dispose();
      };
    }

    let cancelled = false;

    const bindSession = (sessionId: string) => {
      sessionIdRef.current = sessionId;
      onRegisterTerm(tab.clientId, sessionId, term, fitAddon);
      term.onData((data: string) => {
        void terminalWrite(sessionId, data);
      });
    };

    let spawnStarted = false;
    const trySpawn = () => {
      if (spawnStarted || cancelled || sessionIdRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      if (container.clientWidth < 10 || container.clientHeight < 10) return;

      try {
        fitAddon.fit();
      } catch {
        // Container may still be hidden or transitioning
      }

      const cols = term.cols >= 10 ? term.cols : 80;
      const rows = term.rows >= 4 ? term.rows : 24;

      spawnStarted = true;
      void terminalSpawn(cwdRef.current, undefined, cols, rows)
        .then((session: TerminalSession) => {
          if (cancelled) {
            void terminalKill(session.id).catch(() => undefined);
            return;
          }
          onSessionSpawned(tab.clientId, session);
          bindSession(session.id);
          lastSizeRef.current = { cols: term.cols, rows: term.rows };
        })
        .catch((err) => {
          console.error("Failed to spawn terminal:", err);
          spawnStarted = false;
        });
    };

    if (tab.sessionId) {
      bindSession(tab.sessionId);
    } else {
      trySpawn();
    }

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = window.setTimeout(() => {
        resizeTimeoutRef.current = null;
        const container = containerRef.current;
        if (!fitRef.current || !xtermRef.current || !container) return;
        if (container.clientWidth < 10 || container.clientHeight < 10) return;

        try {
          fitRef.current.fit();
        } catch {
          return;
        }

        if (sessionIdRef.current) {
          const size = { cols: xtermRef.current.cols, rows: xtermRef.current.rows };
          if (
            lastSizeRef.current &&
            lastSizeRef.current.cols === size.cols &&
            lastSizeRef.current.rows === size.rows
          ) {
            return;
          }
          lastSizeRef.current = size;
          void terminalResize(sessionIdRef.current, size.cols, size.rows);
        } else {
          trySpawn();
        }
      }, RESIZE_DEBOUNCE_MS);
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      onUnregisterTerm(tab.clientId);
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [tab.clientId]);

  // When this tab becomes active, fit and focus it cleanly
  useEffect(() => {
    if (isActive && xtermRef.current && fitRef.current && containerRef.current) {
      const frame = requestAnimationFrame(() => {
        if (!xtermRef.current || !fitRef.current || !containerRef.current) return;
        if (containerRef.current.clientWidth < 10 || containerRef.current.clientHeight < 10) return;

        try {
          fitRef.current.fit();
          xtermRef.current.focus();
        } catch {
          // Layout may still be applying
        }

        if (sessionIdRef.current && isDesktopRuntime()) {
          const size = { cols: xtermRef.current.cols, rows: xtermRef.current.rows };
          if (
            !lastSizeRef.current ||
            lastSizeRef.current.cols !== size.cols ||
            lastSizeRef.current.rows !== size.rows
          ) {
            lastSizeRef.current = size;
            void terminalResize(sessionIdRef.current, size.cols, size.rows);
          }
        }
      });

      return () => cancelAnimationFrame(frame);
    }
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      className={`terminal-tab-pane${isActive ? " active" : " hidden"}`}
      style={{
        display: isActive ? "block" : "none",
        width: "100%",
        height: "100%",
      }}
    />
  );
});

export function Terminal({ defaultCwd }: TerminalProps = {}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeClientId, setActiveClientId] = useState<string | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  const termMapRef = useRef<Map<string, { term: XTerm; fitAddon: FitAddon; sessionId: string | null }>>(new Map());
  const sessionToClientMapRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const handleRegisterTerm = useCallback(
    (clientId: string, sessionId: string | null, term: XTerm, fitAddon: FitAddon) => {
      termMapRef.current.set(clientId, { term, fitAddon, sessionId });
      if (sessionId) {
        sessionToClientMapRef.current.set(sessionId, clientId);
      }
    },
    []
  );

  const handleUnregisterTerm = useCallback((clientId: string) => {
    const entry = termMapRef.current.get(clientId);
    if (entry?.sessionId) {
      sessionToClientMapRef.current.delete(entry.sessionId);
    }
    termMapRef.current.delete(clientId);
  }, []);

  const handleSessionSpawned = useCallback((clientId: string, session: TerminalSession) => {
    const shellName = session.shell.split("/").pop() ?? session.shell;
    setTabs((prev) =>
      prev.map((t) =>
        t.clientId === clientId
          ? { ...t, sessionId: session.id, pending: false, title: shellName, cwd: session.cwd, shell: session.shell }
          : t
      )
    );
    sessionToClientMapRef.current.set(session.id, clientId);
    const entry = termMapRef.current.get(clientId);
    if (entry) {
      entry.sessionId = session.id;
    }
  }, []);

  const createTab = useCallback(() => {
    const clientId = makeClientId();

    if (!isDesktopRuntime()) {
      const tab: Tab = {
        clientId,
        sessionId: clientId,
        pending: false,
        title: "Terminal (no IPC)",
        cwd: "~",
        shell: "n/a",
      };
      setTabs((prev) => [...prev, tab]);
      setActiveClientId(clientId);
      return;
    }

    const tab: Tab = {
      clientId,
      sessionId: null,
      pending: true,
      title: "shell",
      cwd: "",
      shell: "",
    };
    setTabs((prev) => [...prev, tab]);
    setActiveClientId(clientId);
  }, []);

  const resetTerminal = useCallback(() => {
    if (!activeClientId) return;
    const entry = termMapRef.current.get(activeClientId);
    if (!entry) return;

    entry.term.reset();
    try {
      entry.fitAddon.fit();
    } catch {
      // ignore
    }

    if (isDesktopRuntime() && entry.sessionId) {
      void terminalResize(entry.sessionId, entry.term.cols, entry.term.rows);
    }
  }, [activeClientId]);

  const closeTab = useCallback(
    async (clientId: string) => {
      const tab = tabsRef.current.find((t) => t.clientId === clientId);

      if (isDesktopRuntime() && tab?.sessionId) {
        try {
          await terminalKill(tab.sessionId);
        } catch (err) {
          console.error("Failed to kill terminal session:", err);
        }
      }

      setTabs((prev) => {
        const filtered = prev.filter((t) => t.clientId !== clientId);
        if (activeClientId === clientId) {
          const next = filtered.length > 0 ? filtered[filtered.length - 1].clientId : null;
          setActiveClientId(next);
        }
        return filtered;
      });
    },
    [activeClientId]
  );

  useEffect(() => {
    if (tabs.length === 0) {
      createTab();
    }
  }, [tabs.length, createTab]);

  // Global listener for output from all terminal PTY sessions
  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const fn = await onTerminalOutput(({ id, dataBase64 }) => {
        const clientId = sessionToClientMapRef.current.get(id);
        const entry = clientId ? termMapRef.current.get(clientId) : undefined;
        if (entry?.term) {
          entry.term.write(base64ToBytes(dataBase64));
        }
      });

      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div className="terminal-view">
      <div className="terminal-tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.clientId}
            className={`terminal-tab${activeClientId === tab.clientId ? " terminal-tab-active" : ""}`}
            onClick={() => setActiveClientId(tab.clientId)}
          >
            <TerminalSquare size={12} />
            <span className="terminal-tab-title">{tab.title}</span>
            <button
              className="terminal-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.clientId);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="terminal-tab-new" onClick={() => createTab()} title="New tab">
          <Plus size={14} />
        </button>
        <div className="terminal-tab-bar-spacer" />
        <button
          className="terminal-tab-reset"
          onClick={resetTerminal}
          title="Reset terminal (clears screen if display gets corrupted)"
          disabled={!activeClientId}
        >
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="terminal-container">
        {tabs.map((tab) => (
          <TerminalTabPane
            key={tab.clientId}
            tab={tab}
            isActive={activeClientId === tab.clientId}
            defaultCwd={defaultCwd}
            onSessionSpawned={handleSessionSpawned}
            onRegisterTerm={handleRegisterTerm}
            onUnregisterTerm={handleUnregisterTerm}
          />
        ))}
      </div>
    </div>
  );
}
