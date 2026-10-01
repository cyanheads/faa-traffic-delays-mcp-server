/**
 * @fileoverview Tests for TtlCache: freshness, expiry, single-flight loading, per-caller
 * cancellation over a shared load, failure handling, and the LRU cap.
 * @module tests/services/upstream/ttl-cache.test
 */

import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '@/services/upstream/ttl-cache.js';
import { createClock } from '../../helpers/faa-fakes.js';

const live = (): AbortSignal => new AbortController().signal;

/** A loader that resolves when `release()` is called, counting invocations. */
function gatedLoader<T>(value: T, ttlMs = 1_000) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = vi.fn(async () => {
    await gate;
    return { ttlMs, value };
  });
  return { load, release };
}

describe('TtlCache', () => {
  it('serves a fresh entry without loading again', async () => {
    const clock = createClock();
    const cache = new TtlCache(clock.now);
    const load = vi.fn(async () => ({ ttlMs: 60_000, value: 'a' }));

    await expect(cache.get('k', load, live())).resolves.toBe('a');
    clock.advance(59_999);
    await expect(cache.get('k', load, live())).resolves.toBe('a');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads once the entry has expired', async () => {
    const clock = createClock();
    const cache = new TtlCache(clock.now);
    let n = 0;
    const load = vi.fn(async () => ({ ttlMs: 60_000, value: ++n }));

    await cache.get('k', load, live());
    clock.advance(60_000);
    await expect(cache.get('k', load, live())).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps keys independent', async () => {
    const cache = new TtlCache(createClock().now);
    await cache.get('a', async () => ({ ttlMs: 1_000, value: 'A' }), live());
    const loadB = vi.fn(async () => ({ ttlMs: 1_000, value: 'B' }));
    await expect(cache.get('b', loadB, live())).resolves.toBe('B');
    expect(loadB).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = new TtlCache(createClock().now);
    const { load, release } = gatedLoader('shared');

    const first = cache.get('k', load, live());
    const second = cache.get('k', load, live());
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rejects a cancelled caller alone while the shared load fills the cache', async () => {
    const cache = new TtlCache(createClock().now);
    const { load, release } = gatedLoader('value');
    const cancelled = new AbortController();

    const cancelledCall = cache.get('k', load, cancelled.signal);
    const patientCall = cache.get('k', load, live());
    cancelled.abort(new Error('caller went away'));
    await expect(cancelledCall).rejects.toThrow('caller went away');

    release();
    await expect(patientCall).resolves.toBe('value');
    await expect(cache.get('k', load, live())).resolves.toBe('value');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('caches the value even when every caller abandoned the load', async () => {
    const cache = new TtlCache(createClock().now);
    const { load, release } = gatedLoader('kept');
    const only = new AbortController();

    const call = cache.get('k', load, only.signal);
    only.abort(new Error('gone'));
    await expect(call).rejects.toThrow('gone');
    release();
    await vi.waitFor(async () => {
      await expect(cache.get('k', load, live())).resolves.toBe('kept');
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately with the reason when the signal is already aborted', async () => {
    const cache = new TtlCache(createClock().now);
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));

    await expect(
      cache.get('k', async () => ({ ttlMs: 1_000, value: 'x' }), controller.signal),
    ).rejects.toThrow('already cancelled');
  });

  it('does not cache a failed load and lets the next caller retry', async () => {
    const cache = new TtlCache(createClock().now);
    const load = vi
      .fn<() => Promise<{ ttlMs: number; value: string }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ttlMs: 1_000, value: 'ok' });

    await expect(cache.get('k', load, live())).rejects.toThrow('boom');
    await expect(cache.get('k', load, live())).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never serves an expired entry when its refresh fails', async () => {
    const clock = createClock();
    const cache = new TtlCache(clock.now);
    await cache.get('k', async () => ({ ttlMs: 1_000, value: 'old' }), live());
    clock.advance(1_000);

    await expect(
      cache.get(
        'k',
        async () => {
          throw new Error('upstream down');
        },
        live(),
      ),
    ).rejects.toThrow('upstream down');
  });

  it('shares a failed load between concurrent callers', async () => {
    const cache = new TtlCache(createClock().now);
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      throw new Error('shared failure');
    });

    const first = cache.get('k', load, live());
    const second = cache.get('k', load, live());
    fail();

    await expect(first).rejects.toThrow('shared failure');
    await expect(second).rejects.toThrow('shared failure');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used entry past maxEntries', async () => {
    const cache = new TtlCache(createClock().now, 2);
    const loaders = new Map(
      ['a', 'b', 'c'].map((key) => [key, vi.fn(async () => ({ ttlMs: 60_000, value: key }))]),
    );
    const get = (key: string) => cache.get(key, loaders.get(key) as never, live());

    await get('a');
    await get('b');
    await get('a'); // a is now most recent; b is the eviction candidate
    await get('c'); // evicts b

    await get('a');
    await get('c');
    expect(loaders.get('a')).toHaveBeenCalledTimes(1);
    expect(loaders.get('c')).toHaveBeenCalledTimes(1);
    await get('b');
    expect(loaders.get('b')).toHaveBeenCalledTimes(2);
  });
});
