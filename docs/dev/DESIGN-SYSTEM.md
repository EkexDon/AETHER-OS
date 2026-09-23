# AETHER-OS Design System (v0.2)

The design foundation every view, feature and plugin builds on. Read this
before adding UI. Companion references: `src/styles/tokens.css` (the source
of truth for values), `src/ui/README.md` (primitive props) and
`docs/dev/SWARM-CONTRACT.md` §4–5 (rules and registry contracts).

## 1. Direction

**Warm graphite, one quiet accent, dense but airy.** AETHER-OS is a desktop
tool people live in all day, so it borrows from Linear (calm hierarchy,
precise spacing), Obsidian (reading comfort in notes) and Warp (a
keyboard-first command surface). Surfaces are near-neutral with a slight
warm tint so long sessions feel softer than blue-grey UIs; there is exactly
one accent (teal by default) and it only marks what matters: the primary
action, the active workspace, focus and selection. No gradients, no glow,
no purple.

Principles:

1. **Hierarchy through weight and tone, not color.** Primary text,
   secondary text and tertiary meta do most of the work; color is reserved
   for state (success/warning/danger/info) and the accent.
2. **Chrome recedes, content leads.** Rail, sidebars, toolbars and the
   status bar share one surface tone; the content canvas is its own tone.
3. **Every action has a keyboard path.** Commands carry shortcuts and show
   up in the palette (⌘K) and the shortcuts overlay (⌘/).
4. **Motion confirms, it never decorates.** 120–280 ms, ease-out, and
   everything respects `prefers-reduced-motion`.

## 2. Color

All colors are semantic tokens (`--color-*`) defined per theme. Components
never use raw hex values. Translucent fills/borders adapt to whatever
surface they sit on.

### Surfaces

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--color-bg` | `#131312` | `#f8f7f4` | Content canvas |
| `--color-surface` | `#181817` | `#f1efeb` | Rail, sidebars, toolbars, status bar |
| `--color-elevated` | `#1e1e1c` | `#fdfcfa` | Cards, inputs |
| `--color-overlay` | `#242422` | `#fefdfb` | Menus, popovers, modals |
| `--color-sunken` | `#0f0f0e` | `#f4f2ee` | Terminal, code wells |
| `--color-backdrop` | `rgba(10,9,8,.62)` | `rgba(38,34,28,.28)` | Modal backdrop |

Fills (`--color-fill-subtle/hover/active/strong`) and borders
(`--color-border-subtle`, `--color-border`, `--color-border-strong`) are
warm-white alpha in dark and warm-black alpha in light.

### Text

| Token | Dark | Light | Min. contrast (worst surface) |
| --- | --- | --- | --- |
| `--color-fg-primary` | `#ecebe6` | `#1d1c1a` | > 12:1 |
| `--color-fg-secondary` | `#adaba3` | `#56544e` | > 7:1 |
| `--color-fg-tertiary` | `#918f87` | `#6e6c65` | ≥ 4.5:1 (AA body) |
| `--color-fg-disabled` | `#5d5c56` | `#a8a59d` | decorative only |

Contrast was verified for every text token against every surface token in
both themes (WCAG AA, 4.5:1 for body text).

### Accent (exactly one active)

Chosen in Settings → Appearance, stored as `aether-accent`, applied as
`<html data-accent>`.

| Accent | Dark `--color-accent` | Light `--color-accent` | Text on accent |
| --- | --- | --- | --- |
| Teal (default) | `#3fb0a3` | `#1b7a70` | 6.7:1 / 4.9:1 |
| Ember | `#e27a4e` | `#b04e27` | 6.2:1 / 5.0:1 |
| Cobalt | `#6d9cf0` | `#2d5fc4` | 6.7:1 / 5.6:1 |
| Graphite | `#e3e0d8` | `#2b2a27` | 13.6:1 / 13.4:1 |

Each accent defines `--color-accent`, `-hover`, `-fg` (text on accent),
`-text` (accent used as text: links, active icons), `-soft` (tinted
background), `-border` and `--color-focus`. Budget: the accent should cover
well under 10 % of any screen — primary button, active rail indicator,
selected row tint, focus ring.

