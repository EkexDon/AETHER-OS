import React, { useEffect, useState } from "react";
import { Brain, Plus, Trash2, Tag } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getMemoryFacts, saveMemoryFact, deleteMemoryFact } from "../lib/ipc";

export function MemoryPanel() {
  const { memoryFacts, setMemoryFacts } = useAetherStore();
  const [newFact, setNewFact] = useState("");
  const [newCategory, setNewCategory] = useState("general");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getMemoryFacts().then(setMemoryFacts).catch(() => {});
  }, [setMemoryFacts]);

  const handleAdd = async () => {
    if (!newFact.trim()) return;
    try {
      const facts = await saveMemoryFact(newFact.trim(), newCategory.trim() || "general");
      setMemoryFacts(facts);
      setNewFact("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (fact: string) => {
    try {
      const facts = await deleteMemoryFact(fact);
      setMemoryFacts(facts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const byCategory = memoryFacts.reduce<Record<string, typeof memoryFacts>>((acc, f) => {
    (acc[f.category] ??= []).push(f);
    return acc;
  }, {});

  return (
    <div className="memory-panel">
      <div className="memory-header">
        <Brain size={20} />
        <div>
          <h2 className="memory-title">AI Memory</h2>
          <p className="memory-subtitle">
            {memoryFacts.length} fact{memoryFacts.length === 1 ? "" : "s"} the AI knows about you
          </p>
        </div>
      </div>

      <div className="memory-add">
        <input
          type="text"
          className="memory-input"
          placeholder="e.g. I prefer Cursor as my editor"
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd();
          }}
        />
        <input
          type="text"
          className="memory-input memory-category-input"
          placeholder="category"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
        />
        <button className="btn btn-primary" onClick={() => void handleAdd()} disabled={!newFact.trim()}>
          <Plus size={16} /> Remember
        </button>
      </div>

      {error && <div className="projects-error">{error}</div>}

      {memoryFacts.length === 0 ? (
        <div className="projects-empty">
          <Brain size={48} className="dashboard-empty-icon" />
          <p>No memories yet. Add facts the AI should always know about you.</p>
        </div>
      ) : (
        <div className="memory-list">
          {Object.entries(byCategory).map(([category, facts]) => (
            <div key={category} className="memory-category">
              <div className="memory-category-header">
                <Tag size={12} />
                <span>{category}</span>
              </div>
              {facts.map((f) => (
                <div key={f.fact} className="memory-fact">
                  <span className="memory-fact-text">{f.fact}</span>
                  <span className="memory-fact-date">
                    {new Date(f.created_at * 1000).toLocaleDateString()}
                  </span>
                  <button
                    className="btn btn-icon memory-fact-delete"
                    onClick={() => void handleDelete(f.fact)}
                    title="Forget this"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
