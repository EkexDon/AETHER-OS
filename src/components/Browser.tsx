import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, ArrowRight, RotateCcw, ExternalLink, Star, StarOff, Globe, Shield } from "lucide-react";
import { getBrowserInfo, browserOpen, browserOpenLibreWolf, isDesktopRuntime } from "../lib/ipc";
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
  // Check if it looks like a URL (contains a dot, no spaces)
  if (/\.[a-z]{2,}/i.test(trimmed) && !/\s/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  // Otherwise treat as a search query — use DuckDuckGo for privacy
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

export function Browser() {
  const [url, setUrl] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks());
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    saveBookmarks(bookmarks);
  }, [bookmarks]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void getBrowserInfo()
      .then(setBrowserInfo)
      .catch((e) => setError(String(e)));
  }, []);

  const navigate = useCallback((rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) return;

    setUrl(normalized);
    setCurrentUrl(normalized);
    setLoading(true);
    setShowHint(false);
    setError(null);

    setHistory((prev) => {
      const newHist = [...prev.slice(0, historyIndex + 1), normalized].slice(-MAX_HISTORY);
      setHistoryIndex(newHist.length - 1);
      return newHist;
    });

    // Save to localStorage history
    try {
      const rawHist = localStorage.getItem(HISTORY_KEY);
      const hist: string[] = rawHist ? JSON.parse(rawHist) : [];
      hist.unshift(normalized);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, MAX_HISTORY)));
    } catch {
      // ignore
    }

    // Show a dismissible hint after 3s in case the page is blank
    // (many sites block iframe embedding via X-Frame-Options/CSP)
    window.setTimeout(() => setShowHint(true), 3000);
  }, [historyIndex]);

  const handleLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const goBack = useCallback(() => {
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    const target = history[newIndex];
    setUrl(target);
    setCurrentUrl(target);
    setLoading(true);
    setShowHint(false);
  }, [history, historyIndex]);

  const goForward = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    setHistoryIndex(newIndex);
    const target = history[newIndex];
    setUrl(target);
    setCurrentUrl(target);
    setLoading(true);
    setShowHint(false);
  }, [history, historyIndex]);

  const reload = useCallback(() => {
    if (!currentUrl) return;
    setCurrentUrl("");
    requestAnimationFrame(() => {
      setCurrentUrl(currentUrl);
      setLoading(true);
      setShowHint(false);
    });
  }, [currentUrl]);

  const toggleBookmark = useCallback(() => {
    if (!currentUrl) return;
    setBookmarks((prev) => {
      const exists = prev.find((b) => b.url === currentUrl);
      if (exists) {
        return prev.filter((b) => b.url !== currentUrl);
      }
      return [...prev, { title: currentUrl, url: currentUrl }];
    });
  }, [currentUrl]);

  const isBookmarked = bookmarks.some((b) => b.url === currentUrl);

  const openInLibreWolf = useCallback(async () => {
    if (!currentUrl) return;
    try {
      await browserOpenLibreWolf(currentUrl);
    } catch (e) {
      setError(String(e));
    }
  }, [currentUrl]);

  const openExternal = useCallback(async () => {
    if (!currentUrl) return;
    try {
      await browserOpen(currentUrl);
    } catch (e) {
      setError(String(e));
    }
  }, [currentUrl]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(url);
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
      <div className="browser-toolbar">
        <button className="browser-nav-btn" onClick={goBack} disabled={historyIndex <= 0} title="Back">
          <ArrowLeft size={16} />
        </button>
        <button
          className="browser-nav-btn"
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
          title="Forward"
        >
          <ArrowRight size={16} />
        </button>
        <button className="browser-nav-btn" onClick={reload} disabled={!currentUrl} title="Reload">
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
          {loading && <div className="browser-loading-spinner" />}
        </div>

        <button
          className="browser-nav-btn"
          onClick={toggleBookmark}
          disabled={!currentUrl}
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
            disabled={!currentUrl}
            title="Open in LibreWolf"
          >
            <Shield size={16} />
          </button>
        )}

        <button
          className="browser-nav-btn"
          onClick={openExternal}
          disabled={!currentUrl}
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
                navigate(bm.url);
                setShowBookmarks(false);
              }}
            >
              <Globe size={12} />
              <span>{bm.title.replace(/^https?:\/\//, "").slice(0, 30)}</span>
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
        {!currentUrl && (
          <div className="browser-home">
            <Globe size={64} className="browser-home-icon" />
            <h2>AETHER-OS Browser</h2>
            <p>Enter a URL or search query above to get started.</p>
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
                    <span>{bm.title.replace(/^https?:\/\//, "").slice(0, 40)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {currentUrl && (
          <>
            <iframe
              ref={iframeRef}
              src={currentUrl}
              className="browser-iframe"
              onLoad={handleLoad}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
            />
            {showHint && (
              <div className="browser-hint">
                <span>Page not loading? It may block embedded viewing.</span>
                <div className="browser-hint-actions">
                  {browserInfo?.librewolf_installed && (
                    <button className="btn btn-primary browser-hint-btn" onClick={openInLibreWolf}>
                      <Shield size={14} />
                      LibreWolf
                    </button>
                  )}
                  <button className="btn btn-secondary browser-hint-btn" onClick={openExternal}>
                    <ExternalLink size={14} />
                    External
                  </button>
                  <button className="browser-hint-dismiss" onClick={() => setShowHint(false)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
