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
import { AetherNotes } from "../components/AetherNotes";
import { MemoryPanel } from "../components/MemoryPanel";
import { Projects } from "../components/Projects";
import { TaskBoard } from "../components/TaskBoard";
import { SystemMonitor } from "../components/SystemMonitor";
import { Browser } from "../components/Browser";
import { registerCommands, viewNavigationCommands } from "../lib/commands/registry";
import type { ViewGroup, ViewMode } from "./modes";
// Feature view imports go directly above your anchor:
import { ClipboardList as ClipboardViewIcon } from "lucide-react";
const ClipboardView = lazy(() => import("../components/clipboard/ClipboardView").then((m) => ({ default: m.ClipboardView })));
// @anchor:view-import:clipboard
import { UniversalSearch } from "../components/search/UniversalSearch";
// @anchor:view-import:search
import { History as HistoryIcon } from "lucide-react";
const HistoryView = lazy(() => import("../components/history/HistoryView").then((m) => ({ default: m.HistoryView })));
// @anchor:view-import:history
// @anchor:view-import:home
import { ListChecks } from "lucide-react";
const VaultTasksView = lazy(() => import("../components/vaulttasks/VaultTasksView").then((m) => ({ default: m.VaultTasksView })));
// @anchor:view-import:vaulttasks
// @anchor:view-import:intel
import { Blocks as PluginsIcon } from "lucide-react";
const PluginsView = lazy(() => import("../components/plugins/PluginsView").then((m) => ({ default: m.PluginsView })));
// @anchor:view-import:plugins
import { exportView } from "../components/export/view";
// @anchor:view-import:export
import { ShieldCheck as SyncViewIcon } from "lucide-react";
const SyncView = lazy(() => import("../components/sync/SyncView").then((m) => ({ default: m.SyncView })));
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
    description: "Your day at a glance",
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
    component: UniversalSearch,
    description: "Search notes, files, apps, events, tasks and memory",
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
  { mode: "clipboard", label: "Clipboard", icon: ClipboardViewIcon, group: "system", component: ClipboardView, description: "Clipboard history — search, pin and re-copy" },
  // @anchor:view:clipboard
  // @anchor:view:search
  { mode: "history", label: "History", icon: HistoryIcon, group: "knowledge", component: HistoryView, description: "Every version of every note" },
  // @anchor:view:history
  // @anchor:view:home
  { mode: "vaulttasks", label: "Note Tasks", icon: ListChecks, group: "life", shortcut: "mod+alt+c", component: VaultTasksView, description: "Checkbox tasks from every note" },
  // @anchor:view:vaulttasks
  // @anchor:view:intel
  { mode: "plugins", label: "Plugins", icon: PluginsIcon, group: "system", component: PluginsView, description: "Sandboxed plugins, permissions and panels" },
  // @anchor:view:plugins
  exportView,
  // @anchor:view:export
  { mode: "sync", label: "Sync & Backup", icon: SyncViewIcon, group: "system", component: SyncView, description: "Encrypted multi-device sync and backups" },
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