### State and data

`--color-success|warning|danger|info` plus `-soft` backgrounds. Data
visualisation (graph nodes, syntax, labels) uses the muted categorical
palette `--color-cat-1 … --color-cat-8`, tuned per theme so it never
competes with the accent. User-owned colors (calendar event colors,
project colors, note ink colors, programming-language dots) remain data and
are rendered as tints (`color-mix`) so they stay legible in both themes.

## 3. Typography

| Role | Family | Why |
| --- | --- | --- |
| UI | **IBM Plex Sans Variable** (`@fontsource-variable/ibm-plex-sans`) | Engineered grotesk with real character, excellent at 12–13 px, tabular figures; avoids the Inter/Roboto look. |
| Code, terminal, paths | **JetBrains Mono Variable** (`@fontsource-variable/jetbrains-mono`) | Tall x-height, clear 0/O and 1/l, ligatures for Monaco. |

Both are bundled (Tauri CSP `default-src 'self'`), imported in
`src/styles/index.css`. Scale (`--text-*`): 10 · 11 · 12 · **13 (UI body)**
· 14 · 16 · 20 · 24 · 30 px; UI line-height 1.5, reading text 1.65–1.72.
Large headings use `--tracking-tight` (-0.02em) or `--tracking-tighter`
(-0.035em for the note title); uppercase section labels use
`--tracking-wide` (0.06em) at 10–11 px.

## 4. Space, radius, elevation, motion

- **Spacing** — 4 px scale: `--space-1` (4) … `--space-12` (48), plus
  half steps `-0-5`, `-1-5`, `-2-5`, `-3-5` and `--space-16/24`. Vary rhythm:
  tight inside controls (4–8), comfortable inside cards (12–16), generous
  between sections (20–32).
- **Density** — `data-density="comfortable|compact"` switches
  `--control-h-sm/md/lg` (26/32/38 → 24/28/34), `--row-h` (28 → 24) and the
  view padding. Use these variables for control and row heights.
- **Radii (contextual)** — badge/kbd/chip `--radius-xs` 4, rows & small
  controls `--radius-sm` 6, buttons & inputs `--radius-md` 8, cards &
  popovers `--radius-lg` 12, modals `--radius-xl` 16. `--radius-full` only
  for dots, avatars, switches and tag pills — never containers.
- **Shadows (multi-layer)** — `--shadow-sm` (resting cards/buttons),
  `--shadow-md` (hover), `--shadow-lg` (toasts), `--shadow-pop` (menus,
  modals: hairline + two soft layers). `--shadow-inset-top` adds a 1 px top
  highlight to raised controls. Theme-independent control shading (same in
  light and dark, defined on `:root`): `--shadow-accent-raised` (raised
  accent surfaces: primary button, send), `--shadow-pressed` (pressed
  controls), `--shadow-knob` (switch knobs), `--shadow-well` (inset wells)
  and `--shadow-swatch-ring` (colour swatch rings); tooltip kbd chips use
  `--color-tooltip-kbd-bg` / `--color-tooltip-kbd-border`.
- **Icons** — `lucide-react` at 14, 16 or 18 px only: 14 for the status
  bar, rows, buttons and compact controls (the large majority), 16 for view
  header icons and small empty states, 18 for regular empty states.
- **Layers** — `--z-titlebar` 40 < `--z-dropdown` 100 < `--z-overlay`
  300 (modal backdrop) < `--z-popover` 400 < `--z-toast` 500 <
  `--z-tooltip` 600.
- **Motion** — `--motion-fast` 120 ms (hover/press), `--motion-base`
  180 ms (popovers, view switch), `--motion-slow` 280 ms (modals, toasts);
  `--ease-out` for entrances. Always list transition properties explicitly
  (never `transition: all`).
- **Focus** — `:focus-visible` everywhere: 2 px `--color-focus` outline
  with 2 px offset; fields show an accent border plus a 3 px
  `--color-accent-soft` ring.

