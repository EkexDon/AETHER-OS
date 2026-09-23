import { describe, expect, it } from "vitest";
import {
  assetCandidates,
  decodeRef,
  fileName,
  hasUrlScheme,
  isInlineImageSrc,
  mediaKindOf,
  mediaKindOfMime,
  normalizeRelative,
  noteFolder,
  parseWikiEmbed,
} from "./assets";

const ROOT = "/Users/demo/Vault";
const NOTE = `${ROOT}/03-Resources/Recipes/Bread.md`;

describe("media kinds", () => {
  it("classifies by extension and MIME type", () => {
    expect(mediaKindOf("a/b/photo.JPG")).toBe("image");
    expect(mediaKindOf("clip.webm")).toBe("video");
    expect(mediaKindOf("voice.m4a")).toBe("audio");
    expect(mediaKindOf("paper.pdf#page=3")).toBe("pdf");
    expect(mediaKindOf("notes.md")).toBeNull();
    expect(mediaKindOf("no-extension")).toBeNull();
    expect(mediaKindOfMime("image/svg+xml")).toBe("image");
    expect(mediaKindOfMime("application/pdf")).toBe("pdf");
    expect(mediaKindOfMime("text/html")).toBeNull();
  });

  it("recognises inline images and URL schemes", () => {
    expect(isInlineImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isInlineImageSrc("data:text/html;base64,AAAA")).toBe(false);
    expect(hasUrlScheme("javascript:alert(1)")).toBe(true);
    expect(hasUrlScheme("C:/Users/x.png")).toBe(false);
    expect(hasUrlScheme("images/x.png")).toBe(false);
  });
});

describe("parseWikiEmbed", () => {
  it("reads sizes and alt text after the pipe", () => {
    expect(parseWikiEmbed("diagram.png")).toEqual({ target: "diagram.png", alt: "diagram.png", width: null, height: null });
    expect(parseWikiEmbed("diagram.png|300")).toEqual({ target: "diagram.png", alt: "diagram.png", width: 300, height: null });
    expect(parseWikiEmbed(" img/a.png | 300x200 ")).toEqual({ target: "img/a.png", alt: "a.png", width: 300, height: 200 });
    expect(parseWikiEmbed("a.png|The | architecture")).toEqual({ target: "a.png", alt: "The | architecture", width: null, height: null });
  });
});

describe("path helpers", () => {
  it("normalises and refuses escapes", () => {
    expect(normalizeRelative("a/./b//c.png")).toBe("a/b/c.png");
    expect(normalizeRelative("a/../b.png")).toBe("b.png");
    expect(normalizeRelative("../b.png")).toBeNull();
    expect(normalizeRelative("a/.git/config.png")).toBeNull();
    expect(normalizeRelative("a\\b.png")).toBe("a/b.png");
  });

  it("decodes references", () => {
    expect(decodeRef("<my image.png>")).toBe("my image.png");
    expect(decodeRef("my%20image.png?raw=1")).toBe("my image.png");
    expect(decodeRef("100%.png")).toBe("100%.png");
    expect(fileName("a/b/c.png#x")).toBe("c.png");
  });

  it("finds the note's folder inside the vault", () => {
    expect(noteFolder(NOTE, ROOT)).toBe("03-Resources/Recipes");
    expect(noteFolder(`${ROOT}/Inbox.md`, `${ROOT}/`)).toBe("");
    expect(noteFolder("/elsewhere/x.md", ROOT)).toBeNull();
    expect(noteFolder(null, ROOT)).toBe("");
    expect(noteFolder("C:\\Vault\\daily\\x.md", "C:\\Vault")).toBe("daily");
  });
});

describe("assetCandidates", () => {
  it("tries the note folder, the vault root, then attachment folders up the tree", () => {
    expect(assetCandidates("img/bread.jpg", NOTE, ROOT)).toEqual([
      "03-Resources/Recipes/img/bread.jpg",
      "img/bread.jpg",
      "03-Resources/Recipes/attachments/bread.jpg",
      "03-Resources/Recipes/assets/bread.jpg",
      "03-Resources/Recipes/Attachments/bread.jpg",
      "03-Resources/Recipes/Assets/bread.jpg",
      "03-Resources/attachments/bread.jpg",
      "03-Resources/assets/bread.jpg",
      "03-Resources/Attachments/bread.jpg",
      "03-Resources/Assets/bread.jpg",
      "attachments/bread.jpg",
      "assets/bread.jpg",
      "Attachments/bread.jpg",
      "Assets/bread.jpg",
    ]);
  });

  it("does not repeat candidates for notes in the vault root", () => {
    expect(assetCandidates("attachments/x.png", `${ROOT}/Inbox.md`, ROOT)).toEqual([
      "attachments/x.png",
      "assets/x.png",
      "Attachments/x.png",
      "Assets/x.png",
    ]);
  });

  it("resolves ../ against the note folder but never above the vault", () => {
    expect(assetCandidates("../shared/logo.svg", NOTE, ROOT).slice(0, 2)).toEqual([
      "03-Resources/shared/logo.svg",
      "03-Resources/Recipes/attachments/logo.svg",
    ]);
    expect(assetCandidates("../../../../etc/passwd.png", NOTE, ROOT)[0]).toBe("03-Resources/Recipes/attachments/passwd.png");
  });

  it("maps absolute references into the vault", () => {
    expect(assetCandidates(`${ROOT}/media/clip.mp4`, NOTE, ROOT)[0]).toBe("media/clip.mp4");
    // Obsidian-style vault-absolute path.
    expect(assetCandidates("/media/clip.mp4", NOTE, ROOT)[0]).toBe("media/clip.mp4");
    expect(assetCandidates("/etc/../../x.png", NOTE, ROOT)[0]).toBe("03-Resources/Recipes/attachments/x.png");
  });

  it("decodes escaped names and keeps Windows vaults working", () => {
    expect(assetCandidates("my%20photo.png", "C:\\Vault\\daily\\2026-09-23.md", "C:\\Vault").slice(0, 3)).toEqual([
      "daily/my photo.png",
      "my photo.png",
      "daily/attachments/my photo.png",
    ]);
  });

  it("uses the vault root for content that is not a note", () => {
    expect(assetCandidates("diagram.png", null, ROOT).slice(0, 2)).toEqual(["diagram.png", "attachments/diagram.png"]);
  });

  it("yields nothing for URLs and scheme tricks", () => {
    expect(assetCandidates("https://example.com/a.png", NOTE, ROOT)).toEqual([]);
    expect(assetCandidates("javascript:alert(1)", NOTE, ROOT)).toEqual([]);
    expect(assetCandidates("data:image/png;base64,AAAA", NOTE, ROOT)).toEqual([]);
    expect(assetCandidates("   ", NOTE, ROOT)).toEqual([]);
    expect(assetCandidates("folder/", NOTE, ROOT)).toEqual([]);
  });
});
