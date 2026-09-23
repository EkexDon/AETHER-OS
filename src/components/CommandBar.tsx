import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, FileText, ExternalLink, CornerDownLeft } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { openProject } from "../lib/ipc";
import { COMMAND_GROUPS, useCommands, isCommandEnabled, runCommand } from "../lib/commands/registry";
import { createCommandContext } from "../lib/commands/context";
import { scoreFields } from "../lib/commands/fuzzy";
import { Kbd, Modal, cx } from "../ui";

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  section: string;
  icon: React.ReactNode;
  shortcut?: string;
  score: number;
  run: () => void;
}

const PER_SECTION_LIMIT = 8;
const EMPTY_NOTES_LIMIT = 5;
const GROUP_ORDER: string[] = [
  COMMAND_GROUPS.navigation,
  COMMAND_GROUPS.capture,
  COMMAND_GROUPS.agent,
  COMMAND_GROUPS.general,
  COMMAND_GROUPS.appearance,
];

/**
 * Command palette (⌘K): registered commands, vault notes and projects in
 * one fuzzy list. Arrow keys move, Enter runs, Escape closes.
 */
export function CommandBar({ onClose }: { onClose: () => void }) {
  const { projects, vaultNotes, selectNote, setView } = useAetherStore();
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const ctx = createCommandContext();
    const q = query.trim();

    const commandItems: PaletteItem[] = commands
      .filter((c) => c.id !== "app.commandPalette" && isCommandEnabled(c, ctx))
      .map((c) => {
        const Icon = c.icon;
        return {
          id: `cmd:${c.id}`,
          label: c.title,
          hint: c.group,
          section: q ? "Commands" : c.group,
          icon: Icon ? <Icon size={15} /> : <CornerDownLeft size={15} />,
          shortcut: c.shortcut,
          score: scoreFields(q, c.title, [c.group, ...(c.keywords ?? [])]),
          run: () => {
            onClose();
            void runCommand(c.id).catch(() => undefined);
          },
        };
      });

    const noteItems: PaletteItem[] = vaultNotes.map((n) => ({
      id: `note:${n.path}`,
      label: n.name.replace(/\.md$/i, ""),
      hint: n.path.split("/").slice(-2, -1)[0] ?? "Note",
      section: q ? "Notes" : "Recent notes",
      icon: <FileText size={15} />,
      score: scoreFields(q, n.name, [n.path]),
      run: () => {
        selectNote(n.path);
        setView("editor");
        onClose();
      },
    }));

    const projectItems: PaletteItem[] = projects.map((p) => ({
      id: `project:${p.path}`,
      label: p.name,
      hint: "Open in Cursor",
      section: "Projects",
      icon: <ExternalLink size={15} />,
      score: scoreFields(q, p.name, [p.language, p.git_branch ?? ""]),
      run: () => {
        void openProject(p.path, "cursor").catch(() => openProject(p.path, "code"));
        onClose();
      },
    }));

    if (!q) {
      // Browse mode: groups in a fixed, useful order (navigation first);
      // groups contributed by features follow in registration order.
      const rank = (group: string) => {
        const i = GROUP_ORDER.indexOf(group);
        return i < 0 ? GROUP_ORDER.length : i;
      };
      const ordered = commandItems
        .map((item, i) => ({ item, i }))
        .sort((a, b) => rank(a.item.section) - rank(b.item.section) || a.i - b.i)
        .map(({ item }) => item);
      return [...ordered, ...noteItems.slice(0, EMPTY_NOTES_LIMIT)];
    }
    const rank = (list: PaletteItem[]) =>
      list
        .filter((i) => i.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, PER_SECTION_LIMIT);
    // Sections are ordered by their best hit so the strongest match leads.
    const sections = [rank(commandItems), rank(noteItems), rank(projectItems)].filter((s) => s.length > 0);
    sections.sort((a, b) => b[0].score - a[0].score);
    return sections.flat();
  }, [commands, vaultNotes, projects, query, onClose, selectNote, setView]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[selected]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastSection = "";

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      position="top"
      hideCloseButton
      flush
      aria-label="Command palette"
      className="cmdbar"
      initialFocusRef={inputRef as React.RefObject<HTMLElement>}
    >
      <div className="cmdbar-input-row">
        <Search size={16} />
        <input
          ref={inputRef}
          type="text"
          className="cmdbar-input"
          placeholder="Search views, commands, notes, projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdbar-results"
          aria-activedescendant={items[selected] ? `cmdbar-item-${selected}` : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        <Kbd>Esc</Kbd>
      </div>

      <div className="cmdbar-results" id="cmdbar-results" role="listbox" ref={listRef} aria-label="Results">
        {items.length === 0 ? (
          <div className="cmdbar-empty">
            No results for “{query.trim()}”
          </div>
        ) : (
          items.map((item, i) => {
            const header = item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            return (
              <React.Fragment key={item.id}>
                {header && <div className="cmdbar-section">{header}</div>}
                <div
                  id={`cmdbar-item-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === selected}
                  className={cx("cmdbar-item", i === selected && "cmdbar-item-active")}
                  onClick={() => item.run()}
                  onMouseMove={() => {
                    if (i !== selected) setSelected(i);
                  }}
                >
                  <span className="cmdbar-item-icon">{item.icon}</span>
                  <span className="cmdbar-item-label">{item.label}</span>
                  {query.trim() && <span className="cmdbar-item-hint">{item.hint}</span>}
                  {item.shortcut ? (
                    <Kbd shortcut={item.shortcut} className="cmdbar-item-kbd" />
                  ) : (
                    i === selected && <CornerDownLeft size={13} className="cmdbar-item-enter" />
                  )}
                </div>
              </React.Fragment>
            );
          })
        )}
      </div>

      <div className="cmdbar-footer">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span>
          <Kbd>↵</Kbd> run
        </span>
        <span>
          <Kbd>Esc</Kbd> close
        </span>
      </div>
    </Modal>
  );
}
