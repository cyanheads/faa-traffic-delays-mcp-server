/**
 * @fileoverview Closure scope and daily window shared by faa_delays_get_airport_status and
 * faa_delays_list_active_events. Evaluates `DLY HHMM-HHMM` at the feed snapshot's `fetchedAt`.
 * @module mcp-server/tools/closure-window
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DailyWindow } from '@/services/nas-status/types.js';

const DAY_MS = 86_400_000;

/** Whether the full FAA NOTAM's opening scope closes the reported airport. */
export function hasFullClosureScope(airportId: string, notamText: string | undefined): boolean {
  if (notamText === undefined) return false;
  const scope =
    /^![A-Z0-9]{3}\s+\d{2}\/\d{3}\s+([A-Z0-9]{3})\s+AD\s+AP\s+CLSD\s+(?:EXC\s+(?!\d{10}-|DLY(?:\s|$))[A-Z0-9]|\d{10}-(?:\d{10}(?:EST)?|PERM)$)/i.exec(
      notamText.trim(),
    );
  return scope?.[1]?.toUpperCase() === airportId;
}

/** The two fields a scheduled closure, or a closure row, carries beside its times. */
export const DailyWindowFields = {
  dailyWindowUtc: z
    .object({
      start: z.string().describe('Window start, HHMM UTC.'),
      end: z
        .string()
        .describe('Window end, HHMM UTC; earlier than start when the window crosses 0000Z.'),
    })
    .optional()
    .describe(
      'The daily window the NOTAM schedules (a DLY HHMM-HHMM closing its text, with startTime on the first window start and endTime on the last window end): the closure applies only inside it, every day from startTime to endTime. Absent when the text states no such schedule.',
    ),
  inEffect: z
    .boolean()
    .optional()
    .describe(
      'Whether the closure applies at fetchedAt: between startTime and endTime and inside dailyWindowUtc. Present only with dailyWindowUtc; when false, the notice names the next window.',
    ),
};

/** A parsed closure or a closure row; output rows admit an explicit `undefined`. */
export interface ScheduledClosure {
  dailyWindowUtc?: DailyWindow | undefined;
  endTime?: string | undefined;
  startTime?: string | undefined;
}

/** A scheduled closure at one instant. */
export interface DailyWindowState {
  /** End of the last window: the closure's `endTime`. */
  endTime: string;
  inEffect: boolean;
  /** Next window start (`YYYY-MM-DDTHH:MM:SSZ`) while not in effect; absent once the last window has ended. */
  nextWindowStart?: string;
  window: DailyWindow;
}

const offsetMs = (hhmm: string): number =>
  (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2))) * 60_000;

/**
 * A closure's daily window evaluated at `at` (UTC ISO, the snapshot's `fetchedAt`): in effect
 * when `startTime ≤ at < endTime` and the time of day is inside the window. Undefined for a
 * closure without a window.
 */
export function dailyWindowState(
  closure: ScheduledClosure,
  at: string,
): DailyWindowState | undefined {
  const { dailyWindowUtc: window, endTime, startTime } = closure;
  // The parser sets dailyWindowUtc only beside both times.
  if (!window || !startTime || !endTime) return;
  const now = Date.parse(at);
  const first = Date.parse(startTime);
  const last = Date.parse(endTime);
  const opens = offsetMs(window.start);
  const closes = offsetMs(window.end);
  const timeOfDay = now % DAY_MS;
  const inWindow =
    opens < closes
      ? timeOfDay >= opens && timeOfDay < closes
      : timeOfDay >= opens || timeOfDay < closes;
  if (now >= first && now < last && inWindow) return { endTime, inEffect: true, window };
  let next = now - timeOfDay + opens;
  if (next <= now) next += DAY_MS;
  next = Math.max(next, first);
  return {
    endTime,
    inEffect: false,
    window,
    ...(next < last && { nextWindowStart: `${new Date(next).toISOString().slice(0, 19)}Z` }),
  };
}

/** `daily 0515–1030 UTC`. */
export const dailyWindowLabel = ({ end, start }: DailyWindow): string =>
  `daily ${start}–${end} UTC`;

/** ` · daily 0515–1030 UTC, not in effect` for a scheduled closure's line; empty otherwise. */
export function dailyWindowSuffix(row: {
  dailyWindowUtc?: DailyWindow | undefined;
  inEffect?: boolean | undefined;
}): string {
  if (!row.dailyWindowUtc) return '';
  const state = row.inEffect === undefined ? '' : row.inEffect ? ', in effect' : ', not in effect';
  return ` · ${dailyWindowLabel(row.dailyWindowUtc)}${state}`;
}
