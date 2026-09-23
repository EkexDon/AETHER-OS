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
import { onTokensChange, readTokens } from "../lib/tokens";
import type { TerminalSession } from "../types";

const RESIZE_DEBOUNCE_MS = 120;

const TERMINAL_FONT = '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace';

const TERMINAL_TOKENS = [
  "--color-sunken",
  "--color-fg-primary",
  "--color-fg-tertiary",
  "--color-accent",
  "--color-selection",
  "--color-danger",
  "--color-success",
  "--color-warning",
  "--color-info",
  "--color-cat-5",
  "--color-cat-2",
] as const;

/**
 * Dispose an xterm instance on the next macrotask. xterm schedules a
 * `setTimeout(0)` scroll-area sync from `open()`; disposing synchronously
 * (StrictMode remounts, closing a tab right after opening it) makes that
 * callback hit a torn-down renderer ("reading 'dimensions'").
 */
function disposeTerminalLater(term: XTerm): void {
  setTimeout(() => {
    try {
      term.dispose();
    } catch {
      // already disposed
    }
  }, 0);
}

/** xterm colour theme derived from the active design tokens. */
function terminalTheme() {
  const t = readTokens(TERMINAL_TOKENS);
  return {
    background: t["--color-sunken"],
    foreground: t["--color-fg-primary"],
    cursor: t["--color-accent"],
    cursorAccent: t["--color-sunken"],
    selectionBackground: t["--color-selection"],
    black: t["--color-sunken"],
    red: t["--color-danger"],
    green: t["--color-success"],
    yellow: t["--color-warning"],
    blue: t["--color-info"],
    magenta: t["--color-cat-5"],
    cyan: t["--color-cat-2"],
    white: t["--color-fg-primary"],
    brightBlack: t["--color-fg-tertiary"],
    brightRed: t["--color-danger"],
    brightGreen: t["--color-success"],
    brightYellow: t["--color-warning"],
    brightBlue: t["--color-info"],
    brightMagenta: t["--color-cat-5"],
    brightCyan: t["--color-cat-2"],
    brightWhite: t["--color-fg-primary"],
  };
}

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
  const activeFrameRef = useRef<number | null>(null);
  // Theme changes that arrived while the pane was hidden (0×0): xterm's
  // renderer has no dimensions then, so they are applied on the next show.
  const pendingThemeRef = useRef(false);

  sessionIdRef.current = tab.sessionId;
  cwdRef.current = defaultCwd;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.25,
      fontFamily: TERMINAL_FONT,
      theme: terminalTheme(),
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);
    xtermRef.current = term;
    fitRef.current = fitAddon;

    const isMeasurable = () => {
      const el = containerRef.current;
      return !!el && el.clientWidth >= 10 && el.clientHeight >= 10;
    };

    // Follow theme / accent changes without recreating the terminal.
    const offTokens = onTokensChange(() => {
      if (!term.options) return;
      if (isMeasurable()) term.options.theme = terminalTheme();
      else pendingThemeRef.current = true;
    });
    // The bundled mono font may finish loading after xterm measured its
    // cells; re-apply it once ready so glyph metrics are correct.
    if (typeof document !== "undefined" && document.fonts?.load) {
      void document.fonts
        .load(`13px ${TERMINAL_FONT}`)
        .then(() => {
          if (xtermRef.current !== term || !term.options || !isMeasurable()) return;
          term.options.fontFamily = TERMINAL_FONT;
          try {
            fitAddon.fit();
          } catch {
            // layout still settling
          }
        })
        .catch(() => undefined);
    }

    onRegisterTerm(tab.clientId, tab.sessionId, term, fitAddon);

    if (!isDesktopRuntime()) {
      term.writeln("\x1b[90mAETHER-OS Terminal\x1b[0m");
      term.writeln("\x1b[90mStart the desktop app to use the terminal: \x1b[1mnpm run app\x1b[0m");
      term.writeln("");
      return () => {
        offTokens();
        onUnregisterTerm(tab.clientId);
        disposeTerminalLater(term);
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

        // The view became visible again: apply a theme switch that happened
        // while it was hidden.
        if (pendingThemeRef.current && xtermRef.current.options) {
          pendingThemeRef.current = false;
          xtermRef.current.options.theme = terminalTheme();
        }

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
      offTokens();
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      onUnregisterTerm(tab.clientId);
      disposeTerminalLater(term);
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [tab.clientId]);

  // When this tab becomes active, fit and focus it cleanly
  useEffect(() => {
    if (isActive && xtermRef.current && fitRef.current && containerRef.current) {
      // Two rAFs: the first lets the browser compute layout for the
      // display:none → display:block transition; the second lets the
      // ResizeObserver-driven fit complete so we resize the PTY to the
      // final settled size instead of an intermediate one.
      const frame1 = requestAnimationFrame(() => {
        const frame2 = requestAnimationFrame(() => {
          if (!xtermRef.current || !fitRef.current || !containerRef.current) return;
          if (containerRef.current.clientWidth < 10 || containerRef.current.clientHeight < 10) return;

          const before = { cols: xtermRef.current.cols, rows: xtermRef.current.rows };
          if (pendingThemeRef.current && xtermRef.current.options) {
            pendingThemeRef.current = false;
            xtermRef.current.options.theme = terminalTheme();
          }
          try {
            fitRef.current.fit();
            // Force the renderer to redraw every row after a fit. When a
            // hidden pane becomes visible again, the canvas can retain
            // stale dimensions and render the buffer anchored far below
            // the viewport, which the user sees as the prompt "shifting
            // downward".
            xtermRef.current.refresh(0, xtermRef.current.rows - 1);
            xtermRef.current.focus();
          } catch {
            // Layout may still be applying
          }

          if (sessionIdRef.current && isDesktopRuntime()) {
            const size = { cols: xtermRef.current.cols, rows: xtermRef.current.rows };
            if (before.cols !== size.cols || before.rows !== size.rows) {
              lastSizeRef.current = size;
              void terminalResize(sessionIdRef.current, size.cols, size.rows);
            }
          }
        });
        activeFrameRef.current = frame2;
      });
      activeFrameRef.current = frame1;

      return () => {
        if (activeFrameRef.current !== null) {
          cancelAnimationFrame(activeFrameRef.current);
          activeFrameRef.current = null;
        }
      };
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

  // Always keep one tab open. The ref stops React StrictMode's double effect
  // run from opening two shells before the first state update lands.
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (tabs.length > 0) {
      autoCreatedRef.current = false;
      return;
    }
    if (autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    createTab();
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
