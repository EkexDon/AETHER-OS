import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, ArrowRight, RotateCcw, ExternalLink, Star, StarOff, Globe, Shield, X, Plus, Loader2 } from "lucide-react";
import {
  getBrowserInfo,
  browserOpen,
  browserOpenLibreWolf,
  browserWebviewOpen,
  browserWebviewClose,
  browserWebviewNavigate,
  browserWebviewBack,
  browserWebviewForward,
  browserWebviewReload,
  browserWebviewList,
  browserWebviewSetBounds,
  browserWebviewShow,
  browserWebviewHide,
  browserWebviewHideAll,
  onBrowserWebviewNav,
  onBrowserWebviewTitle,
  isDesktopRuntime,
} from "../lib/ipc";
import type { BrowserInfo } from "../types";

const BOOKMARKS_KEY = "aether-browser-bookmarks";
const MAX_HISTORY = 50;

interface Bookmark {
  title: string;
  url: string;
}

function loadBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveBookmarks(bm: Bookmark[]) {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bm));
  } catch {
    // ignore
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^about:/i.test(trimmed)) return trimmed;
  if (/\.[a-z]{2,}/i.test(trimmed) && !/\s/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function urlToTitle(url: string): string {
  return url
    .replace("https://", "")
    .replace("http://", "")
    .replace(/\/$/, "")
    .slice(0, 40);
}

interface Tab {
  label: string;      // webview label (backend identifier)
  url: string;        // current display URL (synced via nav events)
  title: string;
  history: string[];
  historyIndex: number;
}

export function Browser() {
  const [url, setUrl] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks());
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeLabelRef = useRef<string | null>(null);

  useEffect(() => {
    activeLabelRef.current = activeLabel;
  }, [activeLabel]);

  useEffect(() => {
    saveBookmarks(bookmarks);
  }, [bookmarks]);

  const activeTab = tabs.find((t) => t.label === activeLabel) ?? null;

  // Measure the browser content area. add_child() positions are relative to
  // the main window's content area — identical to getBoundingClientRect().
  const measureRect = useCallback(() => {
    const el = contentRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, []);

  const updateBounds = useCallback(async (label: string) => {
    const rect = measureRect();
    if (!rect) return;
    try {
      await browserWebviewSetBounds(label, rect);
    } catch {
      // webview may have been closed
    }
  }, [measureRect]);

  // Initial setup: browser info + restore existing webviews (view remount)
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void getBrowserInfo()
      .then(setBrowserInfo)
      .catch((e) => setError(String(e)));
    void browserWebviewList()
      .then((wins) => {
        if (wins.length > 0) {
          setTabs(
            wins.map(([label, u]) => ({
              label,
              url: u,
              title: urlToTitle(u),
              history: [u],
              historyIndex: 0,
            }))
          );
          setActiveLabel(wins[0][0]);
          setUrl(wins[0][1]);
        }
      })
      .catch(() => undefined);
  }, []);

  // Subscribe to navigation/title events from the native webviews
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let unlistenNav: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;

    void onBrowserWebviewNav((e) => {
      setLoading(false);
      setTabs((prev) =>
        prev.map((t) => {
          if (t.label !== e.label) return t;
          const u = e.url;
          if (t.history[t.historyIndex] === u) return { ...t, url: u };
          // Back/forward reconciliation
          if (t.historyIndex > 0 && t.history[t.historyIndex - 1] === u) {
            return { ...t, url: u, historyIndex: t.historyIndex - 1 };
          }
          if (
            t.historyIndex < t.history.length - 1 &&
            t.history[t.historyIndex + 1] === u
          ) {
            return { ...t, url: u, historyIndex: t.historyIndex + 1 };
          }
          const hist = [...t.history.slice(0, t.historyIndex + 1), u].slice(-MAX_HISTORY);
          return { ...t, url: u, history: hist, historyIndex: hist.length - 1 };
        })
      );
      if (activeLabelRef.current === e.label) {
        setUrl(e.url);
      }
    }).then((fn) => (unlistenNav = fn));

    void onBrowserWebviewTitle((e) => {
      if (!e.title) return;
      setTabs((prev) =>
        prev.map((t) => (t.label === e.label ? { ...t, title: e.title.slice(0, 60) } : t))
      );
    }).then((fn) => (unlistenTitle = fn));

    return () => {
      unlistenNav?.();
      unlistenTitle?.();
    };
  }, []);

  // Show active webview / hide others; position it over the content area
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    for (const tab of tabs) {
      if (tab.label === activeLabel) {
        void updateBounds(tab.label).then(() => browserWebviewShow(tab.label));
      } else {
        void browserWebviewHide(tab.label);
      }
    }
    if (!activeLabel) {
      void browserWebviewHideAll();
    }
  }, [activeLabel, tabs, updateBounds]);

  // Reposition when the content area resizes (window resize, layout changes)
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (activeLabelRef.current) {
        void updateBounds(activeLabelRef.current);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateBounds]);

  // Hide all webviews when leaving the browser view (unmount)
  useEffect(() => {
    return () => {
      if (isDesktopRuntime()) {
        void browserWebviewHideAll();
      }
    };
  }, []);

  const navigate = useCallback(
    async (rawUrl: string, existingLabel?: string | null) => {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) return;
      setError(null);
      setLoading(true);

      try {
        if (existingLabel) {
          await browserWebviewNavigate(existingLabel, normalized);
          setTabs((prev) =>
            prev.map((t) => {
              if (t.label !== existingLabel) return t;
              const hist = [...t.history.slice(0, t.historyIndex + 1), normalized].slice(-MAX_HISTORY);
              return { ...t, url: normalized, history: hist, historyIndex: hist.length - 1 };
            })
          );
        } else {
          const rect = measureRect() ?? { x: 0, y: 0, width: 800, height: 600 };
          const label = await browserWebviewOpen(normalized, rect);
          const newTab: Tab = {
            label,
            url: normalized,
            title: urlToTitle(normalized),
            history: [normalized],
            historyIndex: 0,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveLabel(label);
        }
        setUrl(normalized);
      } catch (e) {
        setError(String(e));
        setLoading(false);
      }
    },
    [measureRect]
  );

  const closeTab = useCallback(
    async (label: string) => {
      try {
        await browserWebviewClose(label);
      } catch {
        // already gone
      }
      setTabs((prev) => {
        const filtered = prev.filter((t) => t.label !== label);
        if (activeLabel === label) {
          const next = filtered.length > 0 ? filtered[filtered.length - 1] : null;
          setActiveLabel(next ? next.label : null);
          setUrl(next ? next.url : "");
        }
        return filtered;
      });
    },
    [activeLabel]
  );

  const goBack = useCallback(async () => {
    if (!activeLabel) return;
    try {
      await browserWebviewBack(activeLabel);
    } catch (e) {
      setError(String(e));
    }
  }, [activeLabel]);

  const goForward = useCallback(async () => {
    if (!activeLabel) return;
    try {
      await browserWebviewForward(activeLabel);
    } catch (e) {
      setError(String(e));
    }
  }, [activeLabel]);

  const reload = useCallback(async () => {
    if (!activeLabel) return;
    setLoading(true);
    try {
      await browserWebviewReload(activeLabel);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }, [activeLabel]);

  const toggleBookmark = useCallback(() => {
    if (!activeTab) return;
    setBookmarks((prev) => {
      const exists = prev.find((b) => b.url === activeTab.url);
      if (exists) return prev.filter((b) => b.url !== activeTab.url);
      return [...prev, { title: activeTab.title, url: activeTab.url }];
    });
  }, [activeTab]);

  const isBookmarked = activeTab ? bookmarks.some((b) => b.url === activeTab.url) : false;

  const openInLibreWolf = useCallback(async () => {
    if (!activeTab) return;
    try {
      await browserOpenLibreWolf(activeTab.url);
    } catch (e) {
      setError(String(e));
    }
  }, [activeTab]);

  const openExternal = useCallback(async () => {
    if (!activeTab) return;
    try {
      await browserOpen(activeTab.url);
    } catch (e) {
      setError(String(e));
    }
  }, [activeTab]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void navigate(url, activeLabel);
    }
  };

  if (!isDesktopRuntime()) {
    return (
      <div className="browser-container">
        <div className="browser-error">
          <Globe size={48} />
          <p>Browser requires the desktop runtime. Start with: npm run app</p>
        </div>
      </div>
    );
  }

  return (
    <div className="browser-container">
      <div className="browser-tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.label}
            className={`browser-tab${activeLabel === tab.label ? " browser-tab-active" : ""}`}
            onClick={() => {
              setActiveLabel(tab.label);
              setUrl(tab.url);
            }}
          >
            <Globe size={12} />
            <span className="browser-tab-title">{tab.title}</span>
            <button
              className="browser-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.label);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="browser-tab-new"
          onClick={() => {
            setActiveLabel(null);
            setUrl("");
          }}
          title="New tab"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="browser-toolbar">
        <button
          className="browser-nav-btn"
          onClick={goBack}
          disabled={!activeTab || activeTab.historyIndex <= 0}
          title="Back"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className="browser-nav-btn"
          onClick={goForward}
          disabled={!activeTab || activeTab.historyIndex >= activeTab.history.length - 1}
          title="Forward"
        >
          <ArrowRight size={16} />
        </button>
        <button className="browser-nav-btn" onClick={reload} disabled={!activeTab} title="Reload">
          <RotateCcw size={16} />
        </button>

        <div className="browser-url-bar">
          <Globe size={14} className="browser-url-icon" />
          <input
            type="text"
            className="browser-url-input"
            placeholder="Search or enter URL…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          {loading && <Loader2 size={14} className="browser-loading-spinner" />}
        </div>

        <button
          className="browser-nav-btn"
          onClick={toggleBookmark}
          disabled={!activeTab}
          title={isBookmarked ? "Remove bookmark" : "Add bookmark"}
        >
          {isBookmarked ? <Star size={16} className="browser-bookmark-active" /> : <StarOff size={16} />}
        </button>

        <button
          className="browser-nav-btn"
          onClick={() => setShowBookmarks((s) => !s)}
          title="Bookmarks"
        >
          <Star size={16} />
        </button>

        {browserInfo?.librewolf_installed && (
          <button
            className="browser-nav-btn browser-librewolf-btn"
            onClick={openInLibreWolf}
            disabled={!activeTab}
            title="Open in LibreWolf"
          >
            <Shield size={16} />
          </button>
        )}

        <button
          className="browser-nav-btn"
          onClick={openExternal}
          disabled={!activeTab}
          title="Open in external browser"
        >
          <ExternalLink size={16} />
        </button>
      </div>

      {showBookmarks && bookmarks.length > 0 && (
        <div className="browser-bookmarks-bar">
          {bookmarks.map((bm) => (
            <button
              key={bm.url}
              className="browser-bookmark-item"
              onClick={() => {
                void navigate(bm.url, activeLabel);
                setShowBookmarks(false);
              }}
            >
              <Globe size={12} />
              <span>{bm.title.slice(0, 30)}</span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="browser-error-banner">{error}</div>}

      {browserInfo && (
        <div className="browser-status-bar">
          <Shield size={11} />
          <span>Embedded native browser — {browserInfo.default_browser} engine</span>
          {browserInfo.librewolf_installed && (
            <span className="browser-librewolf-badge">LibreWolf detected</span>
          )}
        </div>
      )}

      <div className="browser-content" ref={contentRef}>
        {!activeLabel && (
          <div className="browser-home">
            <Globe size={64} className="browser-home-icon" />
            <h2>AETHER-OS Browser</h2>
            <p>Enter a URL or search query above to get started.</p>
            <p className="browser-home-hint">
              Pages render in a real browser engine embedded in this window —
              Google, YouTube, GitHub and all other sites work natively.
            </p>
            {bookmarks.length > 0 && (
              <div className="browser-home-bookmarks">
                <h3>Quick Access</h3>
                {bookmarks.map((bm) => (
                  <button
                    key={bm.url}
                    className="browser-home-bookmark"
                    onClick={() => void navigate(bm.url)}
                  >
                    <Globe size={16} />
                    <span>{bm.title.slice(0, 40)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
