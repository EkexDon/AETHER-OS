import React, { useState } from "react";
import { FileText, Sparkles } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { semanticSearch } from "../lib/ipc";
import { Button, EmptyState, SearchField, ViewHeader } from "../ui";

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
    <div className="view semantic-search">
      <ViewHeader
        title="Search"
        subtitle="Find notes by meaning, not keywords — powered by your local embeddings."
      />
      <div className="view-body">
        <form
          className="search-bar"
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault();
            void handleSearch();
          }}
        >
          <SearchField
            size="lg"
            value={query}
            onChange={setQuery}
            placeholder="Search by meaning, not keywords..."
            className="search-input"
            autoFocus
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!query.trim() || busy} className="search-submit">
            Search
          </Button>
        </form>

        {error && <div className="search-error">{error}</div>}

        {searchResults.length === 0 && !busy ? (
          <EmptyState
            icon={Sparkles}
            title="Results will appear here"
            description="Ask a question or describe an idea. Notes are ranked by semantic similarity — index the vault first from the status bar."
            className="search-empty"
          />
        ) : (
          <div className="search-results" role="list">
            {searchResults.map((result) => {
              const pct = Math.max(0, Math.min(100, result.score * 100));
              return (
                <button
                  key={result.id}
                  type="button"
                  role="listitem"
                  className="search-result-card"
                  onClick={() => handleOpen(result.id)}
                >
                  <div className="result-header">
                    <FileText size={14} className="result-icon" />
                    <span className="result-name">{result.id.split("/").pop()?.replace(/\.md$/, "")}</span>
                    <span className="result-path">{result.id.split("/").slice(-2, -1)[0] ?? ""}</span>
                    <span className="result-score" title="Semantic similarity">
                      <span className="result-score-bar" aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </span>
                      {(result.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="result-snippet">{result.text.slice(0, 200).replace(/[#*`\[\]]/g, "")}...</p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
