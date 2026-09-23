/**
 * Colours users can give calendar events, imported calendars and task
 * projects. They are user data (stored as `#rrggbb`), so they are not theme
 * tokens — but every swatch keeps at least 3:1 contrast (WCAG non-text)
 * against the canvas and card surfaces of both the dark and the light
 * theme, and views render them as tints (`color-mix`) for backgrounds.
 */
export const CALENDAR_COLORS = [
  "#0f9d8a", // teal (default, matches the backend's default event colour)
  "#3b7dd8", // blue
  "#8466d6", // violet
  "#3f9142", // green
  "#b7791b", // amber
  "#d0533f", // red
  "#c94f86", // rose
  "#6f7b8c", // slate
] as const;

/** Colour of new events and projects unless the user picks another one. */
export const DEFAULT_CALENDAR_COLOR = CALENDAR_COLORS[0];

export type CalendarColor = (typeof CALENDAR_COLORS)[number];
