/**
 * Every workspace (view) the shell can show. Feature agents add their mode
 * as a new union member directly above their anchor and register the view
 * in `src/views/registry.tsx`.
 */
export type ViewMode =
  | "dashboard"
  | "editor"
  | "search"
  | "graph"
  | "notes"
  | "memory"
  | "ide"
  | "projects"
  | "terminal"
  | "calendar"
  | "tasks"
  | "monitor"
  | "browser"
  // @anchor:mode:clipboard
  // @anchor:mode:search
  // @anchor:mode:history
  // @anchor:mode:home
  // @anchor:mode:vaulttasks
  // @anchor:mode:intel
  // @anchor:mode:plugins
  // @anchor:mode:export
  // @anchor:mode:sync
  // @anchor:mode:onboarding
  ;

/** Navigation groups, in rail order. */
export type ViewGroup = "knowledge" | "build" | "life" | "system";

export const VIEW_GROUPS: { id: ViewGroup; label: string }[] = [
  { id: "knowledge", label: "Knowledge" },
  { id: "build", label: "Build" },
  { id: "life", label: "Life" },
  { id: "system", label: "System" },
];

/** The view the app opens with. */
export const DEFAULT_VIEW: ViewMode = "dashboard";
