import { useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Check, FolderPlus, GripVertical, Pencil, Pin, Plus, Trash2, X } from "lucide-react";
import type { PinGroup, PinItem } from "../../types";
import { countPins, usePinsStore } from "../../lib/pinsStore";
import { useAetherStore } from "../../lib/store";
import { useCommands } from "../../lib/commands/registry";
import { locateItem } from "../../lib/home/reorder";
import {
  PIN_KIND_META,
  isPinStale,
  livePinDeps,
  normalizePinUrl,
  openPin,
  urlLabel,
} from "../../lib/home/pinActions";
import { formatShortcut } from "../../lib/shortcuts";
import { Badge, Button, EmptyState, IconButton, Input, ListRow, SegmentedControl, Select, cx, toast } from "../../ui";

/** MIME type carrying a pin id during drag-and-drop. */
export const PIN_DRAG_TYPE = "application/x-aether-pin";

export interface PinsPanelProps {
  /**
   * `compact` (Home, sidebar): pins with drag/keyboard reordering;
   * `full` (drawer): adds group management and a form to pin links and
   * commands.
   */
  variant?: "compact" | "full";
  /** Called after a pin was opened (e.g. to close the drawer). */
  onOpened?: () => void;
  className?: string;
}

interface DropTarget {
  groupId: string;
  index: number;
}

/**
 * Pinned notes, projects, commands, conversations and links, grouped and
 * reorderable by drag-and-drop or alt+↑/↓. Enter opens a pin, Delete
 * unpins it (with undo), ↑/↓ move between pins. Exported for the vault
 * sidebar as well.
 */
