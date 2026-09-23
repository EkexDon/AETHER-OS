import { useEffect, useState } from "react";
import { Brain, Plus, Trash2, Tag } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getMemoryFacts, saveMemoryFact, deleteMemoryFact } from "../lib/ipc";
import { Button, EmptyState, IconButton, Input, ListRow, ViewHeader } from "../ui";

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
    <div className="view memory-panel">
      <ViewHeader
        title="AI Memory"
        subtitle={`${memoryFacts.length} fact${memoryFacts.length === 1 ? "" : "s"} the AI knows about you`}
      />
      <div className="view-body">
        <form
          className="memory-add"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
        >
          <Input
            className="memory-input"
            placeholder="e.g. I prefer Cursor as my editor"
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
            aria-label="New fact"
          />
          <Input
            className="memory-category-input"
            iconLeft={<Tag size={14} />}
            placeholder="category"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            aria-label="Category"
          />
          <Button type="submit" variant="primary" iconLeft={<Plus size={14} />} disabled={!newFact.trim()}>
            Remember
          </Button>
        </form>

        {error && <div className="projects-error memory-error">{error}</div>}

        {memoryFacts.length === 0 ? (
          <EmptyState
            icon={Brain}
            title="No memories yet"
            description="Add facts the AI should always know about you — preferences, projects, people."
          />
        ) : (
          <div className="memory-list">
            {Object.entries(byCategory).map(([category, facts]) => (
              <section key={category} className="memory-category">
                <h3 className="ui-section-label memory-category-header">
                  <Tag size={14} />
                  <span>{category}</span>
                  <span className="memory-category-count">{facts.length}</span>
                </h3>
                <div className="memory-card">
                  {facts.map((f) => (
                    <ListRow
                      key={f.fact}
                      className="memory-fact"
                      title={<span className="memory-fact-text">{f.fact}</span>}
                      meta={new Date(f.created_at * 1000).toLocaleDateString()}
                      actions={
                        <IconButton
                          label="Forget this"
                          size="sm"
                          variant="danger"
                          icon={<Trash2 size={14} />}
                          onClick={() => void handleDelete(f.fact)}
                        />
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
