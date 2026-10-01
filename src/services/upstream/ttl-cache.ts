/**
 * @fileoverview In-process TTL cache with single-flight loading and an optional LRU cap. Concurrent
 * callers for one key share a single in-flight load; each caller races that shared load against its
 * own abort signal, so a cancelled caller rejects alone while the load completes for the rest. An
 * expired entry is never served, even when its refresh fails.
 * @module services/upstream/ttl-cache
 */

/** What a loader resolves to: the value plus how long to keep it. */
export interface CacheLoad<T> {
  ttlMs: number;
  value: T;
}

interface Entry {
  expiresAt: number;
  value: unknown;
}

/** Rejects with the signal's reason when it aborts first; otherwise settles with `promise`. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Keyed TTL cache; `maxEntries` evicts the least recently used entry past the cap. */
export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly now: () => number,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  /**
   * Returns the cached value for `key` while fresh; otherwise joins (or starts) the shared load.
   * The load is never bound to `signal`: it serves every caller waiting on it.
   */
  get<T>(key: string, load: () => Promise<CacheLoad<T>>, signal: AbortSignal): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return Promise.resolve(hit.value as T);
    }
    let pending = this.inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load()
        .then(({ ttlMs, value }) => {
          this.store(key, value, ttlMs);
          return value;
        })
        .finally(() => this.inflight.delete(key));
      // A load every caller abandoned still settles; keep its rejection from going unhandled.
      pending.catch(() => undefined);
      this.inflight.set(key, pending);
    }
    return raceAbort(pending, signal);
  }

  private store(key: string, value: unknown, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.now() + ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