export function PinsPanel({ variant = "compact", onOpened, className }: PinsPanelProps) {
  const groups = usePinsStore((s) => s.groups);
  const notes = useAetherStore((s) => s.vaultNotes);
  const commands = useCommands();
  const commandIds = useMemo(() => new Set(commands.map((c) => c.id)), [commands]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);
  const total = countPins(groups);
  const full = variant === "full";

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    rowRefs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [groups]);

  const orderedIds = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);

  const open = async (pin: PinItem) => {
    try {
      await openPin(pin, livePinDeps());
      onOpened?.();
    } catch (e) {
      toast.error("Could not open pin", {
        description: e instanceof Error ? e.message : String(e),
        action: { label: "Unpin", onClick: () => usePinsStore.getState().removePin(pin.id) },
      });
    }
  };

  const remove = (pin: PinItem) => {
    const store = usePinsStore.getState();
    const loc = locateItem(store.groups, pin.id);
    const groupId = loc ? store.groups[loc.groupIndex].id : undefined;
    const next = orderedIds[orderedIds.indexOf(pin.id) + 1] ?? orderedIds[orderedIds.indexOf(pin.id) - 1];
    if (next) pendingFocus.current = next;
    store.removePin(pin.id);
    toast.success("Unpinned", {
      description: pin.label,
      action: {
        label: "Undo",
        onClick: () => {
          const s = usePinsStore.getState();
          const restored = s.addPin({ kind: pin.kind, ref: pin.ref, label: pin.label, icon: pin.icon }, groupId);
          if (groupId && loc) s.movePin(restored.id, groupId, loc.itemIndex);
        },
      },
    });
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, pin: PinItem) => {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      pendingFocus.current = pin.id;
      usePinsStore.getState().movePinBy(pin.id, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (!e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const i = orderedIds.indexOf(pin.id) + (e.key === "ArrowUp" ? -1 : 1);
      const target = orderedIds[i];
      if (target) rowRefs.current.get(target)?.focus();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(pin);
    }
  };

  const finishDrop = (e: DragEvent, target: DropTarget) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData(PIN_DRAG_TYPE) || dragId;
    setDrop(null);
    setDragId(null);
    if (id) usePinsStore.getState().movePin(id, target.groupId, target.index);
  };

  const rowDragOver = (e: DragEvent<HTMLDivElement>, groupId: string, index: number) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const at = before ? index : index + 1;
    if (drop?.groupId !== groupId || drop.index !== at) setDrop({ groupId, index: at });
  };

  const groupDragOver = (e: DragEvent<HTMLDivElement>, group: PinGroup) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drop?.groupId !== group.id || drop.index !== group.items.length) setDrop({ groupId: group.id, index: group.items.length });
  };

  if (total === 0 && !full) {
    return (
      <EmptyState
        size="sm"
        icon={Pin}
        title="Nothing pinned yet"
        description={`Press ${formatShortcut("mod+shift+d")} in a note, or use the pin button on any recent item.`}
        className={cx("home-pins-empty", className)}
      />
    );
  }

  const showGroupHeaders = full || groups.length > 1;

  return (
    <div className={cx("home-pins", `home-pins-${variant}`, className)}>
      {total === 0 && (
        <EmptyState
          size="sm"
          icon={Pin}
          title="Nothing pinned yet"
          description={`Press ${formatShortcut("mod+shift+d")} in a note, use the pin button on recent items, or add a link below.`}
        />
      )}
      {groups.map((group) => {
        const groupDrop = drop?.groupId === group.id;
        return (
          <div key={group.id} className="home-pin-group">
            {showGroupHeaders && <GroupHeader group={group} editable={full} canDelete={groups.length > 1} />}
            <div
              className={cx("home-pin-list", groupDrop && group.items.length === 0 && "is-drop-target")}
              role="list"
              aria-label={group.name}
              onDragOver={(e) => groupDragOver(e, group)}
              onDrop={(e) => finishDrop(e, { groupId: group.id, index: group.items.length })}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
              }}
            >
              {group.items.length === 0 && full && <div className="home-pin-placeholder">Drop pins here</div>}
              {group.items.map((pin, index) => {
                const meta = PIN_KIND_META[pin.kind];
                const Icon = meta.icon;
                const stale = isPinStale(pin, notes, commandIds);
                const dropBefore = groupDrop && drop.index === index;
                const dropAfter = groupDrop && index === group.items.length - 1 && drop.index === group.items.length;
                return (
                  <div key={pin.id} role="listitem" className="home-pin-item">
                    <ListRow
                      ref={(el) => {
                        if (el) rowRefs.current.set(pin.id, el);
                        else rowRefs.current.delete(pin.id);
                      }}
                      className={cx(
                        "home-pin-row",
                        stale && "is-stale",
                        dragId === pin.id && "is-dragging",
                        dropBefore && "is-drop-before",
                        dropAfter && "is-drop-after"
                      )}
                      draggable
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete"
                      aria-roledescription="Pin"
                      icon={
                        <>
                          <span className="home-pin-grip" aria-hidden="true">
                            <GripVertical size={14} />
                          </span>
                          <Icon size={14} />
                        </>
                      }
                      title={pin.label}
                      description={full ? (stale ? `${meta.label} · not found` : `${meta.label} · ${pinDetail(pin)}`) : undefined}
                      meta={stale && !full ? <Badge variant="warning">Missing</Badge> : undefined}
                      actions={
                        <IconButton size="sm" label={`Unpin ${pin.label}`} icon={<X size={14} />} onClick={() => remove(pin)} />
                      }
                      onClick={() => void open(pin)}
                      onKeyDown={(e) => onRowKeyDown(e, pin)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PIN_DRAG_TYPE, pin.id);
                        e.dataTransfer.setData("text/plain", pin.label);
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(pin.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDrop(null);
                      }}
                      onDragOver={(e) => rowDragOver(e, group.id, index)}
                      onDrop={(e) => finishDrop(e, drop ?? { groupId: group.id, index })}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {full && <PanelFooter groups={groups} />}
    </div>
  );
}

/** Secondary line for full-variant rows. */
function pinDetail(pin: PinItem): string {
  switch (pin.kind) {
    case "url":
      return urlLabel(pin.ref);
    case "note":
    case "project": {
      const parts = pin.ref.split(/[\\/]/).filter(Boolean);
      return parts.slice(-2, -1)[0] ?? pin.ref;
    }
    default:
      return pin.ref;
  }
}

function GroupHeader({ group, editable, canDelete }: { group: PinGroup; editable: boolean; canDelete: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);

  const commit = () => {
    const clean = name.trim();
    if (clean && clean !== group.name) usePinsStore.getState().renameGroup(group.id, clean);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="home-pin-group-header is-editing">
        <Input
          size="sm"
          autoFocus
          aria-label="Group name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setName(group.name);
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
        <IconButton size="sm" label="Save group name" icon={<Check size={14} />} onMouseDown={(e) => e.preventDefault()} onClick={commit} />
      </div>
    );
  }

  return (
    <div className="home-pin-group-header">
      <span className="ui-section-label home-pin-group-name" onDoubleClick={editable ? () => setEditing(true) : undefined}>
        {group.name}
        <span className="home-pin-group-count">{group.items.length}</span>
      </span>
      {editable && (
        <span className="home-pin-group-actions">
          <IconButton
            size="sm"
            label={`Rename ${group.name}`}
            icon={<Pencil size={14} />}
            onClick={() => {
              setName(group.name);
              setEditing(true);
            }}
          />
          <IconButton
            size="sm"
            label={canDelete ? `Delete ${group.name}` : "The last group cannot be deleted"}
            icon={<Trash2 size={14} />}
            disabled={!canDelete}
            onClick={() => {
              const moved = group.items.length;
              const target = usePinsStore.getState().groups.find((g) => g.id !== group.id)?.name ?? "";
              if (usePinsStore.getState().removeGroup(group.id)) {
                toast.success(`Deleted "${group.name}"`, {
                  description: moved > 0 ? `${moved} pin${moved === 1 ? "" : "s"} moved to "${target}".` : undefined,
                });
              }
            }}
          />
        </span>
      )}
    </div>
  );
}

/** "New group" + "Pin a link or command" (drawer only). */
function PanelFooter({ groups }: { groups: PinGroup[] }) {
  const commands = useCommands();
  const [mode, setMode] = useState<"url" | "command">("url");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [commandId, setCommandId] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState<string | null>(null);

  const targetGroup = groups.some((g) => g.id === groupId) ? groupId : groups[0]?.id;
  const commandOptions = useMemo(
    () =>
      [...commands]
        .filter((c) => !c.id.startsWith("home.") || c.id === "home.toggleTimer" || c.id === "home.toggleFocusMode")
        .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title))
        .map((c) => ({ value: c.id, label: `${c.group} · ${c.title}` })),
    [commands]
  );

  const add = () => {
    setError(null);
    const store = usePinsStore.getState();
    if (mode === "url") {
      const ref = normalizePinUrl(url);
      if (!ref) {
        setError("Enter a web address like https://example.com");
        return;
      }
      const pin = store.addPin({ kind: "url", ref, label: label.trim() || urlLabel(ref) }, targetGroup);
      toast.success("Link pinned", { description: pin.label });
      setUrl("");
      setLabel("");
      return;
    }
    const command = commands.find((c) => c.id === commandId);
    if (!command) {
      setError("Choose a command to pin");
      return;
    }
    const pin = store.addPin({ kind: "command", ref: command.id, label: command.title }, targetGroup);
    toast.success("Command pinned", { description: pin.label });
    setCommandId("");
  };

  const createGroup = () => {
    const name = (newGroup ?? "").trim();
    if (!name) {
      setNewGroup(null);
      return;
    }
    const group = usePinsStore.getState().addGroup(name);
    setGroupId(group.id);
    setNewGroup(null);
  };

  return (
    <div className="home-pins-footer">
      <form
        className="home-pin-form"
        aria-label="Pin a link or command"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="home-pin-form-row">
          <span className="ui-section-label">Add pin</span>
          <SegmentedControl
            size="sm"
            aria-label="Pin type"
            value={mode}
            onChange={(v) => {
              setMode(v);
              setError(null);
            }}
            options={[
              { value: "url", label: "Link" },
              { value: "command", label: "Command" },
            ]}
          />
        </div>
        {mode === "url" ? (
          <>
            <Input
              size="sm"
              aria-label="Web address"
              placeholder="https://…"
              value={url}
              invalid={!!error}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input size="sm" aria-label="Label (optional)" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
          </>
        ) : (
          <Select
            size="sm"
            aria-label="Command"
            value={commandId}
            invalid={!!error}
            onChange={(e) => setCommandId(e.target.value)}
            options={[{ value: "", label: "Choose a command…" }, ...commandOptions]}
          />
        )}
        {groups.length > 1 && (
          <Select
            size="sm"
            aria-label="Group"
            value={targetGroup}
            onChange={(e) => setGroupId(e.target.value)}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
        )}
        {error && (
          <span className="ui-field-error" role="alert">
            {error}
          </span>
        )}
        <Button type="submit" size="sm" iconLeft={<Plus size={14} />}>
          Pin {mode === "url" ? "link" : "command"}
        </Button>
      </form>

      {newGroup === null ? (
        <Button variant="ghost" size="sm" iconLeft={<FolderPlus size={14} />} onClick={() => setNewGroup("")}>
          New group
        </Button>
      ) : (
        <div className="home-pin-new-group">
          <Input
            size="sm"
            autoFocus
            aria-label="New group name"
            placeholder="Group name"
            maxLength={60}
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                createGroup();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setNewGroup(null);
              }
            }}
          />
          <Button size="sm" onClick={createGroup}>
            Create
          </Button>
        </div>
      )}
    </div>
  );
}