## 5. Theming

- `src/lib/theme.ts` — preference `system | light | dark` persisted as
  `aether-theme`; the resolved theme is written to `<html data-theme>`,
  `color-scheme` and `<meta name="theme-color">`; `system` follows
  `matchMedia("(prefers-color-scheme: dark)")` live. Toggle: status bar
  sun/moon, command "Toggle light / dark theme" (⌘⇧L), Settings →
  Appearance.
- `src/lib/appearance.ts` — accent (`aether-accent`), density
  (`aether-density`) and rail labels (`aether-rail-expanded`).
- `index.html` applies all three before first paint (no flash).
- Canvas/JS surfaces read tokens through `src/lib/tokens.ts`
  (`readTokens`, `useTokens`, `onTokensChange`, `toHex`, `withAlpha`):
  xterm themes, Monaco themes (`aether-dark` / `aether-light`, regenerated
  on every theme/accent change), the knowledge graph canvas, monitor
  sparklines and mermaid diagrams all follow the theme.

## 6. Layout & shell

```
┌ titlebar 38px ── brand / view ─── ⌘K command pill ─── capture · clip · agent ┐
│ rail │ vault sidebar │ main (view-frame → .view)            │ agent panel │
│ 52px │ 232px, drag   │ ViewHeader + .view-body              │ 320px, drag │
└ status bar 26px ── vault · index · providers · [feature items] ── ⌘K · ⌘/ · theme ┘
```

- **Titlebar** (`src/shell/Titlebar.tsx`) keeps `data-tauri-drag-region`
  on every non-interactive part; macOS traffic lights sit in the 84 px
  left padding.
- **Nav rail** (`src/shell/NavRail.tsx`) — views grouped Knowledge ·
  Build · Life · System with thin separators; tooltips show label +
  shortcut; ⌘1–⌘9 jump to the first nine; "Show labels" (⌘\\) expands it
  to 204 px with group headings.
- **Views** render through `src/shell/ViewHost.tsx`: lazy views suspend
  with a spinner, `keepAlive` views stay mounted (hidden) after their first
  visit, each view sits in an error boundary that reports crashes via
  `reportFrontendError`.
- **Every view**: `<div className="view"><ViewHeader …/><div
  className="view-body">…</div></div>`; tool views with their own chrome
  (editor, IDE, terminal, browser, calendar, tasks) use a 36–56 px toolbar
  instead of a `ViewHeader`. Show an `EmptyState` when there is nothing,
  surface errors inline or with a toast.

## 7. Component inventory

Primitives (`src/ui`, see README): `Button`, `IconButton`, `Input`,
`Textarea`, `Select`, `Switch`, `Checkbox`, `Badge`, `Card`, `Tabs`,
`SegmentedControl`, `Modal`, `Popover`, `Tooltip`, `Kbd`, `EmptyState`,
`Spinner`, `Toast`/`ToastProvider`/`useToast`/`toast`, `ViewHeader`,
`ListRow`, `SearchField`, `Portal`.

Shell (`src/shell`): `Titlebar`, `NavRail`, `StatusBar` (+
`statusbar/registry.ts`, `statusbar/items.tsx`), `ViewHost`,
`ShellErrorBoundary`, `ShortcutsOverlay`, `NewNoteDialog`,
`useGlobalShortcuts`, `shellStore`, `BrandMark`.

Settings layout helpers (`src/settings/layout.tsx`): `SettingsPage`,
`SettingsGroup`, `SettingsRow`.

CSS utilities: `.ui-field`, `.ui-field-label`, `.ui-field-hint`,
`.ui-field-error`, `.ui-field-row`, `.ui-section-label`, `.ui-notice`
(`-danger|-success|-warning`), `.ui-menu-item`, `.context-menu`,
`.sr-only`, `.tabular`, `.mono`. Legacy classes used by older markup
(`.btn*`, `.settings-input`, `.event-editor-*`, `.engine-badge`) are
mapped onto the tokens in `components/legacy.css`; new code uses the
primitives.

