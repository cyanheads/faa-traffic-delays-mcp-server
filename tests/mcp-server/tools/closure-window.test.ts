/**
 * @fileoverview Tests for the daily closure window shared by the two feed tools: whether a
 * `DLY HHMM-HHMM` closure is in effect at the snapshot time and when its next window starts, the
 * notice fragment naming it, and the closure-line suffix.
 * @module tests/mcp-server/tools/closure-window.test
 */

import { describe, expect, it } from 'vitest';
import { dailyWindowState, dailyWindowSuffix } from '@/mcp-server/tools/closure-window.js';
import { closureWindowNotice } from '@/mcp-server/tools/notices.js';

/** PVD as listed at 2026-11-04T08:28Z: closed 0515–1030Z daily from Nov 3 to Nov 4. */
const PVD = {
  dailyWindowUtc: { end: '1030', start: '0515' },
  endTime: '2026-11-04T10:30:00Z',
  startTime: '2026-11-03T05:15:00Z',
};

/** Synthetic: closed 2300–0600Z daily from the night of Nov 3 to the morning of Nov 6. */
const OVERNIGHT = {
  dailyWindowUtc: { end: '0600', start: '2300' },
  endTime: '2026-11-06T06:00:00Z',
  startTime: '2026-11-03T23:00:00Z',
};

describe('dailyWindowState', () => {
  it.each([
    [
      'PVD a day before its first window, inside the time of day',
      PVD,
      '2026-11-02T06:00:00Z',
      false,
      '2026-11-03T05:15:00Z',
    ],
    ['PVD before its first window', PVD, '2026-11-03T04:00:00Z', false, '2026-11-03T05:15:00Z'],
    ['PVD at its first window start', PVD, '2026-11-03T05:15:00Z', true, undefined],
    ['PVD inside its first window', PVD, '2026-11-03T06:00:00Z', true, undefined],
    ['PVD at a window end', PVD, '2026-11-03T10:30:00Z', false, '2026-11-04T05:15:00Z'],
    ['PVD between windows', PVD, '2026-11-03T12:23:00Z', false, '2026-11-04T05:15:00Z'],
    ['PVD inside its last window', PVD, '2026-11-04T08:28:00Z', true, undefined],
    ['PVD a second before endTime', PVD, '2026-11-04T10:29:59Z', true, undefined],
    ['PVD at endTime', PVD, '2026-11-04T10:30:00Z', false, undefined],
    [
      'PVD a day after endTime, inside the time of day',
      PVD,
      '2026-11-05T06:00:00Z',
      false,
      undefined,
    ],
    [
      'overnight before its first window, inside the time of day',
      OVERNIGHT,
      '2026-11-03T03:00:00Z',
      false,
      '2026-11-03T23:00:00Z',
    ],
    ['overnight before 0000Z', OVERNIGHT, '2026-11-04T23:30:00Z', true, undefined],
    ['overnight after 0000Z', OVERNIGHT, '2026-11-05T03:00:00Z', true, undefined],
    ['overnight between windows', OVERNIGHT, '2026-11-05T12:00:00Z', false, '2026-11-05T23:00:00Z'],
    ['overnight at endTime', OVERNIGHT, '2026-11-06T06:00:00Z', false, undefined],
  ] as const)('%s', (_label, closure, at, inEffect, nextWindowStart) => {
    expect(dailyWindowState(closure, at)).toEqual({
      endTime: closure.endTime,
      inEffect,
      window: closure.dailyWindowUtc,
      ...(nextWindowStart && { nextWindowStart }),
    });
  });

  it('is undefined for a closure without a daily window', () => {
    expect(
      dailyWindowState({ endTime: PVD.endTime, startTime: PVD.startTime }, '2026-11-03T12:00:00Z'),
    ).toBeUndefined();
  });
});

describe('closureWindowNotice', () => {
  it('names the airport, the window, and the next window start', () => {
    expect(closureWindowNotice('PVD', 'airport closure', PVD, '2026-11-03T12:23:00.000Z')).toBe(
      'PVD airport closure applies daily 0515–1030 UTC and is not in effect at fetchedAt; its next window starts 2026-11-04T05:15:00Z.',
    );
  });

  it('says when the last window has ended', () => {
    expect(closureWindowNotice('ASE', 'closure NOTAM', PVD, '2026-11-04T15:00:00.000Z')).toBe(
      'ASE closure NOTAM applies daily 0515–1030 UTC; its last window ended 2026-11-04T10:30:00Z.',
    );
  });

  it.each([
    ['in effect', PVD],
    ['unscheduled', { endTime: PVD.endTime, startTime: PVD.startTime }],
  ])('is undefined for a closure %s', (_label, closure) => {
    expect(
      closureWindowNotice('PVD', 'airport closure', closure, '2026-11-04T08:28:00.000Z'),
    ).toBeUndefined();
  });

  it('flattens the airport identifier it interpolates', () => {
    expect(
      closureWindowNotice('P\nVD [x]', 'airport closure', PVD, '2026-11-03T12:23:00Z'),
    ).toMatch(/^P VD \\\[x\\\] airport closure/);
  });
});

describe('dailyWindowSuffix', () => {
  it.each([
    [
      { dailyWindowUtc: { end: '1030', start: '0515' }, inEffect: true },
      ' · daily 0515–1030 UTC, in effect',
    ],
    [
      { dailyWindowUtc: { end: '0600', start: '2300' }, inEffect: false },
      ' · daily 2300–0600 UTC, not in effect',
    ],
    [{}, ''],
  ])('renders %j as %j', (row, suffix) => {
    expect(dailyWindowSuffix(row)).toBe(suffix);
  });
});
