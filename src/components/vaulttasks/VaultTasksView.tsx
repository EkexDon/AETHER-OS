import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Columns3, FilterX, FolderOpen, LayoutList, ListChecks, NotebookText, RefreshCw, SearchX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import "../../styles/views/vaulttasks.css";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  SearchField,
  SegmentedControl,
  Select,
  Spinner,
  Switch,
  ViewHeader,
  useToast,
} from "../../ui";
import { useAetherStore } from "../../lib/store";
import { useShellStore } from "../../shell/shellStore";
import { useVaultTasksStore, type VaultTasksMode } from "../../lib/vaultTasksStore";
import {
  applyViewFilters,
  collectTags,
  hasActiveFilters,
  type DueFilter,
  type PriorityFilter,
} from "../../lib/vaulttasks/filters";
import { computeStats } from "../../lib/vaulttasks/stats";
import { BoardView } from "./BoardView";
import { ListView } from "./ListView";
import { NoteGroupsView } from "./NoteGroupsView";
import { QuickAddInline } from "./QuickAdd";
import { useToday } from "./useToday";

const MODES = [
  { value: "board" as const, label: "Board", icon: <Columns3 size={14} /> },
  { value: "list" as const, label: "List", icon: <LayoutList size={14} /> },
  { value: "notes" as const, label: "By note", icon: <NotebookText size={14} /> },
];

const DUE_OPTIONS: Array<{ value: DueFilter; label: string }> = [
  { value: "all", label: "Any date" },
  { value: "today", label: "Due today" },
  { value: "week", label: "This week" },
  { value: "overdue", label: "Overdue" },
  { value: "none", label: "No date" },
];

