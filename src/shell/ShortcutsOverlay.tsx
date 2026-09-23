import { useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import { groupCommands, runCommand, useCommands } from "../lib/commands/registry";
import { scoreFields } from "../lib/commands/fuzzy";
import { EmptyState, Kbd, Modal, SearchField } from "../ui";

/** Shortcuts owned by individual editors (not global commands). */
const CONTEXT_SHORTCUTS: { group: string; items: { title: string; shortcut: string }[] }[] = [
  {
    group: "Notes editor",
    items: [
      { title: "Save note", shortcut: "mod+s" },
      { title: "Bold", shortcut: "mod+b" },
      { title: "Italic", shortcut: "mod+i" },
      { title: "Underline", shortcut: "mod+u" },
    ],
  },
  {
    group: "AI agent",
    items: [
      { title: "Send message", shortcut: "enter" },
      { title: "New line", shortcut: "shift+enter" },
    ],
  },
  {
    group: "IDE",
    items: [
      { title: "Save file", shortcut: "mod+s" },
      { title: "Commit staged changes", shortcut: "mod+enter" },
      { title: "Close diff", shortcut: "escape" },
    ],
  },
];

/** ⌘/ — every registered command grouped, plus editor-local shortcuts. */
export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const commands = useCommands();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim();
    const filtered = q
      ? commands.filter((c) => scoreFields(q, c.title, [c.group, ...(c.keywords ?? [])]) > 0)
      : commands;
    return groupCommands(filtered);
  }, [commands, query]);

  const contextGroups = useMemo(() => {
    const q = query.trim();
    if (!q) return CONTEXT_SHORTCUTS;
    return CONTEXT_SHORTCUTS.map((g) => ({
      ...g,
      items: g.items.filter((i) => scoreFields(q, i.title, [g.group]) > 0),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  const empty = groups.length === 0 && contextGroups.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Every command is also available in the command palette."
      icon={Keyboard}
      size="xl"
      className="shortcuts-modal"
      headerActions={
        <SearchField value={query} onChange={setQuery} placeholder="Filter shortcuts" size="sm" className="shortcuts-search" autoFocus />
      }
    >
      {empty ? (
        <EmptyState icon={Keyboard} title="No matching shortcuts" description="Try a different word." size="sm" />
      ) : (
        <div className="shortcuts-grid">
          {groups.map((g) => (
            <section key={g.group} className="shortcuts-group">
              <h3 className="ui-section-label">{g.group}</h3>
              <ul>
                {g.commands.map((c) => {
                  const Icon = c.icon;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="shortcuts-row"
                        onClick={() => {
                          onClose();
                          void runCommand(c.id).catch(() => undefined);
                        }}
                      >
                        {Icon && <Icon size={14} className="shortcuts-row-icon" />}
                        <span className="shortcuts-row-title">{c.title}</span>
                        {c.shortcut && <Kbd shortcut={c.shortcut} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {contextGroups.map((g) => (
            <section key={g.group} className="shortcuts-group">
              <h3 className="ui-section-label">{g.group}</h3>
              <ul>
                {g.items.map((i) => (
                  <li key={i.title} className="shortcuts-row is-static">
                    <span className="shortcuts-row-title">{i.title}</span>
                    <Kbd shortcut={i.shortcut} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
