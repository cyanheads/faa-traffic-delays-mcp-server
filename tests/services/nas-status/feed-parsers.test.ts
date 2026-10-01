/**
 * @fileoverview Tests for the tolerant NAS Status feed parsers: field mapping against the
 * API Reference shapes, and the drift rules (wrong-typed field omitted and reported, keyless row
 * skipped, wrong top-level shape raises feed_contract_changed, empty array is quiet).
 * @module tests/services/nas-status/feed-parsers.test
 */

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

function expectContractChanged(run: () => unknown, feed: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.SerializationError);
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
      reason: 'low ceilings',
      startTime: '2026-09-30T01:00:00Z',
      updatedAt: '2026-09-30T00:17:04Z',
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
      maxMinutes: 30,
      minMinutes: 16,
      trend: 'decreasing',
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

    it('derives a decreasing band from averageDelay and never goes below zero', () => {
      expect(band({ averageDelay: 10, trend: 'decreasing' })).toEqual({
        maxMinutes: 10,
        minMinutes: 0,
        trend: 'decreasing',
      });
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
});

describe('parseEnrouteEvents', () => {
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

describe('parseOperationsPlan', () => {
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
