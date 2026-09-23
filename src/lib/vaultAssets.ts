/**
 * Loads media embedded in notes through `cmd_read_vault_asset` (the
 * webview has no file access) and keeps them in an in-memory LRU cache
 * keyed by vault-relative path.
 *
 * `loadVaultAsset(ref, notePath, vaultRoot)` tries the candidates from
 * `assetCandidates` in order (note folder → vault root → attachment
 * folders) and remembers which one hit, so a note that renders twice asks
 * Rust once. Concurrent requests share one promise; misses are remembered
 * for {@link MISS_TTL_MS} so a broken embed does not hammer IPC on every
 * re-render.
 */
import type { VaultAsset } from "../types";
import { readVaultAsset } from "./ipc";
import { assetCandidates, mediaKindOfMime, noteFolder, type MediaKind } from "./markdown/assets";

/** A loaded asset, ready to render. */
export interface LoadedAsset {
  /** Vault-relative path that resolved. */
  path: string;
  mime: string;
  kind: MediaKind | null;
  /** `data:<mime>;base64,…` */
  dataUrl: string;
  byteLen: number;
}

/** Entries the cache keeps at most. */
export const ASSET_CACHE_MAX_ENTRIES = 64;
/** Approximate memory budget of the cache (data URL characters). */
export const ASSET_CACHE_MAX_WEIGHT = 96 * 1024 * 1024;
/** How long a failed lookup is remembered. */
export const MISS_TTL_MS = 15_000;

/**
 * A least-recently-used map with an entry limit and a weight budget.
 * `get` refreshes recency; inserting evicts the oldest entries until both
 * limits hold (an entry heavier than the whole budget is not stored).
 */
export class LruCache<V> {
  private readonly map = new Map<string, { value: V; weight: number }>();
  private total = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxWeight: number,
    private readonly weigh: (value: V) => number
  ) {}

  get size(): number {
    return this.map.size;
  }

  /** Sum of the weights of the stored entries. */
  get weight(): number {
    return this.total;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    const weight = this.weigh(value);
    this.delete(key);
    if (weight > this.maxWeight) return;
    this.map.set(key, { value, weight });
    this.total += weight;
    while (this.map.size > this.maxEntries || this.total > this.maxWeight) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.total -= entry.weight;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

type Reader = (path: string) => Promise<VaultAsset>;

const cache = new LruCache<LoadedAsset>(ASSET_CACHE_MAX_ENTRIES, ASSET_CACHE_MAX_WEIGHT, (a) => a.dataUrl.length);
/** Lookup key (root, note folder, reference) → resolved path. */
const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<LoadedAsset>>();
const misses = new Map<string, { until: number; message: string }>();

function lookupKey(ref: string, notePath: string | null | undefined, vaultRoot: string | null | undefined): string {
  return `${vaultRoot ?? ""}\u0000${noteFolder(notePath, vaultRoot) ?? ""}\u0000${ref}`;
}

function cacheKey(vaultRoot: string | null | undefined, path: string): string {
  return `${vaultRoot ?? ""}\u0000${path}`;
}

/** Errors that mean "try the next candidate" (as opposed to "this file exists but cannot be shown"). */
function isNotFound(message: string): boolean {
  return /not found|outside the vault|no such file/i.test(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cached asset for a reference, without any I/O (`null` when not loaded yet). */
export function peekVaultAsset(ref: string, notePath: string | null | undefined, vaultRoot: string | null | undefined): LoadedAsset | null {
  const path = resolved.get(lookupKey(ref, notePath, vaultRoot));
  return path ? (cache.get(cacheKey(vaultRoot, path)) ?? null) : null;
}

/**
 * Resolve and load a media reference of the note at `notePath`. Rejects
 * with the backend's message when no candidate can be read (the last
 * "not found" message, or the first real error such as "larger than 25 MB").
 */
export function loadVaultAsset(
  ref: string,
  notePath: string | null | undefined,
  vaultRoot: string | null | undefined,
  read: Reader = readVaultAsset,
  now: () => number = Date.now
): Promise<LoadedAsset> {
  const key = lookupKey(ref, notePath, vaultRoot);
  const hit = peekVaultAsset(ref, notePath, vaultRoot);
  if (hit) return Promise.resolve(hit);
  const miss = misses.get(key);
  if (miss && miss.until > now()) return Promise.reject(new Error(miss.message));
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const candidates = assetCandidates(ref, notePath, vaultRoot);
    let lastError = candidates.length === 0 ? `not a vault file: ${ref}` : `asset not found: ${ref}`;
    for (const path of candidates) {
      const cached = cache.get(cacheKey(vaultRoot, path));
      if (cached) {
        resolved.set(key, path);
        return cached;
      }
      let asset: VaultAsset;
      try {
        asset = await read(path);
      } catch (error) {
        const message = messageOf(error);
        if (isNotFound(message)) {
          lastError = message;
          continue;
        }
        throw new Error(message);
      }
      const loaded: LoadedAsset = {
        path,
        mime: asset.mime,
        kind: mediaKindOfMime(asset.mime),
        dataUrl: `data:${asset.mime};base64,${asset.data_base64}`,
        byteLen: asset.byte_len,
      };
      cache.set(cacheKey(vaultRoot, path), loaded);
      if (resolved.size > 2_000) resolved.clear();
      resolved.set(key, path);
      return loaded;
    }
    throw new Error(lastError);
  })();

  inflight.set(key, task);
  task.then(
    () => {
      inflight.delete(key);
      misses.delete(key);
    },
    (error) => {
      inflight.delete(key);
      misses.set(key, { until: now() + MISS_TTL_MS, message: messageOf(error) });
    }
  );
  return task;
}

/** Forget every cached asset, resolution and miss (vault switched, tests). */
export function clearVaultAssetCache(): void {
  cache.clear();
  resolved.clear();
  inflight.clear();
  misses.clear();
}

/** Current cache contents (tests, diagnostics). */
export function vaultAssetCacheStats(): { entries: number; weight: number; keys: string[] } {
  return { entries: cache.size, weight: cache.weight, keys: cache.keys() };
}

/** Bytes of a `data:` URL's base64 payload, e.g. to build a Blob URL for video or PDF. */
export function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
