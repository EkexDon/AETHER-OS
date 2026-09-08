export const CALENDAR_COLORS = [
  "#7c3aed", // aether purple (default)
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#14b8a6", // teal
  "#6b7280", // gray
] as const;

export const DEFAULT_CALENDAR_COLOR = CALENDAR_COLORS[0];

export type CalendarColor = (typeof CALENDAR_COLORS)[number];