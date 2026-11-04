/**
 * @fileoverview Tests for the tolerant NAS Status feed parsers: field mapping against the
 * API Reference shapes, and the drift rules (wrong-typed field omitted and reported, keyless row
 * skipped, wrong top-level shape raises feed_contract_changed, empty array is quiet).
 * @module tests/services/nas-status/feed-parsers.test
 */

import { threadCpuUsage } from 'node:process';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  type ParseReporter,
  parseAirportEvents,
  parseAnnouncements,
  parseDurationMinutes,
  parseEnrouteEvents,
  parseOperationsPlan,
  parsePacingAirports,
  parsePlannedEvent,
  parseTerminalPlannedEvent,
} from '@/services/nas-status/feed-parsers.js';
import type { AirportEvents } from '@/services/nas-status/types.js';
import { feedFixture } from '../../helpers/faa-fakes.js';

/** Records reporter calls. */
function recorder() {
  const drift: [string, string][] = [];
  const unknownKeys: [string, string][] = [];
  const report: ParseReporter = {
    drift: (path, observedType) => drift.push([path, observedType]),
    unknownKey: (feed, key) => unknownKeys.push([feed, key]),
  };
  return { drift, report, unknownKeys };
}

function airportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { airportId: 'SEA', ...overrides };
}

function parseOneAirport(overrides: Record<string, unknown>): {
  drift: [string, string][];
  row: AirportEvents;
} {
  const { drift, report } = recorder();
  const { rows } = parseAirportEvents([airportRow(overrides)], report);
  return { drift, row: rows[0] as AirportEvents };
}

/** How the shape-change message names each feed, matching the retry and malformed-JSON messages. */
const FEED_LABELS: Record<string, string> = {
  'airport-events': 'airport events',
  'enroute-events': 'en-route events',
  'miscellaneous-info': 'announcements',
  'operations-plan': 'operations plan',
  'pacing-airports': 'pacing airports',
};

function expectContractChanged(run: () => unknown, feed: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.SerializationError);
    expect((error as McpError).message).toMatch(
      new RegExp(
        `^The FAA NAS Status ${FEED_LABELS[feed]} feed returned a shape this server does not recognize \\(.+\\)\\.$`,
      ),
    );
    expect((error as McpError).data).toMatchObject({
      feed,
      reason: 'feed_contract_changed',
      retryable: false,
    });
    return;
  }
  throw new Error('Expected feed_contract_changed, but the parser returned.');
}

