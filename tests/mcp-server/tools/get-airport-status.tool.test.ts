/**
 * @fileoverview Tests for faa_delays_get_airport_status: input normalization and validation,
 * ICAO crosswalk, unknown_airport before any upstream call, each row's ARTCC and the coordinate
 * fallback to the NASR directory, status precedence, the daily closure window, the operations
 * plan's planned programs per airport, degrade paths, staleness and skipped-row notices, declared feed errors, and format()
 * fidelity and sanitizing.
 * @module tests/mcp-server/tools/get-airport-status.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAirportStatus } from '@/mcp-server/tools/definitions/get-airport-status.tool.js';
import { getOperationsPlan } from '@/mcp-server/tools/definitions/get-operations-plan.tool.js';
import { NASR_AIRPORTS_TSV } from '@/services/airport-directory/nasr-airports.generated.js';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import {
  callsTo,
  contentText,
  createClock,
  errorOf,
  type FeedName,
  type FeedOverride,
  feedHarness,
  feedUrl,
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

/** The text of every paragraph and heading a CommonMark parse of `markdown` yields. */
const commonmarkTexts = (markdown: string): string[] =>
  new MarkdownIt('commonmark')
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .map((token) => token.content);

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  setup();
});
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

  it('accepts 25, 26, and 100 submitted airports and rejects 101', () => {
    const codes = (n: number) =>
      Array.from({ length: n }, (_, i) => `A${String(i).padStart(2, '0')}`);
    expect(parse(codes(25)).success).toBe(true);
    expect(parse(codes(26)).success).toBe(true);
    expect(parse(codes(100)).success).toBe(true);
    expect(parse(codes(101)).success).toBe(false);
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

  it.each([
    ['a comma-separated string', (n: number) => Array(n).fill('A').join(',')],
    ['an array', (n: number) => Array(n).fill('A')],
  ])(
    'rejects 10,000 malformed codes in %s with the same bounded error as 101',
    async (_label, codes) => {
      const atLimit = await run({ airports: codes(101) });
      const result = await run({ airports: codes(10_000) });

      expect(errorOf(result)).toEqual(errorOf(atLimit));
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      // Zod checks the array's size bound before its elements, so the list fails as one issue.
      expect(errorOf(result).data?.issues).toEqual([
        expect.objectContaining({ code: 'too_big', maximum: 100, path: ['airports'] }),
      ]);
      expect(errorOf(result).data?.issuesCount).toBeUndefined();
      expect(JSON.stringify(result).length).toBeLessThan(20_000);
    },
  );
});

