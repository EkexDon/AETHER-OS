import { useEffect, useRef, useState, useCallback } from "react";
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
import type { TerminalSession } from "../types";

const RESIZE_DEBOUNCE_MS = 120;

/**
 * A tab is identified by a stable `clientId` generated once on creation.
 * `clientId` is used for all React state/keys and never changes, which
 * lets us update `sessionId` in place (once the backend PTY spawns)
 * without ever re-triggering the xterm mount effect. This is what
 * allows us to measure the real, fitted terminal size BEFORE asking
 * the backend to spawn the shell, instead of guessing a fixed 80x24
 * and resizing moments later (a race that can desync any program
 * that queries terminal size once at startup, e.g. build tool
 * progress bars).
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

export function Terminal() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeClientId, setActiveClientId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const tabsRef = useRef<Tab[]>([]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

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
    if (!xtermRef.current) return;

    xtermRef.current.reset();

    if (fitRef.current) {
      fitRef.current.fit();
    }

    if (isDesktopRuntime() && activeSessionIdRef.current) {
      void terminalResize(activeSessionIdRef.current, xtermRef.current.cols, xtermRef.current.rows);
    }
  }, []);

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

  useEffect(() => {
    if (!activeClientId || !containerRef.current) return;

    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    if (resizeTimeoutRef.current !== null) {
      window.clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = null;
    }

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
    // Fit BEFORE anything else touches the PTY: this gives us the true
    // container-derived cols/rows so the backend shell (and any program
    // it runs) never sees a stale/incorrect terminal size.
    fitAddon.fit();

    xtermRef.current = term;
    fitRef.current = fitAddon;

    const currentTab = tabsRef.current.find((t) => t.clientId === activeClientId);

    if (!isDesktopRuntime()) {
      activeSessionIdRef.current = currentTab?.sessionId ?? activeClientId;
      term.writeln("\x1b[90mAETHER-OS Terminal\x1b[0m");
      term.writeln("\x1b[90mStart the desktop app to use the terminal: \x1b[1mnpm run app\x1b[0m");
      term.writeln("");
      return;
    }

    let cancelled = false;

    const bindSession = (sessionId: string) => {
      activeSessionIdRef.current = sessionId;
      term.onData((data: string) => {
        void terminalWrite(sessionId, data);
      });
    };

    if (currentTab && !currentTab.pending && currentTab.sessionId) {
      bindSession(currentTab.sessionId);
    } else {
      // Spawn the PTY using the size we just measured from the real,
      // mounted container — not a hardcoded guess. This eliminates the
      // startup race where a program (e.g. a build tool's progress bar)
      // queries terminal size before our first resize call lands.
      void terminalSpawn(undefined, undefined, term.cols, term.rows)
        .then((session: TerminalSession) => {
          if (cancelled) {
            void terminalKill(session.id).catch(() => undefined);
            return;
          }
          const shellName = session.shell.split("/").pop() ?? session.shell;
          setTabs((prev) =>
            prev.map((t) =>
              t.clientId === activeClientId
                ? { ...t, sessionId: session.id, pending: false, title: shellName, cwd: session.cwd, shell: session.shell }
                : t
            )
          );
          bindSession(session.id);
        })
        .catch((err) => {
          console.error("Failed to spawn terminal:", err);
        });
    }

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = window.setTimeout(() => {
        resizeTimeoutRef.current = null;
        if (!fitRef.current || !xtermRef.current) return;
        fitRef.current.fit();
        if (isDesktopRuntime() && activeSessionIdRef.current) {
          void terminalResize(activeSessionIdRef.current, xtermRef.current.cols, xtermRef.current.rows);
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
    };
  }, [activeClientId]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const fn = await onTerminalOutput(({ id, data }) => {
        // Only write output into the currently-mounted xterm instance if
        // it belongs to the session that's actually active. Without this
        // check, a background tab's shell finishing a command could bleed
        // its output into whatever terminal happens to be visible.
        if (xtermRef.current && activeSessionIdRef.current === id) {
          xtermRef.current.write(data);
        }
      });
      // If cleanup ran while we were waiting for the async listener
      // registration, immediately unlisten to avoid a dangling second
      // listener that would duplicate every output chunk.
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

  useEffect(() => {
    return () => {
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
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
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
