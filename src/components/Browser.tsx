import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, ArrowRight, RotateCcw, ExternalLink, Star, StarOff, Globe, Shield, X, Plus, Loader2 } from "lucide-react";
import {
  getBrowserInfo,
  browserOpen,
  browserOpenLibreWolf,
  browserProxyPort,
  isDesktopRuntime,
} from "../lib/ipc";
import type { BrowserInfo } from "../types";

const BOOKMARKS_KEY = "aether-browser-bookmarks";
const HISTORY_KEY = "aether-browser-history";
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
  id: number;
  url: string;
  title: string;
  history: string[];
  historyIndex: number;
}

let tabCounter = 0;

export function Browser() {
  const [url, setUrl] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks());
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [loading, setLoading] = useState(false);
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    saveBookmarks(bookmarks);
  }, [bookmarks]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void getBrowserInfo()
      .then(setBrowserInfo)
      .catch((e) => setError(String(e)));
    void browserProxyPort()
      .then(setProxyPort)
      .catch((e) => setError(String(e)));
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const proxyUrl = useCallback((targetUrl: string): string => {
    if (!proxyPort) return "";
    return `http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(targetUrl)}`;
  }, [proxyPort]);

  const navigate = useCallback((rawUrl: string, tabId?: number) => {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) return;

    setUrl(normalized);
    setError(null);
    setLoading(true);

    setTabs((prev) => {
      if (tabId !== undefined) {
        return prev.map((t) => {
          if (t.id !== tabId) return t;
          const newHist = [...t.history.slice(0, t.historyIndex + 1), normalized].slice(-MAX_HISTORY);
          return {
            ...t,
            url: normalized,
            title: urlToTitle(normalized),
            history: newHist,
            historyIndex: newHist.length - 1,
          };
        });
      } else {
        const id = ++tabCounter;
        const newTab: Tab = {
          id,
          url: normalized,
          title: urlToTitle(normalized),
          history: [normalized],
          historyIndex: 0,
        };
        setActiveTabId(id);
        return [...prev, newTab];
      }
    });

    try {
      const rawHist = localStorage.getItem(HISTORY_KEY);
      const hist: string[] = rawHist ? JSON.parse(rawHist) : [];
      hist.unshift(normalized);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, MAX_HISTORY)));
    } catch {
      // ignore
    }
  }, [proxyPort]);

  const closeTab = useCallback((id: number) => {
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(filtered.length > 0 ? filtered[filtered.length - 1].id : null);
      }
      return filtered;
    });
  }, [activeTabId]);

  const goBack = useCallback(() => {
    if (!activeTab || activeTab.historyIndex <= 0) return;
    const newIndex = activeTab.historyIndex - 1;
    const target = activeTab.history[newIndex];
    setTabs((prev) => prev.map((t) =>
      t.id === activeTab.id ? { ...t, url: target, title: urlToTitle(target), historyIndex: newIndex } : t
    ));
    setUrl(target);
    setLoading(true);
  }, [activeTab]);

  const goForward = useCallback(() => {
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;
    const newIndex = activeTab.historyIndex + 1;
    const target = activeTab.history[newIndex];
    setTabs((prev) => prev.map((t) =>
      t.id === activeTab.id ? { ...t, url: target, title: urlToTitle(target), historyIndex: newIndex } : t
    ));
    setUrl(target);
    setLoading(true);
  }, [activeTab]);

  const reload = useCallback(() => {
    if (!activeTab) return;
    setLoading(true);
    // Force iframe reload by toggling src
    if (iframeRef.current) {
      const src = iframeRef.current.src;
      iframeRef.current.src = "about:blank";
      requestAnimationFrame(() => {
        if (iframeRef.current) {
          iframeRef.current.src = src;
        }
      });
    }
  }, [activeTab]);

  const toggleBookmark = useCallback(() => {
    if (!activeTab) return;
    setBookmarks((prev) => {
      const exists = prev.find((b) => b.url === activeTab.url);
      if (exists) {
        return prev.filter((b) => b.url !== activeTab.url);
      }
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
      navigate(url, activeTabId ?? undefined);
    }
  };

  const handleIframeLoad = useCallback(() => {
    setLoading(false);
  }, []);

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
            key={tab.id}
            className={`browser-tab${activeTabId === tab.id ? " browser-tab-active" : ""}`}
            onClick={() => {
              setActiveTabId(tab.id);
              setUrl(tab.url);
            }}
          >
            <Globe size={12} />
            <span className="browser-tab-title">{tab.title}</span>
            <button
              className="browser-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="browser-tab-new"
          onClick={() => {
            setActiveTabId(null);
            setUrl("");
          }}
          title="New tab"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="browser-toolbar">
        <button className="browser-nav-btn" onClick={goBack} disabled={!activeTab || activeTab.historyIndex <= 0} title="Back">
          <ArrowLeft size={16} />
        </button>
        <button className="browser-nav-btn" onClick={goForward} disabled={!activeTab || activeTab.historyIndex >= activeTab.history.length - 1} title="Forward">
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
                navigate(bm.url, activeTabId ?? undefined);
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

      <div className="browser-content">
        {!activeTab && (
          <div className="browser-home">
            <Globe size={64} className="browser-home-icon" />
            <h2>AETHER-OS Browser</h2>
            <p>Enter a URL or search query above to get started.</p>
            <p className="browser-home-hint">
              Pages load through a local proxy that removes embedding restrictions.
              Google, GitHub, and all other sites work.
            </p>
            {bookmarks.length > 0 && (
              <div className="browser-home-bookmarks">
                <h3>Quick Access</h3>
                {bookmarks.map((bm) => (
                  <button
                    key={bm.url}
                    className="browser-home-bookmark"
                    onClick={() => navigate(bm.url)}
                  >
                    <Globe size={16} />
                    <span>{bm.title.slice(0, 40)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab && proxyPort && (
          <iframe
            ref={iframeRef}
            key={activeTab.id}
            src={proxyUrl(activeTab.url)}
            className="browser-iframe"
            onLoad={handleIframeLoad}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}
