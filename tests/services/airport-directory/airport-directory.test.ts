/**
 * @fileoverview Tests for the bundled NASR airport directory: FAA-identifier lookup, the ICAO
 * crosswalk as a lookup (never a prefix strip), code normalization, and the directory metadata.
 * @module tests/services/airport-directory/airport-directory.test
 */

import { describe, expect, it } from 'vitest';
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