describe('airport resolution', () => {
  it.each([25, 26, 100])('applies the processing cap for %i submitted codes', async (count) => {
    const codes = NASR_AIRPORTS_TSV.split('\n')
      .slice(0, count)
      .map((line) => line.split('\t')[0] as string);
    const result = await run({ airports: codes.join(',') });
    expect(result.structuredContent).toMatchObject({
      cap: 25,
      processedCount: 25,
      omittedAirports: codes.slice(25),
    });
    expect(rowsOf(result).map((row) => row.airportId)).toEqual(codes.slice(0, 25));
    expect(contentText(result)).toContain('**Processed count:** 25');
    expect(contentText(result)).toContain('**Cap:** 25');
    if (count > 25) {
      const next = await run({ airports: codes.slice(25) });
      expect(rowsOf(next).map((row) => row.airportId)).toEqual(codes.slice(25, 50));
    }
  });
  it('counts duplicate FAA/ICAO aliases once across the processing boundary', async () => {
    const result = await run({ airports: Array(50).fill('KSEA').concat(Array(50).fill('SEA')) });
    expect(result.structuredContent).toMatchObject({
      cap: 25,
      processedCount: 1,
      omittedAirports: [],
    });
    expect(rowsOf(result)[0]).toMatchObject({ airportId: 'SEA', requestedAs: 'KSEA' });
  });
  it.each(['ZZZZ', 'malformed!'])('validates invalid tail %s before fetching', async (tail) => {
    const codes = NASR_AIRPORTS_TSV.split('\n')
      .slice(0, 25)
      .map((line) => line.split('\t')[0] as string);
    const result = await run({ airports: [...codes, tail] });
    expect(result.isError).toBe(true);
    expect(errorOf(result).data?.reason).toBe(
      tail === 'ZZZZ' ? 'unknown_airport' : 'invalid_arguments',
    );
    expect(harness.calls).toHaveLength(0);
  });
  it.each([Array(101).fill('SEA'), Array(101).fill('SEA').join(',')])(
    'rejects over 100 submitted codes before deduplication',
    async (airports) => {
      expect((await run({ airports })).isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    },
  );
  it('discloses unreadable events, profile loss, and skipped pacing rows on both surfaces', async () => {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'SEA',
          groundStop: 'active',
          groundDelay: {
            avgDelay: 5,
            fuelFlowAdvisoryDelayTime: {
              startTime: '2026-10-13T18:00:00Z',
              dasDelays: {
                dasDelay: [
                  { seq: 1, delay: 10 },
                  { seq: 3, delay: 90 },
                ],
              },
            },
          },
        },
      ],
      'pacing-airports': [{ airportId: 'SEA' }, {}],
    });
    const result = await run({ airports: ['SEA'] });
    expect(rowsOf(result)[0]).toMatchObject({ groundDelayProgram: { averageDelayMinutes: 5 } });
    expect(rowsOf(result)[0]?.groundDelayProgram).not.toHaveProperty('delayProfile');
    for (const text of [noticeOf(result), contentText(result)]) {
      expect(text).toContain('groundStop');
      expect(text).toContain('dasDelay');
      expect(text).toContain('1 FAA feed row');
    }
  });
  it('renders effective and reported PHX zones on both surfaces', async () => {
    services.dispose();
    setup({ 'pacing-airports': [{ airportId: 'PHX', timezone: 'US/Mountain' }] });
    const result = await run({ airports: ['PHX'] });
    expect(rowsOf(result)[0]).toMatchObject({
      timezone: 'America/Phoenix',
      reportedTimezone: 'US/Mountain',
    });
    expect(contentText(result)).toContain('America/Phoenix');
    expect(contentText(result)).toContain('FAA-reported time zone:** US/Mountain');
  });
  it('processes the first 25 canonical airports and names the exact remainder on both surfaces', async () => {
    const codes = NASR_AIRPORTS_TSV.split('\n')
      .slice(0, 26)
      .map((line) => line.split('\t')[0] as string);
    const result = await run({ airports: codes });
    expect(result.isError).toBeFalsy();
    expect(rowsOf(result).map((row) => row.airportId)).toEqual(codes.slice(0, 25));
    expect(result.structuredContent).toMatchObject({
      cap: 25,
      processedCount: 25,
      omittedAirports: codes.slice(25),
    });
    expect(contentText(result)).toContain(codes[25]);
    expect(contentText(result)).toContain('faa_delays_get_airport_status');
  });
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

  it("keeps a listed airport's feed coordinates", async () => {
    const [row] = rowsOf(await run({ airports: ['SEA'] }));
    expect(row).toMatchObject({ latitude: 47.4502, longitude: -122.3088 });
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

describe('ARTCC and coordinates', () => {
  it('gives an unlisted airport its NASR ARTCC and coordinates', async () => {
    const result = await run({ airports: ['BOI'] });

    expect(rowsOf(result)[0]).toMatchObject({
      airportId: 'BOI',
      artcc: 'ZLC',
      latitude: 43.5644,
      listedInFeed: false,
      longitude: -116.2229,
      status: 'no_active_events',
    });
    expect(contentText(result)).toContain('**ARTCC:** ZLC · **Coordinates:** 43.5644, -116.2229');
  });

  it("keeps a listed airport's feed coordinates and adds its NASR ARTCC", async () => {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'DFW',
          airportLongName: 'Dallas-Fort Worth International',
          departureDelay: { averageDelay: '15', trend: 'increasing' },
          latitude: '32.8998',
          longitude: '-97.0403',
        },
      ],
    });

    const result = await run({ airports: ['KDFW'] });

    expect(rowsOf(result)[0]).toMatchObject({
      airportId: 'DFW',
      artcc: 'ZFW',
      latitude: 32.8998,
      listedInFeed: true,
      longitude: -97.0403,
      requestedAs: 'KDFW',
    });
    expect(contentText(result)).toContain('**ARTCC:** ZFW · **Coordinates:** 32.8998, -97.0403');
  });

  it('decodes an airport under a facility outside the 25 US ARTCCs', async () => {
    const [row] = rowsOf(await run({ airports: ['GUM'] }));
    expect(row).toMatchObject({ artcc: 'ZUA', latitude: 13.484, longitude: 144.7971 });
  });

  it("leaves out a listed airport's coordinates the feed omits rather than mixing in NASR's", async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA' }] });

    const result = await run({ airports: ['SEA'] });
    const [row] = rowsOf(result);

    expect(row).toMatchObject({ artcc: 'ZSE', listedInFeed: true });
    expect(row).not.toHaveProperty('latitude');
    expect(row).not.toHaveProperty('longitude');
    expect(contentText(result)).toContain('**ARTCC:** ZSE\n');
    expect(contentText(result)).not.toContain('**Coordinates:**');
  });

  it('describes where each row gets its ARTCC and coordinates, as the rows above follow it', () => {
    const { description } = getAirportStatus;

    expect(description).toContain("Every row carries the airport's ARTCC");
    expect(description).toContain(
      'coordinates come from the feed when the airport is listed (absent when the feed omits them) and from the NASR directory otherwise',
    );
    expect(description).not.toContain("Rows carry the airport's ARTCC and coordinates");
  });

  it('renders the ARTCC and coordinates of every row, listed or not', async () => {
    const result = await run({ airports: ['SEA', 'BOI', 'PDX', 'PGUM', 'ORD', 'FAQ'] });
    const rows = rowsOf(result);
    const sections = contentText(result).split('\n## ').slice(1);

    expect(sections).toHaveLength(rows.length);
    for (const [i, row] of rows.entries()) {
      expect(row, row.airportId).toMatchObject({
        artcc: expect.any(String),
        latitude: expect.any(Number),
        longitude: expect.any(Number),
      });
      expect(sections[i]).toContain(
        `**ARTCC:** ${row.artcc} · **Coordinates:** ${row.latitude}, ${row.longitude}`,
      );
    }
    expect(rows.map((row) => [row.airportId, row.listedInFeed])).toEqual([
      ['SEA', true],
      ['BOI', false],
      ['PDX', false],
      ['GUM', false],
      ['ORD', true],
      ['FAQ', false],
    ]);
  });

  describe('NASR fields left blank', () => {
    const GENERATED = '@/services/airport-directory/nasr-airports.generated.js';

    afterEach(() => {
      vi.doUnmock(GENERATED);
      vi.resetModules();
    });

    it('omits the field from the row and the rendered text', async () => {
      vi.resetModules();
      vi.doMock(GENERATED, () => ({
        NASR_EFFECTIVE_DATE: '2026-09-03',
        NASR_AIRPORTS_TSV: [
          'PDX\tKPDX\tPORTLAND INTL\tPORTLAND\tOR\t\t\t',
          'SEA\tKSEA\tSEATTLE-TACOMA INTL\tSEATTLE\tWA\t\t47.4499\t-122.3118',
        ].join('\n'),
      }));
      const { getAirportStatus: tool } = await import(
        '@/mcp-server/tools/definitions/get-airport-status.tool.js'
      );
      const fakes = await import('../../helpers/faa-fakes.js');
      const fresh = fakes.installServices({
        fetch: fakes.feedHarness().fetch,
        now: fakes.createClock().now,
      });

      try {
        const result = await runToolContract(tool, { airports: ['PDX', 'SEA'] });
        const [pdx, sea] = (result.structuredContent as { airports: Row[] }).airports;

        expect(result.isError).toBeFalsy();
        expect(pdx).toMatchObject({ airportId: 'PDX', listedInFeed: false });
        for (const field of ['artcc', 'latitude', 'longitude']) {
          expect(pdx).not.toHaveProperty(field);
        }
        expect(sea).toMatchObject({ latitude: 47.4502, listedInFeed: true, longitude: -122.3088 });
        expect(sea).not.toHaveProperty('artcc');
        const [pdxText, seaText] = contentText(result).split('\n## ').slice(1);
        expect(pdxText).not.toMatch(/ARTCC|Coordinates/);
        expect(seaText).toContain('**Coordinates:** 47.4502, -122.3088');
        expect(seaText).not.toContain('**ARTCC:**');
      } finally {
        fresh.dispose();
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

  it('carries the NOTAM text, number, and issue time of an airport closure', async () => {
    const result = await run({ airports: ['JFK'] });

    expect(result.isError).toBeFalsy();
    expect(rowsOf(result)[0]?.closure).toEqual({
      endTime: '2026-09-30T04:00:00Z',
      issuedAt: '2026-09-29T19:25:00Z',
      notamNumber: 412,
      notamText: '!JFK 09/412 JFK AD AP CLSD EXC EMERGENCY AND MILITARY 2609292000-2609300400',
      startTime: '2026-09-29T20:00:00Z',
      text: 'CLOSED EXC EMERGENCY AND MILITARY',
      updatedAt: '2026-09-29T19:30:00Z',
    });
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

describe('daily closure window', () => {
  /** PVD's closure as listed at 2026-11-04T08:28Z: closed 0515–1030Z daily, Nov 3 to Nov 4. */
  const PVD_CLOSURE = {
    airportId: 'PVD',
    createdAt: '2026-11-01T20:06:09Z',
    endTime: '2026-11-04T10:30:00Z',
    id: '00000000-0000-4000-8000-000000000005',
    issuedDate: '2026-11-01T20:01:00Z',
    notamNumber: 5,
    simpleText: '!PVD 11/005 PVD AD AP CLSD EXC HEL DLY 0515-1030 2611030515-2611041030',
    startTime: '2026-11-03T05:15:00Z',
    text: 'except HEL DLY 0515-1030',
    updatedAt: '2026-11-01T20:06:09Z',
  };
  const NEXT_WINDOW_NOTICE =
    'PVD airport closure applies daily 0515–1030 UTC and is not in effect at fetchedAt; its next window starts 2026-11-04T05:15:00Z.';

  function setupPvd(at: string, events: Record<string, unknown> = {}): void {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'PVD', airportClosure: PVD_CLOSURE, ...events }] }, at);
  }

  it('reads a daily closure between its windows as listed but not in effect', async () => {
    setupPvd('2026-11-03T12:23:00Z');

    const result = await run({ airports: ['PVD'] });
    const [row] = rowsOf(result);

    expect(row).toMatchObject({
      closure: { dailyWindowUtc: { end: '1030', start: '0515' }, inEffect: false },
      listedInFeed: true,
      status: 'restrictions_only',
    });
    expect(noticeOf(result)).toContain(NEXT_WINDOW_NOTICE);
    expect(contentText(result)).toContain('**Status:** restrictions_only');
    expect(contentText(result)).toContain(
      '**Airport closure (NOTAM 5):** 2026-11-03T05:15:00Z → 2026-11-04T10:30:00Z · daily 0515–1030 UTC, not in effect',
    );
    expect(contentText(result)).not.toContain('Airport closed');
    expect(contentText(result)).toContain(NEXT_WINDOW_NOTICE);
  });

  it('reads a daily closure inside its window as closed', async () => {
    setupPvd('2026-11-04T08:28:00Z');

    const result = await run({ airports: ['PVD'] });

    expect(rowsOf(result)[0]).toMatchObject({
      closure: { dailyWindowUtc: { end: '1030', start: '0515' }, inEffect: true },
      status: 'closed',
    });
    expect(noticeOf(result) ?? '').not.toContain('daily');
    expect(contentText(result)).toContain(
      '**Airport closed (NOTAM 5):** 2026-11-03T05:15:00Z → 2026-11-04T10:30:00Z · daily 0515–1030 UTC, in effect',
    );
  });

  it('says the last window has ended once the closure passes its endTime', async () => {
    setupPvd('2026-11-04T15:00:00Z');

    const result = await run({ airports: ['PVD'] });

    expect(rowsOf(result)[0]).toMatchObject({
      closure: { inEffect: false },
      status: 'restrictions_only',
    });
    expect(noticeOf(result)).toContain(
      'PVD airport closure applies daily 0515–1030 UTC; its last window ended 2026-11-04T10:30:00Z.',
    );
    expect(contentText(result)).toContain('**Airport closure (NOTAM 5):**');
    expect(contentText(result)).not.toContain('Airport closed');
  });

  it.each([
    ['inside its window', '2026-11-04T08:28:00Z', 'closed'],
    ['between its windows', '2026-11-03T12:23:00Z', 'ground_stop'],
  ])('ranks a daily closure %s against a ground stop', async (_label, at, status) => {
    setupPvd(at, { groundStop: { impactingCondition: 'thunderstorms' } });

    expect(rowsOf(await run({ airports: ['PVD'] }))[0]?.status).toBe(status);
  });

  it('evaluates a daily closure NOTAM without letting it set the status', async () => {
    services.dispose();
    setup(
      { 'airport-events': [{ airportId: 'PVD', freeForm: PVD_CLOSURE }] },
      '2026-11-03T12:23:00Z',
    );

    const result = await run({ airports: ['PVD'] });

    expect(rowsOf(result)[0]).toMatchObject({
      closureNotam: { dailyWindowUtc: { end: '1030', start: '0515' }, inEffect: false },
      status: 'restrictions_only',
    });
    expect(noticeOf(result)).toContain('PVD closure NOTAM applies daily 0515–1030 UTC');
    expect(contentText(result)).toContain(
      '**Closure NOTAM 5:** 2026-11-03T05:15:00Z → 2026-11-04T10:30:00Z · daily 0515–1030 UTC, not in effect',
    );
  });

  it('evaluates the window at fetchedAt, so a cached snapshot keeps status and inEffect agreed', async () => {
    setupPvd('2026-11-04T10:29:30Z');
    const before = await run({ airports: ['PVD'] });

    clock.advance(45_000);
    const cached = await run({ airports: ['PVD'] });

    expect(cached.structuredContent).toMatchObject({ fetchedAt: '2026-11-04T10:29:30.000Z' });
    expect(rowsOf(cached)[0]).toMatchObject({ closure: { inEffect: true }, status: 'closed' });
    expect(rowsOf(cached)).toEqual(rowsOf(before));

    clock.advance(30_000);
    const refreshed = await run({ airports: ['PVD'] });

    expect(refreshed.structuredContent).toMatchObject({ fetchedAt: '2026-11-04T10:30:45.000Z' });
    expect(rowsOf(refreshed)[0]).toMatchObject({
      closure: { inEffect: false },
      status: 'restrictions_only',
    });
  });

  it('leaves a closure whose schedule disagrees with its bounds unscheduled and closed', async () => {
    setupPvd('2026-11-03T12:23:00Z', {
      airportClosure: { ...PVD_CLOSURE, startTime: '2026-11-03T05:00:00Z' },
    });

    const [row] = rowsOf(await run({ airports: ['PVD'] }));

    expect(row?.status).toBe('closed');
    expect(row?.closure).not.toHaveProperty('dailyWindowUtc');
    expect(row?.closure).not.toHaveProperty('inEffect');
  });
});

describe('Ground Delay Program times', () => {
  const DAS_DELAY = [
    { delay: 41, seq: 1 },
    { delay: 47, seq: 2 },
  ];

  /** An AUS-shaped GDP: revision window from 20:45Z, the program running since 17:55Z. */
  function setupAus(delayTime: Record<string, unknown>): void {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'AUS',
          groundDelay: {
            avgDelay: 44,
            endTime: '2026-10-01T23:59:00Z',
            fuelFlowAdvisoryDelayTime: { endTime: '2026-10-01T23:59:00Z', ...delayTime },
            startTime: '2026-10-01T20:45:00Z',
          },
        },
      ],
    });
  }

  it("keeps each GDP's feed startTime and endTime verbatim", async () => {
    const [sea, atl] = rowsOf(await run({ airports: ['SEA', 'ATL'] }));
    expect(sea?.groundDelayProgram).toMatchObject({
      endTime: '2026-09-30T05:59:00Z',
      startTime: '2026-09-30T01:00:00Z',
    });
    expect(atl?.groundDelayProgram).toMatchObject({
      endTime: '2026-09-30T03:00:00Z',
      startTime: '2026-09-29T23:00:00Z',
    });
  });

  it('returns the revision window, programStartTime, and a profile anchored on delayTimeAmount', async () => {
    setupAus({
      dasDelays: { dasDelay: DAS_DELAY, delayTimeAmount: '2026-10-01T17:45:00.000+00:00' },
      startTime: '2026-10-01T17:55:00Z',
    });

    const result = await run({ airports: ['AUS'] });

    expect(rowsOf(result)[0]?.groundDelayProgram).toEqual({
      averageDelayMinutes: 44,
      delayProfile: {
        averageDelayMinutes: [41, 47],
        intervalMinutes: 15,
        startTime: '2026-10-01T17:45:00Z',
      },
      endTime: '2026-10-01T23:59:00Z',
      programStartTime: '2026-10-01T17:55:00Z',
      startTime: '2026-10-01T20:45:00Z',
    });
    const text = contentText(result);
    expect(text).toContain(
      '**Ground Delay Program:** 2026-10-01T20:45:00Z → 2026-10-01T23:59:00Z\n- Program start: 2026-10-01T17:55:00Z (the window above is the current revision)',
    );
    expect(text).toContain(
      '- Delay profile: 41, 47 min (15-min intervals from 2026-10-01T17:45:00Z)',
    );
  });

  it('floors the cumulative start to the quarter hour when delayTimeAmount is absent', async () => {
    setupAus({ dasDelays: { dasDelay: DAS_DELAY }, startTime: '2026-10-01T17:55:00Z' });

    const result = await run({ airports: ['AUS'] });

    expect(rowsOf(result)[0]?.groundDelayProgram).toMatchObject({
      delayProfile: { startTime: '2026-10-01T17:45:00Z' },
      programStartTime: '2026-10-01T17:55:00Z',
      startTime: '2026-10-01T20:45:00Z',
    });
    expect(contentText(result)).toContain('(15-min intervals from 2026-10-01T17:45:00Z)');
  });

  it('omits programStartTime, in both surfaces, when the cumulative start is missing', async () => {
    setupAus({
      dasDelays: { dasDelay: DAS_DELAY, delayTimeAmount: '2026-10-01T17:45:00.000+00:00' },
    });

    const result = await run({ airports: ['AUS'] });
    const gdp = rowsOf(result)[0]?.groundDelayProgram;

    expect(gdp).toMatchObject({ delayProfile: { startTime: '2026-10-01T17:45:00Z' } });
    expect(gdp).not.toHaveProperty('programStartTime');
    expect(contentText(result)).not.toContain('Program start');
  });

  it('returns matching revision and cumulative starts unchanged', async () => {
    const result = await run({ airports: ['SEA'] });

    expect(rowsOf(result)[0]?.groundDelayProgram).toMatchObject({
      delayProfile: { startTime: '2026-09-30T01:00:00Z' },
      programStartTime: '2026-09-30T01:00:00Z',
      startTime: '2026-09-30T01:00:00Z',
    });
    expect(contentText(result)).toContain('- Program start: 2026-09-30T01:00:00Z\n');
    expect(contentText(result)).not.toContain('current revision');
  });

  it('prints no revision note for a GDP whose feed gives no window start', async () => {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'AUS',
          groundDelay: {
            endTime: '2026-10-01T23:59:00Z',
            fuelFlowAdvisoryDelayTime: { startTime: '2026-10-01T17:55:00Z' },
          },
        },
      ],
    });

    const result = await run({ airports: ['AUS'] });
    const gdp = rowsOf(result)[0]?.groundDelayProgram;

    expect(gdp).toMatchObject({ programStartTime: '2026-10-01T17:55:00Z' });
    expect(gdp).not.toHaveProperty('startTime');
    expect(contentText(result)).toMatch(/^- Program start: 2026-10-01T17:55:00Z$/m);
    expect(contentText(result)).not.toContain('current revision');
  });

  it('reads all three times from the fixture row where they differ', async () => {
    const result = await run({ airports: ['ATL'] });

    expect(rowsOf(result)[0]?.groundDelayProgram).toMatchObject({
      delayProfile: { averageDelayMinutes: [18, 22, 25, 20], startTime: '2026-09-29T20:45:00Z' },
      programStartTime: '2026-09-29T20:55:00Z',
      startTime: '2026-09-29T23:00:00Z',
    });
    const text = contentText(result);
    expect(text).toContain('**Ground Delay Program:** 2026-09-29T23:00:00Z → 2026-09-30T03:00:00Z');
    expect(text).toContain('- Program start: 2026-09-29T20:55:00Z');
    expect(text).toContain('(15-min intervals from 2026-09-29T20:45:00Z)');
  });
});