describe('parseAirportEvents', () => {
  it('discloses unreadable event objects while retaining usable siblings', () => {
    expect(
      parseAirportEvents(
        [{ airportId: 'ORD', groundStop: 'active', groundDelay: { avgDelay: 3 } }],
        recorder().report,
      ),
    ).toMatchObject({
      rows: [{ airportId: 'ORD', groundDelayProgram: { averageDelayMinutes: 3 } }],
      unreadableSections: ['airport-events[].groundStop'],
    });
  });
  it.each([[1, 3], [1, 1], [0], [-1], [1.5], [Infinity], [NaN]])(
    'omits and discloses invalid profile sequences %j',
    (...seqs) => {
      const parsed = parseAirportEvents(
        [
          {
            airportId: 'SEA',
            groundDelay: {
              avgDelay: 7,
              fuelFlowAdvisoryDelayTime: {
                startTime: '2026-10-13T18:00:00Z',
                dasDelays: { dasDelay: seqs.map((seq) => ({ seq, delay: 10 })) },
              },
            },
          },
        ],
        recorder().report,
      );
      expect(parsed.rows[0]?.groundDelayProgram).toEqual({
        averageDelayMinutes: 7,
        programStartTime: '2026-10-13T18:00:00Z',
      });
      expect(parsed).toHaveProperty('unreadableSections', [
        'airport-events[].groundDelay.fuelFlowAdvisoryDelayTime.dasDelays.dasDelay',
      ]);
    },
  );
  it('keeps absent/null event sections and scalar drift free of section diagnostics', () => {
    const parsed = parseAirportEvents(
      [{ airportId: 'SEA', groundStop: null, latitude: {} }],
      recorder().report,
    );
    expect(parsed).toEqual({ rows: [{ airportId: 'SEA' }], skippedRows: 0 });
  });
  it('reads the fixture rows into normalized events', () => {
    const { drift, report, unknownKeys } = recorder();
    const { rows, skippedRows } = parseAirportEvents(feedFixture('airport-events'), report);

    expect(skippedRows).toBe(0);
    expect(drift).toEqual([]);
    expect(unknownKeys).toEqual([]);
    expect(rows.map((row) => row.airportId)).toEqual([
      'LAX',
      'ORD',
      'SEA',
      'DEN',
      'JFK',
      'BOS',
      'MSP',
      'ATL',
    ]);
  });

  it('maps a Ground Delay Program with delay profile, advisory, and derived fields', () => {
    const { rows } = parseAirportEvents(feedFixture('airport-events'), recorder().report);
    const sea = rows.find((row) => row.airportId === 'SEA');

    expect(sea).toMatchObject({
      airportName: 'Seattle-Tacoma International',
      latitude: 47.4502,
      longitude: -122.3088,
      runwayConfiguration: {
        arrivalRatePerHour: 38,
        arrivalRunways: '34L',
        departureRunways: '34C/34R',
        reportedAt: '2026-09-30T00:53:49Z',
      },
    });
    expect(sea?.groundDelayProgram).toEqual({
      advisory: {
        date: '2026-09-30',
        number: 3,
        url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=09302026',
      },
      averageDelayMinutes: 55,
      controllingCenter: 'ZSE',
      delayProfile: {
        averageDelayMinutes: [64, 62, 62, 65],
        intervalMinutes: 15,
        startTime: '2026-09-30T01:00:00Z',
      },
      departureScopeNm: 1200,
      endTime: '2026-09-30T05:59:00Z',
      includedFacilities: ['CYEG', 'CYVR', 'CYYC'],
      includedFlights: 'ALL CONTIGUOUS US DEP',
      maximumDelayMinutes: 117,
      programStartTime: '2026-09-30T01:00:00Z',
      reason: 'low ceilings',
      startTime: '2026-09-30T01:00:00Z',
      updatedAt: '2026-09-30T00:17:04Z',
    });
  });

  it('keeps the revision startTime and adds the cumulative start when the two differ', () => {
    const { rows } = parseAirportEvents(feedFixture('airport-events'), recorder().report);
    const atl = rows.find((row) => row.airportId === 'ATL');

    expect(atl?.groundDelayProgram).toMatchObject({
      delayProfile: {
        averageDelayMinutes: [18, 22, 25, 20],
        intervalMinutes: 15,
        startTime: '2026-09-29T20:45:00Z',
      },
      endTime: '2026-09-30T03:00:00Z',
      programStartTime: '2026-09-29T20:55:00Z',
      startTime: '2026-09-29T23:00:00Z',
    });
  });

  it('maps a ground stop and lowercases the extension probability', () => {
    const { rows } = parseAirportEvents(feedFixture('airport-events'), recorder().report);
    expect(rows.find((row) => row.airportId === 'DEN')?.groundStop).toEqual({
      advisory: {
        date: '2026-09-29',
        number: 12,
        url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=12&adv_date=09292026',
      },
      endTime: '2026-09-29T23:30:00Z',
      includedFacilities: ['ZAU', 'ZDC'],
      probabilityOfExtension: 'high',
      reason: 'thunderstorms',
      startTime: '2026-09-29T22:00:00Z',
      updatedAt: '2026-09-29T22:05:00Z',
    });
  });

  it('maps closure, NOTAM closure, deicing, and both delay-band derivations', () => {
    const { rows } = parseAirportEvents(feedFixture('airport-events'), recorder().report);
    const byId = new Map(rows.map((row) => [row.airportId, row]));

    expect(byId.get('JFK')?.closure).toMatchObject({
      text: 'CLOSED EXC EMERGENCY AND MILITARY',
    });
    expect(byId.get('LAX')?.closureNotam).toMatchObject({
      issuedAt: '2026-05-27T18:26:00Z',
      notamNumber: 277,
      notamText: expect.stringContaining('!LAX 05/277'),
      text: expect.stringContaining('TO NON SKED TRANSIENT GA ACFT'),
    });
    expect(byId.get('MSP')?.deicing).toEqual({ startedAt: '2026-09-29T21:00:00Z' });
    expect(byId.get('ORD')?.departureDelay).toEqual({
      maxMinutes: 30,
      minMinutes: 16,
      reason: 'RWY:Obstruction',
      trend: 'increasing',
      updatedAt: '2026-09-29T23:15:00Z',
    });
    expect(byId.get('BOS')?.arrivalDelay).toMatchObject({
      maxMinutes: 29,
      minMinutes: 15,
      trend: 'decreasing',
    });
  });

  describe('closures', () => {
    it('reads the NOTAM text, number, and issue time of an airport closure', () => {
      const { rows } = parseAirportEvents(feedFixture('airport-events'), recorder().report);

      expect(rows.find((row) => row.airportId === 'JFK')?.closure).toEqual({
        endTime: '2026-09-30T04:00:00Z',
        issuedAt: '2026-09-29T19:25:00Z',
        notamNumber: 412,
        notamText: '!JFK 09/412 JFK AD AP CLSD EXC EMERGENCY AND MILITARY 2609292000-2609300400',
        startTime: '2026-09-29T20:00:00Z',
        text: 'CLOSED EXC EMERGENCY AND MILITARY',
        updatedAt: '2026-09-29T19:30:00Z',
      });
    });

    it('reads a closure that carries only its text', () => {
      const { drift, row } = parseOneAirport({ airportClosure: { text: 'except HEL' } });

      expect(row.closure).toEqual({ text: 'except HEL' });
      expect(drift).toEqual([]);
    });

    it('omits wrong-typed closure NOTAM fields and reports them', () => {
      const { drift, row } = parseOneAirport({
        airportClosure: {
          issuedDate: 20_261_101,
          notamNumber: '5',
          simpleText: ['!PVD'],
          text: 'x',
        },
      });

      expect(row.closure).toEqual({ text: 'x' });
      expect(drift).toEqual([
        ['airport-events[].airportClosure.simpleText', 'array'],
        ['airport-events[].airportClosure.notamNumber', 'string'],
        ['airport-events[].airportClosure.issuedDate', 'number'],
      ]);
    });

    /** PVD as listed at 2026-11-04T08:28Z: closed 0515–1030Z daily from Nov 3 to Nov 4. */
    const PVD = {
      endTime: '2026-11-04T10:30:00Z',
      startTime: '2026-11-03T05:15:00Z',
      text: 'except HEL DLY 0515-1030',
    };

    it.each([
      ['a daily window after exceptions (PVD)', PVD, { end: '1030', start: '0515' }],
      [
        'a window alone (SNA)',
        {
          endTime: '2026-11-08T14:15:00Z',
          startTime: '2026-11-03T07:30:00Z',
          text: 'DLY 0730-1415',
        },
        { end: '1415', start: '0730' },
      ],
      [
        'a window crossing 0000Z',
        {
          endTime: '2026-11-06T06:00:00Z',
          startTime: '2026-11-03T23:00:00Z',
          text: 'DLY 2300-0600',
        },
        { end: '0600', start: '2300' },
      ],
      [
        'bounds written with an offset',
        { ...PVD, endTime: '2026-11-04T05:30:00-05:00', startTime: '2026-11-03T00:15:00-05:00' },
        { end: '1030', start: '0515' },
      ],
      ['trailing whitespace', { ...PVD, text: 'DLY 0515-1030 \t' }, { end: '1030', start: '0515' }],
    ])('reads %s into dailyWindowUtc', (_label, closure, window) => {
      const { drift, row } = parseOneAirport({ airportClosure: closure, freeForm: closure });

      expect(row.closure).toEqual({ ...closure, dailyWindowUtc: window });
      expect(row.closureNotam).toEqual({ ...closure, dailyWindowUtc: window });
      expect(drift).toEqual([]);
    });

    it.each([
      ['no schedule', { ...PVD, text: 'except HEL' }],
      ['a schedule before more text', { ...PVD, text: 'DLY 0515-1030 EXC HEL' }],
      ['DLY inside a word', { ...PVD, text: 'XDLY 0515-1030' }],
      ['no space after DLY', { ...PVD, text: 'DLY0515-1030' }],
      ['a three-digit time', { ...PVD, startTime: '2026-11-03T00:00:00Z', text: 'DLY 000-1030' }],
      ['an hour past 23', { ...PVD, text: 'DLY 2415-1030' }],
      ['a minute past 59', { ...PVD, text: 'DLY 0560-1030' }],
      [
        'a start equal to its end',
        {
          endTime: '2026-11-04T05:15:00Z',
          startTime: '2026-11-03T05:15:00Z',
          text: 'DLY 0515-0515',
        },
      ],
      ['a startTime off the window start', { ...PVD, startTime: '2026-11-03T05:00:00Z' }],
      ['an endTime off the window end', { ...PVD, endTime: '2026-11-04T10:00:00Z' }],
      ['no startTime', { endTime: PVD.endTime, text: PVD.text }],
      ['no endTime', { startTime: PVD.startTime, text: PVD.text }],
      ['a startTime without an offset', { ...PVD, startTime: '2026-11-03T05:15:00' }],
      ['an endTime before its startTime', { ...PVD, endTime: '2026-11-02T10:30:00Z' }],
    ])('leaves a closure with %s unscheduled', (_label, closure) => {
      const { row } = parseOneAirport({ airportClosure: closure });

      expect(row.closure).toEqual(closure);
    });

    it.each([
      ['repeated openers', (n: number) => 'DLY '.repeat(n / 4)],
      ['an opener before a long blank run', (n: number) => `DLY${' '.repeat(n)}x`],
      ['repeated openers with times', (n: number) => 'DLY DLY 0515-'.repeat(n / 13)],
      [
        'repeated schedules failing at the end',
        (n: number) => `${'DLY 0515-1030 '.repeat(n / 14)}x`,
      ],
      ['a schedule before a long blank run', (n: number) => `DLY 0515-1030${' '.repeat(n)}x`],
      ['openers split by breaks', (n: number) => 'DLY\r\n'.repeat(n / 5)],
      ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ])('reads the schedule of %s in linear CPU time across a 64-fold span', (_label, build) => {
      const { report } = recorder();
      const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
      const perCallMicros: number[] = [];
      for (const size of sizes) {
        const body = [{ airportClosure: { ...PVD, text: build(size) }, airportId: 'PVD' }];
        const batch = 320_000 / size;
        let fastest = Infinity;
        for (let round = 0; round < 5; round++) {
          const started = threadCpuUsage();
          for (let call = 0; call < batch; call++) parseAirportEvents(body, report);
          const elapsed = threadCpuUsage(started);
          fastest = Math.min(fastest, (elapsed.user + elapsed.system) / batch);
        }
        expect(fastest).toBeLessThan(size * 0.5);
        perCallMicros.push(fastest);
      }
      expect((perCallMicros.at(-1) as number) / (perCallMicros[0] as number)).toBeLessThan(256);
    });
  });

  it('sorts the delay profile by seq regardless of array order', () => {
    const { row } = parseOneAirport({
      groundDelay: {
        fuelFlowAdvisoryDelayTime: {
          dasDelays: {
            dasDelay: [
              { delay: 30, seq: 3 },
              { delay: 10, seq: 1 },
              { delay: 20, seq: 2 },
            ],
          },
          startTime: '2026-09-30T01:00:00Z',
        },
      },
    });
    expect(row.groundDelayProgram?.delayProfile?.averageDelayMinutes).toEqual([10, 20, 30]);
  });

  it('accepts a single dasDelay object where an array is expected', () => {
    const { row } = parseOneAirport({
      groundDelay: {
        fuelFlowAdvisoryDelayTime: {
          dasDelays: { dasDelay: { delay: 12, seq: 1 } },
          startTime: '2026-09-30T01:00:00Z',
        },
      },
    });
    expect(row.groundDelayProgram?.delayProfile?.averageDelayMinutes).toEqual([12]);
  });

  it('drops the whole delay profile when one entry is unreadable, and reports it', () => {
    const { drift, row } = parseOneAirport({
      groundDelay: {
        avgDelay: 10,
        fuelFlowAdvisoryDelayTime: {
          dasDelays: {
            dasDelay: [
              { delay: 10, seq: 1 },
              { delay: 'x', seq: 2 },
            ],
          },
          startTime: '2026-09-30T01:00:00Z',
        },
      },
    });
    expect(row.groundDelayProgram?.delayProfile).toBeUndefined();
    expect(row.groundDelayProgram?.averageDelayMinutes).toBe(10);
    expect(drift).toContainEqual([
      'airport-events[].groundDelay.fuelFlowAdvisoryDelayTime.dasDelays.dasDelay[]',
      'object',
    ]);
  });

  it.each([
    ['delay', { delay: Number.POSITIVE_INFINITY, seq: 2 }],
    ['seq', { delay: 12, seq: Number.NaN }],
  ])(
    'drops the delay profile when an entry %s is not a finite number, and reports it',
    (_label, entry) => {
      const { drift, row } = parseOneAirport({
        groundDelay: {
          fuelFlowAdvisoryDelayTime: {
            dasDelays: { dasDelay: [{ delay: 10, seq: 1 }, entry] },
            startTime: '2026-09-30T01:00:00Z',
          },
        },
      });
      expect(row.groundDelayProgram?.delayProfile).toBeUndefined();
      expect(drift).toContainEqual([
        'airport-events[].groundDelay.fuelFlowAdvisoryDelayTime.dasDelays.dasDelay[]',
        'object',
      ]);
    },
  );

  describe('program start and delay profile anchor', () => {
    const DAS_DELAY = [
      { delay: 41, seq: 1 },
      { delay: 47, seq: 2 },
    ];

    /** An AUS-shaped GDP: revision 20:45Z, cumulative start 17:55Z, intervals from 17:45Z. */
    function gdp(
      delayTime: Record<string, unknown>,
      dasDelays: Record<string, unknown> = { dasDelay: DAS_DELAY },
    ) {
      return parseOneAirport({
        groundDelay: {
          endTime: '2026-10-01T23:59:00Z',
          fuelFlowAdvisoryDelayTime: { dasDelays, endTime: '2026-10-01T23:59:00Z', ...delayTime },
          startTime: '2026-10-01T20:45:00Z',
        },
      });
    }

    it('anchors the profile on delayTimeAmount and carries the cumulative start as programStartTime', () => {
      const { drift, row } = gdp(
        { startTime: '2026-10-01T17:55:00Z' },
        { dasDelay: DAS_DELAY, delayTimeAmount: '2026-10-01T17:45:00.000+00:00' },
      );

      expect(drift).toEqual([]);
      expect(row.groundDelayProgram).toEqual({
        delayProfile: {
          averageDelayMinutes: [41, 47],
          intervalMinutes: 15,
          startTime: '2026-10-01T17:45:00Z',
        },
        endTime: '2026-10-01T23:59:00Z',
        programStartTime: '2026-10-01T17:55:00Z',
        startTime: '2026-10-01T20:45:00Z',
      });
    });

    it('prefers delayTimeAmount over the floor of the cumulative start', () => {
      const { row } = gdp(
        { startTime: '2026-10-01T17:55:00Z' },
        { dasDelay: DAS_DELAY, delayTimeAmount: '2026-10-01T17:30:00.000+00:00' },
      );
      expect(row.groundDelayProgram?.delayProfile?.startTime).toBe('2026-10-01T17:30:00Z');
    });

    it.each([
      [
        'a +00:00 offset with milliseconds',
        '2026-10-01T17:45:00.000+00:00',
        '2026-10-01T17:45:00Z',
      ],
      ['another offset', '2026-10-01T13:45:00-04:00', '2026-10-01T17:45:00Z'],
      ['the feed form already', '2026-10-01T17:45:00Z', '2026-10-01T17:45:00Z'],
    ])('rewrites a delayTimeAmount with %s to YYYY-MM-DDTHH:MM:SSZ', (_label, amount, expected) => {
      const { row } = gdp(
        { startTime: '2026-10-01T17:55:00Z' },
        { dasDelay: DAS_DELAY, delayTimeAmount: amount },
      );
      expect(row.groundDelayProgram?.delayProfile?.startTime).toBe(expected);
    });

    it.each([
      ['2026-10-01T17:55:00Z', '2026-10-01T17:45:00Z'],
      ['2026-10-01T17:50:00Z', '2026-10-01T17:45:00Z'],
      ['2026-10-01T23:59:59Z', '2026-10-01T23:45:00Z'],
      ['2026-10-01T16:00:00Z', '2026-10-01T16:00:00Z'],
    ])(
      'without delayTimeAmount, floors a cumulative start of %s to %s, never the next hour',
      (cumulative, expected) => {
        const { row } = gdp({ startTime: cumulative });
        expect(row.groundDelayProgram).toMatchObject({
          delayProfile: { startTime: expected },
          programStartTime: cumulative,
          startTime: '2026-10-01T20:45:00Z',
        });
      },
    );

    it('reports a non-string delayTimeAmount as drift and falls back to the floor', () => {
      const { drift, row } = gdp(
        { startTime: '2026-10-01T17:55:00Z' },
        { dasDelay: DAS_DELAY, delayTimeAmount: 1_759_340_700_000 },
      );
      expect(row.groundDelayProgram?.delayProfile?.startTime).toBe('2026-10-01T17:45:00Z');
      expect(drift).toEqual([
        [
          'airport-events[].groundDelay.fuelFlowAdvisoryDelayTime.dasDelays.delayTimeAmount',
          'number',
        ],
      ]);
    });

    it.each([
      ['a word', 'soon'],
      ['blank', '  '],
      ['a time without an offset', '2026-10-01T17:30:00'],
      ['a date with no time', '2026-10-01'],
      ['an impossible month', '2026-13-01T17:30:00Z'],
      ['a day past the end of its month', '2026-02-30T17:30:00.000+00:00'],
      ['a leap day in a common year', '2026-02-29T17:30:00Z'],
    ])('ignores a delayTimeAmount that is %s and falls back to the floor', (_label, amount) => {
      const { drift, row } = gdp(
        { startTime: '2026-10-01T17:55:00Z' },
        { dasDelay: DAS_DELAY, delayTimeAmount: amount },
      );
      expect(row.groundDelayProgram?.delayProfile?.startTime).toBe('2026-10-01T17:45:00Z');
      expect(drift).toEqual([]);
    });

    it('anchors on delayTimeAmount when the cumulative start is missing, and omits programStartTime', () => {
      const { row } = gdp(
        {},
        { dasDelay: DAS_DELAY, delayTimeAmount: '2026-10-01T17:45:00.000+00:00' },
      );
      expect(row.groundDelayProgram?.delayProfile).toEqual({
        averageDelayMinutes: [41, 47],
        intervalMinutes: 15,
        startTime: '2026-10-01T17:45:00Z',
      });
      expect(row.groundDelayProgram).not.toHaveProperty('programStartTime');
      expect(row.groundDelayProgram?.startTime).toBe('2026-10-01T20:45:00Z');
    });

    it('drops the profile when neither delayTimeAmount nor the cumulative start is present', () => {
      const { row } = gdp({});
      expect(row.groundDelayProgram).toEqual({
        endTime: '2026-10-01T23:59:00Z',
        startTime: '2026-10-01T20:45:00Z',
      });
    });

    it('drops the profile but keeps programStartTime verbatim when the cumulative start is not a time', () => {
      const { drift, row } = gdp({ startTime: 'soon' });
      expect(row.groundDelayProgram).toEqual({
        endTime: '2026-10-01T23:59:00Z',
        programStartTime: 'soon',
        startTime: '2026-10-01T20:45:00Z',
      });
      expect(drift).toEqual([]);
    });
  });

  it('trims padding around runway configurations', () => {
    const { row } = parseOneAirport({
      airportConfig: { arrivalRunwayConfig: ' 25L/24R ', departureRunwayConfig: ' 24L/25R' },
    });
    expect(row.runwayConfiguration).toEqual({
      arrivalRunways: '25L/24R',
      departureRunways: '24L/25R',
    });
  });

  describe('drift rules', () => {
    it('omits a wrong-typed field and reports its path and observed type', () => {
      const { drift, row } = parseOneAirport({
        groundDelay: { avgDelay: '55', impactingCondition: 'volume', maxDelay: 96 },
      });

      expect(row.groundDelayProgram).toEqual({ maximumDelayMinutes: 96, reason: 'volume' });
      expect(drift).toEqual([['airport-events[].groundDelay.avgDelay', 'string']]);
    });

    it('omits a non-finite number and a wrong-typed string', () => {
      const { drift, row } = parseOneAirport({
        airportLongName: 42,
        airportConfig: { arrivalRate: Number.NaN, arrivalRunwayConfig: '34L' },
      });

      expect(row.airportName).toBeUndefined();
      expect(row.runwayConfiguration).toEqual({ arrivalRunways: '34L' });
      expect(drift.map(([path]) => path)).toEqual([
        'airport-events[].airportLongName',
        'airport-events[].airportConfig.arrivalRate',
      ]);
    });

    it('omits an event whose value is not an object and reports it', () => {
      const { drift, row } = parseOneAirport({ groundStop: 'active', departureDelay: [] });

      expect(row.groundStop).toBeUndefined();
      expect(row.departureDelay).toBeUndefined();
      expect(drift).toEqual([
        ['airport-events[].groundStop', 'string'],
        ['airport-events[].departureDelay', 'array'],
      ]);
    });

    it('reads blank strings as absent without reporting drift', () => {
      const { drift, row } = parseOneAirport({
        airportLongName: '   ',
        airportClosure: { text: '' },
      });

      expect(row.airportName).toBeUndefined();
      expect(row.closure).toEqual({});
      expect(drift).toEqual([]);
    });

    it('drops non-string items of a string list and reports them', () => {
      const { drift, row } = parseOneAirport({
        groundStop: { includedFacilities: ['ZAU', 7, '', 'ZDC'] },
      });

      expect(row.groundStop?.includedFacilities).toEqual(['ZAU', 'ZDC']);
      expect(drift.map(([path]) => path)).toEqual([
        'airport-events[].groundStop.includedFacilities[]',
      ]);
    });

    it('reports the actual type of a dropped list item, not the placeholder "string"', () => {
      const { drift } = parseOneAirport({ groundStop: { includedFacilities: ['ZAU', 7] } });
      expect(drift).toEqual([['airport-events[].groundStop.includedFacilities[]', 'number']]);
    });

    it('omits an empty facility list', () => {
      const { row } = parseOneAirport({ groundStop: { includedFacilities: [] } });
      expect(row.groundStop?.includedFacilities).toBeUndefined();
    });

    it('skips a row without an airportId and counts it', () => {
      const { report } = recorder();
      const { rows, skippedRows } = parseAirportEvents(
        [airportRow(), { groundStop: null }, { airportId: '  ' }, { airportId: 7 }],
        report,
      );

      expect(rows.map((row) => row.airportId)).toEqual(['SEA']);
      expect(skippedRows).toBe(3);
    });

    it('skips a non-object item and counts it', () => {
      const { rows, skippedRows } = parseAirportEvents(
        [airportRow(), null, 'SEA', 5],
        recorder().report,
      );
      expect(rows).toHaveLength(1);
      expect(skippedRows).toBe(3);
    });

    it('normalizes the airport id to trimmed uppercase', () => {
      const { report } = recorder();
      const { rows } = parseAirportEvents([{ airportId: ' sea ' }], report);
      expect(rows[0]?.airportId).toBe('SEA');
    });

    it('raises feed_contract_changed when every row of a non-empty array is unreadable', () => {
      expectContractChanged(
        () => parseAirportEvents([{ foo: 1 }, { bar: 2 }], recorder().report),
        'airport-events',
      );
    });

    it.each([
      ['an object', { airportId: 'SEA' }],
      ['a string', 'maintenance'],
      ['null', null],
      ['a number', 3],
    ])('raises feed_contract_changed when the body is %s', (_label, body) => {
      expectContractChanged(() => parseAirportEvents(body, recorder().report), 'airport-events');
    });

    it('treats an empty array as the quiet state', () => {
      const { drift, report, unknownKeys } = recorder();
      expect(parseAirportEvents([], report)).toEqual({ rows: [], skippedRows: 0 });
      expect(drift).toEqual([]);
      expect(unknownKeys).toEqual([]);
    });

    it('reports an unknown row key and otherwise ignores it', () => {
      const { report, unknownKeys } = recorder();
      const { rows } = parseAirportEvents([airportRow({ tmiPlanned: { a: 1 } })], report);

      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('tmiPlanned');
      expect(unknownKeys).toEqual([['airport-events', 'tmiPlanned']]);
    });
  });

  describe('coordinates', () => {
    it.each([
      ['a numeric string', '47.45', 47.45],
      ['a padded numeric string', ' 47.45 ', 47.45],
      ['a number', 47.45, 47.45],
    ])('reads %s', (_label, raw, expected) => {
      expect(parseOneAirport({ latitude: raw }).row.latitude).toBe(expected);
    });

    it.each([
      ['an unparseable string', 'north'],
      ['a blank string', ' '],
    ])('omits %s without drift', (_label, raw) => {
      const { drift, row } = parseOneAirport({ latitude: raw });
      expect(row.latitude).toBeUndefined();
      expect(drift).toEqual([]);
    });

    it('omits a non-string, non-number coordinate and reports drift', () => {
      const { drift, row } = parseOneAirport({ longitude: true });
      expect(row.longitude).toBeUndefined();
      expect(drift).toEqual([['airport-events[].longitude', 'boolean']]);
    });
  });

  describe('delay bands', () => {
    const band = (fields: Record<string, unknown>) =>
      parseOneAirport({ arrivalDelay: fields }).row.arrivalDelay;

    it('reads the hour form of arrivalDeparture.min/max', () => {
      expect(band({ arrivalDeparture: { max: '2 hours', min: '1 hour and 57 minutes' } })).toEqual({
        maxMinutes: 120,
        minMinutes: 117,
      });
    });

    it('takes the trend from arrivalDeparture when the row has none', () => {
      expect(
        band({ arrivalDeparture: { max: '30 minutes', min: '16 minutes', trend: 'Decreasing' } }),
      ).toMatchObject({ trend: 'decreasing' });
    });

    it('derives an increasing band from averageDelay', () => {
      expect(band({ averageDelay: '45', trend: 'increasing' })).toEqual({
        maxMinutes: 60,
        minMinutes: 46,
        trend: 'increasing',
      });
    });

    it.each([
      ['15', 16, 30],
      ['30', 31, 45],
    ])('derives an increasing %s as %i–%i', (averageDelay, minMinutes, maxMinutes) => {
      expect(band({ averageDelay, trend: 'increasing' })).toEqual({
        maxMinutes,
        minMinutes,
        trend: 'increasing',
      });
    });

    it.each([
      ['15', 0, 14],
      ['30', 15, 29],
      ['45', 30, 44],
    ])(
      'derives a decreasing %s as %i–%i, below the average',
      (averageDelay, minMinutes, maxMinutes) => {
        expect(band({ averageDelay, trend: 'decreasing' })).toEqual({
          maxMinutes,
          minMinutes,
          trend: 'decreasing',
        });
      },
    );

    it.each([
      ['10', 'increasing'],
      ['10', 'decreasing'],
      ['0', 'increasing'],
      ['0', 'decreasing'],
      [-5, 'increasing'],
      [-5, 'decreasing'],
      [14.5, 'decreasing'],
    ])(
      'derives no band from an averageDelay of %j (%s), below the 15-minute floor, and keeps the trend',
      (averageDelay, trend) => {
        expect(band({ averageDelay, reason: 'volume', trend })).toEqual({
          reason: 'volume',
          trend,
        });
      },
    );

    it('never derives a negative bound or a minimum above the maximum', () => {
      for (let averageDelay = -30; averageDelay <= 120; averageDelay++) {
        for (const trend of ['increasing', 'decreasing']) {
          const { maxMinutes, minMinutes } = band({ averageDelay, trend }) ?? {};
          if (minMinutes === undefined && maxMinutes === undefined) continue;
          expect(minMinutes, `${averageDelay} ${trend}`).toBeGreaterThanOrEqual(0);
          expect(minMinutes, `${averageDelay} ${trend}`).toBeLessThanOrEqual(maxMinutes as number);
        }
      }
    });

    it('keeps the bounds a row reports in arrivalDeparture over any averageDelay derivation', () => {
      expect(
        band({
          arrivalDeparture: { max: '45 minutes', min: '31 minutes' },
          averageDelay: '30',
          trend: 'decreasing',
        }),
      ).toEqual({ maxMinutes: 45, minMinutes: 31, trend: 'decreasing' });
    });

    it('leaves the band unset when neither form is usable', () => {
      expect(
        band({ averageDelay: 'about half an hour', reason: 'volume', trend: 'increasing' }),
      ).toEqual({ reason: 'volume', trend: 'increasing' });
      expect(band({ averageDelay: '30' })).toEqual({});
    });

    it('ignores an unrecognized trend value', () => {
      expect(band({ averageDelay: '30', trend: 'steady' })).toEqual({});
    });

    it.each([
      ['a numeric string too long to represent', '9'.repeat(400)],
      ['a non-finite number', Number.POSITIVE_INFINITY],
    ])('leaves the band unset for an averageDelay that is %s', (_label, averageDelay) => {
      expect(band({ averageDelay, trend: 'increasing' })).toEqual({ trend: 'increasing' });
    });

    it('drops a bound too large to represent and keeps the other', () => {
      expect(
        band({ arrivalDeparture: { max: '30 minutes', min: `${'9'.repeat(400)} minutes` } }),
      ).toEqual({ maxMinutes: 30 });
    });
  });

  it('reads deicing without an eventTime as present with no start', () => {
    expect(parseOneAirport({ deicing: { airportId: 'SEA' } }).row.deicing).toEqual({});
  });

  it('strips the leading ": " from includedFlights and drops a bare prefix', () => {
    const flights = (value: string) =>
      parseOneAirport({ groundDelay: { includedFlights: value } }).row.groundDelayProgram
        ?.includedFlights;
    expect(flights(': ALL CONTIGUOUS US DEP')).toBe('ALL CONTIGUOUS US DEP');
    expect(flights(':   ')).toBeUndefined();
  });

  it('omits the advisory when the link lacks a number or a date', () => {
    const advisory = (advisoryUrl: string) =>
      parseOneAirport({ groundStop: { advisoryUrl } }).row.groundStop?.advisory;
    expect(
      advisory('https://www.fly.faa.gov/adv/adv_otherdis.jsp?adv_date=09302026'),
    ).toBeUndefined();
    expect(advisory('https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=3')).toBeUndefined();
  });

  it.each([
    ['a number that runs into letters', 'advn=3abc&adv_date=09302026'],
    ['a date naming month 13 day 45', 'advn=3&adv_date=13452026'],
    ['a date naming February 30', 'advn=3&adv_date=02302026'],
  ])('omits the advisory when the link carries %s, as it does a missing one', (_label, query) => {
    const { row } = parseOneAirport({
      groundStop: {
        advisoryUrl: `https://www.fly.faa.gov/adv/adv_otherdis.jsp?${query}&facId=SEA&title=ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 CDM GROUND STOP&titleDate=09/30/2026`,
      },
    });
    expect(row.groundStop).toBeDefined();
    expect(row.groundStop).not.toHaveProperty('advisory');
  });
});

