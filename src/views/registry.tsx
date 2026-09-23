import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  NotebookPen,
  Search,
  Waypoints,
  Sparkles,
  Brain,
  CodeXml,
  FolderGit2,
  SquareTerminal,
  CalendarDays,
  SquareKanban,
  Activity,
  Globe,
} from "lucide-react";
import { Dashboard } from "../components/Dashboard";
import { NoteEditor } from "../components/NoteEditor";
import { SemanticSearch } from "../components/SemanticSearch";
import { AetherNotes } from "../components/AetherNotes";
import { MemoryPanel } from "../components/MemoryPanel";
import { Projects } from "../components/Projects";
import { TaskBoard } from "../components/TaskBoard";
import { SystemMonitor } from "../components/SystemMonitor";
import { Browser } from "../components/Browser";
import { registerCommands, viewNavigationCommands } from "../lib/commands/registry";
import type { ViewGroup, ViewMode } from "./modes";
// Feature view imports go directly above your anchor:
// @anchor:view-import:clipboard
// @anchor:view-import:search
// @anchor:view-import:history
// @anchor:view-import:home
// @anchor:view-import:vaulttasks
// @anchor:view-import:intel
// @anchor:view-import:plugins
// @anchor:view-import:export
// @anchor:view-import:sync
// @anchor:view-import:onboarding

/** A workspace the shell can navigate to. */
export interface ViewDefinition {
  /** String literal; add yours to `ViewMode` in `src/views/modes.ts`. */
  mode: ViewMode;
  label: string;
  icon: LucideIcon;
  group: ViewGroup;
  /** e.g. `"mod+1"`. */
  shortcut?: string;
  component: LazyExoticComponent<ComponentType> | ComponentType;
  /** Render hidden instead of unmounting once opened (terminal). */
  keepAlive?: boolean;
  hidesVaultSidebar?: boolean;
  /** One line shown in the palette / tooltips. */
  description?: string;
}

// Heavy views are split into their own chunks and fetched on first open.
const IdeView = lazy(() => import("../components/IdeView").then((m) => ({ default: m.IdeView })));
const CalendarView = lazy(() => import("../components/Calendar").then((m) => ({ default: m.Calendar })));
const GraphView = lazy(() => import("../components/VaultGraph").then((m) => ({ default: m.VaultGraph })));
const TerminalView = lazy(() => import("../components/Terminal").then((m) => ({ default: m.Terminal })));

/** All views, in navigation order within each group. */
export const VIEWS: ViewDefinition[] = [
  // ── Knowledge ──
  {
    mode: "dashboard",
    label: "Home",
    icon: LayoutDashboard,
    group: "knowledge",
    shortcut: "mod+1",
    component: Dashboard,
    description: "Vault overview and quick actions",
  },
  {
    mode: "editor",
    label: "Notes",
    icon: NotebookPen,
    group: "knowledge",
    shortcut: "mod+2",
    component: NoteEditor,
    description: "Write and link Markdown notes",
  },
  {
    mode: "search",
    label: "Search",
    icon: Search,
    group: "knowledge",
    shortcut: "mod+3",
    component: SemanticSearch,
    description: "Semantic search across the vault",
  },
  {
    mode: "graph",
    label: "Graph",
    icon: Waypoints,
    group: "knowledge",
    shortcut: "mod+4",
    component: GraphView,
    description: "Knowledge graph of wikilinks",
  },
  {
    mode: "notes",
    label: "AI Notes",
    icon: Sparkles,
    group: "knowledge",
    shortcut: "mod+5",
    component: AetherNotes,
    description: "Saved AI answers",
  },
  {
    mode: "memory",
    label: "Memory",
    icon: Brain,
    group: "knowledge",
    shortcut: "mod+6",
    component: MemoryPanel,
    description: "Facts the agent always knows",
  },
  // ── Build ──
  {
    mode: "ide",
    label: "IDE",
    icon: CodeXml,
    group: "build",
    shortcut: "mod+7",
    component: IdeView,
    hidesVaultSidebar: true,
    description: "Code editor with Git and LSP",
  },
  {
    mode: "projects",
    label: "Projects",
    icon: FolderGit2,
    group: "build",
    shortcut: "mod+8",
    component: Projects,
    description: "Git projects on this machine",
  },
  {
    mode: "terminal",
    label: "Terminal",
    icon: SquareTerminal,
    group: "build",
    shortcut: "mod+9",
    component: TerminalView,
    keepAlive: true,
    description: "Multi-tab shell",
  },
  // ── Life ──
  {
    mode: "calendar",
    label: "Calendar",
    icon: CalendarDays,
    group: "life",
    component: CalendarView,
    description: "Events, reminders, ICS import",
  },
  {
    mode: "tasks",
    label: "Tasks",
    icon: SquareKanban,
    group: "life",
    component: TaskBoard,
    description: "Projects and issue boards",
  },
  // ── System ──
  {
    mode: "monitor",
    label: "Monitor",
    icon: Activity,
    group: "system",
    component: SystemMonitor,
    description: "CPU, memory, disks, network",
  },
  {
    mode: "browser",
    label: "Browser",
    icon: Globe,
    group: "system",
    component: Browser,
    description: "Embedded web browser",
  },
  // @anchor:view:clipboard
  // @anchor:view:search
  // @anchor:view:history
  // @anchor:view:home
  // @anchor:view:vaulttasks
  // @anchor:view:intel
  // @anchor:view:plugins
  // @anchor:view:export
  // @anchor:view:sync
  // @anchor:view:onboarding
];

/** Look up a view by mode. */
export function getView(mode: ViewMode): ViewDefinition | undefined {
  return VIEWS.find((v) => v.mode === mode);
}

/** Views grouped for the navigation rail, preserving order. */
export function viewsByGroup(views: ViewDefinition[] = VIEWS): Map<ViewGroup, ViewDefinition[]> {
  const map = new Map<ViewGroup, ViewDefinition[]>();
  for (const v of views) {
    const list = map.get(v.group);
    if (list) list.push(v);
    else map.set(v.group, [v]);
  }
  return map;
}

registerCommands(viewNavigationCommands(VIEWS));
