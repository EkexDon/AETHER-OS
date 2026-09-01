import React, { useState } from "react";
import { Search, FileText, Loader } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { semanticSearch } from "../lib/ipc";

export function SemanticSearch() {
  const { searchResults, setSearchResults, selectNote, setView, busy, setBusy } = useAetherStore();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      const results = await semanticSearch(query.trim(), 20);
      setSearchResults(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = (path: string) => {
    selectNote(path);
    setView("editor");
  };

  return (
    <div className="semantic-search">
      <div className="search-bar">
        <Search size={18} className="search-icon" />
        <input
          type="text"
          placeholder="Search by meaning, not keywords..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          className="search-input"
        />
        <button className="btn btn-primary" onClick={handleSearch} disabled={!query.trim() || busy}>
          {busy ? <Loader size={16} className="spin" /> : "Search"}
        </button>
      </div>

      {error && <div className="search-error">{error}</div>}

      <div className="search-results">
        {searchResults.length === 0 && !busy && (
          <div className="search-empty">
            <Search size={32} />
            <p>Results will appear here</p>
          </div>
        )}
        {searchResults.map((result) => (
          <div
            key={result.id}
            className="search-result-card"
            onClick={() => handleOpen(result.id)}
          >
            <div className="result-header">
              <FileText size={14} />
              <span className="result-name">
                {result.id.split("/").pop()?.replace(/\.md$/, "")}
              </span>
              <span className="result-score">
                {(result.score * 100).toFixed(1)}%
              </span>
            </div>
            <p className="result-snippet">
              {result.text.slice(0, 200).replace(/[#*`\[\]]/g, "")}...
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
