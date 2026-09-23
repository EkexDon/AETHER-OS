import { describe, expect, it } from "vitest";
import type { VaultNote } from "../../types";
import {
  baseName,
  defaultExportDir,
  defaultScope,
  emptyScope,
  filterNotes,
  folderList,
  isInsideVault,
  isScopeReady,
  joinPath,
  parentDir,
  relativeTo,
  safeFileName,
  scopeKindsFor,
  scopeSummary,
  suggestDestination,
} from "./scope";

const ROOT = "/Users/demo/Vault";
const note = (rel: string): VaultNote => ({
  path: `${ROOT}/${rel}`,
  name: baseName(rel).replace(/\.md$/, ""),
  mtime: 0,
});
const NOTES = [note("Welcome.md"), note("Projects/Alpha.md"), note("Projects/Deep/Beta.md"), note("Areas/Health.md")];

describe("scope helpers", () => {
  it("limits the HTML flow to single notes", () => {
    expect(scopeKindsFor("html")).toEqual(["note"]);
    expect(scopeKindsFor("site")).toEqual(["note", "folder", "vault", "tag", "selection"]);
    expect(defaultScope("html", "/a.md")).toEqual({ kind: "note", value: "/a.md" });
    expect(defaultScope("bundle", "/a.md")).toEqual({ kind: "vault" });
  });

  it("pre-fills empty scopes from the current note", () => {
    const current = `${ROOT}/Projects/Alpha.md`;
    expect(emptyScope("folder", current)).toEqual({ kind: "folder", value: `${ROOT}/Projects` });
    expect(emptyScope("selection", current)).toEqual({ kind: "selection", value: [current] });
    expect(emptyScope("selection", null)).toEqual({ kind: "selection", value: [] });
    expect(emptyScope("tag", current)).toEqual({ kind: "tag", value: "" });
  });

  it("knows when a scope is ready", () => {
    expect(isScopeReady({ kind: "vault" })).toBe(true);
    expect(isScopeReady({ kind: "note", value: " " })).toBe(false);
    expect(isScopeReady({ kind: "tag", value: "rust" })).toBe(true);
    expect(isScopeReady({ kind: "selection", value: [] })).toBe(false);
  });

  it("summarises scopes", () => {
    expect(scopeSummary({ kind: "note", value: `${ROOT}/Projects/Alpha.md` }, ROOT)).toBe("Alpha");
    expect(scopeSummary({ kind: "folder", value: `${ROOT}/Projects` }, ROOT)).toBe("Projects/");
    expect(scopeSummary({ kind: "folder", value: ROOT }, ROOT)).toBe("Whole vault");
    expect(scopeSummary({ kind: "tag", value: "#rust" }, ROOT)).toBe("#rust");
    expect(scopeSummary({ kind: "selection", value: ["a"] }, ROOT)).toBe("1 selected note");
  });

  it("handles paths", () => {
    expect(parentDir("/a/b/c.md")).toBe("/a/b");
    expect(parentDir("/a")).toBe("/");
    expect(joinPath("/a/", "/b.html")).toBe("/a/b.html");
    expect(relativeTo(`${ROOT}/x/y.md`, ROOT)).toBe("x/y.md");
    expect(relativeTo("/elsewhere/y.md", ROOT)).toBe("/elsewhere/y.md");
    expect(isInsideVault(`${ROOT}/export`, ROOT)).toBe(true);
    expect(isInsideVault(ROOT, ROOT)).toBe(true);
    expect(isInsideVault("/Users/demo/Vault2/x", ROOT)).toBe(false);
    expect(isInsideVault("", ROOT)).toBe(false);
  });

  it("suggests safe destinations", () => {
    expect(safeFileName('Plan: Q3 / "draft"?')).toBe("Plan- Q3 - -draft");
    expect(safeFileName("...")).toBe("export");
    expect(suggestDestination("html", "/Users/demo/Desktop", "My Note")).toBe("/Users/demo/Desktop/My Note.html");
    expect(suggestDestination("bundle", "/d", "Notes")).toBe("/d/Notes.zip");
    expect(suggestDestination("site", "/d", "Second Brain")).toBe("/d/second-brain-site");
    expect(defaultExportDir("/Users/demo/Documents/Vault")).toBe("/Users/demo/Desktop");
    expect(defaultExportDir("/home/ada/notes")).toBe("/home/ada/Desktop");
    expect(defaultExportDir("/Volumes/Data/vault")).toBe("/Volumes/Data");
    expect(defaultExportDir(null)).toBe("");
  });

  it("lists folders with recursive counts", () => {
    const folders = folderList(NOTES, ROOT);
    expect(folders.map((f) => [f.rel, f.depth, f.count])).toEqual([
      ["", 0, 4],
      ["Areas", 1, 1],
      ["Projects", 1, 2],
      ["Projects/Deep", 2, 1],
    ]);
    expect(folders[0].name).toBe("Vault");
    expect(folderList(NOTES, null)).toEqual([]);
  });

  it("filters notes by every search word", () => {
    expect(filterNotes(NOTES, "", ROOT)).toHaveLength(4);
    expect(filterNotes(NOTES, "projects beta", ROOT).map((n) => n.name)).toEqual(["Beta"]);
    expect(filterNotes(NOTES, "HEALTH", ROOT).map((n) => n.name)).toEqual(["Health"]);
  });
});
