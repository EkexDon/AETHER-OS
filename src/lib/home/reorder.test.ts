import { describe, expect, it } from "vitest";
import { locateItem, moveItem, moveItemBy, reorder, reorderGroups } from "./reorder";

const item = (id: string) => ({ id });
const groups = () => [
  { id: "a", items: [item("1"), item("2"), item("3")] },
  { id: "b", items: [item("4")] },
  { id: "c", items: [] as { id: string }[] },
];
const ids = (gs: { id: string; items: { id: string }[] }[]) => gs.map((g) => `${g.id}:${g.items.map((i) => i.id).join("")}`);

describe("reorder", () => {
  it("moves an element to the target index", () => {
    expect(reorder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("clamps the target and ignores an invalid source", () => {
    expect(reorder(["a", "b"], 0, 99)).toEqual(["b", "a"]);
    expect(reorder(["a", "b"], 1, -4)).toEqual(["b", "a"]);
    expect(reorder(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const list = ["a", "b", "c"];
    reorder(list, 0, 2);
    expect(list).toEqual(["a", "b", "c"]);
  });
});

describe("moveItem", () => {
  it("locates items across groups", () => {
    expect(locateItem(groups(), "4")).toEqual({ groupIndex: 1, itemIndex: 0 });
    expect(locateItem(groups(), "x")).toBeNull();
  });

  it("reorders within a group using drop-indicator indices", () => {
    // Drop "1" before the element at index 2 ("3").
    expect(ids(moveItem(groups(), "1", "a", 2))).toEqual(["a:213", "b:4", "c:"]);
    // Drop "3" at the top.
    expect(ids(moveItem(groups(), "3", "a", 0))).toEqual(["a:312", "b:4", "c:"]);
    // Drop at the end.
    expect(ids(moveItem(groups(), "1", "a"))).toEqual(["a:231", "b:4", "c:"]);
  });

  it("returns the same reference for a no-op drop", () => {
    const gs = groups();
    expect(moveItem(gs, "2", "a", 1)).toBe(gs);
    expect(moveItem(gs, "2", "a", 2)).toBe(gs);
    expect(moveItem(gs, "nope", "a", 0)).toBe(gs);
    expect(moveItem(gs, "1", "nope", 0)).toBe(gs);
  });

  it("moves between groups, including into an empty one", () => {
    expect(ids(moveItem(groups(), "2", "b", 0))).toEqual(["a:13", "b:24", "c:"]);
    expect(ids(moveItem(groups(), "4", "c"))).toEqual(["a:123", "b:", "c:4"]);
    expect(ids(moveItem(groups(), "1", "b", 42))).toEqual(["a:23", "b:41", "c:"]);
  });

  it("keeps untouched groups by reference", () => {
    const gs = groups();
    const next = moveItem(gs, "1", "a", 3);
    expect(next[1]).toBe(gs[1]);
    expect(next[2]).toBe(gs[2]);
  });
});

describe("moveItemBy (keyboard)", () => {
  it("moves up and down inside a group", () => {
    expect(ids(moveItemBy(groups(), "2", -1))).toEqual(["a:213", "b:4", "c:"]);
    expect(ids(moveItemBy(groups(), "2", 1))).toEqual(["a:132", "b:4", "c:"]);
  });

  it("crosses into the neighbouring group at the edges", () => {
    expect(ids(moveItemBy(groups(), "3", 1))).toEqual(["a:12", "b:34", "c:"]);
    expect(ids(moveItemBy(groups(), "4", -1))).toEqual(["a:1234", "b:", "c:"]);
    expect(ids(moveItemBy(groups(), "4", 1))).toEqual(["a:123", "b:", "c:4"]);
  });

  it("stops at the very first and last position", () => {
    const gs = groups();
    expect(moveItemBy(gs, "1", -1)).toBe(gs);
    const last = [{ id: "a", items: [item("1")] }];
    expect(moveItemBy(last, "1", 1)).toBe(last);
    expect(moveItemBy(gs, "missing", 1)).toBe(gs);
  });
});

describe("reorderGroups", () => {
  it("moves whole groups", () => {
    expect(reorderGroups(groups(), 2, 0).map((g) => g.id)).toEqual(["c", "a", "b"]);
  });
});
