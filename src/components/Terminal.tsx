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

interface Tab {
  sessionId: string;
  title: string;
  cwd: string;
  shell: string;
}

export function Terminal() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const activeSessionRef = useRef<string | null>(null);

  const createTab = useCallback(async () => {
    if (!isDesktopRuntime()) {
      const fakeId = `local-${Date.now()}`;
      const tab: Tab = {
        sessionId: fakeId,
        title: "Terminal (no IPC)",
        cwd: "~",
        shell: "n/a",
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(fakeId);
      return;
    }

    try {
      const cols = 80;
      const rows = 24;
      const session: TerminalSession = await terminalSpawn(undefined, undefined, cols, rows);
      const shellName = session.shell.split("/").pop() ?? session.shell;
      const tab: Tab = {
        sessionId: session.id,
        title: shellName,
        cwd: session.cwd,
        shell: session.shell,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(session.id);
    } catch (err) {
      console.error("Failed to spawn terminal:", err);
    }
  }, []);

  const resetTerminal = useCallback(() => {
    if (!xtermRef.current) return;

    xtermRef.current.reset();

    if (fitRef.current) {
      fitRef.current.fit();
    }

    if (
      isDesktopRuntime() &&
      activeSessionRef.current &&
      !activeSessionRef.current.startsWith("local-")
    ) {
      void terminalResize(activeSessionRef.current, xtermRef.current.cols, xtermRef.current.rows);
    }
  }, []);

  const closeTab = useCallback(
    async (sessionId: string) => {
      if (isDesktopRuntime() && !sessionId.startsWith("local-")) {
        try {
          await terminalKill(sessionId);
        } catch (err) {
          console.error("Failed to kill terminal session:", err);
        }
      }

      setTabs((prev) => {
        const filtered = prev.filter((t) => t.sessionId !== sessionId);
        if (activeTabId === sessionId) {
          const next = filtered.length > 0 ? filtered[filtered.length - 1].sessionId : null;
          setActiveTabId(next);
        }
        return filtered;
      });
    },
    [activeTabId]
  );

  useEffect(() => {
    if (tabs.length === 0) {
      void createTab();
    }
  }, [tabs.length, createTab]);

  useEffect(() => {
    if (!activeTabId || !containerRef.current) return;

    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
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
    fitAddon.fit();

    xtermRef.current = term;
    fitRef.current = fitAddon;
    activeSessionRef.current = activeTabId;

    if (isDesktopRuntime() && !activeTabId.startsWith("local-")) {
      term.onData((data: string) => {
        void terminalWrite(activeTabId, data);
      });

      fitAddon.fit();
      void terminalResize(activeTabId, term.cols, term.rows);
    } else {
      term.writeln("\x1b[90mAETHER-OS Terminal\x1b[0m");
      term.writeln("\x1b[90mStart the desktop app to use the terminal: \x1b[1mnpm run app\x1b[0m");
      term.writeln("");
    }

    const resizeObserver = new ResizeObserver(() => {
      if (fitRef.current && xtermRef.current) {
        fitRef.current.fit();
        if (isDesktopRuntime() && activeSessionRef.current && !activeSessionRef.current.startsWith("local-")) {
          void terminalResize(activeSessionRef.current, xtermRef.current.cols, xtermRef.current.rows);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [activeTabId]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await onTerminalOutput((output) => {
        if (xtermRef.current && activeSessionRef.current) {
          xtermRef.current.write(output);
        }
      });
    })();

    unlistenRef.current = unlisten;

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  return (
    <div className="terminal-view">
      <div className="terminal-tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.sessionId}
            className={`terminal-tab${activeTabId === tab.sessionId ? " terminal-tab-active" : ""}`}
            onClick={() => setActiveTabId(tab.sessionId)}
          >
            <TerminalSquare size={12} />
            <span className="terminal-tab-title">{tab.title}</span>
            <button
              className="terminal-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.sessionId);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="terminal-tab-new" onClick={() => void createTab()} title="New tab">
          <Plus size={14} />
        </button>
        <div className="terminal-tab-bar-spacer" />
        <button
          className="terminal-tab-reset"
          onClick={resetTerminal}
          title="Reset terminal (clears screen if display gets corrupted)"
          disabled={!activeTabId}
        >
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
