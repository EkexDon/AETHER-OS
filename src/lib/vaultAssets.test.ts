import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultAsset } from "../types";
import { LruCache, MISS_TTL_MS, clearVaultAssetCache, dataUrlBytes, loadVaultAsset, peekVaultAsset, vaultAssetCacheStats } from "./vaultAssets";

const ROOT = "/vault";
const NOTE = `${ROOT}/notes/today.md`;

function asset(data = "iVBORw0KGgo="): VaultAsset {
  return { mime: "image/png", data_base64: data, byte_len: 8 };
}

/** A reader that serves `files` (vault-relative) and fails like Rust otherwise. */
function reader(files: Record<string, VaultAsset | Error>) {
  return vi.fn(async (path: string) => {
    const hit = files[path];
    if (hit instanceof Error) throw hit;
    if (!hit) throw new Error(`invalid input: asset not found: ${path}`);
    return hit;
  });
}

beforeEach(() => clearVaultAssetCache());

describe("LruCache", () => {
  it("evicts the least recently used entry beyond the entry limit", () => {
    const cache = new LruCache<string>(2, 1_000, (v) => v.length);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("a")).toBe("1"); // a is now the most recent
    cache.set("c", "3");
    expect(cache.keys()).toEqual(["a", "c"]);
  });

  it("keeps the total weight under budget and skips oversized entries", () => {
    const cache = new LruCache<string>(10, 10, (v) => v.length);
    cache.set("a", "xxxx");
    cache.set("b", "xxxx");
    cache.set("c", "xxxx");
    expect(cache.keys()).toEqual(["b", "c"]);
    expect(cache.weight).toBe(8);
    cache.set("huge", "x".repeat(11));
    expect(cache.has("huge")).toBe(false);
    cache.set("b", "xx");
    expect(cache.weight).toBe(6);
  });
});

describe("loadVaultAsset", () => {
  it("tries candidates in order and remembers the hit", async () => {
    const read = reader({ "attachments/pic.png": asset() });
    const loaded = await loadVaultAsset("pic.png", NOTE, ROOT, read);
    expect(loaded).toMatchObject({ path: "attachments/pic.png", kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
    expect(read.mock.calls.map(([p]) => p)).toEqual([
      "notes/pic.png",
      "pic.png",
      "notes/attachments/pic.png",
      "notes/assets/pic.png",
      "notes/Attachments/pic.png",
      "notes/Assets/pic.png",
      "attachments/pic.png",
    ]);
    expect(peekVaultAsset("pic.png", NOTE, ROOT)).toBe(loaded);
    await loadVaultAsset("pic.png", NOTE, ROOT, read);
    expect(read).toHaveBeenCalledTimes(7);
    // Another reference to the same file reuses the cached bytes.
    await loadVaultAsset("../attachments/pic.png", NOTE, ROOT, read);
    expect(read).toHaveBeenCalledTimes(7);
    expect(vaultAssetCacheStats().entries).toBe(1);
  });

  it("shares one request between concurrent renders", async () => {
    const read = reader({ "notes/a.png": asset() });
    const [a, b] = await Promise.all([loadVaultAsset("a.png", NOTE, ROOT, read), loadVaultAsset("a.png", NOTE, ROOT, read)]);
    expect(a).toBe(b);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("remembers misses for a while", async () => {
    let now = 1_000;
    const read = reader({});
    await expect(loadVaultAsset("gone.png", NOTE, ROOT, read, () => now)).rejects.toThrow("asset not found: Assets/gone.png");
    const calls = read.mock.calls.length;
    await expect(loadVaultAsset("gone.png", NOTE, ROOT, read, () => now)).rejects.toThrow("asset not found");
    expect(read.mock.calls.length).toBe(calls);
    now += MISS_TTL_MS + 1;
    await expect(loadVaultAsset("gone.png", NOTE, ROOT, read, () => now)).rejects.toThrow("asset not found");
    expect(read.mock.calls.length).toBe(calls * 2);
  });

  it("stops at a real error instead of trying further folders", async () => {
    const read = reader({ "notes/big.mp4": new Error("invalid input: asset is larger than 25 MB: notes/big.mp4") });
    await expect(loadVaultAsset("big.mp4", NOTE, ROOT, read)).rejects.toThrow("larger than 25 MB");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refuses URLs and scheme tricks without any IPC", async () => {
    const read = reader({});
    await expect(loadVaultAsset("javascript:alert(1)", NOTE, ROOT, read)).rejects.toThrow("not a vault file");
    expect(read).not.toHaveBeenCalled();
  });

  it("keys the cache by vault so switching vaults never shows stale files", async () => {
    const readA = reader({ "notes/a.png": asset("QQ==") });
    const readB = reader({ "notes/a.png": asset("Qg==") });
    const a = await loadVaultAsset("a.png", NOTE, ROOT, readA);
    const b = await loadVaultAsset("a.png", "/other/notes/today.md", "/other", readB);
    expect(a.dataUrl).not.toBe(b.dataUrl);
  });
});

describe("dataUrlBytes", () => {
  it("decodes the base64 payload", () => {
    expect([...dataUrlBytes("data:application/pdf;base64,JVBERg==")]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});
