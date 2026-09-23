/**
 * Pins (bookmarks) for notes, projects, commands, AI conversations and
 * URLs, organised in ordered groups. Persisted in localStorage under
 * `aether-pins`; pure reordering lives in `src/lib/home/reorder.ts`.
 */
import { create } from "zustand";
import type { PinGroup, PinItem, PinKind } from "../types";
import { moveItem, moveItemBy, reorder, reorderGroups } from "./home/reorder";

/** localStorage key of the persisted groups. */
export const PINS_STORAGE_KEY = "aether-pins";
/** Id of the group created on first run. */
export const DEFAULT_PIN_GROUP_ID = "pinned";

const PIN_KINDS: PinKind[] = ["note", "project", "command", "conversation", "url"];
const MAX_LABEL = 200;
const MAX_GROUP_NAME = 60;

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The first-run state: one empty "Pinned" group. */
export function defaultPinGroups(): PinGroup[] {
  return [{ id: DEFAULT_PIN_GROUP_ID, name: "Pinned", items: [] }];
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * Validate persisted/foreign data: drops malformed pins, duplicate ids and
 * duplicate targets, and guarantees at least one group.
 */
export function sanitizePinGroups(raw: unknown): PinGroup[] {
  if (!Array.isArray(raw)) return defaultPinGroups();
  const groupIds = new Set<string>();
  const pinIds = new Set<string>();
  const targets = new Set<string>();
  const groups: PinGroup[] = [];
  for (const g of raw) {
    if (typeof g !== "object" || g === null) continue;
    const group = g as Record<string, unknown>;
    const id = typeof group.id === "string" && group.id ? group.id : null;
    if (!id || groupIds.has(id)) continue;
    groupIds.add(id);
    const items: PinItem[] = [];
    for (const it of Array.isArray(group.items) ? group.items : []) {
      if (typeof it !== "object" || it === null) continue;
      const item = it as Record<string, unknown>;
      const kind = PIN_KINDS.includes(item.kind as PinKind) ? (item.kind as PinKind) : null;
      const ref = typeof item.ref === "string" ? item.ref.trim() : "";
      const pinId = typeof item.id === "string" && item.id ? item.id : null;
      if (!kind || !ref || !pinId || pinIds.has(pinId) || targets.has(`${kind}:${ref}`)) continue;
      pinIds.add(pinId);
      targets.add(`${kind}:${ref}`);
      const label = cleanText(item.label, MAX_LABEL) || ref;
      const icon = typeof item.icon === "string" && item.icon ? item.icon : undefined;
      items.push(icon ? { id: pinId, kind, ref, label, icon } : { id: pinId, kind, ref, label });
    }
    groups.push({ id, name: cleanText(group.name, MAX_GROUP_NAME) || "Untitled", items });
  }
  return groups.length > 0 ? groups : defaultPinGroups();
}

function load(): PinGroup[] {
  try {
    const raw = window.localStorage.getItem(PINS_STORAGE_KEY);
    return raw ? sanitizePinGroups(JSON.parse(raw)) : defaultPinGroups();
  } catch {
    return defaultPinGroups();
  }
}

function save(groups: PinGroup[]): void {
  try {
    window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // storage unavailable (private mode) — pins still work for this session
  }
}

/** What `addPin` needs; the id is generated. */
export type NewPin = Omit<PinItem, "id">;

interface PinsState {
  groups: PinGroup[];
  /**
   * Pin a target. Returns the new pin, or the existing one when the same
   * `kind` + `ref` is already pinned (nothing changes then).
   */
  addPin: (pin: NewPin, groupId?: string) => PinItem;
  removePin: (id: string) => void;
  /** Unpin by target; returns whether something was removed. */
  removePinByRef: (kind: PinKind, ref: string) => boolean;
  renamePin: (id: string, label: string) => void;
  /** Drag-and-drop: move into `toGroupId` before index `toIndex` (default end). */
  movePin: (id: string, toGroupId: string, toIndex?: number) => void;
  /** Keyboard: one step up (−1) or down (+1), crossing group borders. */
  movePinBy: (id: string, delta: -1 | 1) => void;
  reorderPins: (groupId: string, from: number, to: number) => void;
  addGroup: (name: string) => PinGroup;
  renameGroup: (id: string, name: string) => void;
  /**
   * Delete a group; its pins move to the first remaining group. The last
   * group cannot be deleted (returns `false`).
   */
  removeGroup: (id: string) => boolean;
  moveGroup: (from: number, to: number) => void;
  /** Replace everything (sanitised). */
  replaceAll: (groups: unknown) => void;
}

export const usePinsStore = create<PinsState>((set, get) => ({
  groups: load(),

  addPin: (pin, groupId) => {
    const ref = pin.ref.trim();
    const existing = findPin(get().groups, pin.kind, ref);
    if (existing) return existing;
    const item: PinItem = {
      id: newId(),
      kind: pin.kind,
      ref,
      label: cleanText(pin.label, MAX_LABEL) || ref,
      ...(pin.icon ? { icon: pin.icon } : {}),
    };
    set((s) => {
      const target = s.groups.find((g) => g.id === groupId) ?? s.groups[0];
      return { groups: s.groups.map((g) => (g.id === target.id ? { ...g, items: [...g.items, item] } : g)) };
    });
    return item;
  },

  removePin: (id) =>
    set((s) => ({
      groups: s.groups.map((g) => (g.items.some((i) => i.id === id) ? { ...g, items: g.items.filter((i) => i.id !== id) } : g)),
    })),

  removePinByRef: (kind, ref) => {
    const pin = findPin(get().groups, kind, ref);
    if (!pin) return false;
    get().removePin(pin.id);
    return true;
  },

  renamePin: (id, label) => {
    const clean = cleanText(label, MAX_LABEL);
    if (!clean) return;
    set((s) => ({
      groups: s.groups.map((g) =>
        g.items.some((i) => i.id === id) ? { ...g, items: g.items.map((i) => (i.id === id ? { ...i, label: clean } : i)) } : g
      ),
    }));
  },

  movePin: (id, toGroupId, toIndex) => set((s) => ({ groups: moveItem(s.groups, id, toGroupId, toIndex) })),

  movePinBy: (id, delta) => set((s) => ({ groups: moveItemBy(s.groups, id, delta) })),

  reorderPins: (groupId, from, to) =>
    set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, items: reorder(g.items, from, to) } : g)) })),

  addGroup: (name) => {
    const group: PinGroup = { id: newId(), name: cleanText(name, MAX_GROUP_NAME) || "New group", items: [] };
    set((s) => ({ groups: [...s.groups, group] }));
    return group;
  },

  renameGroup: (id, name) => {
    const clean = cleanText(name, MAX_GROUP_NAME);
    if (!clean) return;
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) }));
  },

  removeGroup: (id) => {
    const { groups } = get();
    const index = groups.findIndex((g) => g.id === id);
    if (index < 0 || groups.length <= 1) return false;
    const removed = groups[index];
    const rest = groups.filter((g) => g.id !== id);
    rest[0] = { ...rest[0], items: [...rest[0].items, ...removed.items] };
    set({ groups: rest });
    return true;
  },

  moveGroup: (from, to) => set((s) => ({ groups: reorderGroups(s.groups, from, to) })),

  replaceAll: (groups) => set({ groups: sanitizePinGroups(groups) }),
}));

usePinsStore.subscribe((state, prev) => {
  if (state.groups !== prev.groups) save(state.groups);
});

/** The pin for `kind` + `ref`, if any. */
export function findPin(groups: PinGroup[], kind: PinKind, ref: string): PinItem | undefined {
  for (const g of groups) {
    const hit = g.items.find((i) => i.kind === kind && i.ref === ref);
    if (hit) return hit;
  }
  return undefined;
}

/** React hook: is `kind` + `ref` pinned? */
export function useIsPinned(kind: PinKind, ref: string | null | undefined): boolean {
  return usePinsStore((s) => (ref ? findPin(s.groups, kind, ref) !== undefined : false));
}

/** Total number of pins. */
export function countPins(groups: PinGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}
