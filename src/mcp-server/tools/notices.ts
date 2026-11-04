/**
 * @fileoverview Notice fragments shared by the feed tools: the stale arrival/departure delay
 * warning (an entry last updated more than 6 h before the snapshot), a daily closure outside its
 * window, and the skipped-rows count.
 * @module mcp-server/tools/notices
 */

import { dailyWindowLabel, dailyWindowState, type ScheduledClosure } from './closure-window.js';
import { inline } from './format-helpers.js';

const STALE_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * `ORD departure delay was last updated 8 h ago; …` when `updatedAt` is more than 6 h older than
 * `fetchedAt`, else undefined. The FAA feed can keep a delay entry after the delay lapses.
 */
export function staleDelayNotice(
  airportId: string,
  kind: 'arrival' | 'departure',
  updatedAt: string | undefined,
  fetchedAt: string,
): string | undefined {
  if (!updatedAt) return;
  const age = Date.parse(fetchedAt) - Date.parse(updatedAt);
  if (!Number.isFinite(age) || age <= STALE_DELAY_MS) return;
  return `${inline(airportId)} ${kind} delay was last updated ${Math.floor(age / 3_600_000)} h ago; the FAA feed can keep a delay entry after it lapses.`;
}

/**
 * `PVD airport closure applies daily 0515–1030 UTC and is not in effect at fetchedAt; its next
 * window starts …`, or `…; its last window ended …` once it has; undefined for a closure in
 * effect or without a daily window.
 */
export function closureWindowNotice(
  airportId: string,
  kind: 'airport closure' | 'closure NOTAM',
  closure: ScheduledClosure,
  fetchedAt: string,
): string | undefined {
  const state = dailyWindowState(closure, fetchedAt);
  if (!state || state.inEffect) return;
  const schedule = `${inline(airportId)} ${kind} applies ${dailyWindowLabel(state.window)}`;
  return state.nextWindowStart
    ? `${schedule} and is not in effect at fetchedAt; its next window starts ${state.nextWindowStart}.`
    : `${schedule}; its last window ended ${inline(state.endTime)}.`;
}

/** `N FAA feed rows could not be read and were skipped.`, singular for one row. */
export function skippedRowsNotice(count: number): string {
  return count === 1
    ? '1 FAA feed row could not be read and was skipped.'
    : `${count} FAA feed rows could not be read and were skipped.`;
}

/** Names structured feed sections omitted from this snapshot, never ordinary scalar drift. */
export function unreadableSectionsNotice(sections: string[] | undefined): string[] {
  return sections?.length
    ? [
        `FAA feed sections could not be read and were omitted: ${sections.map(inline).join(', ')}. Their contents are unknown, not confirmed empty.`,
      ]
    : [];
}
