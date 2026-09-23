import { describe, expect, it } from "vitest";
import { Zap } from "lucide-react";
import type { RecentHit, SearchHit } from "../../types";
import type { CommandContribution } from "../commands/registry";
import { parseQuery, placeholderFor } from "./prefix";
import { acronymScore, launcherScore, matchPositions } from "./fuzzy";
import { decodeEntities, parseMarkedSnippet, segmentsFromPositions, snippetText } from "./highlight";
import { frecency, frecencyBoost, reciprocalRankFusion, visitWeight } from "./frecency";
import {
  FILES_FIRST_ORDER,
  commandItems,
  flattenGroups,
  groupItems,
  helpItems,
  hitItems,
  recentItems,
  sectionJump,
  type LauncherItem,
} from "./launcherItems";
import { hostOf, loadBookmarks, matchBookmarks } from "./sources";
import { splitNote } from "./preview";

const DAY = 86_400;

function hit(id: string, kind: SearchHit["kind"], title: string, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    kind,
    title,
    subtitle: "",
    path: "",
    snippet_html: "",
    score: 1,
    updated_at: 0,
    extra: {},
    matched: ["keyword"],
    ...extra,
  };
}

function command(id: string, title: string, extra: Partial<CommandContribution> = {}): CommandContribution {
  return { id, title, group: "General", icon: Zap, run: () => undefined, ...extra };
}

describe("parseQuery", () => {
  it("treats plain text as a query over everything", () => {
    expect(parseQuery("  garden plan ")).toMatchObject({
      mode: "all",
      prefix: "",
      text: "garden plan",
      kinds: null,
      backendQuery: "garden plan",
      includeCommands: true,
      includeExtras: true,
    });
  });

  it("maps every prefix to its mode, kinds and backend query", () => {
    expect(parseQuery("> theme")).toMatchObject({ mode: "commands", text: "theme", backendQuery: "", includeCommands: true });
    expect(parseQuery("#project")).toMatchObject({ mode: "tags", text: "project", backendQuery: "#project", includeCommands: false });
    expect(parseQuery("/src main")).toMatchObject({ mode: "files", kinds: ["file", "note"], backendQuery: "src main" });
    expect(parseQuery("@anna")).toMatchObject({ mode: "people", kinds: ["memory", "conversation"], backendQuery: "anna" });
    expect(parseQuery("?")).toMatchObject({ mode: "help", backendQuery: "" });
    expect(parseQuery("#")).toMatchObject({ mode: "tags", backendQuery: "" });
  });

  it("only honours a prefix in first position", () => {
    expect(parseQuery("c++ > java").mode).toBe("all");
    expect(parseQuery("   /readme").mode).toBe("files");
  });

  it("has a placeholder per mode", () => {
    expect(placeholderFor("files")).toBe("Go to file…");
    expect(placeholderFor("all")).toMatch(/Search/);
  });
});

describe("fuzzy", () => {
  it("finds abbreviations the palette scorer rejects", () => {
    expect(acronymScore("clbrd", "Clipboard")).toBeGreaterThan(0);
    expect(acronymScore("vsc", "Visual Studio Code")).toBeGreaterThan(0);
    expect(acronymScore("gtc", "Go to Calendar")).toBeGreaterThan(0);
    expect(acronymScore("rust", "Help: run setup again")).toBe(0);
    expect(acronymScore("lpd", "Clipboard")).toBe(0);
    expect(acronymScore("c", "Clipboard")).toBe(0);
  });

  it("keeps substring matches above acronym matches", () => {
    expect(launcherScore("board", "Clipboard")).toBeGreaterThan(launcherScore("clbrd", "Clipboard"));
    expect(launcherScore("", "anything")).toBe(1);
    expect(launcherScore("zzz", "Clipboard")).toBe(0);
  });

  it("returns highlight positions for substrings and subsequences", () => {
    expect(matchPositions("gar", "My Garden")).toEqual([3, 4, 5]);
    expect(matchPositions("vsc", "Visual Studio Code")).toEqual([0, 7, 14]);
    expect(matchPositions("xyz", "Garden")).toEqual([]);
    expect(matchPositions("", "Garden")).toEqual([]);
  });
});

