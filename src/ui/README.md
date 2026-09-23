# `src/ui` — AETHER-OS primitives

Import everything from `src/ui` (the barrel `index.ts`). Styles live in
`src/styles/components/*.css` and use only design tokens
(`src/styles/tokens.css`), so every primitive works in light and dark,
with every accent and both densities. Icons are `lucide-react` at 14/16/18.

```tsx
import { Button, IconButton, Modal, ViewHeader, useToast } from "../ui";
```

| Primitive | Use it for |
| --- | --- |
| `Button` | Text buttons. One `primary` per screen. |
| `IconButton` | Icon-only buttons — `label` is mandatory (a11y name + tooltip). |
| `Input`, `Textarea`, `Select`, `SearchField` | Form fields. |
| `Switch`, `Checkbox`, `SegmentedControl` | Binary / single-choice controls. |
| `Tabs` | Tab lists (you render the panel). |
| `Badge`, `Kbd`, `Spinner` | Small inline status. |
| `Card`, `ListRow`, `EmptyState` | Content containers. |
| `Modal`, `Popover`, `Tooltip` | Overlays (portaled to `document.body`). |
| `ToastProvider`, `useToast`, `toast` | Transient feedback (bottom-right). |
| `ViewHeader` | The header every view starts with. |

---

## Button

```tsx
<Button variant="primary" iconLeft={<Plus size={14} />} onClick={add}>New task</Button>
<Button variant="secondary" size="sm" loading={saving}>Save</Button>
```

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `variant` | `"primary" \| "secondary" \| "ghost" \| "danger"` | `"secondary"` | `danger` is soft until hover. |
| `size` | `"sm" \| "md"` | `"md"` | 26 / 32 px (24 / 28 px compact). |
| `loading` | `boolean` | `false` | Spinner, `aria-busy`, clicks blocked. |
| `iconLeft`, `iconRight` | `ReactNode` | — | |
| `fullWidth` | `boolean` | `false` | |
| …rest | `ButtonHTMLAttributes` | | `type` defaults to `"button"`. |

## IconButton

```tsx
<IconButton label="Toggle terminal" shortcut="mod+j" icon={<PanelBottom size={14} />} active={open} onClick={toggle} />
```

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `label` | `string` | **required** | `aria-label` and tooltip text. |
| `icon` | `ReactNode` | **required** | |
| `variant` | `"ghost" \| "secondary" \| "danger"` | `"ghost"` | |
| `size` | `"sm" \| "md"` | `"md"` | 24 / 28 px squares. |
| `active` | `boolean` | — | Sets `aria-pressed`. |
| `loading` | `boolean` | — | |
| `shortcut` | `string` | — | Shown in the tooltip (`mod+k`). |
| `tooltip` | `boolean` | `true` | |
| `tooltipPlacement` | `Placement` | `"top"` | |

## Input · Textarea · Select · SearchField

```tsx
<Input iconLeft={<Link2 size={14} />} placeholder="Paste a URL…" value={url} onChange={(e) => setUrl(e.target.value)} />
<Textarea rows={4} mono value={msg} onChange={(e) => setMsg(e.target.value)} />
<Select value={v} onChange={(e) => setV(e.target.value)} options={[{ value: "a", label: "A" }]} />
<SearchField value={q} onChange={setQ} onSubmit={run} shortcutHint="mod+k" />
```

- `Input`: `size` (`sm`/`md`/`lg`), `iconLeft`, `suffix`, `invalid`; the ref points at the `<input>`; `className` styles the wrapper, `inputClassName` the field.
- `Textarea`: `invalid`, `resizable` (default `true`), `mono`.
- `Select`: native `<select>` (keyboard + OS picker for free); `options` or `<option>` children, `size`, `iconLeft`, `invalid`.
- `SearchField`: `value`/`onChange(value)`, `onSubmit(value)` on Enter, Escape clears (then blurs), clear button, optional `shortcutHint`.

For labels use the field helpers from `form.css`:

```tsx
<div className="ui-field">
  <label className="ui-field-label" htmlFor="name">Name</label>
  <Input id="name" … />
  <span className="ui-field-hint">Shown in the sidebar.</span>
</div>
```