const PRIORITY_OPTIONS: Array<{ value: PriorityFilter; label: string }> = [
  { value: "all", label: "Any priority" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "No priority" },
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Note Tasks: every checkbox in every note as one list — Board by status,
 * List by due date, or grouped by note. Edits write back to the Markdown.
 */
export function VaultTasksView() {
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const openSettings = useShellStore((s) => s.openSettings);
  const toast = useToast();
  const today = useToday();
  const searchRef = useRef<HTMLInputElement>(null);
  const s = useVaultTasksStore(
    useShallow((st) => ({
      tasks: st.tasks,
      loaded: st.loaded,
      loading: st.loading,
      rescanning: st.rescanning,
      error: st.error,
      mode: st.mode,
      query: st.query,
      due: st.due,
      priority: st.priority,
      tag: st.tag,
      showCompleted: st.showCompleted,
      searchFocusToken: st.searchFocusToken,
    }))
  );
  const actions = useVaultTasksStore.getState();

  useEffect(() => {
    if (!vaultPath) return;
    // Errors are shown inline from the store's `error`.
    void useVaultTasksStore.getState().load().catch(() => undefined);
    const onFocus = () => void useVaultTasksStore.getState().load({ silent: true }).catch(() => undefined);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [vaultPath]);

  useEffect(() => {
    if (s.searchFocusToken > 0) searchRef.current?.focus();
  }, [s.searchFocusToken]);

  const filters = useMemo(
    () => ({ query: s.query, due: s.due, priority: s.priority, tag: s.tag, showCompleted: s.showCompleted }),
    [s.query, s.due, s.priority, s.tag, s.showCompleted]
  );
  const visible = useMemo(
    () => applyViewFilters(s.tasks, filters, today, s.mode === "board" ? true : filters.showCompleted),
    [s.tasks, filters, s.mode, today]
  );
  // By note counts progress over every matching task, completed or not.
  const noteScope = useMemo(
    () => (s.mode === "notes" ? applyViewFilters(s.tasks, filters, today, true) : visible),
    [s.tasks, filters, s.mode, today, visible]
  );
  const tags = useMemo(() => collectTags(s.tasks), [s.tasks]);
  const stats = useMemo(() => computeStats(s.tasks, today), [s.tasks, today]);
  const filtered = hasActiveFilters(filters);

  const rescan = async () => {
    try {
      const count = await actions.rescan();
      toast.success("Tasks rescanned", { description: `${count} task${count === 1 ? "" : "s"} across your notes.` });
    } catch (e) {
      toast.error("Rescan failed", { description: errorText(e) });
    }
  };

  const subtitle = s.loaded ? (
    <span className="vt-stats">
      <button type="button" className="vt-stat" onClick={() => actions.resetFilters()} title="Show all open tasks">
        <Badge variant="neutral" className="tabular">
          {stats.open} open
        </Badge>
      </button>
      {stats.due_today > 0 && (
        <button type="button" className="vt-stat" onClick={() => actions.showDuePreset("today")} title="Show tasks due today">
          <Badge variant="warning" dot className="tabular">
            {stats.due_today} due today
          </Badge>
        </button>
      )}
      {stats.overdue > 0 && (
        <button type="button" className="vt-stat" onClick={() => actions.showDuePreset("overdue")} title="Show overdue tasks">
          <Badge variant="danger" dot className="tabular">
            {stats.overdue} overdue
          </Badge>
        </button>
      )}
      <span className="vt-stats-note">
        {stats.by_note.length} note{stats.by_note.length === 1 ? "" : "s"}
      </span>
    </span>
  ) : (
    "Checkboxes from every note"
  );

  const header = (
    <ViewHeader
      title="Note Tasks"
      icon={ListChecks}
      subtitle={subtitle}
      actions={
        <>
          <SearchField
            ref={searchRef}
            size="sm"
            className="vt-search"
            placeholder="Search tasks…"
            aria-label="Search tasks"
            value={s.query}
            onChange={actions.setQuery}
            shortcutHint="mod+f"
          />
          <SegmentedControl<VaultTasksMode>
            aria-label="Layout"
            size="sm"
            value={s.mode}
            onChange={actions.setMode}
            options={MODES}
          />
          <IconButton
            label="Rescan notes"
            shortcut="mod+alt+r"
            icon={<RefreshCw size={14} />}
            loading={s.rescanning}
            disabled={!vaultPath}
            onClick={() => void rescan()}
          />
        </>
      }
    />
  );

  if (!vaultPath) {
    return (
      <div className="view vt-view">
        {header}
        <div className="view-body">
          <EmptyState
            icon={FolderOpen}
            title="No vault connected"
            description="Note Tasks collects every - [ ] checkbox from your Markdown notes. Connect a vault to begin."
            action={
              <Button variant="primary" onClick={() => openSettings("vault")}>
                Choose a vault
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  let content: ReactNode;
  if (!s.loaded && (s.loading || !s.error)) {
    content = (
      <div className="vt-loading">
        <Spinner size={18} label="Scanning notes for tasks" />
      </div>
    );
  } else if (!s.loaded && s.error) {
    content = (
      <div className="ui-notice ui-notice-danger vt-error" role="alert">
        <span>{s.error}</span>
        <Button size="sm" onClick={() => void actions.load().catch(() => undefined)}>
          Retry
        </Button>
      </div>
    );
  } else if (s.tasks.length === 0) {
    content = (
      <EmptyState
        icon={ListChecks}
        title="No tasks in your notes yet"
        description="Write “- [ ] something” in any note, or add one to today's daily note above."
      />
    );
  } else if (visible.length === 0) {
    content = (
      <EmptyState
        icon={SearchX}
        title={filtered ? "No tasks match these filters" : "All caught up"}
        description={
          filtered
            ? "Try another search or clear the filters."
            : "Every task is done. Turn on “Show completed” to see them."
        }
        action={
          filtered ? (
            <Button iconLeft={<FilterX size={14} />} onClick={actions.resetFilters}>
              Clear filters
            </Button>
          ) : (
            <Button onClick={() => actions.setShowCompleted(true)}>Show completed</Button>
          )
        }
      />
    );
  } else if (s.mode === "board") {
    content = <BoardView tasks={visible} today={today} />;
  } else if (s.mode === "notes") {
    content = <NoteGroupsView scope={noteScope} visible={visible} today={today} />;
  } else {
    content = <ListView tasks={visible} today={today} />;
  }

  return (
    <div className="view vt-view">
      {header}
      <div className="view-body vt-body">
        <div className="vt-toolbar">
          <QuickAddInline />
          <div className="vt-filters" role="group" aria-label="Filters">
            <Select
              size="sm"
              aria-label="Due date filter"
              value={s.due}
              onChange={(e) => actions.setDueFilter(e.target.value as DueFilter)}
              options={DUE_OPTIONS}
            />
            <Select
              size="sm"
              aria-label="Priority filter"
              value={s.priority}
              onChange={(e) => actions.setPriorityFilter(e.target.value as PriorityFilter)}
              options={PRIORITY_OPTIONS}
            />
            <Select
              size="sm"
              aria-label="Tag filter"
              value={s.tag ?? ""}
              onChange={(e) => actions.setTagFilter(e.target.value || null)}
              options={[
                { value: "", label: "All tags" },
                ...(s.tag && !tags.some((t) => t.toLowerCase() === s.tag?.toLowerCase())
                  ? [{ value: s.tag, label: `#${s.tag}` }]
                  : []),
                ...tags.map((t) => ({ value: t, label: `#${t}` })),
              ]}
            />
            {s.mode !== "board" && (
              <Switch checked={s.showCompleted} onChange={actions.setShowCompleted} label="Show completed" />
            )}
            {filtered && (
              <Button size="sm" variant="ghost" iconLeft={<FilterX size={14} />} onClick={actions.resetFilters}>
                Clear
              </Button>
            )}
          </div>
        </div>
        {content}
      </div>
    </div>
  );
}