describe("highlight", () => {
  it("parses only <mark> and decodes entities", () => {
    expect(parseMarkedSnippet("a &lt;b&gt; <mark>tomato</mark> &amp; <script>x</script>")).toEqual([
      { text: "a <b> ", mark: false },
      { text: "tomato", mark: true },
      { text: " & <script>x</script>", mark: false },
    ]);
    expect(parseMarkedSnippet("<mark>open")).toEqual([{ text: "open", mark: true }]);
    expect(snippetText("x <mark>y</mark> z")).toBe("x y z");
  });

  it("decodes numeric entities and leaves unknown ones alone", () => {
    expect(decodeEntities("&#39;&#x41;&unknown;&quot;")).toBe(`'A&unknown;"`);
  });

  it("builds segments from positions", () => {
    expect(segmentsFromPositions("Garden", [0, 1])).toEqual([
      { text: "Ga", mark: true },
      { text: "rden", mark: false },
    ]);
    expect(segmentsFromPositions("Garden", [])).toEqual([{ text: "Garden", mark: false }]);
  });
});

describe("frecency", () => {
  const now = 1_800_000_000;

  it("weighs recent visits higher and scales with the count", () => {
    expect(visitWeight(3600)).toBe(100);
    expect(visitWeight(120 * DAY)).toBe(10);
    expect(frecency({ count: 1, lastUsed: now - 3600, visits: [now - 3600] }, now)).toBe(100);
    expect(frecency({ count: 5, lastUsed: now, visits: [now, now - 20 * DAY] }, now)).toBe(375);
    expect(frecency({ count: 0, lastUsed: now, visits: [] }, now)).toBe(0);
  });

  it("boosts are neutral for unused results and capped", () => {
    expect(frecencyBoost(0)).toBe(1);
    expect(frecencyBoost(Number.NaN)).toBe(1);
    expect(frecencyBoost(100)).toBeCloseTo(1 + 0.5 * Math.log(2));
    expect(frecencyBoost(1e12)).toBe(2);
  });

  it("fuses ranked lists like the backend", () => {
    const fused = reciprocalRankFusion([
      { ids: ["a", "b", "c"], weight: 1 },
      { ids: ["c", "d", "a"], weight: 1 },
      { ids: ["x"], weight: 0 },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 63);
  });
});

describe("launcher items", () => {
  const commands = [
    command("app.commandPalette", "Command palette"),
    command("view.calendar", "Go to Calendar", { group: "Navigation", shortcut: "mod+0" }),
    command("theme.toggle", "Toggle light / dark theme", { group: "Appearance", keywords: ["dark mode"] }),
    command("clipboard.open", "Clipboard: open history", { group: "Clipboard" }),
  ];

  it("hides the palette itself and ranks by score", () => {
    const items = commandItems(commands, "calendar");
    expect(items.map((i) => i.key)).toEqual(["command:view.calendar"]);
    expect(items[0]).toMatchObject({ section: "commands", shortcut: "mod+0", titlePositions: [6, 7, 8, 9, 10, 11, 12, 13] });
    expect(commandItems(commands, "clbrd").map((i) => i.key)).toEqual(["command:clipboard.open"]);
  });

  it("browses in group order and lifts frequently used commands", () => {
    expect(commandItems(commands, "").map((i) => i.key)).toEqual([
      "command:view.calendar",
      "command:theme.toggle",
      "command:clipboard.open",
    ]);
    const boosted = commandItems(commands, "", new Map([["command:clipboard.open", 500]]));
    expect(boosted[0].key).toBe("command:clipboard.open");
  });

  it("groups sections in launcher order with caps", () => {
    const items: LauncherItem[] = [
      ...hitItems([hit("file:/a.rs", "file", "a.rs"), hit("note:/g.md", "note", "Garden"), hit("app:/Z.app", "app", "Zed")], "a"),
      ...commandItems(commands, "go"),
    ];
    const groups = groupItems(items, { note: 1 });
    expect(groups.map((g) => g.section)).toEqual(["commands", "note", "file", "app"]);
    expect(groups.map((g) => g.start)).toEqual([0, 1, 2, 3]);
    expect(flattenGroups(groups)).toHaveLength(4);
    expect(groupItems(items, {}, 8, {}, FILES_FIRST_ORDER).map((g) => g.section)).toEqual(["file", "commands", "note", "app"]);
  });

  it("jumps between sections with Tab / Shift+Tab, cycling", () => {
    const groups = groupItems([
      ...hitItems([hit("note:1", "note", "N1"), hit("note:2", "note", "N2")], ""),
      ...hitItems([hit("file:1", "file", "F1")], ""),
      ...hitItems([hit("app:1", "app", "A1")], ""),
    ]);
    expect(sectionJump(groups, 0, 1)).toBe(2);
    expect(sectionJump(groups, 2, 1)).toBe(3);
    expect(sectionJump(groups, 3, 1)).toBe(0);
    expect(sectionJump(groups, 1, -1)).toBe(0);
    expect(sectionJump(groups, 0, -1)).toBe(3);
    expect(sectionJump([], 0, 1)).toBe(0);
  });

  it("resolves recents of every kind", () => {
    const recents: RecentHit[] = [
      { id: "note:/g.md", kind: "note", title: null, count: 2, last_used: 5, frecency: 200, hit: hit("note:/g.md", "note", "Garden") },
      { id: "command:theme.toggle", kind: "command", title: "Toggle", count: 1, last_used: 4, frecency: 100, hit: null },
      { id: "command:gone.command", kind: "command", title: "Gone", count: 1, last_used: 3, frecency: 100, hit: null },
      { id: "bookmark:https://docs.rs/x", kind: "bookmark", title: "Docs", count: 1, last_used: 2, frecency: 100, hit: null },
      { id: "clip:42", kind: "clip", title: "copied text", count: 1, last_used: 1, frecency: 100, hit: null },
    ];
    const items = recentItems(recents, commands);
    expect(items.map((i) => i.title)).toEqual(["Garden", "Toggle light / dark theme", "Docs", "copied text"]);
    expect(items.every((i) => i.section === "recents")).toBe(true);
    expect(items[2].action).toEqual({ type: "bookmark", url: "https://docs.rs/x", title: "Docs" });
    expect(items[3].action).toEqual({ type: "clip", id: "42", preview: "copied text" });
  });

  it("offers one help item per prefix", () => {
    const help = helpItems();
    expect(help.map((h) => h.action)).toEqual([
      { type: "prefix", prefix: ">" },
      { type: "prefix", prefix: "#" },
      { type: "prefix", prefix: "/" },
      { type: "prefix", prefix: "@" },
    ]);
  });
});

describe("bookmarks", () => {
  const storage = (value: string | null) => ({ getItem: () => value });

  it("loads valid http(s) bookmarks only", () => {
    const raw = JSON.stringify([
      { title: "Rust docs", url: "https://doc.rust-lang.org" },
      { title: "", url: "https://tauri.app" },
      { title: "evil", url: "javascript:alert(1)" },
      "garbage",
    ]);
    expect(loadBookmarks(storage(raw))).toEqual([
      { title: "Rust docs", url: "https://doc.rust-lang.org" },
      { title: "https://tauri.app", url: "https://tauri.app" },
    ]);
    expect(loadBookmarks(storage("{broken"))).toEqual([]);
    expect(loadBookmarks(storage(null))).toEqual([]);
    expect(loadBookmarks(null)).toEqual([]);
  });

  it("matches by title and host", () => {
    const bookmarks = [
      { title: "Rust docs", url: "https://doc.rust-lang.org" },
      { title: "Tauri", url: "https://www.tauri.app/start" },
    ];
    expect(matchBookmarks(bookmarks, "tauri").map((m) => m.bookmark.title)).toEqual(["Tauri"]);
    expect(matchBookmarks(bookmarks, "rust-lang").map((m) => m.bookmark.title)).toEqual(["Rust docs"]);
    expect(matchBookmarks(bookmarks, "")).toEqual([]);
    expect(hostOf("https://www.tauri.app/start")).toBe("tauri.app");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("note preview", () => {
  it("separates frontmatter fields from the body", () => {
    expect(splitNote("---\ntags: [rust, learning]\naliases:\n  - Ownership\n  - Borrowing\n---\n# Rust\nBody")).toEqual({
      body: "# Rust\nBody",
      fields: [
        { key: "tags", value: "[rust, learning]" },
        { key: "aliases", value: "Ownership, Borrowing" },
      ],
    });
    expect(splitNote("# No frontmatter")).toEqual({ body: "# No frontmatter", fields: [] });
    expect(splitNote("---\nunterminated")).toEqual({ body: "---\nunterminated", fields: [] });
  });
});