describe('parseDurationMinutes', () => {
  it.each([
    ['16 minutes', 16],
    ['1 minute', 1],
    ['1 hour and 57 minutes', 117],
    ['2 hours', 120],
    ['3 Hours 5 Minutes', 185],
  ])('reads %j as %i', (input, expected) => {
    expect(parseDurationMinutes(input)).toBe(expected);
  });

  it.each([undefined, '', 'n/a', '16'])('returns undefined for %j', (input) => {
    expect(parseDurationMinutes(input)).toBeUndefined();
  });

  it.each([
    ['minutes', `${'9'.repeat(400)} minutes`],
    ['hours', `${'9'.repeat(308)} hours`],
  ])('returns undefined for a count of %s too large to represent', (_label, input) => {
    expect(parseDurationMinutes(input)).toBeUndefined();
  });

  it.each(['12345 minutes', '10000 hours'])(
    'returns undefined for %j, a count longer than four digits',
    (input) => {
      expect(parseDurationMinutes(input)).toBeUndefined();
    },
  );

  it.each([
    ['a long digit run with no unit', '1'.repeat(30_000)],
    ['a long digit run before another word', `${'1'.repeat(30_000)} x`],
  ])('reads %s in linear time', (_label, input) => {
    const started = performance.now();
    expect(parseDurationMinutes(input)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('parseEnrouteEvents', () => {
  it('discloses a wrong-typed event object without discarding a readable sibling row', () => {
    const parsed = parseEnrouteEvents(
      [{ airspaceFlowProgram: 'active' }, { airspaceFlowProgram: { afpName: 'FCA005' } }],
      recorder().report,
    );
    expect(parsed).toMatchObject({
      rows: [{ name: 'FCA005' }],
      skippedRows: 1,
      unreadableSections: ['enroute-events[].airspaceFlowProgram'],
    });
  });
  it('reads the fixture rows into Airspace Flow Programs', () => {
    const { report, unknownKeys } = recorder();
    const { rows, skippedRows } = parseEnrouteEvents(feedFixture('enroute-events'), report);

    expect(skippedRows).toBe(0);
    expect(unknownKeys).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      advisory: {
        date: '2026-07-15',
        number: 45,
        url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=45&adv_date=07152026',
      },
      altitudeCeiling: '600',
      altitudeFloor: '000',
      averageDelayMinutes: 42.5,
      comments: 'EXPECT EDCTS FOR FLIGHTS WESTBOUND THROUGH FCAA05.',
      constrainedArea: { name: 'ZNY', type: 'artcc' },
      delayProfile: {
        averageDelayMinutes: [40, 44],
        intervalMinutes: 15,
        startTime: '2026-07-15T18:00:00Z',
      },
      departsFrom: 'ZNY ZDC',
      endTime: '2026-07-16T01:59:00Z',
      excludedDepartures: 'ZBW ZOB',
      filtersMatchAny: false,
      headingDirection: 'westbound',
      name: 'FCAA05',
      reason: 'thunderstorms',
      startTime: '2026-07-15T18:00:00Z',
      updatedAt: '2026-07-15T17:40:00Z',
    });
  });

  it.each([
    [
      'the quarter-hour floor of its start without delayTimeAmount',
      { startTime: '2026-07-15T18:10:00Z' },
      '2026-07-15T18:00:00Z',
    ],
    [
      'delayTimeAmount, with no start',
      {
        dasDelays: {
          dasDelay: [{ delay: 40, seq: 1 }],
          delayTimeAmount: '2026-07-15T18:15:00.000+00:00',
        },
      },
      '2026-07-15T18:15:00Z',
    ],
  ])('anchors afp.delayProfile on %s, like a GDP', (_label, delayTime, expected) => {
    const { rows } = parseEnrouteEvents(
      [
        {
          airspaceFlowProgram: {
            afpName: 'FCA009',
            fuelFlowAdvisoryDelayTime: {
              dasDelays: { dasDelay: [{ delay: 40, seq: 1 }] },
              ...delayTime,
            },
            startTime: '2026-07-15T19:00:00Z',
          },
        },
      ],
      recorder().report,
    );
    expect(rows[0]?.delayProfile).toEqual({
      averageDelayMinutes: [40],
      intervalMinutes: 15,
      startTime: expected,
    });
    expect(rows[0]?.startTime).toBe('2026-07-15T19:00:00Z');
    expect(rows[0]).not.toHaveProperty('programStartTime');
  });

  it('keeps a row that carries only its afpName, with the generic fca area', () => {
    const { rows } = parseEnrouteEvents(feedFixture('enroute-events'), recorder().report);
    expect(rows[1]).toEqual({ constrainedArea: { type: 'fca' }, name: 'FCA002' });
  });

  it('treats an empty array as the quiet state', () => {
    expect(parseEnrouteEvents([], recorder().report)).toEqual({ rows: [], skippedRows: 0 });
  });

  it('skips rows without airspaceFlowProgram.afpName and counts them', () => {
    const { rows, skippedRows } = parseEnrouteEvents(
      [
        { airspaceFlowProgram: { afpName: 'FCA1' } },
        { airspaceFlowProgram: {} },
        { airspaceFlowProgram: { afpName: '' } },
        { airspaceFlowProgram: 'FCA2' },
        { comments: 'orphan' },
      ],
      recorder().report,
    );

    expect(rows.map((row) => row.name)).toEqual(['FCA1']);
    expect(skippedRows).toBe(4);
  });

  it('raises feed_contract_changed when no en-route row is readable', () => {
    expectContractChanged(
      () => parseEnrouteEvents([{ airspaceFlowProgram: {} }], recorder().report),
      'enroute-events',
    );
  });

  it('raises feed_contract_changed for a non-array body', () => {
    expectContractChanged(
      () => parseEnrouteEvents({ events: [] }, recorder().report),
      'enroute-events',
    );
  });

  it('resolves the constrained area in the dashboard precedence', () => {
    const area = (extra: Record<string, unknown>) =>
      parseEnrouteEvents([{ airspaceFlowProgram: { afpName: 'X' }, ...extra }], recorder().report)
        .rows[0]?.constrainedArea;

    expect(
      area({ fcaAirport: { fcaAirportName: 'KSEA' }, fcaArtcc: { fcaArtccName: 'ZSE' } }),
    ).toEqual({
      name: 'KSEA',
      type: 'airport',
    });
    expect(area({ fcaArtcc: { fcaArtccName: 'ZSE' }, fcaSectorName: 'ZSE12' })).toEqual({
      name: 'ZSE',
      type: 'artcc',
    });
    expect(area({ fcaBaseSector: 'ZSE13' })).toEqual({ name: 'ZSE13', type: 'sector' });
    expect(area({ fcaTraconName: 'S46' })).toEqual({ name: 'S46', type: 'tracon' });
    expect(area({ fcaBaseTracon: 'S46B' })).toEqual({ name: 'S46B', type: 'tracon' });
    expect(area({ fcaSuaName: 'R-6714' })).toEqual({
      name: 'R-6714',
      type: 'special_use_airspace',
    });
    expect(area({ fcaFixName: 'BUF' })).toEqual({ name: 'BUF', type: 'fix' });
    expect(area({ fcaAirport: { fcaAirportName: '' }, fcaFixName: 'BUF' })).toEqual({
      name: 'BUF',
      type: 'fix',
    });
  });

  it('joins array flight filters with spaces and reads string filters verbatim', () => {
    const { rows } = parseEnrouteEvents(
      [
        {
          airspaceFlowProgram: { afpName: 'X' },
          arrivesAny: ['KSEA', 'KPDX'],
          arrivesNone: 'KBFI',
          departsAny: [],
          departsNone: ['ZBW', 7],
        },
      ],
      recorder().report,
    );

    expect(rows[0]).toMatchObject({
      arrivesTo: 'KSEA KPDX',
      excludedArrivals: 'KBFI',
      excludedDepartures: 'ZBW',
    });
    expect(rows[0]).not.toHaveProperty('departsFrom');
  });

  it('omits a wrong-typed filtersMatchAny and reports drift', () => {
    const { drift, report } = recorder();
    const { rows } = parseEnrouteEvents(
      [{ airspaceFlowProgram: { afpName: 'X' }, isAnyConditions: 'false' }],
      report,
    );

    expect(rows[0]).not.toHaveProperty('filtersMatchAny');
    expect(drift).toEqual([['enroute-events[].isAnyConditions', 'string']]);
  });

  it('omits wrong-typed AFP fields inside airspaceFlowProgram', () => {
    const { drift, report } = recorder();
    const { rows } = parseEnrouteEvents(
      [{ airspaceFlowProgram: { afpName: 'X', avgDelay: '40', lowerAltitude: 0 } }],
      report,
    );

    expect(rows[0]).toEqual({ constrainedArea: { type: 'fca' }, name: 'X' });
    expect(drift).toEqual([
      ['enroute-events[].airspaceFlowProgram.avgDelay', 'string'],
      ['enroute-events[].airspaceFlowProgram.lowerAltitude', 'number'],
    ]);
  });

  it('reports an unknown row key', () => {
    const { report, unknownKeys } = recorder();
    parseEnrouteEvents([{ airspaceFlowProgram: { afpName: 'X' }, newField: 1 }], report);
    expect(unknownKeys).toEqual([['enroute-events', 'newField']]);
  });
});

describe('parsePlannedEvent', () => {
  it('flattens the tab and dash, and reads qualifier, time, and likelihood', () => {
    expect(parsePlannedEvent('AFTER 1600\t-BOS GROUND STOP/DELAY PROGRAM EXPECTED', '')).toEqual({
      likelihood: 'expected',
      text: 'AFTER 1600 BOS GROUND STOP/DELAY PROGRAM EXPECTED',
      timeQualifier: 'after',
      timeUtc: '1600',
    });
  });

  it.each([
    ['UNTIL 0300\t-PHL AREA C', 'until', '0300'],
    ['BY 2200 -SEA', 'by', '2200'],
    ['between 1100 AND 1300 -DEN', 'between', '1100'],
  ])('reads the qualifier of %j', (event, qualifier, time) => {
    expect(parsePlannedEvent(event, undefined)).toMatchObject({
      timeQualifier: qualifier,
      timeUtc: time,
    });
  });

  it('prefers a non-empty upstream time over the parsed one', () => {
    expect(parsePlannedEvent('AFTER 1600\t-BOS GS POSSIBLE', ' 1615 ')).toMatchObject({
      timeQualifier: 'after',
      timeUtc: '1615',
    });
  });

  it('leaves time and likelihood unset when the text states none', () => {
    expect(parsePlannedEvent('GULF ROUTE CLOSURES WERE EXTENDED', '')).toEqual({
      text: 'GULF ROUTE CLOSURES WERE EXTENDED',
    });
  });

  it('accepts only the closed likelihood vocabulary', () => {
    expect(parsePlannedEvent('AFTER 1500\t-DEN GS LIKELY', '')).not.toHaveProperty('likelihood');
    expect(parsePlannedEvent('AFTER 1500\t-DEN GS Probable', '')).toMatchObject({
      likelihood: 'probable',
    });
  });

  it('collapses runs of spaces and a leading dash', () => {
    expect(parsePlannedEvent('- AFTER  1500   -DEN', '').text).toBe('AFTER 1500 -DEN');
  });
});

describe('parseTerminalPlannedEvent', () => {
  it('adds the named airports to the planned-item parse', () => {
    expect(
      parseTerminalPlannedEvent('AFTER 1600\t-SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE', ''),
    ).toEqual({
      airports: ['SEA', 'BFI'],
      likelihood: 'possible',
      text: 'AFTER 1600 SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE',
      timeQualifier: 'after',
      timeUtc: '1600',
    });
  });

  it.each([
    ['AFTER 1200\t-IAH/HOU GROUND STOP POSSIBLE', ['IAH', 'HOU']],
    ['UNTIL 2300\t-MIA/FLL/DJT GROUND STOP POSSIBLE', ['MIA', 'FLL', 'DJT']],
    ['UNTIL 0500\t-MEM GROUND STOP PROBABLE', ['MEM']],
    ['AFTER 2100 \t-LAS GROUND STOPS POSSIBLE', ['LAS']],
    ['AFTER 1600\t-EWR/TEB/PHL GROUND DELAY PROGRAM POSSIBLE', ['EWR', 'TEB', 'PHL']],
    ['ATL GROUND STOP/GROUND DELAY PROGRAM', ['ATL']],
    ['AFTER 1500\t-PBI/SEA GROUND STOP POSSIBLE', ['SEA']],
  ])('reads %j as %j', (event, airports) => {
    expect(parseTerminalPlannedEvent(event, undefined).airports).toEqual(airports);
  });

  it.each([
    ['a metro area', 'AFTER 1600\t-NEW YORK METROS GROUND STOP POSSIBLE'],
    ['an ARTCC', 'AFTER 1600\t-ZNY GROUND STOP POSSIBLE'],
    ['an identifier the directory lacks', 'AFTER 1500\t-PBI GROUND STOP/DELAY PROGRAM POSSIBLE'],
    ['a group with a 4-character part', 'AFTER 1500\t-SEA/KBFI GROUND STOP POSSIBLE'],
    ['an en-route phrase', 'AFTER 1700\t-ORD/MDW ARRIVAL ROUTES POSSIBLE'],
    ['a word that only starts with GROUND', 'AFTER 1500\t-SFO GROUNDSTOP POSSIBLE'],
    ['lowercase text', 'after 1600\t-sfo ground stop possible'],
    ['no word after the identifier', 'AFTER 1600\t-SFO'],
    ['nothing after the time', 'AFTER 1600\t-'],
    [
      'a between window, its end time before the identifier',
      'BETWEEN 1100 AND 1300\t-DEN GROUND STOP POSSIBLE',
    ],
  ])('names no airport for %s', (_label, event) => {
    expect(parseTerminalPlannedEvent(event, undefined)).not.toHaveProperty('airports');
  });

  it('reads the leading identifier when the time comes from the time field', () => {
    expect(parseTerminalPlannedEvent('SFO GROUND STOP POSSIBLE', '1500')).toEqual({
      airports: ['SFO'],
      likelihood: 'possible',
      text: 'SFO GROUND STOP POSSIBLE',
      timeUtc: '1500',
    });
  });

  it.each([
    ['a long slash run', (n: number) => `AFTER 1600\t-${'SEA/'.repeat(n / 4)}BFI GROUND STOP`],
    [
      'a slash run failing at its end',
      (n: number) => `AFTER 1600\t-${'SEA/'.repeat(n / 4)}X GROUND`,
    ],
    ['repeated qualifiers', (n: number) => `${'AFTER 1600 '.repeat(n / 11)}SFO GROUND STOP`],
    ['a word repeating GROUND', (n: number) => `AFTER 1600\t-SFO ${'GROUND'.repeat(n / 6)}`],
    ['repeated tab-dash openers', (n: number) => `${'\t-'.repeat(n / 2)}SFO GROUND STOP`],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ])('parses %s in linear CPU time across a 64-fold span', (_label, build) => {
    const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
    const perCallMicros: number[] = [];
    for (const size of sizes) {
      const event = build(size);
      const batch = 320_000 / size;
      let fastest = Infinity;
      for (let round = 0; round < 5; round++) {
        const started = threadCpuUsage();
        for (let call = 0; call < batch; call++) parseTerminalPlannedEvent(event, undefined);
        const elapsed = threadCpuUsage(started);
        fastest = Math.min(fastest, (elapsed.user + elapsed.system) / batch);
      }
      expect(fastest).toBeLessThan(size * 0.5);
      perCallMicros.push(fastest);
    }
    expect((perCallMicros.at(-1) as number) / (perCallMicros[0] as number)).toBeLessThan(256);
  });
});

describe('parseOperationsPlan', () => {
  it('keeps usable plan siblings and distinguishes malformed from absent/null sections', () => {
    const parsed = parseOperationsPlan(
      { terminalPlanned: 'unreadable', enRoutePlanned: [{ event: 'AFTER 1500 FCA005 EXPECTED' }] },
      recorder().report,
    );
    expect(parsed.enRoutePlanned).toMatchObject([{ text: 'AFTER 1500 FCA005 EXPECTED' }]);
    expect(parsed.unreadableSections).toEqual(['operations-plan.terminalPlanned']);
    expect(
      parseOperationsPlan({ terminalPlanned: null, enRoutePlanned: [] }, recorder().report),
    ).not.toHaveProperty('unreadableSections');
  });
  it('reads the fixture into planned items and an advisory reference', () => {
    const plan = parseOperationsPlan(feedFixture('operations-plan'), recorder().report);

    expect(plan.skippedRows).toBe(0);
    expect(plan.advisory).toEqual({
      date: '2026-09-29',
      number: 82,
      url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=82&adv_date=09292026',
    });
    expect(plan.terminalPlanned.map((item) => item.likelihood)).toEqual([
      'possible',
      'expected',
      'probable',
    ]);
    expect(plan.enRoutePlanned).toHaveLength(2);
    expect(plan.terminalPlanned[0]).toMatchObject({ timeQualifier: 'after', timeUtc: '1100' });
  });

  it('names the airports of each terminal item', () => {
    const plan = parseOperationsPlan(feedFixture('operations-plan'), recorder().report);
    expect(plan.terminalPlanned.map((item) => item.airports)).toEqual([
      ['DCA'],
      ['BOS'],
      ['MIA', 'FLL'],
    ]);
  });

  it('reads no airports from an en-route item, even one worded as a ground stop', () => {
    const plan = parseOperationsPlan(
      { enRoutePlanned: [{ event: 'AFTER 1500\t-DEN GROUND STOP POSSIBLE', time: '' }] },
      recorder().report,
    );
    expect(plan.enRoutePlanned).toEqual([
      {
        likelihood: 'possible',
        text: 'AFTER 1500 DEN GROUND STOP POSSIBLE',
        timeQualifier: 'after',
        timeUtc: '1500',
      },
    ]);
  });

  it('accepts an object carrying only a link, with empty lists', () => {
    const plan = parseOperationsPlan(
      { link: 'https://x.test/?advn=5&adv_date=01022026' },
      recorder().report,
    );
    expect(plan).toMatchObject({ enRoutePlanned: [], skippedRows: 0, terminalPlanned: [] });
    expect(plan.advisory).toMatchObject({ date: '2026-01-02', number: 5 });
  });

  it('accepts empty planned lists without an advisory', () => {
    const plan = parseOperationsPlan(
      { enRoutePlanned: [], terminalPlanned: [] },
      recorder().report,
    );
    expect(plan).toEqual({ enRoutePlanned: [], skippedRows: 0, terminalPlanned: [] });
  });

  it('skips unreadable planned rows, counts them, and keeps the rest', () => {
    const plan = parseOperationsPlan(
      {
        enRoutePlanned: [{ event: 'AFTER 1200\t-LAKE ERIE ROUTES POSSIBLE' }, { event: '' }],
        terminalPlanned: [{ event: 'AFTER 1100\t-DCA GS POSSIBLE' }, { time: '1200' }, 'x'],
      },
      recorder().report,
    );
    expect(plan.terminalPlanned).toHaveLength(1);
    expect(plan.enRoutePlanned).toHaveLength(1);
    expect(plan.skippedRows).toBe(3);
  });

  it('raises feed_contract_changed when a non-empty planned list has no readable row', () => {
    expectContractChanged(
      () =>
        parseOperationsPlan(
          { terminalPlanned: [{ event: 5 }, {}], enRoutePlanned: [] },
          recorder().report,
        ),
      'operations-plan',
    );
  });

  it('omits a planned list that is not an array and reports drift', () => {
    const { drift, report } = recorder();
    const plan = parseOperationsPlan({ link: '', terminalPlanned: 'none' }, report);
    expect(plan.terminalPlanned).toEqual([]);
    expect(drift).toEqual([['operations-plan.terminalPlanned', 'string']]);
  });

  it.each([
    ['an array', []],
    ['a string', 'x'],
    ['null', null],
    ['an object with none of the plan keys', { unrelated: true }],
  ])('raises feed_contract_changed when the body is %s', (_label, body) => {
    expectContractChanged(() => parseOperationsPlan(body, recorder().report), 'operations-plan');
  });
});

describe('parseAnnouncements', () => {
  it('reads the fixture texts', () => {
    expect(parseAnnouncements(feedFixture('miscellaneous-info'), recorder().report)).toEqual({
      rows: ['NEXT PLANNING WEBINAR 1115Z'],
      skippedRows: 0,
    });
  });

  it('treats an empty array as the quiet state', () => {
    expect(parseAnnouncements([], recorder().report)).toEqual({ rows: [], skippedRows: 0 });
  });

  it('skips rows with a missing, blank, or wrong-typed event', () => {
    const { rows, skippedRows } = parseAnnouncements(
      [{ event: 'A' }, { event: ' ' }, { event: 3 }, {}],
      recorder().report,
    );
    expect(rows).toEqual(['A']);
    expect(skippedRows).toBe(3);
  });

  it('raises feed_contract_changed when no row is readable, or the body is not an array', () => {
    expectContractChanged(() => parseAnnouncements([{}], recorder().report), 'miscellaneous-info');
    expectContractChanged(() => parseAnnouncements({}, recorder().report), 'miscellaneous-info');
  });
});

describe('parsePacingAirports', () => {
  it('corrects only PHX US/Mountain and preserves reported provenance', () => {
    const row = parsePacingAirports(
      [{ airportId: 'phx', timezone: 'US/Mountain' }],
      recorder().report,
    ).rows[0];
    expect(row).toEqual({
      airportId: 'PHX',
      timezone: 'America/Phoenix',
      reportedTimezone: 'US/Mountain',
    });
    for (const month of ['01', '10']) {
      expect(
        new Intl.DateTimeFormat('en-US', {
          timeZone: row?.timezone,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(`2026-${month}-13T18:00:00Z`)),
      ).toBe('11');
    }
  });
  it('preserves other reported zones and already-correct PHX zones', () => {
    expect(
      parsePacingAirports(
        [
          { airportId: 'DEN', timezone: 'US/Mountain' },
          { airportId: 'PHX', timezone: 'America/Phoenix' },
        ],
        recorder().report,
      ).rows,
    ).toEqual([
      { airportId: 'DEN', timezone: 'US/Mountain' },
      { airportId: 'PHX', timezone: 'America/Phoenix' },
    ]);
  });
  it('reads the fixture rows without the isPacing flag', () => {
    const { rows, skippedRows } = parsePacingAirports(
      feedFixture('pacing-airports'),
      recorder().report,
    );

    expect(skippedRows).toBe(0);
    expect(rows.map((row) => row.airportId)).toEqual(['STL', 'SEA', 'ORD', 'DEN', 'TEB']);
    expect(rows[1]).toEqual({
      airportId: 'SEA',
      latitude: 47.4502,
      longitude: -122.3088,
      timezone: 'US/Pacific',
    });
  });

  it('excludes rows flagged isPacing: false and keeps rows without the flag', () => {
    const { rows } = parsePacingAirports(
      [
        { airportId: 'SEA', isPacing: false },
        { airportId: 'ORD', isPacing: true },
        { airportId: 'DEN' },
      ],
      recorder().report,
    );
    expect(rows.map((row) => row.airportId)).toEqual(['ORD', 'DEN']);
  });

  it('skips keyless rows and raises feed_contract_changed when none is readable', () => {
    const { rows, skippedRows } = parsePacingAirports(
      [{ airportId: 'SEA' }, { timezone: 'US/Pacific' }],
      recorder().report,
    );
    expect(rows).toHaveLength(1);
    expect(skippedRows).toBe(1);
    expectContractChanged(
      () => parsePacingAirports([{ timezone: 'US/Pacific' }], recorder().report),
      'pacing-airports',
    );
  });

  it('treats an empty array as quiet and a non-array as a contract change', () => {
    expect(parsePacingAirports([], recorder().report)).toEqual({ rows: [], skippedRows: 0 });
    expectContractChanged(() => parsePacingAirports({}, recorder().report), 'pacing-airports');
  });

  it('omits a wrong-typed timezone and reports drift', () => {
    const { drift, report } = recorder();
    const { rows } = parsePacingAirports([{ airportId: 'SEA', timezone: 8 }], report);
    expect(rows[0]).toEqual({ airportId: 'SEA' });
    expect(drift).toEqual([['pacing-airports[].timezone', 'number']]);
  });
});
