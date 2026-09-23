import { beforeEach, describe, expect, it } from "vitest";
import { countPins, defaultPinGroups, findPin, PINS_STORAGE_KEY, sanitizePinGroups, usePinsStore } from "./pinsStore";

const ids = () => usePinsStore.getState().groups.map((g) => `${g.name}:${g.items.map((i) => i.label).join(",")}`);

beforeEach(() => {
  window.localStorage.clear();
  usePinsStore.setState({ groups: defaultPinGroups() });
});

describe("pins store", () => {
  it("adds pins once per target and persists them", () => {
    const s = usePinsStore.getState();
    const a = s.addPin({ kind: "note", ref: "/v/a.md", label: "  Alpha   note " });
    const again = usePinsStore.getState().addPin({ kind: "note", ref: "/v/a.md", label: "Other" });
    expect(again.id).toBe(a.id);
    expect(a.label).toBe("Alpha note");
    expect(countPins(usePinsStore.getState().groups)).toBe(1);
    const stored = JSON.parse(window.localStorage.getItem(PINS_STORAGE_KEY) ?? "[]");
    expect(stored[0].items[0]).toMatchObject({ kind: "note", ref: "/v/a.md", label: "Alpha note" });
  });

  it("removes by id and by target", () => {
    const s = usePinsStore.getState();
    const a = s.addPin({ kind: "url", ref: "https://a.dev/", label: "A" });
    s.addPin({ kind: "project", ref: "/dev/x", label: "X" });
    usePinsStore.getState().removePin(a.id);
    expect(ids()).toEqual(["Pinned:X"]);
    expect(usePinsStore.getState().removePinByRef("project", "/dev/x")).toBe(true);
    expect(usePinsStore.getState().removePinByRef("project", "/dev/x")).toBe(false);
    expect(ids()).toEqual(["Pinned:"]);
  });

  it("manages groups and moves pins between them", () => {
    const s = usePinsStore.getState();
    s.addPin({ kind: "note", ref: "1", label: "one" });
    s.addPin({ kind: "note", ref: "2", label: "two" });
    const work = usePinsStore.getState().addGroup("  Work  ");
    const three = usePinsStore.getState().addPin({ kind: "note", ref: "3", label: "three" }, work.id);
    expect(ids()).toEqual(["Pinned:one,two", "Work:three"]);

    usePinsStore.getState().movePin(three.id, "pinned", 0);
    expect(ids()).toEqual(["Pinned:three,one,two", "Work:"]);

    const two = findPin(usePinsStore.getState().groups, "note", "2")!;
    usePinsStore.getState().movePinBy(two.id, 1);
    expect(ids()).toEqual(["Pinned:three,one", "Work:two"]);

    usePinsStore.getState().reorderPins("pinned", 0, 1);
    expect(ids()).toEqual(["Pinned:one,three", "Work:two"]);

    usePinsStore.getState().renameGroup(work.id, "Deep work");
    usePinsStore.getState().renameGroup(work.id, "   ");
    usePinsStore.getState().moveGroup(1, 0);
    expect(ids()).toEqual(["Deep work:two", "Pinned:one,three"]);

    // Deleting a group keeps its pins in the first remaining group.
    expect(usePinsStore.getState().removeGroup(work.id)).toBe(true);
    expect(ids()).toEqual(["Pinned:one,three,two"]);
    expect(usePinsStore.getState().removeGroup("pinned")).toBe(false);
  });

  it("renames pins, ignoring blank labels", () => {
    const p = usePinsStore.getState().addPin({ kind: "command", ref: "theme.toggle", label: "Theme" });
    usePinsStore.getState().renamePin(p.id, "Toggle theme");
    usePinsStore.getState().renamePin(p.id, "  ");
    expect(ids()).toEqual(["Pinned:Toggle theme"]);
  });
});

describe("sanitizePinGroups", () => {
  it("drops malformed entries, duplicates and unknown kinds", () => {
    const groups = sanitizePinGroups([
      {
        id: "g1",
        name: "Main",
        items: [
          { id: "a", kind: "note", ref: "/v/a.md", label: "A" },
          { id: "a", kind: "note", ref: "/v/b.md", label: "dup id" },
          { id: "b", kind: "note", ref: "/v/a.md", label: "dup target" },
          { id: "c", kind: "spaceship", ref: "x", label: "bad kind" },
          { id: "d", kind: "url", ref: "   ", label: "no ref" },
          { id: "e", kind: "url", ref: "https://x.dev", label: "", icon: "Globe" },
          "junk",
        ],
      },
      { id: "g1", name: "duplicate group", items: [] },
      { name: "no id" },
      null,
    ]);
    expect(groups).toEqual([
      {
        id: "g1",
        name: "Main",
        items: [
          { id: "a", kind: "note", ref: "/v/a.md", label: "A" },
          { id: "e", kind: "url", ref: "https://x.dev", label: "https://x.dev", icon: "Globe" },
        ],
      },
    ]);
  });

  it("falls back to the default group", () => {
    expect(sanitizePinGroups(null)).toEqual(defaultPinGroups());
    expect(sanitizePinGroups([])).toEqual(defaultPinGroups());
    expect(sanitizePinGroups([{ id: "x", items: [] }])[0].name).toBe("Untitled");
  });
});
