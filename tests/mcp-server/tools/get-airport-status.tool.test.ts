/**
 * @fileoverview Tests for faa_delays_get_airport_status: input normalization and validation,
 * ICAO crosswalk, unknown_airport before any upstream call, status precedence, degrade paths,
 * staleness and skipped-row notices, declared feed errors, and format() fidelity and sanitizing.
 * @module tests/mcp-server/tools/get-airport-status.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAirportStatus } from '@/mcp-server/tools/definitions/get-airport-status.tool.js';
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
let clock: ReturnType<typeof createClock>;
let services: { dispose: () => void };

function setup(overrides: Overrides = {}, start?: string): void {
  harness = feedHarness(overrides);
  clock = createClock(start);
  services = installServices({ fetch: harness.fetch, now: clock.now });
}

const run = (input: unknown) => runToolContract(getAirportStatus, input as { airports: string[] });

type Row = {
  airportId: string;
  [key: string]: unknown;
};
const rowsOf = (result: Awaited<ReturnType<typeof run>>): Row[] =>
  (result.structuredContent as { airports: Row[] }).airports;
const noticeOf = (result: Awaited<ReturnType<typeof run>>): string | undefined =>
  (result.structuredContent as { notice?: string }).notice;

beforeEach(() => setup());
afterEach(() => {
  services.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('input', () => {
  const parse = (airports: unknown) => getAirportStatus.input.safeParse({ airports });

  it.each([
    [['sea'], ['SEA']],
    [' ord , jfk ', ['ORD', 'JFK']],
    ['ORD JFK\tBOS\nSEA', ['ORD', 'JFK', 'BOS', 'SEA']],
    [
      ['  ksea ', 'Phnl'],
      ['KSEA', 'PHNL'],
    ],
    ['0S9', ['0S9']],
  ])('normalizes %j to %j', (input, expected) => {
    const parsed = parse(input);
    expect(parsed.success && parsed.data.airports).toEqual(expected);
  });

  it('accepts exactly 25 airports and rejects 26', () => {
    const codes = (n: number) =>
      Array.from({ length: n }, (_, i) => `A${String(i).padStart(2, '0')}`);
    expect(parse(codes(25)).success).toBe(true);
    expect(parse(codes(26)).success).toBe(false);
  });

  it.each([
    ['a blank string', ''],
    ['whitespace only', '  ,  '],
    ['an empty array', []],
    ['a city name', 'Seattle'],
    ['a 2-character code', 'SE'],
    ['a 5-character code', 'KSEAA'],
    ['a code with punctuation', 'SE-A'],
    ['a non-string item', [42]],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(parse(value).success).toBe(false);
  });

  it('reaches the wire as InvalidParams with reason invalid_arguments', async () => {
    const result = await run({ airports: 'Seattle' });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
  });
});

describe('airport resolution', () => {
  it('maps ICAO codes to FAA identifiers and echoes requestedAs only when they differ', async () => {
    const result = await run({ airports: ['KSEA', 'phnl', 'sea', 'ORD'] });
    const rows = rowsOf(result);

    expect(rows.map((row) => row.airportId)).toEqual(['SEA', 'HNL', 'ORD']);
    expect(rows[0]).toMatchObject({ airportId: 'SEA', requestedAs: 'KSEA' });
    expect(rows[1]).toMatchObject({ airportId: 'HNL', requestedAs: 'PHNL' });
    expect(rows[2]).not.toHaveProperty('requestedAs');
  });

  it('drops duplicates after normalization, keeping the first and its requestedAs', async () => {
    const rows = rowsOf(await run({ airports: ['KSEA', 'SEA', 'sea'] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ airportId: 'SEA', requestedAs: 'KSEA' });
  });

  it('keeps request order', async () => {
    const rows = rowsOf(await run({ airports: ['ORD', 'SEA', 'LAX'] }));
    expect(rows.map((row) => row.airportId)).toEqual(['ORD', 'SEA', 'LAX']);
  });

  it('echoes the directory name, city, and state for an airport the feed does not list', async () => {
    const [row] = rowsOf(await run({ airports: ['PDX'] }));
    expect(row).toMatchObject({
      airportId: 'PDX',
      city: 'PORTLAND',
      listedInFeed: false,
      state: 'OR',
    });
    expect(row?.airportName).toEqual(expect.any(String));
  });

  it('prefers the feed long name when the airport is listed', async () => {
    const [row] = rowsOf(await run({ airports: ['SEA'] }));
    expect(row?.airportName).toBe('Seattle-Tacoma International');
  });

  describe('unknown_airport', () => {
    it('fails the whole batch with typed data before any upstream request', async () => {
      const result = await run({ airports: ['SEA', 'zzz', 'K0S9', 'ZZZ', 'CYVR'] });

      expect(harness.calls).toHaveLength(0);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'unknown_airport', unknownCodes: ['ZZZ', 'K0S9', 'CYVR'] },
      });
      const message = errorOf(result).message;
      expect(message).toContain('ZZZ (not a US FAA location identifier)');
      expect(message).toContain(
        'K0S9 (not the ICAO code of a US airport with a 3-character FAA identifier)',
      );
      expect(message).toContain('CYVR (not the ICAO code');
      expect(contentText(result)).toContain(
        'Recovery: Send each airport as its 3-character FAA identifier',
      );
    });

    it('rejects a 3-character unknown code with no upstream call', async () => {
      const result = await run({ airports: ['QQQ'] });
      expect(errorOf(result).data).toMatchObject({
        reason: 'unknown_airport',
        unknownCodes: ['QQQ'],
      });
      expect(harness.calls).toHaveLength(0);
    });

    it('rejects a 4-character unknown code with no upstream call', async () => {
      const result = await run({ airports: ['KQQQ'] });
      expect(errorOf(result).data).toMatchObject({
        reason: 'unknown_airport',
        unknownCodes: ['KQQQ'],
      });
      expect(harness.calls).toHaveLength(0);
    });

    it('carries the recovery hint the contract declares', async () => {
      const declared = getAirportStatus.errors?.find((e) => e.reason === 'unknown_airport');
      const result = await run({ airports: ['QQQ'] });
      expect(recoveryHint(errorOf(result))).toBe(declared?.recovery);
    });

    it('logs at notice, as caller input, while feed reasons keep the default error level', () => {
      for (const entry of getAirportStatus.errors ?? []) {
        expect('severity' in entry ? entry.severity : undefined, entry.reason).toBe(
          entry.reason === 'unknown_airport' ? 'notice' : undefined,
        );
      }
    });
  });
});

describe('status', () => {
  const statusOf = async (code: string) =>
    (rowsOf(await run({ airports: [code] }))[0] as Row).status;

  it.each([
    ['JFK', 'closed'],
    ['DEN', 'ground_stop'],
    ['SEA', 'ground_delay_program'],
    ['ATL', 'ground_delay_program'],
    ['ORD', 'delays'],
    ['BOS', 'delays'],
    ['LAX', 'restrictions_only'],
    ['MSP', 'restrictions_only'],
    ['PDX', 'no_active_events'],
  ])('%s is %s', async (code, expected) => {
    expect(await statusOf(code)).toBe(expected);
  });

  it('applies precedence closure > ground stop > GDP > delays > restrictions', async () => {
    const everything = {
      airportClosure: { text: 'CLOSED' },
      arrivalDelay: { averageDelay: '15', trend: 'increasing' },
      deicing: { eventTime: '2026-09-29T21:00:00Z' },
      groundDelay: { avgDelay: 10 },
      groundStop: { impactingCondition: 'x' },
    };
    const cases: [Record<string, unknown>, string][] = [
      [everything, 'closed'],
      [{ ...everything, airportClosure: null }, 'ground_stop'],
      [{ ...everything, airportClosure: null, groundStop: null }, 'ground_delay_program'],
      [{ ...everything, airportClosure: null, groundStop: null, groundDelay: null }, 'delays'],
      [{ deicing: everything.deicing }, 'restrictions_only'],
    ];
    for (const [events, expected] of cases) {
      services.dispose();
      setup({ 'airport-events': [{ airportId: 'SEA', ...events }] });
      expect((rowsOf(await run({ airports: ['SEA'] }))[0] as Row).status, expected).toBe(expected);
    }
  });

  it('reports every active event of a listed airport in its own field', async () => {
    const [sea] = rowsOf(await run({ airports: ['SEA'] }));
    expect(sea).toMatchObject({
      groundDelayProgram: {
        averageDelayMinutes: 55,
        delayProfile: { averageDelayMinutes: [64, 62, 62, 65], intervalMinutes: 15 },
        includedFlights: 'ALL CONTIGUOUS US DEP',
        maximumDelayMinutes: 117,
      },
      latitude: 47.4502,
      listedInFeed: true,
      runwayConfiguration: { arrivalRatePerHour: 38, arrivalRunways: '34L' },
    });
    expect(sea).not.toHaveProperty('groundStop');
  });

  it('marks pacing airports with their time zone, listed or not', async () => {
    const [sea, stl, pdx] = rowsOf(await run({ airports: ['SEA', 'STL', 'PDX'] }));
    expect(sea).toMatchObject({ isPacingAirport: true, timezone: 'US/Pacific' });
    expect(stl).toMatchObject({
      isPacingAirport: true,
      listedInFeed: false,
      timezone: 'US/Central',
    });
    expect(pdx).toMatchObject({ isPacingAirport: false });
    expect(pdx).not.toHaveProperty('timezone');
  });

  it('stamps fetchedAt from the airport-events fetch', async () => {
    const result = await run({ airports: ['SEA'] });
    expect((result.structuredContent as { fetchedAt: string }).fetchedAt).toBe(
      '2026-09-30T02:00:00.000Z',
    );
  });
});

describe('empty and partial feeds', () => {
  it('reports no_active_events with a notice on the zero-result page', async () => {
    services.dispose();
    setup({ 'airport-events': [] });

    const result = await run({ airports: ['SEA', 'ORD'] });

    expect(result.isError).toBeFalsy();
    expect(rowsOf(result).map((row) => row.status)).toEqual([
      'no_active_events',
      'no_active_events',
    ]);
    expect(rowsOf(result).every((row) => row.listedInFeed === false)).toBe(true);
    expect(noticeOf(result)).toContain(
      'None of the requested airports has an active FAA traffic management event',
    );
    expect(contentText(result)).toContain('faa_delays_get_operations_plan');
  });

  it('omits that notice when at least one airport is listed', async () => {
    const result = await run({ airports: ['SEA', 'PDX'] });
    expect(noticeOf(result)).toBeUndefined();
  });

  it('serves sparse rows without inventing facts', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA' }] });

    const result = await run({ airports: ['SEA'] });
    const [row] = rowsOf(result);

    expect(row).toMatchObject({ listedInFeed: true, status: 'restrictions_only' });
    expect(row).not.toHaveProperty('latitude');
    expect(row).not.toHaveProperty('runwayConfiguration');
    expect(contentText(result)).not.toMatch(/undefined|NaN/);
  });

  it('reports skipped feed rows in the notice', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA' }, { nope: 1 }, { alsoNope: 2 }] });

    const result = await run({ airports: ['SEA'] });

    expect(noticeOf(result)).toContain('2 FAA feed rows could not be read and were skipped.');
  });

  it('flags a delay last updated more than 6 h before the snapshot', async () => {
    services.dispose();
    setup({}, '2026-09-30T08:00:00Z');

    const result = await run({ airports: ['ORD'] });

    expect(noticeOf(result)).toContain(
      'ORD departure delay was last updated 8 h ago; the FAA feed can keep a delay entry after it lapses.',
    );
  });

  it('flags a stale arrival delay by its own label', async () => {
    services.dispose();
    setup({}, '2026-09-30T08:00:00Z');

    const result = await run({ airports: ['BOS'] });

    expect(noticeOf(result)).toContain('BOS arrival delay was last updated 8 h ago');
  });

  it('does not flag a delay at exactly 6 h', async () => {
    services.dispose();
    setup({}, '2026-09-30T05:15:00Z');
    expect(noticeOf(await run({ airports: ['ORD'] }))).toBeUndefined();
  });
});

describe('degrade paths', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('omits pacing fields and adds a notice when the pacing leg fails', async () => {
    services.dispose();
    setup({ 'pacing-airports': () => new Response('down', { status: 503 }) });

    const result = await withLadder(() => run({ airports: ['SEA', 'PDX'] }));

    expect(result.isError).toBeFalsy();
    for (const row of rowsOf(result)) {
      expect(row).not.toHaveProperty('isPacingAirport');
      expect(row).not.toHaveProperty('timezone');
    }
    expect(rowsOf(result)[0]).toMatchObject({ status: 'ground_delay_program' });
    expect(noticeOf(result)).toContain('Pacing-airport flags and time zones are omitted');
  });

  it('degrades on a pacing contract change too', async () => {
    services.dispose();
    setup({ 'pacing-airports': () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run({ airports: ['SEA'] }));

    expect(result.isError).toBeFalsy();
    expect(noticeOf(result)).toContain('Pacing-airport flags');
  });

  it('joins several notices into one string', async () => {
    services.dispose();
    setup({
      'airport-events': [{ airportId: 'SEA' }, { junk: true }],
      'pacing-airports': () => new Response('gone', { status: 404 }),
    });

    const result = await withLadder(() => run({ airports: ['SEA'] }));

    expect(noticeOf(result)).toContain('Pacing-airport flags and time zones are omitted');
    expect(noticeOf(result)).toContain('1 FAA feed row could not be read and was skipped.');
  });

  it('rethrows a failed pacing leg when the caller was cancelled', async () => {
    const controller = new AbortController();
    await getNasStatusService().getAirportEvents(createMockContext());
    controller.abort(new Error('client cancelled'));

    const result = await runToolContract(
      getAirportStatus,
      { airports: ['SEA'] },
      { context: { signal: controller.signal } },
    );

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('fails the call when the airport-events leg fails, even if pacing is fine', async () => {
    services.dispose();
    setup({ 'airport-events': () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run({ airports: ['SEA'] }));

    expect(errorOf(result).data).toMatchObject({ reason: 'feed_contract_changed' });
  });
});

describe('declared feed errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each(FEED_FAILURES)(
    '$label reaches the result as $reason',
    async ({ code, reason, respond }) => {
      services.dispose();
      setup({ 'airport-events': respond });

      const result = await withLadder(() => run({ airports: ['SEA'] }));

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data?.reason).toBe(reason);
      const declared = getAirportStatus.errors?.find((entry) => entry.reason === reason);
      expect(recoveryHint(error)).toBe(declared?.recovery);
      expect(contentText(result)).toContain(`reason ${reason}`);
    },
  );

  it('carries a shed from this server own pacer as pacer_shed with retryAfter', async () => {
    vi.spyOn(getNasStatusService(), 'getAirportEvents').mockRejectedValue(
      rateLimited('queue full', { reason: 'pacer_shed', retryAfter: 7 }),
    );

    const result = await run({ airports: ['SEA'] });

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryAfter: 7 },
    });
    expect(contentText(result)).toContain('wait the retryAfter seconds');
  });

  it('declares every feed reason on the tool, naming the tool in each retry hint', () => {
    const reasons = getAirportStatus.errors?.map((entry) => entry.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'unknown_airport',
        'feed_unavailable',
        'upstream_rate_limited',
        'retry_deadline_exceeded',
        'pacer_shed',
        'feed_contract_changed',
      ]),
    );
    for (const entry of getAirportStatus.errors ?? []) {
      if (entry.reason !== 'feed_contract_changed' && entry.reason !== 'unknown_airport') {
        expect(entry.recovery).toContain('faa_delays_get_airport_status');
      }
    }
  });
});

describe('format', () => {
  it('carries the same data as structuredContent', async () => {
    const result = await run({ airports: ['SEA', 'KJFK', 'DEN', 'ORD', 'LAX'] });
    const text = contentText(result);

    expect(text).toContain('**Fetched:** 2026-09-30T02:00:00.000Z');
    expect(text).toContain('## SEA — Seattle-Tacoma International (SEATTLE, WA)');
    expect(text).toContain('**Status:** ground_delay_program · **Listed in feed:** yes');
    expect(text).toContain('**Pacing airport:** yes · **Time zone:** US/Pacific');
    expect(text).toContain('- Arrival runways: 34L');
    expect(text).toContain('- Arrival rate: 38 per hour');
    expect(text).toContain('- Delay: average 55 min, maximum 117 min');
    expect(text).toContain(
      '- Delay profile: 64, 62, 62, 65 min (15-min intervals from 2026-09-30T01:00:00Z)',
    );
    expect(text).toContain('- Departure scope: 1200 nm');
    expect(text).toContain('- Included facilities: CYEG CYVR CYYC');
    expect(text).toContain(
      '- Advisory: ADVZY 3 · 2026-09-30 · https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=09302026',
    );
    expect(text).toContain('**Requested as:** KJFK');
    expect(text).toContain('**Airport closed:** 2026-09-29T20:00:00Z → 2026-09-30T04:00:00Z');
    expect(text).toContain('> CLOSED EXC EMERGENCY AND MILITARY');
    expect(text).toContain('- Probability of extension: high');
    expect(text).toContain('- Included facilities: ZAU ZDC');
    expect(text).toContain('**Departure delay:** 16–30 min, increasing');
    expect(text).toContain('- Reason: RWY:Obstruction');
    expect(text).toContain('**Closure NOTAM 277:**');
  });

  it('renders a delay without a band honestly', () => {
    const blocks = getAirportStatus.format?.({
      airports: [
        {
          airportId: 'SEA',
          airportName: 'Sea',
          arrivalDelay: { reason: 'volume' },
          listedInFeed: true,
          status: 'delays',
        },
      ],
      fetchedAt: 'now',
    });
    expect(blocks?.[0]).toMatchObject({
      text: expect.stringContaining('**Arrival delay:** band not reported'),
    });
  });

  it('names or leaves out a value the FAA did not report, never a placeholder', () => {
    const blocks = getAirportStatus.format?.({
      airports: [
        {
          airportId: 'SEA',
          airportName: 'Sea',
          arrivalDelay: { minMinutes: 16 },
          departureDelay: { maxMinutes: 30 },
          groundDelayProgram: { maximumDelayMinutes: 96 },
          groundStop: { startTime: '2026-09-30T01:00:00Z' },
          listedInFeed: true,
          longitude: -122.379,
          status: 'ground_stop',
        },
        {
          airportId: 'ORD',
          airportName: 'Ord',
          closure: { endTime: '2026-09-30T04:00:00Z' },
          closureNotam: {},
          latitude: 41.97,
          listedInFeed: true,
          status: 'closed',
        },
      ],
      fetchedAt: 'now',
    });
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : '';

    expect(text).toContain('**Coordinates:** longitude -122.379');
    expect(text).toContain('**Coordinates:** latitude 41.97');
    expect(text).toContain('**Ground stop:** from 2026-09-30T01:00:00Z (end not reported)');
    expect(text).toContain('**Ground Delay Program:** times not reported');
    expect(text).toContain('- Delay: maximum 96 min');
    expect(text).toContain('**Arrival delay:** at least 16 min');
    expect(text).toContain('**Departure delay:** up to 30 min');
    expect(text).toContain('**Airport closed:** until 2026-09-30T04:00:00Z (start not reported)');
    expect(text).toContain('**Closure NOTAM:** times not reported');
    expect(text).not.toContain('?');
  });

  it('keeps upstream CR/LF/TAB out of inline slots and quotes multi-line free text', async () => {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'SEA',
          airportClosure: {
            endTime: '2026-09-30T05:00:00Z\n## Closure end',
            text: 'LINE ONE\r\nLINE TWO\n## Injected heading',
          },
          airportConfig: {
            arrivalRunwayConfig: '34L\r\n## Runway injection',
            arrivalRate: 40,
            sourceTimeStamp: '2026-09-30T00:53:49Z\r\n## Reported',
          },
          airportLongName: 'Sea\r\n# Name injection',
          deicing: { eventTime: '2026-09-29T21:00:00Z\n## Deicing' },
          departureDelay: {
            reason: 'RWY\r\n## Reason injection',
            averageDelay: '15',
            trend: 'increasing',
            updateTime: '2026-09-30T01:00:00Z\n## Band updated',
          },
          freeForm: {
            issuedDate: '2026-05-27T18:26:00Z\r\n## Issued',
            simpleText: '!SEA 1\r\n2\r\n3',
            text: 'NARROW\tRESTRICTION\r\n- injected',
          },
          groundDelay: {
            center: 'ZSE\n## Center',
            fuelFlowAdvisoryDelayTime: {
              dasDelays: { dasDelay: [{ delay: 30, seq: 1 }] },
              startTime: '2026-09-30T01:00:00Z\n## Profile start',
            },
            includedFlights: ': ALL\r\n## Flights',
            impactingCondition: 'ceil\r\n## GDP reason',
            updatedAt: '2026-09-30T00:17:04Z\n## GDP updated',
          },
          groundStop: {
            impactingCondition: 'wx\r\n## Stop reason',
            includedFacilities: ['ZAU\n## Fac'],
            startTime: '2026-09-30T01:00:00Z\r\n## Stop start',
          },
        },
      ],
    });

    const text = contentText(await run({ airports: ['SEA'] }));
    const lines = text.split('\n');

    for (const injected of [
      '# Name injection',
      '## Runway injection',
      '## Reason injection',
      '## GDP reason',
      '## Stop reason',
      '## Center',
      '## Flights',
      '## Fac',
      '## Closure end',
      '## Reported',
      '## Deicing',
      '## Band updated',
      '## Issued',
      '## Profile start',
      '## GDP updated',
      '## Stop start',
    ]) {
      expect(
        lines.some((line) => line.startsWith(injected)),
        injected,
      ).toBe(false);
    }
    expect(lines.filter((line) => line.startsWith('## '))).toEqual([
      expect.stringMatching(/^## SEA — Sea # Name injection/),
    ]);
    expect(lines).toContain('> LINE ONE');
    expect(lines).toContain('> LINE TWO');
    expect(lines).toContain('> ## Injected heading');
    expect(lines).toContain('> !SEA 1');
    expect(lines).toContain('> 3');
    expect(lines).toContain('- Restriction: NARROW RESTRICTION - injected');
  });

  it('keeps structuredContent verbatim while the text flattens', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA', airportClosure: { text: 'A\r\nB' } }] });

    const result = await run({ airports: ['SEA'] });

    expect(rowsOf(result)[0]).toMatchObject({ closure: { text: 'A\r\nB' } });
  });
});
