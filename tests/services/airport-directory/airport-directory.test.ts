/**
 * @fileoverview Tests for the bundled NASR airport directory: FAA-identifier lookup with each
 * airport's ARTCC and coordinates, blank NASR fields left out, the ICAO crosswalk as a lookup
 * (never a prefix strip), code normalization, and the directory metadata.
 * @module tests/services/airport-directory/airport-directory.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDirectoryInfo,
  normalizeAirportCode,
  resolveAirportCode,
} from '@/services/airport-directory/airport-directory.js';

describe('resolveAirportCode', () => {
  it('resolves a 3-character code by FAA identifier', () => {
    expect(resolveAirportCode('SEA')).toMatchObject({
      faaId: 'SEA',
      icaoId: 'KSEA',
      state: 'WA',
    });
  });

  it('resolves numeric FAA identifiers', () => {
    expect(resolveAirportCode('0S9')).toMatchObject({ faaId: '0S9' });
  });

  it.each([
    ['KSEA', 'SEA'],
    ['KJFK', 'JFK'],
    ['PHNL', 'HNL'],
    ['PANC', 'ANC'],
    ['TJSJ', 'SJU'],
    ['PGUM', 'GUM'],
  ])('crosswalks ICAO %s to FAA %s', (icao, faa) => {
    expect(resolveAirportCode(icao)?.faaId).toBe(faa);
  });

  it('returns the same record for a 3-character and an ICAO code of one airport', () => {
    expect(resolveAirportCode('KSEA')).toBe(resolveAirportCode('SEA'));
  });

  it('carries the name, city, and state the tools echo', () => {
    const airport = resolveAirportCode('ORD');
    expect(airport?.name).toEqual(expect.any(String));
    expect(airport?.name.length).toBeGreaterThan(0);
    expect(airport?.city).toEqual(expect.any(String));
    expect(airport?.state).toBe('IL');
  });

  it.each([
    ['BOI', { artcc: 'ZLC', latitude: 43.5644, longitude: -116.2229 }],
    ['KSEA', { artcc: 'ZSE', latitude: 47.4499, longitude: -122.3118 }],
    ['PANC', { artcc: 'ZAN', latitude: 61.1741, longitude: -149.9981 }],
    ['GUM', { artcc: 'ZUA', latitude: 13.484, longitude: 144.7971 }],
    ['FAQ', { artcc: 'NZZO', latitude: -14.2161, longitude: -169.4235 }],
  ])("carries %s's responsible ARTCC and NASR coordinates", (code, expected) => {
    expect(resolveAirportCode(code)).toMatchObject(expected);
  });

  it.each([
    ['a K-prefixed pseudo-code', 'K0S9'],
    ['a Canadian ICAO code', 'CYVR'],
    ['an ICAO-shaped code that is not assigned', 'KZZZ'],
    ['an unassigned 3-character code', 'ZZZ'],
    ['a 2-character code', 'SE'],
    ['a 5-character code', 'KSEAA'],
    ['the empty string', ''],
  ])('does not resolve %s', (_label, code) => {
    expect(resolveAirportCode(code)).toBeUndefined();
  });

  it('is case-sensitive: callers normalize first', () => {
    expect(resolveAirportCode('sea')).toBeUndefined();
    expect(resolveAirportCode('ksea')).toBeUndefined();
  });

  it('never resolves a 4-character code by prefix-stripping the K', () => {
    // K + a valid FAA identifier is only valid when NASR lists it as that airport's ICAO code.
    expect(resolveAirportCode('KSE1')).toBeUndefined();
  });
});

describe('normalizeAirportCode', () => {
  it.each([
    ['sea', 'SEA'],
    ['  ksea ', 'KSEA'],
    ['Phnl', 'PHNL'],
    ['0s9', '0S9'],
  ])('trims and uppercases %j to %j', (input, expected) => {
    expect(normalizeAirportCode(input)).toBe(expected);
  });

  it.each([[42], [null], [undefined], [['SEA']], [{ code: 'SEA' }]])(
    'passes non-string value %j through unchanged',
    (value) => {
      expect(normalizeAirportCode(value)).toBe(value);
    },
  );
});

describe('getDirectoryInfo', () => {
  it('reports source, an ISO cycle date, and a plausible airport count', () => {
    const info = getDirectoryInfo();

    expect(info.source).toBe('FAA NASR APT_BASE');
    expect(info.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(info.airportCount).toBeGreaterThan(5_000);
  });

  it('lists every fixture pacing airport', () => {
    for (const id of ['STL', 'SEA', 'ORD', 'DEN', 'TEB']) {
      expect(resolveAirportCode(id), id).toBeDefined();
    }
  });
});

describe('a directory row NASR leaves partly blank', () => {
  afterEach(() => {
    vi.doUnmock('@/services/airport-directory/nasr-airports.generated.js');
    vi.resetModules();
  });

  it('omits each blank field, as with a blank ICAO code', async () => {
    vi.resetModules();
    vi.doMock('@/services/airport-directory/nasr-airports.generated.js', () => ({
      NASR_EFFECTIVE_DATE: '2026-09-03',
      NASR_AIRPORTS_TSV: [
        'AAA\tKAAA\tFULL\tCITY\tWA\tZSE\t47.5\t-122.25',
        'BBB\t\tNO ARTCC\tCITY\tWA\t\t47.5\t-122.25',
        'CCC\t\tNO COORDINATES\t\t\tZSE\t\t',
        'DDD\t\tLATITUDE ONLY\tCITY\tWA\tZSE\t-0.5\t',
      ].join('\n'),
    }));
    const { resolveAirportCode: resolve } = await import(
      '@/services/airport-directory/airport-directory.js'
    );

    expect(resolve('AAA')).toEqual({
      artcc: 'ZSE',
      city: 'CITY',
      faaId: 'AAA',
      icaoId: 'KAAA',
      latitude: 47.5,
      longitude: -122.25,
      name: 'FULL',
      state: 'WA',
    });
    expect(resolve('BBB')).not.toHaveProperty('artcc');
    expect(resolve('BBB')).not.toHaveProperty('icaoId');
    expect(resolve('CCC')).toEqual({
      artcc: 'ZSE',
      city: '',
      faaId: 'CCC',
      name: 'NO COORDINATES',
      state: '',
    });
    expect(resolve('DDD')).toMatchObject({ latitude: -0.5 });
    expect(resolve('DDD')).not.toHaveProperty('longitude');
  });
});
