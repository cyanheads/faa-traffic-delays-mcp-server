/**
 * @fileoverview Tests for NasStatusService over a fake fetch: request URLs and headers, the 60 s
 * and 6 h caches, single-flight loading, per-caller cancellation, failure classes (maintenance
 * page, malformed JSON, 404, contract drift, outage), and drift logging.
 * @module tests/services/nas-status/nas-status-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNasStatusService,
  initNasStatusService,
  NasStatusService,
} from '@/services/nas-status/nas-status-service.js';
import {
  callsTo,
  createClock,
  feedHarness,
  feedUrl,
  hangUntilAborted,
  htmlResponse,
  jsonResponse,
} from '../../helpers/faa-fakes.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function makeService(harness = feedHarness(), clock = createClock()) {
  const service = new NasStatusService({
    fetch: harness.fetch,
    now: clock.now,
    userAgent: 'faa-test/9.9',
  });
  return { clock, harness, service };
}

/** Drives fake timers past the retry ladder while `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  return outcome;
}

const dataOf = (error: unknown): Record<string, unknown> => {
  expect(error).toBeInstanceOf(McpError);
  return (error as McpError).data ?? {};
};

describe('NasStatusService', () => {
  let service: NasStatusService;

  afterEach(() => {
    service?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('requests', () => {
    it.each([
      ['getAirportEvents', 'airport-events'],
      ['getEnrouteEvents', 'enroute-events'],
      ['getOperationsPlan', 'operations-plan'],
      ['getAnnouncements', 'miscellaneous-info'],
      ['getPacingAirports', 'pacing-airports'],
    ] as const)(
      '%s reads /api/%s with JSON headers and no query parameters',
      async (method, feed) => {
        const made = makeService();
        service = made.service;

        await service[method](createMockContext());

        expect(made.harness.calls).toHaveLength(1);
        const request = made.harness.calls[0]?.request as Request;
        expect(request.url).toBe(`https://nasstatus.faa.gov/api/${feed}`);
        expect(request.headers.get('accept')).toBe('application/json');
        expect(request.headers.get('user-agent')).toBe('faa-test/9.9');
        expect(request.method).toBe('GET');
      },
    );

    it('stamps each snapshot with the fetch time from the injected clock', async () => {
      const made = makeService(feedHarness(), createClock('2026-09-30T04:05:06Z'));
      service = made.service;

      const snapshot = await service.getAirportEvents(createMockContext());

      expect(snapshot.fetchedAt).toBe('2026-09-30T04:05:06.000Z');
      expect(snapshot.rows.map((row) => row.airportId)).toContain('SEA');
    });

    it('returns parsed rows and the skipped-row count', async () => {
      const made = makeService(
        feedHarness({ 'airport-events': [{ airportId: 'SEA' }, { nope: true }] }),
      );
      service = made.service;

      const snapshot = await service.getAirportEvents(createMockContext());

      expect(snapshot.rows).toEqual([{ airportId: 'SEA' }]);
      expect(snapshot.skippedRows).toBe(1);
    });

    it('serves an empty array feed as an empty snapshot', async () => {
      const made = makeService(feedHarness({ 'enroute-events': [] }));
      service = made.service;

      const snapshot = await service.getEnrouteEvents(createMockContext());

      expect(snapshot).toMatchObject({ rows: [], skippedRows: 0 });
    });
  });

  describe('caching', () => {
    it('serves a feed from cache inside 60 s and refetches at 60 s', async () => {
      const made = makeService();
      service = made.service;
      const ctx = createMockContext();

      const first = await service.getAirportEvents(ctx);
      made.clock.advance(MINUTE - 1);
      const second = await service.getAirportEvents(ctx);
      expect(callsTo(made.harness, feedUrl('airport-events'))).toBe(1);
      expect(second.fetchedAt).toBe(first.fetchedAt);

      made.clock.advance(1);
      const third = await service.getAirportEvents(ctx);
      expect(callsTo(made.harness, feedUrl('airport-events'))).toBe(2);
      expect(third.fetchedAt).not.toBe(first.fetchedAt);
    });

    it('caches the pacing list for 6 h', async () => {
      const made = makeService();
      service = made.service;
      const ctx = createMockContext();

      await service.getPacingAirports(ctx);
      made.clock.advance(6 * HOUR - 1);
      await service.getPacingAirports(ctx);
      expect(callsTo(made.harness, feedUrl('pacing-airports'))).toBe(1);

      made.clock.advance(1);
      await service.getPacingAirports(ctx);
      expect(callsTo(made.harness, feedUrl('pacing-airports'))).toBe(2);
    });

    it('caches each feed independently', async () => {
      const made = makeService();
      service = made.service;
      const ctx = createMockContext();

      await service.getAirportEvents(ctx);
      await service.getEnrouteEvents(ctx);
      await service.getAirportEvents(ctx);
      await service.getEnrouteEvents(ctx);

      expect(callsTo(made.harness, feedUrl('airport-events'))).toBe(1);
      expect(callsTo(made.harness, feedUrl('enroute-events'))).toBe(1);
    });

    it('shares one fetch between concurrent callers', async () => {
      const made = makeService();
      service = made.service;

      const [a, b] = await Promise.all([
        service.getAirportEvents(createMockContext()),
        service.getAirportEvents(createMockContext()),
      ]);

      expect(callsTo(made.harness, feedUrl('airport-events'))).toBe(1);
      expect(a).toEqual(b);
    });

    it('lets a cancelled caller reject alone while the shared fetch fills the cache', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const made = makeService(
        feedHarness({
          'airport-events': async () => {
            await gate;
            return jsonResponse([{ airportId: 'SEA' }]);
          },
        }),
      );
      service = made.service;
      const cancelled = new AbortController();

      const cancelledCall = service.getAirportEvents(
        createMockContext({ signal: cancelled.signal }),
      );
      const patientCall = service.getAirportEvents(createMockContext());
      cancelled.abort(new Error('client cancelled'));
      await expect(cancelledCall).rejects.toThrow('client cancelled');

      release();
      await expect(patientCall).resolves.toMatchObject({ rows: [{ airportId: 'SEA' }] });
      await service.getAirportEvents(createMockContext());
      expect(callsTo(made.harness, feedUrl('airport-events'))).toBe(1);
    });

    it('does not bind the shared fetch to the first caller signal', async () => {
      const made = makeService();
      service = made.service;
      const first = new AbortController();

      const firstCall = service.getAirportEvents(createMockContext({ signal: first.signal }));
      const secondCall = service.getAirportEvents(createMockContext());
      first.abort(new Error('first caller left'));

      await expect(firstCall).rejects.toThrow('first caller left');
      await expect(secondCall).resolves.toMatchObject({ rows: expect.any(Array) });
    });
  });

  describe('failures', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('reads a 200 HTML page as feed_unavailable', async () => {
      const made = makeService(
        feedHarness({ 'airport-events': () => htmlResponse('<html>down</html>') }),
      );
      service = made.service;

      const { error } = await settle(service.getAirportEvents(createMockContext()));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(dataOf(error)).toMatchObject({ reason: 'feed_unavailable' });
    });

    it('reads a malformed JSON body as feed_unavailable, naming the feed', async () => {
      const made = makeService(
        feedHarness({ 'operations-plan': () => jsonResponse('{"link": "x", ') }),
      );
      service = made.service;

      const { error } = await settle(service.getOperationsPlan(createMockContext()));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(dataOf(error)).toMatchObject({ feed: 'operations-plan', reason: 'feed_unavailable' });
      expect((error as McpError).message).toContain(
        'The FAA NAS Status operations plan feed returned a malformed JSON body.',
      );
      expect(callsTo(made.harness, feedUrl('operations-plan'))).toBe(3);
    });

    it('names the feed in caller-readable words when the retry deadline runs out', async () => {
      const made = makeService(feedHarness({ 'operations-plan': hangUntilAborted }));
      service = made.service;

      const { error } = await settle(service.getOperationsPlan(createMockContext()));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect(dataOf(error)).toMatchObject({ reason: 'retry_deadline_exceeded' });
      expect((error as McpError).message).toContain(
        'The FAA NAS Status operations plan feed exceeded its 20000ms retry deadline',
      );
      expect((error as McpError).message).not.toContain('NasStatusService');
    });

    it.each([404, 410])(
      'reads HTTP %i as feed_contract_changed without retrying',
      async (status) => {
        const made = makeService(
          feedHarness({ 'pacing-airports': () => new Response('Website Unavailable', { status }) }),
        );
        service = made.service;

        const { error } = await settle(service.getPacingAirports(createMockContext()));

        expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
        expect(dataOf(error)).toMatchObject({ reason: 'feed_contract_changed', retryable: false });
        expect(callsTo(made.harness, feedUrl('pacing-airports'))).toBe(1);
      },
    );

    it.each([
      ['airport-events', 'getAirportEvents', { airportId: 'SEA' }],
      ['enroute-events', 'getEnrouteEvents', 'nothing at all'],
      ['operations-plan', 'getOperationsPlan', ['not', 'an', 'object']],
      ['miscellaneous-info', 'getAnnouncements', { event: 'x' }],
      ['pacing-airports', 'getPacingAirports', null],
    ] as const)(
      'raises feed_contract_changed once for a wrong top-level %s shape',
      async (feed, method, body) => {
        const made = makeService(feedHarness({ [feed]: () => jsonResponse(JSON.stringify(body)) }));
        service = made.service;

        const { error } = await settle(service[method](createMockContext()) as Promise<unknown>);

        expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
        expect(dataOf(error)).toMatchObject({ feed, reason: 'feed_contract_changed' });
        expect(callsTo(made.harness, feedUrl(feed))).toBe(1);
      },
    );

    it('raises feed_contract_changed when every row of a non-empty feed is keyless', async () => {
      const made = makeService(feedHarness({ 'airport-events': [{ groundStop: null }] }));
      service = made.service;

      const { error } = await settle(service.getAirportEvents(createMockContext()));

      expect(dataOf(error)).toMatchObject({ reason: 'feed_contract_changed' });
    });

    it('reports an outage as feed_unavailable after the retry ladder', async () => {
      const made = makeService(
        feedHarness({ 'airport-events': () => new Response('x', { status: 503 }) }),
      );
      service = made.service;

      const { error } = await settle(service.getAirportEvents(createMockContext()));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(dataOf(error)).toMatchObject({ reason: 'feed_unavailable' });
      expect(callsTo(made.harness, feedUrl('airport-events'))).toBe(3);
    });

    it('does not cache a failure: the next call fetches again and succeeds', async () => {
      let healthy = false;
      const made = makeService(
        feedHarness({
          'airport-events': () =>
            healthy ? jsonResponse([{ airportId: 'SEA' }]) : new Response('x', { status: 404 }),
        }),
      );
      service = made.service;

      const failed = await settle(service.getAirportEvents(createMockContext()));
      expect(failed.error).toBeDefined();

      healthy = true;
      const recovered = await service.getAirportEvents(createMockContext());
      expect(recovered.rows).toEqual([{ airportId: 'SEA' }]);
    });

    it('never serves an expired snapshot when the refresh fails', async () => {
      let healthy = true;
      const made = makeService(
        feedHarness({
          'airport-events': () =>
            healthy ? jsonResponse([{ airportId: 'SEA' }]) : new Response('x', { status: 404 }),
        }),
      );
      service = made.service;
      await service.getAirportEvents(createMockContext());

      healthy = false;
      made.clock.advance(MINUTE);
      const { error } = await settle(service.getAirportEvents(createMockContext()));

      expect(dataOf(error)).toMatchObject({ reason: 'feed_contract_changed' });
    });
  });

  describe('pacing', () => {
    it('names the FAA host, not an internal pacer id, when its own queue sheds a call', async () => {
      const made = makeService();
      service = made.service;
      const ctx = createMockContext();
      for (let request = 0; request < 30; request++) {
        await service.getAirportEvents(ctx);
        made.clock.advance(MINUTE);
      }

      const error = await service.getAirportEvents(ctx).catch((thrown: unknown) => thrown);

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      expect(dataOf(error)).toMatchObject({ reason: 'pacer_shed' });
      expect((error as McpError).message).toContain('No FAA NAS Status request slot');
      expect((error as McpError).message).not.toContain('faa-nasstatus');
      expect(callsTo(made.harness, feedUrl('airport-events'))).toBe(30);
    });
  });

  describe('drift logging', () => {
    it('logs a wrong-typed field once per process, even across refetches', async () => {
      const warning = vi.spyOn(logger, 'warning').mockImplementation(() => undefined);
      const made = makeService(
        feedHarness({ 'airport-events': [{ airportId: 'SEA', groundDelay: { avgDelay: 'x' } }] }),
      );
      service = made.service;
      const ctx = createMockContext();

      await service.getAirportEvents(ctx);
      made.clock.advance(MINUTE);
      await service.getAirportEvents(ctx);

      const driftLogs = warning.mock.calls.filter(([message]) => /unexpected type/.test(message));
      expect(driftLogs).toHaveLength(1);
      expect(driftLogs[0]?.[1]).toMatchObject({
        extra: { fieldPath: 'airport-events[].groundDelay.avgDelay', observedType: 'string' },
      });
    });

    it('logs an unknown row key once', async () => {
      const warning = vi.spyOn(logger, 'warning').mockImplementation(() => undefined);
      const made = makeService(
        feedHarness({
          'airport-events': [
            { airportId: 'SEA', newEvent: {} },
            { airportId: 'ORD', newEvent: {} },
          ],
        }),
      );
      service = made.service;

      await service.getAirportEvents(createMockContext());

      const keyLogs = warning.mock.calls.filter(([message]) => /unknown key/.test(message));
      expect(keyLogs).toHaveLength(1);
      expect(keyLogs[0]?.[1]).toMatchObject({
        extra: { feed: 'airport-events', key: 'newEvent' },
      });
    });

    it('logs skipped rows with their count', async () => {
      const warning = vi.spyOn(logger, 'warning').mockImplementation(() => undefined);
      const made = makeService(feedHarness({ 'airport-events': [{ airportId: 'SEA' }, {}] }));
      service = made.service;

      await service.getAirportEvents(createMockContext());

      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('Skipped 1 unreadable airport-events rows'),
        expect.objectContaining({ extra: { feed: 'airport-events', skippedRows: 1 } }),
      );
    });
  });

  describe('singleton accessor', () => {
    it('returns the instance initNasStatusService constructed', () => {
      const clock = createClock();
      service = initNasStatusService({ fetch: feedHarness().fetch, now: clock.now });
      expect(getNasStatusService()).toBe(service);
    });

    it('throws an actionable error before initialisation', async () => {
      vi.resetModules();
      const fresh = await import('@/services/nas-status/nas-status-service.js');
      expect(() => fresh.getNasStatusService()).toThrow(/not initialized.*initNasStatusService/);
    });
  });
});