describe('delay band fallback', () => {
  it('derives a decreasing band below the average when the feed gives no arrivalDeparture', async () => {
    const result = await run({ airports: ['BOS'] });

    expect(rowsOf(result)[0]?.arrivalDelay).toEqual({
      maxMinutes: 29,
      minMinutes: 15,
      reason: 'WEATHER:Low Ceilings',
      trend: 'decreasing',
      updatedAt: '2026-09-29T23:45:00Z',
    });
    expect(contentText(result)).toContain('**Arrival delay:** 15–29 min, decreasing');
  });

  it('keeps the trend without a band for an average below 15', async () => {
    services.dispose();
    setup({
      'airport-events': [
        { airportId: 'BOS', arrivalDelay: { averageDelay: '10', trend: 'decreasing' } },
      ],
    });

    const result = await run({ airports: ['BOS'] });

    expect(rowsOf(result)[0]?.arrivalDelay).toEqual({ trend: 'decreasing' });
    expect(contentText(result)).toContain('**Arrival delay:** band not reported, decreasing');
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
    expect(noticeOf(result)).toBe(
      'None of the processed airports has an active FAA traffic management event.',
    );
    expect(contentText(result)).not.toContain('faa_delays_get_operations_plan');
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

  it('omits feed numbers too large to represent instead of failing the call', async () => {
    services.dispose();
    setup({
      'airport-events': `[{"airportId": "SEA",
        "groundDelay": {"avgDelay": 55,
          "advisoryUrl": "https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=${'9'.repeat(25)}&adv_date=09302026",
          "fuelFlowAdvisoryDelayTime": {"startTime": "2026-09-30T01:00:00Z",
            "dasDelays": {"dasDelay": [{"delay": 1e999, "seq": 1}]}}},
        "departureDelay": {"arrivalDeparture": {"min": "${'9'.repeat(400)} minutes"}}}]`,
    });

    const result = await run({ airports: ['SEA'] });

    expect(result.isError).toBeFalsy();
    const [row] = rowsOf(result);
    expect(row?.groundDelayProgram).toEqual({
      averageDelayMinutes: 55,
      programStartTime: '2026-09-30T01:00:00Z',
    });
    expect(row?.departureDelay).toEqual({});
    expect(contentText(result)).not.toMatch(/Infinity|NaN/);
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

describe('planned programs', () => {
  const FIXTURE_ADVISORY = {
    date: '2026-09-29',
    number: 82,
    url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=82&adv_date=09292026',
  };
  const PLAN_ADVISORY = {
    date: '2026-11-04',
    number: 3,
    url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=11042026',
  };
  const PLAN_OMITTED =
    'plannedPrograms is omitted because the FAA operations plan could not be read; faa_delays_get_operations_plan returns the reason and when to retry.';
  const plan = (terminalPlanned: unknown, extra: Record<string, unknown> = {}) => ({
    enRoutePlanned: [],
    link: 'https://x.test/?advn=3&adv_date=11042026',
    terminalPlanned,
    ...extra,
  });
  const textsOf = (row: Row | undefined): string[] | undefined =>
    (row?.plannedPrograms as { text: string }[] | undefined)?.map((item) => item.text);

  it('gives each row the plan items naming it, with the plan advisory, and [] when none do', async () => {
    const [bos, mia, fll, sea] = rowsOf(await run({ airports: ['BOS', 'MIA', 'FLL', 'SEA'] }));
    const miaFll = {
      advisory: FIXTURE_ADVISORY,
      likelihood: 'probable',
      text: 'AFTER 1800 MIA/FLL GROUND STOP PROBABLE',
      timeQualifier: 'after',
      timeUtc: '1800',
    };

    expect(bos?.plannedPrograms).toEqual([
      {
        advisory: FIXTURE_ADVISORY,
        likelihood: 'expected',
        text: 'AFTER 1600 BOS GROUND STOP/DELAY PROGRAM EXPECTED',
        timeQualifier: 'after',
        timeUtc: '1600',
      },
    ]);
    expect(mia?.plannedPrograms).toEqual([miaFll]);
    expect(fll?.plannedPrograms).toEqual([miaFll]);
    expect(sea?.plannedPrograms).toEqual([]);
  });

  it('leaves status as the active events set it', async () => {
    const rows = rowsOf(await run({ airports: ['BOS', 'MIA', 'SEA'] }));

    expect(rows.map((row) => [row.airportId, row.status])).toEqual([
      ['BOS', 'delays'],
      ['MIA', 'no_active_events'],
      ['SEA', 'ground_delay_program'],
    ]);
  });

  it('collapses identical plan items to one entry per row', async () => {
    services.dispose();
    setup({
      'operations-plan': plan([
        { event: 'AFTER 1600\t-SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE', time: '' },
        { event: 'AFTER 1500\t-SEA GROUND STOP PROBABLE', time: '' },
        { event: 'AFTER 1600\t-SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE', time: '' },
      ]),
    });

    const [sea, bfi] = rowsOf(await run({ airports: ['SEA', 'BFI'] }));

    expect(textsOf(sea)).toEqual([
      'AFTER 1600 SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE',
      'AFTER 1500 SEA GROUND STOP PROBABLE',
    ]);
    expect(textsOf(bfi)).toEqual(['AFTER 1600 SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE']);
  });

  it('passes items through with the plan times as written, a lapsed UNTIL item included', async () => {
    services.dispose();
    // The clock reads 2026-09-30T02:00Z, an hour past the item's 0100.
    setup({ 'operations-plan': plan([{ event: 'UNTIL 0100\t-MEM GROUND STOP PROBABLE' }]) });

    expect(rowsOf(await run({ airports: ['MEM'] }))[0]?.plannedPrograms).toEqual([
      {
        advisory: PLAN_ADVISORY,
        likelihood: 'probable',
        text: 'UNTIL 0100 MEM GROUND STOP PROBABLE',
        timeQualifier: 'until',
        timeUtc: '0100',
      },
    ]);
  });

  it('leaves out what the plan does not state, the advisory included', async () => {
    services.dispose();
    setup({
      'operations-plan': { enRoutePlanned: [], terminalPlanned: [{ event: 'BOS GROUND STOP' }] },
    });

    expect(rowsOf(await run({ airports: ['BOS'] }))[0]?.plannedPrograms).toEqual([
      { text: 'BOS GROUND STOP' },
    ]);
  });

  it('carries no en-route item, even one naming the airport', async () => {
    services.dispose();
    setup({
      'operations-plan': plan([], {
        enRoutePlanned: [{ event: 'AFTER 1700\t-ORD/MDW ARRIVAL ROUTES POSSIBLE' }],
      }),
    });

    expect(rowsOf(await run({ airports: ['ORD'] }))[0]?.plannedPrograms).toEqual([]);
  });

  it('omits plannedPrograms and names the section when the terminal list is unreadable', async () => {
    services.dispose();
    setup({ 'operations-plan': plan('AFTER 1500\t-BOS GDP EXPECTED') });

    const result = await run({ airports: ['BOS'] });

    expect(rowsOf(result)[0]).not.toHaveProperty('plannedPrograms');
    for (const text of [noticeOf(result), contentText(result)]) {
      expect(text).toContain('operations-plan.terminalPlanned');
      expect(text).toContain('unknown, not confirmed empty');
    }
  });

  it('keeps plannedPrograms and stays quiet when only the en-route list is unreadable', async () => {
    services.dispose();
    setup({ 'operations-plan': plan([], { enRoutePlanned: 'unreadable' }) });

    const result = await run({ airports: ['SEA'] });

    expect(rowsOf(result)[0]?.plannedPrograms).toEqual([]);
    expect(noticeOf(result)).toBeUndefined();
  });

  it('counts skipped plan rows in the notice', async () => {
    services.dispose();
    setup({
      'operations-plan': plan([{ event: 'AFTER 1500\t-SEA GROUND STOP' }, { time: '1200' }]),
    });

    const result = await run({ airports: ['SEA'] });

    expect(textsOf(rowsOf(result)[0])).toEqual(['AFTER 1500 SEA GROUND STOP']);
    expect(noticeOf(result)).toBe('1 FAA feed row could not be read and was skipped.');
  });

  it('reads the plan through the cache entry faa_delays_get_operations_plan uses', async () => {
    await run({ airports: ['SEA'] });
    expect(callsTo(harness, feedUrl('operations-plan'))).toBe(1);

    await runToolContract(getOperationsPlan, {});
    expect(callsTo(harness, feedUrl('operations-plan'))).toBe(1);
  });

  it('stops pointing the all-quiet notice at faa_delays_get_operations_plan once the plan is read', async () => {
    services.dispose();
    setup({ 'airport-events': [] });

    const result = await run({ airports: ['MIA', 'ORD'] });

    expect(noticeOf(result)).toBe(
      'None of the processed airports has an active FAA traffic management event.',
    );
    expect(rowsOf(result)[0]?.plannedPrograms).toHaveLength(1);
  });

  it('describes [] as the plan naming the airport nowhere, and absent as unread', () => {
    const description = getAirportStatus.output.shape.airports.element.shape.plannedPrograms
      .description as string;

    expect(description).toContain('does not mean no trouble is expected');
    expect(description).toContain('Absent when the operations plan could not be read');
  });

  describe('when the plan leg fails', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it.each(FEED_FAILURES)('omits plannedPrograms with a notice on $label', async ({ respond }) => {
      services.dispose();
      setup({ 'operations-plan': respond });

      const result = await withLadder(() => run({ airports: ['SEA', 'MIA'] }));

      expect(result.isError).toBeFalsy();
      expect(rowsOf(result).map((row) => row.status)).toEqual([
        'ground_delay_program',
        'no_active_events',
      ]);
      for (const row of rowsOf(result)) expect(row).not.toHaveProperty('plannedPrograms');
      expect(noticeOf(result)).toBe(PLAN_OMITTED);
      expect(contentText(result)).not.toContain('**Planned programs');
    });

    it('points at faa_delays_get_operations_plan once when every airport is quiet', async () => {
      services.dispose();
      setup({
        'airport-events': [],
        'operations-plan': () => new Response('down', { status: 503 }),
      });

      const result = await withLadder(() => run({ airports: ['SEA'] }));

      expect(noticeOf(result)).toBe(
        `None of the processed airports has an active FAA traffic management event. ${PLAN_OMITTED}`,
      );
      expect(contentText(result).split('faa_delays_get_operations_plan')).toHaveLength(2);
    });

    it('rethrows the failed plan leg when the caller was cancelled', async () => {
      const live = createMockContext();
      await getNasStatusService().getAirportEvents(live);
      await getNasStatusService().getPacingAirports(live);
      const controller = new AbortController();
      const reason = new Error('client cancelled');
      controller.abort(reason);
      const ctx = createMockContext({ errors: getAirportStatus.errors, signal: controller.signal });

      await expect(
        getAirportStatus.handler(getAirportStatus.input.parse({ airports: ['SEA'] }), ctx),
      ).rejects.toBe(reason);
    });
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
  it('renders closure and NOTAM links literally while preserving structured strings', async () => {
    const text = 'USE <FIX> [route](u) *literal*\nFCA005:NO_AR_ATLANTIC\t\u202e';
    services.dispose();
    setup({
      'airport-events': [
        { airportId: 'SEA', airportClosure: { text }, freeForm: { simpleText: text } },
      ],
    });
    const result = await run({ airports: ['SEA'] });
    expect(rowsOf(result)[0]).toMatchObject({
      closure: { text },
      closureNotam: { notamText: text },
    });
    expect(contentText(result)).toContain('> USE \\<FIX\\> \\[route\\](u) *literal*');
    expect(contentText(result)).toContain('> FCA005:NO_AR_ATLANTIC ');
    expect(contentText(result)).not.toContain('\u202e');
  });
  it('carries the same data as structuredContent', async () => {
    const result = await run({ airports: ['SEA', 'KJFK', 'DEN', 'ORD', 'LAX'] });
    const text = contentText(result);

    expect(text).toContain('**Fetched:** 2026-09-30T02:00:00.000Z');
    expect(text).toContain('## SEA — Seattle-Tacoma International (SEATTLE, WA)');
    expect(text).toContain('**Status:** ground_delay_program · **Listed in feed:** yes');
    expect(text).toContain('**ARTCC:** ZSE · **Coordinates:** 47.4502, -122.3088');
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
    expect(text).toContain(
      [
        '**Airport closed (NOTAM 412):** 2026-09-29T20:00:00Z → 2026-09-30T04:00:00Z',
        '- Issued: 2026-09-29T19:25:00Z',
        '- Updated: 2026-09-29T19:30:00Z',
        '- Detail: CLOSED EXC EMERGENCY AND MILITARY',
        '> !JFK 09/412 JFK AD AP CLSD EXC EMERGENCY AND MILITARY 2609292000-2609300400',
      ].join('\n'),
    );
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

  it('renders the exceptions of a closure that carries no NOTAM fields', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA', airportClosure: { text: 'except HEL' } }] });

    const result = await run({ airports: ['SEA'] });

    expect(rowsOf(result)[0]?.closure).toEqual({ text: 'except HEL' });
    expect(contentText(result)).toContain(
      '**Airport closed:** times not reported\n- Detail: except HEL',
    );
    expect(contentText(result)).not.toContain('- Issued:');
  });

  it('keeps upstream CR/LF/TAB out of inline slots and quotes multi-line free text', async () => {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'SEA',
          airportClosure: {
            endTime: '2026-09-30T05:00:00Z\n## Closure end',
            issuedDate: '2026-09-29T19:25:00Z\n## Closure issued',
            simpleText: 'LINE ONE\r\nLINE TWO\n## Injected heading',
            text: 'EXC HEL\r\n## Detail injection',
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
      '## Closure issued',
      '## Detail injection',
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
    expect(lines).toContain('- Detail:');
    expect(lines).toContain('  > EXC HEL');
    expect(lines).toContain('  > ## Detail injection');
    expect(lines).toContain('> !SEA 1');
    expect(lines).toContain('> 3');
    expect(lines).toContain('- Restriction:');
    expect(lines).toContain('  > NARROW RESTRICTION');
    expect(lines).toContain('  > - injected');
    expect(lines).toContain('- Program start: 2026-09-30T01:00:00Z ## Profile start');
  });

  it('keeps the line breaks of a multi-line closure text through a CommonMark parse', async () => {
    services.dispose();
    setup({
      'airport-events': [
        {
          airportId: 'SEA',
          airportClosure: { simpleText: '!SEA 11/001 SEA AD AP CLSD', text: 'EXC HEL\r\nAND SAR' },
          freeForm: { text: 'CLSD TO NON SKED\nTRANSIENT GA' },
        },
      ],
    });

    const result = await run({ airports: ['SEA'] });
    const texts = commonmarkTexts(contentText(result));

    expect(rowsOf(result)[0]).toMatchObject({
      closure: { text: 'EXC HEL\r\nAND SAR' },
      closureNotam: { text: 'CLSD TO NON SKED\nTRANSIENT GA' },
    });
    expect(texts).toContain('EXC HEL\nAND SAR');
    expect(texts).toContain('CLSD TO NON SKED\nTRANSIENT GA');
    expect(texts).toContain('!SEA 11/001 SEA AD AP CLSD');
    expect(texts).toContain('Detail:');
    expect(texts).toContain('Restriction:');
  });

  it('keeps a one-line closure text on its label line', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA', freeForm: { text: 'CLSD TO GA' } }] });

    expect(contentText(await run({ airports: ['SEA'] })).split('\n')).toContain(
      '- Restriction: CLSD TO GA',
    );
  });

  it('renders each planned program with its time, likelihood, and advisory line', async () => {
    services.dispose();
    setup({
      'operations-plan': {
        enRoutePlanned: [],
        link: 'https://x.test/?advn=3&adv_date=11042026',
        terminalPlanned: [
          { event: 'AFTER 1600\t-SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE', time: '' },
          { event: 'SEA GROUND STOP', time: '' },
        ],
      },
    });

    const text = contentText(await run({ airports: ['SEA', 'ORD'] }));
    const advisory =
      'ADVZY 3 · 2026-11-04 · https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=11042026';

    expect(text).toContain(
      [
        '**Planned programs (2):**',
        '',
        `1. after 1600 UTC · possible · ${advisory}`,
        '> AFTER 1600 SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE',
        '',
        `2. no time or likelihood stated · ${advisory}`,
        '> SEA GROUND STOP',
      ].join('\n'),
    );
    expect(text).toContain('**Planned programs:** none named in the operations plan');
    const texts = commonmarkTexts(text);
    expect(texts).toContain(`after 1600 UTC · possible · ${advisory}`);
    expect(texts).toContain(`no time or likelihood stated · ${advisory}`);
    expect(texts).toContain('SEA GROUND STOP');
  });

  it('keeps structuredContent verbatim while the text flattens', async () => {
    services.dispose();
    setup({ 'airport-events': [{ airportId: 'SEA', airportClosure: { text: 'A\r\nB' } }] });

    const result = await run({ airports: ['SEA'] });

    expect(rowsOf(result)[0]).toMatchObject({ closure: { text: 'A\r\nB' } });
  });

  it('renders link, image, and HTML syntax in inline slots as text and drops control characters', async () => {
    services.dispose();
    const reason = '[click](https://evil.example) <b>x</b>\u{1B}[31m\u{202E}';
    setup({
      'airport-events': [
        {
          airportId: 'SEA',
          airportLongName: '![x](https://evil.example/p.png)',
          groundDelay: { impactingCondition: reason },
        },
      ],
    });

    const result = await run({ airports: ['SEA'] });
    const text = contentText(result);

    expect(text).toContain('## SEA — !\\[x\\](https://evil.example/p.png)');
    expect(text).toContain('- Reason: \\[click\\](https://evil.example) \\<b\\>x\\</b\\>\\[31m');
    expect(text).not.toMatch(/[\u{1B}\u{202E}]/u);
    expect(rowsOf(result)[0]).toMatchObject({
      airportName: '![x](https://evil.example/p.png)',
      groundDelayProgram: { reason },
    });
  });
});
