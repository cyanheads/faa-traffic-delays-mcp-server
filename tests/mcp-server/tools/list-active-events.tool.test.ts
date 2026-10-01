/**
 * @fileoverview Tests for faa_delays_list_active_events: event_types normalization (blank and
 * empty read as unset), severity sort, whole-feed counts, the required enrichment on the
 * zero-result and under-cap pages, stale-delay and skipped-row notices, the en-route degrade paths
 * and AFP-only rethrow, declared feed errors, and format() fidelity and sanitizing.
 * @module tests/mcp-server/tools/list-active-events.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listActiveEvents } from '@/mcp-server/tools/definitions/list-active-events.tool.js';
import { EVENT_TYPES } from '@/mcp-server/tools/schemas.js';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import {
  contentText,
  createClock,
  errorOf,
  type FeedName,
  type FeedOverride,
  feedHarness,
  installServices,
  type Responder,
  recoveryHint,
} from '../../helpers/faa-fakes.js';
import { FEED_FAILURES, withLadder } from '../../helpers/feed-failures.js';

type Overrides = Partial<Record<FeedName, FeedOverride | Responder>>;

let harness: ReturnType<typeof feedHarness>;
let services: { dispose: () => void };

function setup(overrides: Overrides = {}, start?: string): void {
  harness = feedHarness(overrides);
  services = installServices({ fetch: harness.fetch, now: createClock(start).now });
}

const run = (input: Record<string, unknown> = {}) =>
  runToolContract(listActiveEvents, input as never);

interface Structured {
  appliedEventTypes: string[];
  countsByType: Record<string, number | undefined>;
  enRouteFeed: string;
  events: { eventType: string; location: string; [key: string]: unknown }[];
  fetchedAt: string;
  notice?: string;
  shown: number;
  totalActive: number;
}
const structured = (result: Awaited<ReturnType<typeof run>>) =>
  result.structuredContent as unknown as Structured;
const locations = (result: Awaited<ReturnType<typeof run>>) =>
  structured(result).events.map((event) => `${event.eventType}:${event.location}`);

beforeEach(() => setup());
afterEach(() => {
  services.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('event_types input', () => {
  const parse = (value: unknown) =>
    listActiveEvents.input.parse({ event_types: value }).event_types;

  it.each([
    ['a blank string', ''],
    ['whitespace', '   '],
    ['a string of only commas', ' , ,'],
    ['an empty array', []],
    ['null', null],
    ['undefined', undefined],
  ])('reads %s as unset', (_label, value) => {
    expect(parse(value)).toBeUndefined();
  });

  it('reads an omitted key as unset', () => {
    expect(listActiveEvents.input.parse({}).event_types).toBeUndefined();
  });

  it.each([
    ['gs', ['ground_stop']],
    ['GDP', ['ground_delay_program']],
    [' afp ', ['airspace_flow_program']],
    ['gs, gdp', ['ground_stop', 'ground_delay_program']],
    [
      ['Ground Stop', 'DEICING'],
      ['ground_stop', 'deicing'],
    ],
    [['closure-notam'], ['closure_notam']],
    ['airport_closure,departure_delay', ['airport_closure', 'departure_delay']],
    ['departure delay, arrival delay', ['departure_delay', 'arrival_delay']],
    ['departure delay', ['departure_delay']],
    ['Ground Stop,gdp afp', ['ground_stop', 'ground_delay_program', 'airspace_flow_program']],
    ['gs gdp', ['ground_stop', 'ground_delay_program']],
  ])('normalizes %j', (input, expected) => {
    const parsed = listActiveEvents.input.safeParse({ event_types: input });
    expect(parsed.success && parsed.data.event_types).toEqual(expected);
  });

  it('accepts spelled-out types in a comma-separated string through the wire', async () => {
    const result = await run({ event_types: 'departure delay, arrival delay' });
    expect(structured(result).appliedEventTypes).toEqual(['departure_delay', 'arrival_delay']);
    expect(locations(result)).toEqual(['arrival_delay:BOS', 'departure_delay:ORD']);
  });

  it('rejects an unknown type through the wire with the options in the hint', async () => {
    const result = await run({ event_types: 'runway_fire' });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data?.reason).toBe('invalid_arguments');
    expect(contentText(result)).toContain('event_types');
  });

  it('rejects a non-string, non-array value', async () => {
    expect(listActiveEvents.input.safeParse({ event_types: 7 }).success).toBe(false);
  });

  it.each([
    ['a string of 10,000 whitespace-separated pieces', `${'- '.repeat(10_000)}x`],
    [
      'an array of 10,000 distinct unknown types',
      Array.from({ length: 10_000 }, (_, i) => `t${i}`),
    ],
  ])('bounds the rejection of %s to one issue per type plus one', async (_label, eventTypes) => {
    const result = await run({ event_types: eventTypes });

    const issues = errorOf(result).data?.issues as unknown[] | undefined;
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(issues?.length).toBeLessThanOrEqual(EVENT_TYPES.length + 1);
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
  });

  it('dedupes before bounding the list, so repeats never push a valid type out', () => {
    expect(parse([...Array(20).fill('gs'), 'gdp'])).toEqual([
      'ground_stop',
      'ground_delay_program',
    ]);
  });

  it.each(['constructor', '__proto__'])(
    'passes %j to the enum as the word sent, never an inherited object member',
    (name) => {
      expect(z.parse(listActiveEvents.input.shape.event_types.in, name)).toEqual([name]);
    },
  );
});

describe('results', () => {
  it('lists every event sorted by severity, then magnitude, then location', async () => {
    const result = await run();

    expect(locations(result)).toEqual([
      'airport_closure:JFK',
      'ground_stop:DEN',
      'ground_delay_program:SEA',
      'ground_delay_program:ATL',
      'airspace_flow_program:FCAA05',
      'airspace_flow_program:FCA002',
      'arrival_delay:BOS',
      'departure_delay:ORD',
      'closure_notam:LAX',
      'deicing:MSP',
    ]);
  });

  it('sorts an Airspace Flow Program with no reported delay after ones that report one', async () => {
    const result = await run({ event_types: 'afp' });
    expect(locations(result)).toEqual([
      'airspace_flow_program:FCAA05',
      'airspace_flow_program:FCA002',
    ]);
  });

  it('keeps the sort transitive across rows with and without a reported delay', async () => {
    services.dispose();
    setup({
      'airport-events': [
        { airportId: 'CCC', groundDelay: { avgDelay: 10 } },
        { airportId: 'AAA', groundDelay: {} },
        { airportId: 'BBB', groundDelay: { avgDelay: 30 } },
        { airportId: 'DDD', groundDelay: {} },
      ],
      'enroute-events': [],
    });

    const result = await run({ event_types: 'gdp' });

    expect(locations(result)).toEqual([
      'ground_delay_program:BBB',
      'ground_delay_program:CCC',
      'ground_delay_program:AAA',
      'ground_delay_program:DDD',
    ]);
  });

  it('sorts arrival and departure delays together by band maximum', async () => {
    services.dispose();
    setup({
      'airport-events': [
        { airportId: 'AAA', arrivalDelay: { averageDelay: '15', trend: 'increasing' } },
        { airportId: 'BBB', departureDelay: { averageDelay: '45', trend: 'increasing' } },
        { airportId: 'CCC', arrivalDelay: { averageDelay: '30', trend: 'increasing' } },
      ],
    });

    const result = await run({ event_types: ['arrival_delay', 'departure_delay'] });

    expect(locations(result)).toEqual([
      'departure_delay:BBB',
      'arrival_delay:CCC',
      'arrival_delay:AAA',
    ]);
  });

  it('maps GDP, delay band, closure, NOTAM, deicing, and AFP fields', async () => {
    const { events } = structured(await run());
    const byKey = new Map(events.map((event) => [`${event.eventType}:${event.location}`, event]));

    expect(byKey.get('ground_delay_program:SEA')).toMatchObject({
      advisory: { date: '2026-09-30', number: 3 },
      averageDelayMinutes: 55,
      locationName: 'Seattle-Tacoma International',
      maximumDelayMinutes: 117,
      reason: 'low ceilings',
    });
    expect(byKey.get('departure_delay:ORD')).toMatchObject({
      delayRangeMinutes: { max: 30, min: 16 },
      trend: 'increasing',
    });
    expect(byKey.get('airport_closure:JFK')).toMatchObject({
      closureText: 'CLOSED EXC EMERGENCY AND MILITARY',
    });
    expect(byKey.get('closure_notam:LAX')?.closureText).toContain('!LAX 05/277');
    expect(byKey.get('deicing:MSP')).toMatchObject({ startTime: '2026-09-29T21:00:00Z' });
    expect(byKey.get('airspace_flow_program:FCAA05')).toMatchObject({
      advisory: { number: 45 },
      afp: {
        constrainedArea: { name: 'ZNY', type: 'artcc' },
        delayProfile: { averageDelayMinutes: [40, 44] },
        excludedDepartures: 'ZBW ZOB',
        filtersMatchAny: false,
      },
      averageDelayMinutes: 42.5,
      location: 'FCAA05',
    });
  });

  it('omits a delay range when the feed gave no usable band', async () => {
    services.dispose();
    setup({
      'airport-events': [{ airportId: 'SEA', departureDelay: { reason: 'volume' } }],
      'enroute-events': [],
    });
    const [event] = structured(await run()).events;
    expect(event).toMatchObject({ eventType: 'departure_delay', reason: 'volume' });
    expect(event).not.toHaveProperty('delayRangeMinutes');
  });

  it.each([
    ['only a minimum', { min: '16 minutes' }, { min: 16 }],
    ['only a maximum', { max: '30 minutes' }, { max: 30 }],
  ])('keeps the known bound of a band that reports %s', async (_label, arrivalDeparture, range) => {
    services.dispose();
    setup({
      'airport-events': [{ airportId: 'SEA', departureDelay: { arrivalDeparture } }],
      'enroute-events': [],
    });
    const [event] = structured(await run()).events;
    expect(event).toMatchObject({ eventType: 'departure_delay', location: 'SEA' });
    expect(event?.delayRangeMinutes).toEqual(range);
  });

  it('omits feed numbers too large to represent instead of failing the list', async () => {
    services.dispose();
    setup({
      'airport-events': `[
        {"airportId": "SEA", "groundDelay": {"avgDelay": 55,
          "advisoryUrl": "https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=${'9'.repeat(25)}&adv_date=09302026"}},
        {"airportId": "ORD", "departureDelay": {"arrivalDeparture":
          {"min": "${'9'.repeat(400)} minutes", "max": "30 minutes"}}},
        {"airportId": "BOS", "arrivalDelay": {"averageDelay": 1e999, "trend": "increasing"}}
      ]`,
      'enroute-events': [],
    });

    const result = await run();

    expect(result.isError).toBeFalsy();
    const byKey = new Map(
      structured(result).events.map((event) => [`${event.eventType}:${event.location}`, event]),
    );
    expect(byKey.get('ground_delay_program:SEA')).toEqual({
      averageDelayMinutes: 55,
      eventType: 'ground_delay_program',
      location: 'SEA',
    });
    expect(byKey.get('departure_delay:ORD')?.delayRangeMinutes).toEqual({ max: 30 });
    expect(byKey.get('arrival_delay:BOS')).not.toHaveProperty('delayRangeMinutes');
  });

  it('sorts a one-sided band by its known bound, ahead of a delay with no band', async () => {
    services.dispose();
    setup({
      'airport-events': [
        { airportId: 'AAA', arrivalDelay: { reason: 'volume' } },
        { airportId: 'BBB', departureDelay: { arrivalDeparture: { min: '46 minutes' } } },
        { airportId: 'CCC', arrivalDelay: { averageDelay: '15', trend: 'increasing' } },
        { airportId: 'DDD', arrivalDelay: { arrivalDeparture: { max: '45 minutes' } } },
      ],
    });

    const result = await run({ event_types: ['arrival_delay', 'departure_delay'] });

    expect(locations(result)).toEqual([
      'departure_delay:BBB',
      'arrival_delay:DDD',
      'arrival_delay:CCC',
      'arrival_delay:AAA',
    ]);
  });
});

describe('enrichment and filtering', () => {
  it('reports whole-feed counts and totals with no filter', async () => {
    const data = structured(await run());

    expect(data).toMatchObject({
      appliedEventTypes: [...EVENT_TYPES],
      countsByType: {
        airport_closure: 1,
        airspace_flow_program: 2,
        arrival_delay: 1,
        closure_notam: 1,
        deicing: 1,
        departure_delay: 1,
        ground_delay_program: 2,
        ground_stop: 1,
      },
      enRouteFeed: 'ok',
      shown: 10,
      totalActive: 10,
    });
    expect(data.notice).toBeUndefined();
  });

  it('filters rows but keeps counts over the whole feed', async () => {
    const data = structured(await run({ event_types: 'gs, gdp' }));

    expect(locations(await run({ event_types: 'gs, gdp' }))).toEqual([
      'ground_stop:DEN',
      'ground_delay_program:SEA',
      'ground_delay_program:ATL',
    ]);
    expect(data).toMatchObject({
      appliedEventTypes: ['ground_stop', 'ground_delay_program'],
      shown: 3,
      totalActive: 10,
    });
    expect(data.countsByType.arrival_delay).toBe(1);
  });

  it('dedupes a repeated type in the applied filter', async () => {
    const data = structured(await run({ event_types: ['gs', 'ground_stop'] }));
    expect(data.appliedEventTypes).toEqual(['ground_stop']);
    expect(data.events).toHaveLength(1);
  });

  it.each([
    ['a blank string', ''],
    ['an empty array', []],
    ['omitted', undefined],
  ])('treats %s as no filter', async (_label, value) => {
    const data = structured(await run(value === undefined ? {} : { event_types: value }));
    expect(data.appliedEventTypes).toEqual([...EVENT_TYPES]);
    expect(data.shown).toBe(10);
  });

  it('explains a filter that matches nothing while other events are active', async () => {
    services.dispose();
    setup({
      'airport-events': [{ airportId: 'SEA', deicing: { eventTime: '2026-09-29T21:00:00Z' } }],
      'enroute-events': [],
    });

    const data = structured(await run({ event_types: 'gs' }));

    expect(data).toMatchObject({ shown: 0, totalActive: 1 });
    expect(data.notice).toContain(
      'No active ground_stop events; 1 other events are active (see countsByType).',
    );
  });

  describe('zero-result page', () => {
    beforeEach(() => {
      services.dispose();
      setup({ 'airport-events': [], 'enroute-events': [] });
    });

    it('returns required enrichment with zero counts and the nationwide-quiet notice', async () => {
      const result = await run();

      expect(result.isError).toBeFalsy();
      const data = structured(result);
      expect(data.events).toEqual([]);
      expect(data).toMatchObject({
        countsByType: {
          airport_closure: 0,
          airspace_flow_program: 0,
          arrival_delay: 0,
          closure_notam: 0,
          deicing: 0,
          departure_delay: 0,
          ground_delay_program: 0,
          ground_stop: 0,
        },
        enRouteFeed: 'ok',
        shown: 0,
        totalActive: 0,
      });
      expect(data.notice).toContain(
        'The FAA reports no active traffic management events nationwide.',
      );
      expect(contentText(result)).toContain('**By type:** none');
    });

    it('adds the no-AFP notice when the filter asks for AFPs', async () => {
      const data = structured(await run({ event_types: 'afp' }));
      expect(data.notice).toContain('No Airspace Flow Programs are active');
    });
  });

  describe('under-cap page', () => {
    it('returns required enrichment for a partial page: one listed airport, empty en-route', async () => {
      services.dispose();
      setup({
        'airport-events': [{ airportId: 'SEA', groundStop: { impactingCondition: 'wx' } }],
        'enroute-events': [],
      });

      const result = await run();
      const data = structured(result);

      expect(result.isError).toBeFalsy();
      expect(data).toMatchObject({ enRouteFeed: 'ok', shown: 1, totalActive: 1 });
      expect(data.countsByType).toMatchObject({ airspace_flow_program: 0, ground_stop: 1 });
      expect(data.notice).toBeUndefined();
    });

    it('returns required enrichment when the filter leaves fewer rows than the feed holds', async () => {
      const result = await run({ event_types: 'deicing' });
      expect(result.isError).toBeFalsy();
      expect(structured(result)).toMatchObject({ shown: 1, totalActive: 10 });
    });
  });

  it('reports skipped rows from both feeds', async () => {
    services.dispose();
    setup({
      'airport-events': [{ airportId: 'SEA', deicing: {} }, { junk: 1 }],
      'enroute-events': [{ airspaceFlowProgram: { afpName: 'F' } }, { airspaceFlowProgram: {} }],
    });

    expect(structured(await run()).notice).toContain(
      '2 FAA feed rows could not be read and were skipped.',
    );
  });

  it('reports one skipped row in the singular', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA', deicing: {} }, { junk: 1 }] });

    expect(structured(await run()).notice).toContain(
      '1 FAA feed row could not be read and was skipped.',
    );
  });

  describe('stale delay rows', () => {
    it('flags each arrival or departure delay last updated more than 6 h before the snapshot', async () => {
      services.dispose();
      setup({}, '2026-09-30T08:00:00Z');

      const { notice } = structured(await run());

      expect(notice).toContain(
        'ORD departure delay was last updated 8 h ago; the FAA feed can keep a delay entry after it lapses.',
      );
      expect(notice).toContain('BOS arrival delay was last updated 8 h ago');
    });

    it('leaves out stale delays the event_types filter excluded', async () => {
      services.dispose();
      setup({}, '2026-09-30T08:00:00Z');

      const { notice } = structured(await run({ event_types: 'gs, departure delay' }));

      expect(notice).toContain('ORD departure delay was last updated 8 h ago');
      expect(notice).not.toContain('BOS arrival delay');
      expect(structured(await run({ event_types: 'gs' })).notice).toBeUndefined();
    });

    it('does not flag a delay at exactly 6 h', async () => {
      services.dispose();
      setup({}, '2026-09-30T05:15:00Z');
      expect(structured(await run()).notice).toBeUndefined();
    });

    it('flattens line breaks in the airport identifier it names', async () => {
      services.dispose();
      setup(
        {
          'airport-events': [
            {
              airportId: 'ORD\n### Injected',
              departureDelay: {
                averageDelay: '15',
                trend: 'increasing',
                updateTime: '2026-09-29T23:15:00Z',
              },
            },
          ],
          'enroute-events': [],
        },
        '2026-09-30T08:00:00Z',
      );

      expect(structured(await run()).notice).toContain(
        'ORD ### INJECTED departure delay was last updated 8 h ago',
      );
    });
  });
});

describe('en-route degrade paths', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('degrades to unavailable when the en-route feed is down, omitting AFP counts', async () => {
    services.dispose();
    setup({ 'enroute-events': () => new Response('down', { status: 503 }) });

    const result = await withLadder(() => run());
    const data = structured(result);

    expect(result.isError).toBeFalsy();
    expect(data.enRouteFeed).toBe('unavailable');
    expect(data.countsByType).not.toHaveProperty('airspace_flow_program');
    expect(data.events.some((event) => event.eventType === 'airspace_flow_program')).toBe(false);
    expect(data.totalActive).toBe(8);
    expect(data.notice).toContain('The FAA en-route feed could not be read');
    expect(contentText(result)).toContain('airspace_flow_program unknown');
  });

  it('reports format_changed when the en-route feed changed shape', async () => {
    services.dispose();
    setup({ 'enroute-events': { unexpected: 'object' } });

    const result = await withLadder(() => run());
    const data = structured(result);

    expect(data.enRouteFeed).toBe('format_changed');
    expect(data.notice).toContain('returned a format this server does not read');
    expect(data.notice).not.toContain('could not be read');
    expect(data.events.length).toBeGreaterThan(0);
  });

  it('reports format_changed for a 404 en-route path', async () => {
    services.dispose();
    setup({ 'enroute-events': () => new Response('gone', { status: 404 }) });

    expect(structured(await withLadder(() => run())).enRouteFeed).toBe('format_changed');
  });

  it('degrades with the other types requested too, unless AFPs are the only type', async () => {
    services.dispose();
    setup({ 'enroute-events': () => new Response('gone', { status: 404 }) });

    const mixed = await withLadder(() => run({ event_types: ['gs', 'afp'] }));
    expect(mixed.isError).toBeFalsy();
    expect(locations(mixed)).toEqual(['ground_stop:DEN']);
  });

  it('rethrows the en-route failure when AFPs are the only type requested', async () => {
    services.dispose();
    setup({ 'enroute-events': () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run({ event_types: 'afp' }));

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      data: { reason: 'feed_contract_changed' },
    });
  });

  it('still fails when the airport leg fails, even if the en-route leg is fine', async () => {
    services.dispose();
    setup({ 'airport-events': () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run());

    expect(errorOf(result).data?.reason).toBe('feed_contract_changed');
  });

  it('rethrows the en-route failure when the caller was cancelled', async () => {
    const controller = new AbortController();
    await getNasStatusService().getAirportEvents(
      (await import('@cyanheads/mcp-ts-core/testing')).createMockContext(),
    );
    controller.abort(new Error('client cancelled'));

    const result = await runToolContract(
      listActiveEvents,
      {},
      { context: { signal: controller.signal } },
    );

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('declared feed errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each(FEED_FAILURES)(
    '$label on airport-events reaches the result as $reason',
    async ({ code, reason, respond }) => {
      services.dispose();
      setup({ 'airport-events': respond });

      const result = await withLadder(() => run());

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data?.reason).toBe(reason);
      const declared = listActiveEvents.errors?.find((entry) => entry.reason === reason);
      expect(recoveryHint(error)).toBe(declared?.recovery);
      expect(declared?.recovery).toContain(
        reason === 'feed_contract_changed'
          ? 'faa_delays_get_advisory'
          : 'faa_delays_list_active_events',
      );
    },
  );

  it('reports a sustained 429 on both feeds as upstream_rate_limited, not pacer_shed', async () => {
    services.dispose();
    const throttled = () => new Response('slow', { headers: { 'retry-after': '5' }, status: 429 });
    setup({ 'airport-events': throttled, 'enroute-events': throttled });

    const error = errorOf(await withLadder(() => run()));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_rate_limited' },
    });
    expect(error.data?.retryAfter).toBeGreaterThanOrEqual(5);
  });

  it('carries pacer_shed with retryAfter', async () => {
    vi.spyOn(getNasStatusService(), 'getAirportEvents').mockRejectedValue(
      rateLimited('queue full', { reason: 'pacer_shed', retryAfter: 9 }),
    );

    const result = await run();

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryAfter: 9 },
    });
  });
});

describe('format', () => {
  it('renders each event with the fields a caller acts on and the enrichment trailer', async () => {
    const text = contentText(await run());

    expect(text).toContain('### airport_closure — JFK (John F Kennedy International)');
    expect(text).toContain('- Delay: average 55 min, maximum 117 min');
    expect(text).toContain('- Delay band: 16–30 min, increasing');
    expect(text).toContain('- Probability of extension: high');
    expect(text).toContain(
      '- Advisory: ADVZY 12 · 2026-09-29 · https://www.fly.faa.gov/adv/adv_otherdis?advn=12&adv_date=09292026',
    );
    expect(text).toContain('- Constrained area: artcc ZNY');
    expect(text).toContain('- Altitudes: floor 000, ceiling 600');
    expect(text).toContain('- Filters match: all (AND)');
    expect(text).toContain('- Excluded departures: ZBW ZOB');
    expect(text).toContain(
      '- Delay profile: 40, 44 min (15-min intervals from 2026-07-15T18:00:00Z)',
    );
    expect(text).toContain('> EXPECT EDCTS FOR FLIGHTS WESTBOUND THROUGH FCAA05.');
    expect(text).toContain(
      '**By type:** airport_closure 1 · ground_stop 1 · ground_delay_program 2',
    );
    expect(text).toContain('**Event types:** all');
    expect(text).toContain('**Total active:** 10');
  });

  it('lists the applied types when filtered', async () => {
    expect(contentText(await run({ event_types: 'gs,gdp' }))).toContain(
      '**Event types:** ground_stop, ground_delay_program',
    );
  });

  it('renders sparse rows without inventing facts', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA', deicing: {} }], 'enroute-events': [] });

    const text = contentText(await run());

    expect(text).toContain('### deicing — SEA');
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('names or leaves out a value the FAA did not report, never a placeholder', () => {
    const blocks = listActiveEvents.format?.({
      events: [
        {
          eventType: 'ground_delay_program',
          location: 'SEA',
          maximumDelayMinutes: 96,
          startTime: '2026-09-30T01:00:00Z',
        },
        { endTime: '2026-09-30T04:00:00Z', eventType: 'ground_stop', location: 'DEN' },
        {
          afp: { altitudeCeiling: '600', constrainedArea: { type: 'fca' } },
          averageDelayMinutes: 40,
          eventType: 'airspace_flow_program',
          location: 'FCA001',
        },
        {
          delayRangeMinutes: { min: 16 },
          eventType: 'arrival_delay',
          location: 'BOS',
          trend: 'increasing',
        },
        { delayRangeMinutes: { max: 30 }, eventType: 'departure_delay', location: 'ORD' },
      ],
      fetchedAt: 'now',
    });
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : '';

    expect(text).toContain('- Delay: maximum 96 min');
    expect(text).toContain('- Window: from 2026-09-30T01:00:00Z (end not reported)');
    expect(text).toContain('- Window: until 2026-09-30T04:00:00Z (start not reported)');
    expect(text).toContain('- Delay: average 40 min');
    expect(text).toContain('- Altitudes: ceiling 600');
    expect(text).toContain('- Delay band: at least 16 min, increasing');
    expect(text).toContain('- Delay band: up to 30 min');
    expect(text).not.toContain('?');
  });

  it('keeps CR/LF/TAB out of inline slots and quotes multi-line text', async () => {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'SEA',
          airportClosure: { text: 'CLOSED\r\n## Closure injection' },
          airportLongName: 'Sea\r\n### Name injection',
          groundDelay: {
            impactingCondition: 'ceil\r\n### Reason injection',
            startTime: '2026-09-30T01:00:00Z\n### Start injection',
            updatedAt: '2026-09-30T00:17:04Z\r\n### Updated injection',
          },
        },
      ],
      'enroute-events': [
        {
          airspaceFlowProgram: {
            afpName: 'FCA\r\n### Afp injection',
            fuelFlowAdvisoryDelayTime: {
              dasDelays: { dasDelay: [{ delay: 40, seq: 1 }] },
              startTime: '2026-09-30T01:00:00Z\n### Profile injection',
            },
            impactingCondition: 'wx\n### Afp reason',
          },
          comments: 'ONE\r\nTWO\n### Comment injection',
          departsAny: 'ZNY\r\n### Dep injection',
        },
      ],
    });

    const text = contentText(await run());
    const lines = text.split('\n');

    for (const injected of [
      '### Name injection',
      '### Reason injection',
      '### Afp injection',
      '### Afp reason',
      '### Dep injection',
      '## Closure injection',
      '### Start injection',
      '### Updated injection',
      '### Profile injection',
    ]) {
      expect(
        lines.some((line) => line.startsWith(injected)),
        injected,
      ).toBe(false);
    }
    expect(lines).toContain('> CLOSED');
    expect(lines).toContain('> ## Closure injection');
    expect(lines).toContain('> TWO');
    expect(lines).toContain('> ### Comment injection');
  });

  it('keeps structuredContent verbatim', async () => {
    services.dispose();
    setup({
      'airport-events': [{ airportId: 'SEA', airportClosure: { text: 'A\r\nB' } }],
      'enroute-events': [],
    });

    expect(structured(await run()).events[0]?.closureText).toBe('A\r\nB');
  });
});
