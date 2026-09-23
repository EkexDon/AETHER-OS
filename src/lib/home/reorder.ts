/**
 * Pure list/group reordering used by the pins store (drag-and-drop and the
 * alt+↑/↓ keyboard alternative). Every function returns new arrays and
 * leaves its inputs untouched; invalid positions are clamped, unknown ids
 * are no-ops (the original reference is returned).
 */

/** Anything with an id. */
export interface Identified {
  id: string;
}

/** A named container of identified items (e.g. a pin group). */
export interface Grouped<T extends Identified> extends Identified {
  items: T[];
}

/** Where an item lives. */
export interface ItemLocation {
  groupIndex: number;
  itemIndex: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Move the element at `from` so that it ends up at index `to` of the
 * resulting list.
 */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(clamp(to, 0, next.length), 0, moved);
  return next;
}

/** Find an item by id across groups. */
export function locateItem<T extends Identified>(groups: readonly Grouped<T>[], itemId: string): ItemLocation | null {
  for (let g = 0; g < groups.length; g++) {
    const i = groups[g].items.findIndex((item) => item.id === itemId);
    if (i >= 0) return { groupIndex: g, itemIndex: i };
  }
  return null;
}

/**
 * Move item `itemId` into group `toGroupId` at `toIndex` (index in the
 * target list *before* removal, like a drop indicator: dropping onto
 * position 3 of the same group places the item before the element that
 * was at index 3). `toIndex` defaults to the end.
 */
export function moveItem<G extends Grouped<T>, T extends Identified>(
  groups: readonly G[],
  itemId: string,
  toGroupId: string,
  toIndex?: number
): G[] {
  const from = locateItem(groups, itemId);
  const targetIndex = groups.findIndex((g) => g.id === toGroupId);
  if (!from || targetIndex < 0) return groups as G[];
  const item = groups[from.groupIndex].items[from.itemIndex];
  const targetLength = groups[targetIndex].items.length;
  let insertAt = clamp(toIndex ?? targetLength, 0, targetLength);
  if (from.groupIndex === targetIndex) {
    // Removing the item first shifts everything after it by one.
    if (insertAt > from.itemIndex) insertAt -= 1;
    if (insertAt === from.itemIndex) return groups as G[];
  }
  return groups.map((group, g) => {
    let items = group.items;
    if (g === from.groupIndex) items = items.filter((i) => i.id !== itemId);
    if (g === targetIndex) {
      items = [...items];
      items.splice(insertAt, 0, item);
    }
    return items === group.items ? group : { ...group, items };
  });
}

/**
 * Keyboard move: shift `itemId` by `delta` (−1 up, +1 down). At the top
 * or bottom of a group it crosses into the end of the previous / start of
 * the next group; at the very first / last position nothing changes.
 */
export function moveItemBy<G extends Grouped<T>, T extends Identified>(
  groups: readonly G[],
  itemId: string,
  delta: -1 | 1
): G[] {
  const loc = locateItem(groups, itemId);
  if (!loc) return groups as G[];
  const group = groups[loc.groupIndex];
  const target = loc.itemIndex + delta;
  if (target >= 0 && target < group.items.length) {
    return groups.map((g, i) =>
      i === loc.groupIndex ? { ...g, items: reorder(g.items, loc.itemIndex, target) } : g
    );
  }
  const neighbour = groups[loc.groupIndex + delta];
  if (!neighbour) return groups as G[];
  return moveItem(groups, itemId, neighbour.id, delta < 0 ? neighbour.items.length : 0);
}

/** Move a whole group from `from` to `to`. */
export function reorderGroups<G extends Identified>(groups: readonly G[], from: number, to: number): G[] {
  return reorder(groups, from, to);
}