## Switch · Checkbox · SegmentedControl

```tsx
<Switch checked={on} onChange={setOn} label="Navigation labels" description="Show names in the rail" />
<Checkbox checked={all} indeterminate={some} onChange={(v) => setAll(v)} label="All notes" />
<SegmentedControl aria-label="View" value={view} onChange={setView}
  options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]} />
```

`Switch` is a `role="switch"` button; `Checkbox` is a native input with a
custom box; `SegmentedControl` is a `radiogroup` (←/→ move the selection).

## Tabs

```tsx
<Tabs aria-label="Import or export" value={tab} onChange={setTab}
  items={[{ id: "export", label: "Export", icon: <Download size={14} /> }, { id: "import", label: "Import", count: 3 }]} />
```

`variant`: `underline` (view level) or `pill` (in panels). Roving focus:
←/→ activate, Home/End jump. Pass `idPrefix` to wire `aria-controls`.

## Badge · Kbd · Spinner

```tsx
<Badge variant="success" dot>Connected</Badge>   // neutral | accent | success | warning | danger | info
<Kbd shortcut="mod+shift+n" />                     // renders ⇧ ⌘ N on macOS, Ctrl Shift N elsewhere
<Spinner size={14} label="Saving" />
```

## Card · ListRow · EmptyState

```tsx
<Card interactive padding="md" onClick={open}>…</Card>
<ListRow icon={<FileText size={14} />} title="Weekly review" description="2 days ago" meta="3"
  actions={<IconButton size="sm" label="Delete" icon={<Trash2 size={14} />} onClick={del} />}
  selected={active} onClick={select} />
<EmptyState icon={FolderGit2} title="No projects yet" description="Add a folder to scan."
  action={<Button variant="primary">Add folder</Button>} />
```

Interactive `Card`s and clickable `ListRow`s are keyboard-activatable
(Enter/Space). `ListRow` actions appear on hover/focus.

## Modal

```tsx
<Modal open={open} onClose={close} title="New project" description="…" icon={FolderKanban} size="sm"
  footerStart={<Button variant="danger">Delete</Button>}
  footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary">Create</Button></>}>
  …
</Modal>
```

| Prop | Notes |
| --- | --- |
| `size` | `sm` 400 · `md` 520 · `lg` 680 · `xl` 880 px |
| `position` | `center` (default) or `top` (palettes, capture) |
| `dismissible` | Escape / backdrop close (default `true`) |
| `initialFocusRef` | Otherwise the first focusable in the body gets focus |
| `hideCloseButton`, `headerActions`, `flush`, `aria-label` (no title) | |

Behaviour: portal, focus trap (Tab/Shift+Tab), Escape closes only the
top-most modal, focus returns to the opener, backdrop click must start and
end on the backdrop.

## Popover · Tooltip

```tsx
<Popover trigger={<Button>Filter</Button>} placement="bottom-start" aria-label="Filters">
  {(close) => <button className="ui-menu-item" onClick={close}>Only open</button>}
</Popover>

<Tooltip content="Notes" shortcut="mod+2" placement="right">
  <button>…</button>
</Tooltip>
```

Popover: click toggles, outside click / Escape close (focus returns to the
trigger). Tooltip: hover delay (default 450 ms, instant for a following
tooltip), instant on keyboard focus, hides on Escape/scroll/pointer down.
Both require a child that forwards its ref (all primitives do).

## Toast

```tsx
const toast = useToast();          // or: import { toast } from "../ui" outside React
toast.success("Saved");
toast.error("Sync failed", { description: err.message });
toast.info("Indexing…", { duration: 0, action: { label: "Open", onClick: open } });
```

`ToastProvider` is mounted once in `App`. Durations: success 3.5 s,
info 4 s, error 7 s; hover/focus pauses; at most 4 visible.

## ViewHeader

```tsx
<ViewHeader title="Projects" subtitle="4 projects in 1 folder"
  actions={<><SearchField … /><Button>Add folder</Button></>}
  tabs={<Tabs … />} />
```

`compact` for tool views, `bordered` when the body is full-bleed, optional
`icon`. Put the rest of the view in `<div className="view-body">`
(scroll container with the standard padding) inside `<div className="view">`.