## 8. Files

```
src/styles/
  index.css            entry: fonts → tokens → base → components → shell → views
  tokens.css           all tokens, both themes, accents, density
  base.css             reset, typography, focus, scrollbars, keyframes
  shell.css            titlebar, rail, vault sidebar, resizers, view frame, status bar
  components/*.css     one file per primitive group + legacy.css + markdown.css
  views/*.css          one file per view (feature views add their own)
```

## 9. Recipes

### Add a view

1. Add the mode to `ViewMode` in `src/views/modes.ts` above your
   `// @anchor:mode:<feature>`.
2. In `src/views/registry.tsx`, import your component (or declare a
   `lazy(() => import(...))`) above `// @anchor:view-import:<feature>` and
   add one entry above `// @anchor:view:<feature>`:

```tsx
{ mode: "clipboard", label: "Clipboard", icon: ClipboardList, group: "system",
  component: ClipboardView, description: "Clipboard history" },
```

The rail, the palette ("Go to Clipboard") and the shortcuts overlay pick
it up automatically. `mod+1…9` are taken; leave `shortcut` empty or ask
the orchestrator.

3. Build the view as `.view` → `ViewHeader` → `.view-body`. Put its styles
   in `src/styles/views/<feature>.css` and add one `@import` line to the
   "Feature views" block of `src/styles/index.css` — every stylesheet is
   imported exactly once there (components never import CSS, so styles are
   present before a lazy view's first render; `src/styles/styles.test.ts`
   checks it).

### Add a command

In `src/lib/commands/registry.ts` add the import above
`// @anchor:command-import:<feature>` and `...clipboardCommands,` above
`// @anchor:command:<feature>`:

```ts
export const clipboardCommands: CommandContribution[] = [{
  id: "clipboard.open", title: "Open clipboard history", group: "Clipboard",
  icon: ClipboardList, shortcut: "mod+shift+v", keywords: ["paste", "history"],
  run: (ctx) => ctx.setView("clipboard"),
}];
```

Runtime registration is also possible: `registerCommands([...])` returns an
unregister function. Shortcuts are global only as modifier combos and are
ignored when an editor already handled the key (`defaultPrevented`).

### Add a settings section

Import above `// @anchor:settings-import:<feature>`, add above
`// @anchor:settings:<feature>` in `src/settings/registry.tsx`:

```tsx
{ id: "sync", title: "Sync & Backup", icon: RefreshCw, order: 60, component: SyncSettings, keywords: ["backup"] },
```

Build the component with `SettingsPage` / `SettingsGroup` / `SettingsRow`.
Open it programmatically with `useShellStore.getState().openSettings("sync")`
or from a command via `ctx.openSettings("sync")`.

### Add a status bar item

Import above `// @anchor:status-import:<feature>` and register above
`// @anchor:status:<feature>` in `src/shell/statusbar/registry.ts`:

```ts
registerStatusItem({ id: "home.focus", order: 300, component: FocusTimerStatus, align: "right" });
```

Render a `<button className="statusbar-item">` (icon 14 px +
`.statusbar-muted` text) wrapped in a `Tooltip`. Items are isolated by an
error boundary.

### Add an always-mounted feature host

Overlays, start-up work and event subscriptions that must live for the
whole session (the onboarding wizard, the note-task quick-add dialog, the
plugin host bootstrap, the quit confirmation) go into `FEATURE_HOSTS` in
`src/shell/FeatureHosts.tsx`:

```ts
{ id: "onboarding.host", component: OnboardingHost },
```

`App` renders them once, outside the view host, each in its own error
boundary. Do not mount them through invisible status bar items.

### Checklist before shipping UI

- Only tokens — no hex/rgb in TSX or CSS (data colors excepted).
- Works in light and dark, with every accent and in compact density.
- Keyboard: reachable with Tab, visible focus, Escape closes overlays,
  primary actions registered as commands.
- Empty, loading and error states designed.
- No overflow at 1024×700 with sidebar and agent panel open.
