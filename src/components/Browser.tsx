import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, ArrowRight, RotateCcw, ExternalLink, Star, StarOff, Globe, Shield, X, Plus } from "lucide-react";
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
  isDesktopRuntime,
} from "../lib/ipc";
import type { BrowserInfo } from "../types";

const BOOKMARKS_KEY = "aether-browser-bookmarks";

interface BrowserTab {
  label: string;
  url: string;
  title: string;
}

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
  // Check if it looks like a URL (contains a dot, no spaces)
  if (/\.[a-z]{2,}/i.test(trimmed) && !/\s/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  // Otherwise treat as a search query — use DuckDuckGo for privacy
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function urlToTitle(url: string): string {
  return url
    .replace("https://", "")
    .replace("http://", "")
    .replace(/\/$/, "")
    .slice(0, 40);
}

export function Browser() {
  const [url, setUrl] = useState("");
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks());
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeLabelRef = useRef<string | null>(null);
  const tabsRef = useRef<BrowserTab[]>([]);

  // Keep refs in sync for use in effects
  useEffect(() => { activeLabelRef.current = activeLabel; }, [activeLabel]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  useEffect(() => {
    saveBookmarks(bookmarks);
  }, [bookmarks]);

  // Measure the browser content area and position the active child webview to overlay it
  const updateBounds = useCallback(async (label: string) => {
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    try {
      await browserWebviewSetBounds(label, rect.left, rect.top, rect.width, rect.height);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Hide all webviews on unmount or when switching away from browser view
  useEffect(() => {
    return () => {
      if (isDesktopRuntime()) {
        void browserWebviewHideAll();
      }
    };
  }, []);

  // Update bounds when active tab changes or window resizes
  useEffect(() => {
    if (!isDesktopRuntime() || !activeLabel) return;
    void updateBounds(activeLabel);
    // Also show the active webview and hide others
    void browserWebviewShow(activeLabel);
    for (const tab of tabs) {
      if (tab.label !== activeLabel) {
        void browserWebviewHide(tab.label);
      }
    }
  }, [activeLabel, tabs, updateBounds]);

  // Reposition on window resize
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const onResize = () => {
      if (activeLabelRef.current) {
        void updateBounds(activeLabelRef.current);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateBounds]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void getBrowserInfo()
      .then(setBrowserInfo)
      .catch((e) => setError(String(e)));
    void browserWebviewList()
      .then((wins) => {
        if (wins.length > 0) {
          setTabs(wins.map(([label, u]) => ({ label, url: u, title: urlToTitle(u) })));
          setActiveLabel(wins[0][0]);
        }
      })
      .catch(() => undefined);
  }, []);

  const navigate = useCallback(
    async (rawUrl: string, existingLabel?: string) => {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) return;

      setUrl(normalized);
      setError(null);

      try {
        if (existingLabel) {
          await browserWebviewNavigate(existingLabel, normalized);
          setTabs((prev) =>
            prev.map((t) =>
              t.label === existingLabel ? { ...t, url: normalized, title: urlToTitle(normalized) } : t
            )
          );
        } else {
          const label = await browserWebviewOpen(normalized);
          const newTab: BrowserTab = { label, url: normalized, title: urlToTitle(normalized) };
          setTabs((prev) => [...prev, newTab]);
          setActiveLabel(label);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    []
  );

  // When a new tab is opened, position it after a tick (waiting for contentRef to be available)
  useEffect(() => {
    if (!isDesktopRuntime() || !activeLabel) return;
    // Small delay to ensure the content div is rendered
    const timer = setTimeout(() => {
      void updateBounds(activeLabel);
    }, 50);
    return () => clearTimeout(timer);
  }, [activeLabel, updateBounds]);

  const closeTab = useCallback(
    async (label: string) => {
      try {
        await browserWebviewClose(label);
      } catch (e) {
        setError(String(e));
      }
      setTabs((prev) => {
        const filtered = prev.filter((t) => t.label !== label);
        if (activeLabel === label) {
          setActiveLabel(filtered.length > 0 ? filtered[filtered.length - 1].label : null);
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
    try {
      await browserWebviewReload(activeLabel);
    } catch (e) {
      setError(String(e));
    }
  }, [activeLabel]);

  const toggleBookmark = useCallback(() => {
    const activeTab = tabs.find((t) => t.label === activeLabel);
    if (!activeTab) return;
    setBookmarks((prev) => {
      const exists = prev.find((b) => b.url === activeTab.url);
      if (exists) {
        return prev.filter((b) => b.url !== activeTab.url);
      }
      return [...prev, { title: activeTab.title, url: activeTab.url }];
    });
  }, [activeLabel, tabs]);

  const isBookmarked = tabs.some((t) => t.label === activeLabel && bookmarks.some((b) => b.url === t.url));

  const openInLibreWolf = useCallback(async () => {
    const activeTab = tabs.find((t) => t.label === activeLabel);
    if (!activeTab) return;
    try {
      await browserOpenLibreWolf(activeTab.url);
    } catch (e) {
      setError(String(e));
    }
  }, [activeLabel, tabs]);

  const openExternal = useCallback(async () => {
    const activeTab = tabs.find((t) => t.label === activeLabel);
    if (!activeTab) return;
    try {
      await browserOpen(activeTab.url);
    } catch (e) {
      setError(String(e));
    }
  }, [activeLabel, tabs]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void navigate(url, activeLabel ?? undefined);
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
        <button className="browser-nav-btn" onClick={goBack} disabled={!activeLabel} title="Back">
          <ArrowLeft size={16} />
        </button>
        <button className="browser-nav-btn" onClick={goForward} disabled={!activeLabel} title="Forward">
          <ArrowRight size={16} />
        </button>
        <button className="browser-nav-btn" onClick={reload} disabled={!activeLabel} title="Reload">
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
        </div>

        <button
          className="browser-nav-btn"
          onClick={toggleBookmark}
          disabled={!activeLabel}
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
            disabled={!activeLabel}
            title="Open in LibreWolf"
          >
            <Shield size={16} />
          </button>
        )}

        <button
          className="browser-nav-btn"
          onClick={openExternal}
          disabled={!activeLabel}
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
                void navigate(bm.url, activeLabel ?? undefined);
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
          <span>Powered by {browserInfo.default_browser}</span>
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
            <p>Enter a URL or search query above to open an embedded webview.</p>
            <p className="browser-home-hint">
              Pages render inside the app using native webviews — no iframe restrictions.
              Google, GitHub, and all other sites work.
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

        {activeLabel && (
          <div className="browser-webview-placeholder" />
        )}
      </div>
    </div>
  );
}
