import { beforeEach, describe, expect, it } from "vitest";
import type { IndexReport, KindReport, RecentHit, SearchHit, SearchSettings, SearchStatus } from "../../types";
import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "./backend";
import { MOCK_APPS, plainText, snippetFor, terms, validateShortcut } from "./search";

const query = (q: string, extra: Record<string, unknown> = {}) =>
  mockInvoke<SearchHit[]>("cmd_search_query", { q, kinds: null, limit: 40, perKind: null, semantic: false, ...extra });

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("mock search index", () => {
  it("finds notes with marked, escaped snippets", async () => {
    const hits = await query("ownership");
    const note = hits.find((h) => h.kind === "note");
    expect(note).toBeDefined();
    expect(note!.snippet_html).toMatch(/<mark>ownership<\/mark>/i);
    expect(note!.id.startsWith("note:")).toBe(true);
    expect(hits[0].score).toBe(1);
  });

  it("covers every kind", async () => {
    const status = await mockInvoke<SearchStatus>("cmd_search_status");
    const kinds = status.counts.map((c) => c.kind);
    for (const kind of ["note", "project", "file", "memory", "event", "task", "app"]) expect(kinds).toContain(kind);
    expect(status.total).toBeGreaterThan(40);
    expect(status.shortcut).toBe("Alt+Space");
  });

  it("finds abbreviations through the fuzzy title fallback", async () => {
    const hits = await query("sysset", { kinds: ["app"] });
    expect(hits[0]).toMatchObject({ kind: "app", title: "System Settings", matched: ["fuzzy"] });
    const code = await query("vsc", { kinds: ["app"] });
    expect(code[0].title).toBe("Code");
  });

  it("restricts kinds, caps per kind and honours tag queries", async () => {
    const files = await query("readme", { kinds: ["file"] });
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((h) => h.kind === "file")).toBe(true);
    const capped = await query("a", { perKind: 2, limit: 100 });
    const perKind = new Map<string, number>();
    for (const h of capped) perKind.set(h.kind, (perKind.get(h.kind) ?? 0) + 1);
    expect(Math.max(...perKind.values())).toBeLessThanOrEqual(2);
    const tagged = await query("#nonexistenttag");
    expect(tagged).toEqual([]);
    await expect(query("x", { kinds: ["nope"] })).rejects.toMatch(/unknown search kind/);
  });

  it("fuses semantic hits from the mock vector search", async () => {
    const hits = await query("how do I remember things", { semantic: true, kinds: ["note"] });
    expect(hits.some((h) => h.matched.includes("semantic"))).toBe(true);
    expect(hits.every((h) => h.kind === "note")).toBe(true);
  });

  it("records recents and boosts them", async () => {
    const before = await query("Zed", { kinds: ["app"] });
    const zed = before.find((h) => h.title === "Zed")!;
    await mockInvoke("cmd_search_recents_record", { id: zed.id, kind: "app", title: null });
    await mockInvoke("cmd_search_recents_record", { id: "command:app.settings", kind: "command", title: "Open settings" });
    await mockInvoke("cmd_search_recents_record", { id: "note:/gone.md", kind: "note", title: null });
    const recents = await mockInvoke<RecentHit[]>("cmd_search_recents_list", { limit: 10 });
    expect(recents.map((r) => r.id)).toEqual(expect.arrayContaining([zed.id, "command:app.settings"]));
    expect(recents.find((r) => r.id === "note:/gone.md")).toBeUndefined();
    expect(recents.find((r) => r.id === zed.id)?.hit?.title).toBe("Zed");
    await mockInvoke("cmd_search_recents_clear");
    expect(await mockInvoke<RecentHit[]>("cmd_search_recents_list", { limit: 10 })).toEqual([]);
    await expect(mockInvoke("cmd_search_recents_record", { id: " ", kind: "note", title: null })).rejects.toMatch(/required/);
  });

  it("validates and persists settings", async () => {
    const current = await mockInvoke<SearchSettings>("cmd_search_get_settings");
    const saved = await mockInvoke<SearchSettings>("cmd_search_set_settings", {
      settings: { ...current, global_shortcut: " Ctrl+Alt+K ", kinds: ["note", "note", "app"] },
    });
    expect(saved).toMatchObject({ global_shortcut: "Ctrl+Alt+K", kinds: ["note", "app"] });
    await expect(
      mockInvoke("cmd_search_set_settings", { settings: { ...saved, global_shortcut: "Shift+K" } })
    ).rejects.toMatch(/needs Alt, Ctrl or Cmd/);
    await expect(mockInvoke("cmd_search_set_settings", { settings: { ...saved, kinds: [] } })).rejects.toMatch(/at least one/);
    await expect(
      mockInvoke("cmd_search_set_settings", { settings: { ...saved, file_roots: ["relative"] } })
    ).rejects.toMatch(/absolute/);
    await expect(
      mockInvoke("cmd_search_set_settings", { settings: { ...saved, file_roots: ["/nowhere/at/all"] } })
    ).rejects.toMatch(/does not exist/);
    // Disabled kinds are not searched.
    expect((await query("ownership")).every((h) => h.kind === "note" || h.kind === "app")).toBe(true);
  });

  it("reindexes with progress events", async () => {
    const progress: KindReport[] = [];
    const updated: IndexReport[] = [];
    const off1 = mockEvents.listen<KindReport>("search-index-progress", (r) => progress.push(r));
    const off2 = mockEvents.listen<IndexReport>("search-index-updated", (r) => updated.push(r));
    const report = await mockInvoke<IndexReport>("cmd_search_reindex", { kinds: ["note", "app"] });
    off1();
    off2();
    expect(report.kinds.map((k) => k.kind)).toEqual(["note", "app"]);
    expect(report.kinds[1].count).toBe(MOCK_APPS.length);
    expect(progress.map((p) => p.kind)).toEqual(["note", "app"]);
    expect(updated).toHaveLength(1);
  });

  it("launches only known apps", async () => {
    await expect(mockInvoke("cmd_launch_app", { path: "/Applications/Zed.app" })).resolves.toBeNull();
    await expect(mockInvoke("cmd_launch_app", { path: "/tmp/Evil.app" })).rejects.toMatch(/outside the application folders/);
    await expect(mockInvoke("cmd_launch_app", { path: "/Applications/Nope.app" })).rejects.toMatch(/not found/);
    expect(await mockInvoke("cmd_search_apps")).toHaveLength(MOCK_APPS.length);
  });
});

describe("mock helpers", () => {
  it("strip Markdown, fold diacritics and validate shortcuts", () => {
    expect(plainText("---\na: b\n---\n# Title\n- [ ] task [[Target|alias]] **bold** [x](http://y)")).toBe("Title\ntask alias bold x");
    expect(terms("Käse & Spätzle käse")).toEqual(["kase", "spatzle"]);
    expect(snippetFor("<b>Tomatoes</b> grow", ["tomatoes"])).toBe("&lt;b&gt;<mark>Tomatoes</mark>&lt;/b&gt; grow");
    expect(validateShortcut("Alt+Space")).toBe("Alt+Space");
    expect(() => validateShortcut("Space")).toThrow();
    expect(() => validateShortcut("K+Alt")).toThrow();
    expect(() => validateShortcut("Alt+")).toThrow();
  });
});
