import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({ indexVault: vi.fn() }));

import { getStatusItems, registerStatusItem } from "./registry";
import source from "./registry.ts?raw";

const A = () => null;

describe("status bar registry", () => {
  it("ships vault, indexing and provider items", () => {
    expect(getStatusItems().map((i) => i.id)).toEqual(
      expect.arrayContaining(["core.vault", "core.indexing", "core.providers"])
    );
  });

  it("sorts by order and unregisters", () => {
    const offLate = registerStatusItem({ id: "test.late", order: 999, component: A });
    const offEarly = registerStatusItem({ id: "test.early", order: 1, component: A, align: "right" });
    const ids = getStatusItems().map((i) => i.id);
    expect(ids[0]).toBe("test.early");
    expect(ids[ids.length - 1]).toBe("test.late");
    offLate();
    offEarly();
    expect(getStatusItems().some((i) => i.id.startsWith("test."))).toBe(false);
  });

  it("replaces an item registered under the same id", () => {
    const first = { id: "test.same", order: 5, component: A };
    const second = { id: "test.same", order: 6, component: A };
    const offFirst = registerStatusItem(first);
    const offSecond = registerStatusItem(second);
    expect(getStatusItems().filter((i) => i.id === "test.same")).toEqual([second]);
    offFirst(); // stale disposer is a no-op
    expect(getStatusItems().some((i) => i.id === "test.same")).toBe(true);
    offSecond();
  });

  it("has anchors for pomodoro (home), sync and clipboard", () => {
    for (const f of ["home", "sync", "clipboard"]) expect(source).toContain(`// @anchor:status:${f}`);
  });
});
